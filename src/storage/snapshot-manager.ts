import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { CRDTEngine } from '../core';
import type { OperationLog } from './operation-log';
import type { NodeId, DocumentId, CRDTDocument, VectorClockRecord } from '../types';
import { CRDTType } from '../types';

/** Struktur lengkap satu file snapshot. */
export interface SnapshotFile {
    /** Identifier unik: "snap_<lastSeqNum>_<timestamp>". */
    snapshotId: string;
    /** Node yang membuat snapshot ini. */
    nodeId: NodeId;
    /** Posisi Operation Log saat snapshot dibuat. */
    lastSequenceNumber: number;
    /** Wall-clock saat snapshot dibuat. */
    createdAt: number;
    /** Vector clock global node saat snapshot dibuat. */
    vectorClock: VectorClockRecord;
    /** State semua dokumen, dikelompokkan per documentId. */
    documents: Record<string, { meta: CRDTDocument; state: unknown }>;
}

/**
 * Snapshot Manager — checkpoint state CRDT secara periodik.
 *
 * Mempercepat startup: hanya log SETELAH snapshot yang perlu di-replay.
 * Mengurangi pertumbuhan Operation Log dengan menyediakan titik referensi.
 *
 * File disimpan terkompresi (gzip) dengan ekstensi .snap.gz.
 * Nama file: snapshot-<12-digit-seqNum>-<timestamp>.snap.gz
 */
export class SnapshotManager {
    private readonly snapshotDir: string;

    /**
     * @param snapshotDir Path direktori penyimpanan file snapshot.
     */
    constructor(snapshotDir: string) {
        this.snapshotDir = snapshotDir;
    }

    /**
     * Buat snapshot baru dari state seluruh dokumen di Engine.
     * @returns Filepath snapshot yang baru dibuat.
     */
    async createSnapshot(
        engine: CRDTEngine,
        log: OperationLog,
    ): Promise<string> {
        const documentIds = engine.getDocumentIds();
        const documents: SnapshotFile['documents'] = {};

        for (const docId of documentIds) {
            const meta = engine.getDocument(docId);
            if (!meta) continue;
            let state: unknown;
            switch (meta.type) {
                case CRDTType.G_COUNTER:
                    state = engine.getCounterState(docId); break;
                case CRDTType.OR_SET:
                    state = engine.getSetState(docId); break;
                case CRDTType.LWW_REGISTER:
                    state = engine.getRegisterState(docId); break;
                case CRDTType.LSEQ_LIST:
                case CRDTType.LSEQ_TEXT:
                    state = engine.getListState(docId); break;
                default:
                    continue;
            }
            documents[docId] = { meta, state };
        }

        const lastSeqNum = await log.getLastSequenceNumber();
        const snapshotFile: SnapshotFile = {
            snapshotId: `snap_${lastSeqNum}_${Date.now()}`,
            nodeId: engine.getNodeId(),
            lastSequenceNumber: lastSeqNum,
            createdAt: Date.now(),
            vectorClock: engine.getVectorClock(),
            documents,
        };

        return this.writeSnapshotFile(snapshotFile);
    }

    /**
     * Muat snapshot dengan sequence number tertinggi (terbaru).
     * @returns SnapshotFile, atau null jika belum ada snapshot.
     */
    loadLatestSnapshot(): SnapshotFile | null {
        if (!fs.existsSync(this.snapshotDir)) return null;

        const files = fs.readdirSync(this.snapshotDir)
            .filter(function (f) { return f.endsWith('.snap.gz'); })
            .sort();

        if (files.length === 0) return null;

        const latestFile = files[files.length - 1] as string;
        const filePath = path.join(this.snapshotDir, latestFile);
        const compressed = fs.readFileSync(filePath);
        const json = zlib.gunzipSync(compressed).toString('utf8');

        return JSON.parse(json) as SnapshotFile;
    }

    /**
     * Hapus snapshot lama, sisakan N generasi terbaru.
     * @param keepCount Jumlah snapshot terbaru yang dipertahankan. Default 5.
     */
    pruneOldSnapshots(keepCount: number = 5): void {
        if (!fs.existsSync(this.snapshotDir)) return;

        const files = fs.readdirSync(this.snapshotDir)
            .filter(function (f) { return f.endsWith('.snap.gz'); })
            .sort();

        const deleteCount = Math.max(0, files.length - keepCount);
        const toDelete = files.slice(0, deleteCount);

        for (const file of toDelete) {
            fs.unlinkSync(path.join(this.snapshotDir, file));
        }
    }

    /**
     * Periksa apakah sudah waktunya membuat snapshot baru.
     * @param operationCount Jumlah operasi sejak snapshot terakhir.
     * @param interval       Interval snapshot (jumlah operasi).
     */
    shouldSnapshot(operationCount: number, interval: number): boolean {
        return operationCount > 0 && operationCount % interval === 0;
    }

    /**
     * Tulis SnapshotFile ke disk, terkompresi gzip.
     * @returns Filepath file yang ditulis.
     */
    private writeSnapshotFile(snapshotFile: SnapshotFile): string {
        const seqPadded = String(snapshotFile.lastSequenceNumber).padStart(12, '0');
        const fileName = `snapshot-${seqPadded}-${snapshotFile.createdAt}.snap.gz`;
        const filePath = path.join(this.snapshotDir, fileName);

        const json = JSON.stringify(snapshotFile);
        const compressed = zlib.gzipSync(json);

        fs.mkdirSync(this.snapshotDir, { recursive: true });
        fs.writeFileSync(filePath, compressed);

        return filePath;
    }
}
