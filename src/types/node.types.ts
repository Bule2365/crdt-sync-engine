/** Identifier unik sebuah node dalam jaringan peer-to-peer. Contoh: "node-001" */
export type NodeId = string;

/** Identifier unik sebuah dokumen yang direplikasi antar node. */
export type DocumentId = string;

/** Identifier unik sebuah operasi CRDT. Menggunakan UUID v4. */
export type OperationId = string;

/** Informasi tentang sebuah node dalam jaringan. */
export interface NodeInfo {
    /** Identifier unik node. */
    nodeId: NodeId;
    /** Alamat WebSocket node. Contoh: "ws://localhost:8002" */
    address: string;
    /** Timestamp (ms) saat node ini pertama kali terhubung ke node kita. */
    connectedAt?: number;
    /** Apakah koneksi WebSocket ke node ini sedang aktif. */
    isConnected: boolean;
}
