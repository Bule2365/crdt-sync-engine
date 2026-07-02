import type { DocumentId } from './node.types';
import type { VectorClockRecord } from './clock.types';

/**
 * Tipe CRDT yang didukung sistem ini.
 * Menggunakan string enum agar nilai dapat dibaca saat debug dan serialisasi JSON.
 */
export enum CRDTType {
    G_COUNTER = 'g-counter',    // Grow-only counter (Langkah 4)
    OR_SET = 'or-set',       // Observed-Remove Set (Langkah 5)
    LWW_REGISTER = 'lww-register', // Last-Write-Wins Register (Langkah 6)
    LSEQ_LIST = 'lseq-list',   // Ordered list berbasis LSEQ (Langkah 7)
    LSEQ_TEXT = 'lseq-text',   // Collaborative text berbasis LSEQ (Langkah 7)
}

/** Metadata dokumen CRDT yang disimpan dan direplikasi antar node. */
export interface CRDTDocument {
    /** Identifier unik dokumen ini. */
    documentId: DocumentId;
    /** Tipe CRDT dokumen ini. */
    type: CRDTType;
    /** Timestamp (ms) saat dokumen pertama kali dibuat. */
    createdAt: number;
    /** Timestamp (ms) saat dokumen terakhir dimodifikasi. */
    updatedAt: number;
    /** State vector clock pada saat dokumen terakhir dimodifikasi. */
    vectorClock: VectorClockRecord;
}
