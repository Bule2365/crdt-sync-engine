import type { NodeId, DocumentId, OperationId } from './node.types';
import type { CRDTType } from './crdt.types';
import type { VectorClockRecord } from './clock.types';

/** Jenis operasi yang dapat dilakukan pada CRDT. */
export enum OperationType {
    INSERT = 'insert',    // Tambah elemen baru (OR-Set, LSEQ)
    DELETE = 'delete',    // Hapus elemen (OR-Set, LSEQ — tombstone)
    UPDATE = 'update',    // Perbarui nilai (LWW-Register)
    INCREMENT = 'increment', // Tambah counter (G-Counter)
}

/**
 * Operasi CRDT — unit data terkecil dalam sistem.
 * Setelah dibuat dan ditulis ke log, operasi tidak boleh diubah (immutable).
 * Properti yang ditandai readonly tidak bisa diubah setelah objek dibuat.
 */
export interface Operation {
    /** UUID v4 — identifier unik global untuk operasi ini. */
    readonly operationId: OperationId;
    /** Dokumen yang dimodifikasi oleh operasi ini. */
    readonly documentId: DocumentId;
    /** Node yang menghasilkan operasi ini. */
    readonly nodeId: NodeId;
    /** Jenis operasi yang dilakukan. */
    readonly type: OperationType;
    /** Tipe CRDT yang dioperasikan. */
    readonly crdtType: CRDTType;
    /**
     * Lamport logical timestamp saat operasi dibuat.
     * BUKAN wall-clock time. Digunakan untuk causal ordering.
     */
    readonly timestamp: number;
    /** State vector clock node ini saat operasi dibuat. */
    readonly vectorClock: VectorClockRecord;
    /**
     * Data spesifik operasi. Tipe bergantung pada crdtType.
     * Gunakan unknown (bukan any) — setiap CRDT wajib melakukan type narrowing.
     */
    readonly payload: unknown;
    /** Wall-clock timestamp (ms) saat operasi dibuat. Hanya untuk audit/logging. */
    readonly createdAt: number;
}
