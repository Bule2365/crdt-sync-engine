import { VectorClock, ClockComparison } from '../clock';
import type { CRDTEngine } from '../core';
import type { OperationLog } from '../storage';
import type {
    NodeId, Operation, DeltaPayload, VectorClockRecord,
} from '../types';

/** State tracking untuk satu peer yang dikenal Sync Engine. */
export interface PeerSyncState {
    nodeId: NodeId;
    /** Vector clock terakhir yang dilaporkan/diketahui dari peer ini. */
    lastKnownClock: VectorClockRecord;
    /** Wall-clock timestamp sync terakhir yang berhasil dengan peer ini. */
    lastSyncedAt: number;
}

/** Ringkasan status sync satu peer, untuk Debug Inspector. */
export interface SyncStatusEntry {
    nodeId: NodeId;
    lastSyncedAt: number;
    syncLag: number;
}

/**
 * Sync Engine — logika murni untuk menghitung delta dan merekonsiliasi state.
 *
 * TIDAK melakukan I/O jaringan apapun. Tidak mengimpor WebSocket.
 * Transport Layer (Langkah 12) yang menjembatani Sync Engine dengan jaringan.
 *
 * Tanggung jawab:
 * - computeDelta(): hitung operasi yang belum diketahui peer.
 * - receiveDelta(): terapkan operasi yang diterima dari peer.
 * - Mengelola tracking ringan per-peer (PeerSyncState).
 */
export class SyncEngine {
    private readonly engine: CRDTEngine;
    private readonly log: OperationLog;
    private readonly peers: Map<NodeId, PeerSyncState>;

    /**
     * @param engine CRDT Core Engine node ini.
     * @param log    Operation Log node ini (harus sudah open()).
     */
    constructor(engine: CRDTEngine, log: OperationLog) {
        this.engine = engine;
        this.log = log;
        this.peers = new Map();
    }

    /**
     * Hitung delta: operasi di log lokal yang belum diketahui peer.
     * Menyertakan operasi dengan relasi AFTER dan CONCURRENT terhadap peerClock.
     *
     * @param peerNodeId NodeId peer tujuan (untuk metadata payload).
     * @param peerClock  Vector clock peer saat ini (dilaporkan via HELLO/SYNC_REQ).
     */
    async computeDelta(
        peerNodeId: NodeId,
        peerClock: VectorClockRecord,
    ): Promise<DeltaPayload> {
        const allEntries = await this.log.getAll();
        const operations: Operation[] = [];

        for (const entry of allEntries) {
            const rel = VectorClock.compare(entry.operation.vectorClock, peerClock);
            if (
                rel === ClockComparison.AFTER ||
                rel === ClockComparison.CONCURRENT
            ) {
                operations.push(entry.operation);
            }
        }

        return {
            fromNodeId: this.engine.getNodeId(),
            documentId: '*',
            senderVectorClock: this.engine.getVectorClock(),
            operations,
        };
    }

    /**
     * Terapkan delta yang diterima dari peer.
     * Melakukan idempotency check sebelum apply (optimasi; CRDT tetap aman tanpa ini).
     *
     * @param delta DeltaPayload yang diterima dari peer.
     * @returns Jumlah operasi yang benar-benar diterapkan (bukan di-skip).
     */
    async receiveDelta(delta: DeltaPayload): Promise<number> {
        let appliedCount = 0;

        for (const operation of delta.operations) {
            const localClock = this.engine.getVectorClock();
            const rel = VectorClock.compare(operation.vectorClock, localClock);
            if (
                rel === ClockComparison.BEFORE ||
                rel === ClockComparison.EQUAL
            ) {
                continue; // sudah pernah diterima, skip
            }

            this.engine.applyOperation(operation, true); // isRemote = true WAJIB
            await this.log.append(operation);
            appliedCount++;
        }

        this.updatePeerClock(delta.fromNodeId, delta.senderVectorClock);
        return appliedCount;
    }

    // ── Peer Management ──────────────────────────────────────────────────

    /** Daftarkan peer baru. Idempotent: tidak menimpa entry yang sudah ada. */
    registerPeer(nodeId: NodeId): void {
        if (!this.peers.has(nodeId)) {
            this.peers.set(nodeId, {
                nodeId,
                lastKnownClock: {},
                lastSyncedAt: 0,
            });
        }
    }

    /** Hapus peer dari tracking (saat disconnect). */
    unregisterPeer(nodeId: NodeId): void {
        this.peers.delete(nodeId);
    }

    /** Update lastKnownClock dan lastSyncedAt untuk satu peer. Otomatis registerPeer jika belum ada. */
    updatePeerClock(nodeId: NodeId, clock: VectorClockRecord): void {
        this.registerPeer(nodeId);
        const peer = this.peers.get(nodeId) as PeerSyncState;
        peer.lastKnownClock = { ...clock };
        peer.lastSyncedAt = Date.now();
    }

    /** Ambil tracking state satu peer, atau null jika tidak terdaftar. */
    getPeerState(nodeId: NodeId): PeerSyncState | null {
        const peer = this.peers.get(nodeId);
        return peer ? { ...peer } : null;
    }

    /** Semua peer yang terdaftar. */
    getAllPeers(): PeerSyncState[] {
        return Array.from(this.peers.values()).map(function (p) { return { ...p }; });
    }

    /**
     * Ringkasan status sync setiap peer. Digunakan oleh Debug Inspector.
     * syncLag adalah perkiraan kasar: selisih total counter clock lokal vs peer.
     */
    getSyncStatus(): SyncStatusEntry[] {
        const localClock = this.engine.getVectorClock();
        const localTotal = Object.values(localClock).reduce(
            function (a, b) { return a + b; }, 0,
        );
        return Array.from(this.peers.values()).map(function (peer) {
            const peerTotal = Object.values(peer.lastKnownClock).reduce(
                function (a, b) { return a + b; }, 0,
            );
            return {
                nodeId: peer.nodeId,
                lastSyncedAt: peer.lastSyncedAt,
                syncLag: Math.max(0, localTotal - peerTotal),
            };
        });
    }

    /** Shortcut: vector clock node ini sendiri. */
    getMyVectorClock(): VectorClockRecord {
        return this.engine.getVectorClock();
    }
}
