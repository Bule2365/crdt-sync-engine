import { encode, decode } from '../compression';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { SyncEngine } from '../sync';
import {
    SyncMessageType,
} from '../types';
import type {
    SystemConfig, SyncMessage, HelloPayload,
    DeltaPayload, VectorClockRecord, NodeId,
} from '../types';

/** Status koneksi satu peer, untuk Debug Inspector. */
export interface PeerConnectionStatus {
    nodeId: string;
    status: 'connected' | 'reconnecting' | 'unreachable';
}

/**
 * Transport Layer — jembatan antara Sync Engine dan jaringan WebSocket nyata.
 *
 * Setiap node berperan SEBAGAI SERVER (menerima koneksi masuk) DAN
 * SEBAGAI CLIENT (menghubungi peer di PEERS config) secara bersamaan.
 *
 * Transport TIDAK memproses logika sync. Ia hanya:
 * - Serialize/deserialize SyncMessage ke/dari MsgPack + zlib compression.
 * - Routing pesan ke method Sync Engine yang sesuai.
 * - Mengelola lifecycle koneksi (connect, reconnect, close).
 */
export class TransportLayer {
    private readonly config: SystemConfig;
    private readonly syncEngine: SyncEngine;
    private wss: WebSocketServer | null = null;
    private readonly socketsByPeer: Map<NodeId, WebSocket> = new Map();
    private readonly reconnectAttempts: Map<string, number> = new Map();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    // private syncTimer: ReturnType<typeof setInterval> | null = null;
    private isShuttingDown: boolean = false;

    private static readonly HEARTBEAT_INTERVAL_MS = 10000;
    private static readonly MAX_BACKOFF_MS = 30000;

    constructor(config: SystemConfig, syncEngine: SyncEngine) {
        this.config = config;
        this.syncEngine = syncEngine;
    }

    /** Buka WebSocketServer, hubungi semua peer yang dikenal, mulai heartbeat. */
    start(): void {
        this.isShuttingDown = false;
        this.wss = new WebSocketServer({ port: this.config.websocketPort });
        this.wss.on('connection', (socket: WebSocket) => {
            this.handleConnection(socket, false);
        });

        for (const address of this.config.peers) {
            this.connectToPeer(address);
        }

        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeats();
        }, TransportLayer.HEARTBEAT_INTERVAL_MS);
    }

    /** Tutup semua koneksi dan server dengan rapi. */
    async stop(): Promise<void> {
        this.isShuttingDown = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const socket of this.socketsByPeer.values()) {
            socket.close();
        }
        this.socketsByPeer.clear();
        if (this.wss) {
            await new Promise<void>((resolve) => {
                this.wss!.close(() => resolve());
            });
            this.wss = null;
        }
    }

    /**
     * Buka koneksi client ke satu alamat peer.
     * Mengimplementasikan reconnect otomatis dengan exponential backoff.
     */
    connectToPeer(address: string): void {
        console.log(`[transport] Connecting to ${address}...`);

        const socket = new WebSocket(address);

        socket.on('open', () => {
            console.log(`[transport] Connected to ${address}`);

            this.handleConnection(socket, true);
            this.reconnectAttempts.set(address, 0);
        });

        socket.on('close', () => {
            console.log(`[transport] Disconnected from ${address}`);

            if (this.isShuttingDown) return;

            const attempt = (this.reconnectAttempts.get(address) ?? 0) + 1;
            this.reconnectAttempts.set(address, attempt);

            const delay = Math.min(
                1000 * Math.pow(2, attempt),
                TransportLayer.MAX_BACKOFF_MS,
            );

            console.log(`[transport] Reconnecting to ${address} in ${delay} ms`);

            setTimeout(() => this.connectToPeer(address), delay);
        });

        socket.on('error', (err) => {
            console.error(`[transport] Connection error to ${address}:`, err.message);
        });
    }

    private handleConnection(
        socket: WebSocket,
        initiateHello: boolean,
    ): void {
        socket.on('message', (raw: RawData) => {
            try {
                const buffer = Buffer.isBuffer(raw)
                    ? raw
                    : Buffer.from(raw as ArrayBuffer);

                const message = decode<SyncMessage>(buffer);

                this.handleMessage(socket, message).catch(() => {
                    // error penanganan pesan diabaikan secara aman untuk prototipe
                });
            } catch {
                // buffer corrupt/tidak valid, abaikan pesan ini
            }
        });
        if (initiateHello) {
            this.sendHello(socket);
        }
    }

    /** Routing pesan masuk ke method Sync Engine yang sesuai. */
    private async handleMessage(
        socket: WebSocket,
        message: SyncMessage,
    ): Promise<void> {

        switch (message.type) {
            case SyncMessageType.HELLO: {
                const payload = message.payload as HelloPayload;

                console.log(`[transport] Received HELLO from ${payload.nodeId}`);

                if (this.socketsByPeer.has(payload.nodeId)) {
                    socket.close();
                    return;
                }

                this.syncEngine.registerPeer(payload.nodeId);
                this.syncEngine.updatePeerClock(payload.nodeId, payload.vectorClock);
                this.socketsByPeer.set(payload.nodeId, socket);

                this.sendSyncRequest(socket);
                break;
            }
            case SyncMessageType.SYNC_REQ: {
                console.log(`[transport] Received SYNC_REQ from ${message.fromNodeId}`);
                const reqPayload = message.payload as { vectorClock: VectorClockRecord };
                const delta = await this.syncEngine.computeDelta(
                    message.fromNodeId,
                    reqPayload.vectorClock,
                );
                console.log(`[transport] Sent SYNC_DELTA to ${message.fromNodeId}`);
                this.send(socket, {
                    type: SyncMessageType.SYNC_DELTA,
                    fromNodeId: this.config.nodeId,
                    timestamp: Date.now(),
                    payload: delta,
                });
                break;
            }
            case SyncMessageType.SYNC_DELTA: {
                const delta = message.payload as DeltaPayload;
                await this.syncEngine.receiveDelta(delta);
                console.log(
                    `[transport] Received SYNC_DELTA from ${message.fromNodeId}`
                );
                console.log(`[transport] Sending SYNC_ACK`);
                this.send(socket, {
                    type: SyncMessageType.SYNC_ACK,
                    fromNodeId: this.config.nodeId,
                    timestamp: Date.now(),
                    payload: { vectorClock: this.syncEngine.getMyVectorClock() },
                });
                break;
            }
            case SyncMessageType.SYNC_ACK: {
                console.log(`[transport] Received SYNC_ACK from ${message.fromNodeId}`);
                const ackPayload = message.payload as { vectorClock: VectorClockRecord };
                this.syncEngine.updatePeerClock(message.fromNodeId, ackPayload.vectorClock);
                break;
            }
            case SyncMessageType.HEARTBEAT:
                console.log(`[transport] Received HEARTBEAT from ${message.fromNodeId}`);
                break;
        }
    }

    /** Kirim SYNC_REQ ke semua peer yang sedang terhubung (OPEN). */
    triggerSync(): void {
        for (const socket of this.socketsByPeer.values()) {
            if (socket.readyState === WebSocket.OPEN) {
                this.sendSyncRequest(socket);
            }
        }
    }

    private sendHello(socket: WebSocket): void {
        const payload: HelloPayload = {
            nodeId: this.config.nodeId,
            knownDocuments: [],
            vectorClock: this.syncEngine.getMyVectorClock(),
        };

        console.log(`[transport] Sent HELLO`);

        this.send(socket, {
            type: SyncMessageType.HELLO,
            fromNodeId: this.config.nodeId,
            timestamp: Date.now(),
            payload,
        });
    }

    /** Kirim SyncMessage via socket sebagai Buffer terkompresi, hanya jika socket OPEN. */
    private send(socket: WebSocket, message: SyncMessage): void {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(encode(message));
        }
    }

    private sendSyncRequest(socket: WebSocket): void {
        console.log(`[transport] Sent SYNC_REQ`);
        this.send(socket, {
            type: SyncMessageType.SYNC_REQ,
            fromNodeId: this.config.nodeId,
            timestamp: Date.now(),
            payload: { vectorClock: this.syncEngine.getMyVectorClock() },
        });
    }

    private sendHeartbeats(): void {
        for (const socket of this.socketsByPeer.values()) {
            if (socket.readyState === WebSocket.OPEN) {
                console.log(`[transport] Sent HEARTBEAT`);
                this.send(socket, {
                    type: SyncMessageType.HEARTBEAT,
                    fromNodeId: this.config.nodeId,
                    timestamp: Date.now(),
                });
            }
        }
    }

    /** Kirim SyncMessage via socket, hanya jika socket sedang OPEN. */
    // private send(socket: WebSocket, message: SyncMessage): void {
    //     if (socket.readyState === WebSocket.OPEN) {
    //         socket.send(JSON.stringify(message));
    //     }
    // }

    /** Status koneksi setiap peer yang dikenal. Untuk Debug Inspector. */
    getPeerConnectionStatus(): PeerConnectionStatus[] {
        const result: PeerConnectionStatus[] = [];
        for (const [nodeId, socket] of this.socketsByPeer.entries()) {
            result.push({
                nodeId,
                status: socket.readyState === WebSocket.OPEN
                    ? 'connected'
                    : 'reconnecting',
            });
        }
        return result;
    }

    /** Jumlah peer dengan koneksi OPEN saat ini. */
    getConnectedPeerCount(): number {
        let count = 0;
        for (const socket of this.socketsByPeer.values()) {
            if (socket.readyState === WebSocket.OPEN) count++;
        }
        return count;
    }
}
