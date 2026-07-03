import { ClassicLevel } from 'classic-level';
import type { Operation, LogEntry } from '../types';

/** Prefix key LevelDB untuk membedakan log entry dari key lain. */
const KEY_PREFIX = 'log:';

/** Panjang zero-padding sequence number. 12 digit = max 999.999.999.999 entries. */
const SEQ_PAD = 12;

/**
 * Hasilkan key LevelDB untuk sequence number tertentu.
 * Zero-padded agar urutan leksikografis = urutan numerik.
 */
function seqKey(seqNum: number): string {
    return KEY_PREFIX + String(seqNum).padStart(SEQ_PAD, '0');
}

/**
 * Operation Log — Penyimpanan append-only semua operasi CRDT.
 *
 * Setiap operasi yang terjadi di node ini disimpan secara permanen ke LevelDB.
 * Log adalah sumber kebenaran tunggal: state CRDT dapat direkonstruksi
 * sepenuhnya dengan me-replay semua entry dari awal.
 *
 * Properti kunci:
 * - Append-only: entry tidak pernah dimodifikasi atau dihapus.
 * - Berurutan: setiap entry memiliki sequenceNumber yang monoton naik.
 * - Persisten: data tersimpan di disk via LevelDB, tahan crash.
 * - Range-scannable: getAfter() efisien untuk delta computation.
 *
 * Lifecycle wajib:
 * 1. new OperationLog(dataDir)
 * 2. await log.open()
 * 3. ... gunakan log ...
 * 4. await log.close()
 */
export class OperationLog {
    private readonly dataDir: string;
    private db: ClassicLevel<string, string> | null;
    private lastSeqNum: number;

    async hasOperation(operationId: string): Promise<boolean> {
        const entries = await this.getAll();

        return entries.some(
            (entry) => entry.operation.operationId === operationId,
        );
    }

    /**
     * @param dataDir Path direktori LevelDB untuk log ini.
     *                Setiap node harus memiliki dataDir unik.
     */
    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.db = null;
        this.lastSeqNum = -1;
    }

    /**
     * Buka koneksi LevelDB dan restore lastSeqNum dari data yang ada.
     * WAJIB dipanggil sebelum operasi lain.
     */
    async open(): Promise<void> {
        this.db = new ClassicLevel<string, string>(
            this.dataDir,
            { valueEncoding: 'utf8' },
        );
        await this.db.open();
        this.lastSeqNum = await this.readLastSeqNum();
    }

    /**
     * Tutup koneksi LevelDB dan flush semua buffer ke disk.
     * WAJIB dipanggil sebelum proses selesai.
     */
    async close(): Promise<void> {
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
    }

    /**
     * Tulis operasi baru ke log.
     * Bersifat append-only: entry yang ada tidak pernah dimodifikasi.
     *
     * @param operation Operasi yang akan disimpan.
     * @returns LogEntry baru dengan sequenceNumber yang ditetapkan.
     */
    async append(operation: Operation): Promise<LogEntry> {
        const db = this.requireDb();
        const seqNum = this.lastSeqNum + 1;
        const entry: LogEntry = {
            sequenceNumber: seqNum,
            operation,
            writtenAt: Date.now(),
        };
        await db.put(seqKey(seqNum), JSON.stringify(entry));
        this.lastSeqNum = seqNum;
        return entry;
    }

    /**
     * Ambil semua entry SETELAH afterSeqNum (exclusive).
     * Digunakan oleh Sync Engine untuk menghitung delta.
     *
     * @param afterSeqNum Entry dengan seqNum <= afterSeqNum diabaikan.
     *                    Gunakan -1 untuk mendapatkan semua entry.
     */
    async getAfter(afterSeqNum: number): Promise<LogEntry[]> {
        const db = this.requireDb();
        const entries: LogEntry[] = [];
        const startKey = seqKey(afterSeqNum + 1);
        for await (const [key, value] of db.iterator({ gte: startKey })) {
            if (!key.startsWith(KEY_PREFIX)) break;
            entries.push(JSON.parse(value) as LogEntry);
        }
        return entries;
    }

    /**
     * Ambil semua entry dari awal log.
     * Digunakan saat startup untuk full state replay.
     */
    async getAll(): Promise<LogEntry[]> {
        return this.getAfter(-1);
    }

    /**
     * Sequence number entry terakhir yang ada di log.
     * Mengembalikan -1 jika log kosong.
     */
    async getLastSequenceNumber(): Promise<number> {
        return this.lastSeqNum;
    }

    /**
     * Hapus semua entry dari log.
     * HANYA untuk keperluan testing. Jangan gunakan di production.
     */
    async clear(): Promise<void> {
        const db = this.requireDb();
        await db.clear();
        this.lastSeqNum = -1;
    }

    /**
     * Baca sequence number terakhir dari LevelDB.
     * Dipanggil saat open() untuk restore state in-memory.
     */
    private async readLastSeqNum(): Promise<number> {
        const db = this.requireDb();
        let last = -1;
        for await (const key of db.keys({ reverse: true, limit: 1 })) {
            if (key.startsWith(KEY_PREFIX)) {
                last = parseInt(key.slice(KEY_PREFIX.length), 10);
            }
        }
        return last;
    }

    /** Pastikan database sudah dibuka. Lempar Error jika belum. */
    private requireDb(): ClassicLevel<string, string> {
        if (!this.db) {
            throw new Error(
                'OperationLog: database belum dibuka. Panggil open() terlebih dahulu.',
            );
        }
        return this.db;
    }
}
