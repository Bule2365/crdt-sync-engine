import type { NodeId } from './node.types';

/** Konfigurasi lengkap sistem CRDT Sync Engine. Dimuat dari file .env. */
export interface SystemConfig {
    /** Identifier unik node ini dalam jaringan peer-to-peer. */
    nodeId: NodeId;
    /** Path direktori penyimpanan data lokal (operation log, snapshot). */
    dataDir: string;
    /** Port WebSocket yang didengarkan node ini. */
    websocketPort: number;
    /**
     * Daftar alamat WebSocket peer yang dikenal saat startup.
     * Contoh: ["ws://localhost:8002", "ws://localhost:8003"]
     */
    peers: string[];
    /** Interval sinkronisasi periodik dalam milidetik. Rekomendasi: 500. */
    syncIntervalMs: number;
    /** Batas ukuran Operation Log (MB) sebelum snapshot dan compaction dijalankan. */
    maxLogSizeMb: number;
    /** Jumlah operasi sebelum snapshot otomatis dibuat. */
    snapshotInterval: number;
    /** Port REST API lokal untuk Debug Inspector. */
    debugPort: number;
    /** Level logging yang aktif. */
    logLevel: 'error' | 'warn' | 'info' | 'debug';
}
