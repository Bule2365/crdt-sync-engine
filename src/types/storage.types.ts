import type { DocumentId } from './node.types';
import type { VectorClockRecord } from './clock.types';
import type { Operation } from './operation.types';

/** Satu entri dalam Operation Log yang disimpan di LevelDB. */
export interface LogEntry {
    /** Nomor urut dalam log. Mulai dari 0, increment monoton, tidak pernah berulang. */
    sequenceNumber: number;
    /** Operasi yang direkam di entri ini. */
    operation: Operation;
    /** Wall-clock timestamp (ms) saat entri ini ditulis ke LevelDB. */
    writtenAt: number;
}

/** Metadata snapshot yang disimpan bersama file snapshot state CRDT. */
export interface SnapshotMetadata {
    documentId: DocumentId;
    /**
     * Identifier unik snapshot ini.
     * Format: snap_{documentId}_{lastSequenceNumber}
     */
    snapshotId: string;
    /** Sequence number terakhir yang sudah terabstraksi dalam snapshot ini. */
    lastSequenceNumber: number;
    /** Jumlah total operasi yang dirangkum dalam snapshot ini. */
    operationCount: number;
    /** Wall-clock timestamp (ms) saat snapshot dibuat. */
    createdAt: number;
    /** Vector clock pada saat snapshot dibuat. */
    vectorClock: VectorClockRecord;
}
