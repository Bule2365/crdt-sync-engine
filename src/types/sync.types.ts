import type { NodeId, DocumentId } from './node.types';
import type { VectorClockRecord } from './clock.types';
import type { Operation } from './operation.types';

/** Tipe pesan yang dipertukarkan antar node via WebSocket. */
export enum SyncMessageType {
    HELLO = 'hello',       // Perkenalan saat koneksi pertama dibuat
    SYNC_REQ = 'sync-req',   // Node A meminta delta dari Node B
    SYNC_DELTA = 'sync-delta', // Node A mengirimkan delta ke Node B
    SYNC_ACK = 'sync-ack',   // Konfirmasi penerimaan delta berhasil
    HEARTBEAT = 'heartbeat',  // Sinyal keepalive antar node
}

/** Pesan sinkronisasi yang dikirim dan diterima via WebSocket. */
export interface SyncMessage {
    type: SyncMessageType;
    fromNodeId: NodeId;
    /** Lamport timestamp pesan ini untuk ordering. */
    timestamp: number;
    /** Payload spesifik tipe pesan. Gunakan unknown untuk keamanan tipe. */
    payload?: unknown;
}

/** Paket delta yang dikirimkan dari satu node ke node lain. */
export interface DeltaPayload {
    fromNodeId: NodeId;
    documentId: DocumentId;
    /** Vector clock pengirim pada saat delta ini dihitung. */
    senderVectorClock: VectorClockRecord;
    /** Daftar operasi yang belum diterima oleh node tujuan. */
    operations: Operation[];
}

/** Payload pesan HELLO yang dikirim saat koneksi pertama. */
export interface HelloPayload {
    nodeId: NodeId;
    /** Daftar documentId yang dimiliki node ini. */
    knownDocuments: DocumentId[];
    /** Vector clock node ini saat hello dikirim. */
    vectorClock: VectorClockRecord;
}
