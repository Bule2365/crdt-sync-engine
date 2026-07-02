import { v4 as uuidv4 } from 'uuid';
import type { NodeId, DocumentId, Operation } from '../../types';
import { CRDTType, OperationType } from '../../types';

/** Satu entri dalam OR-Set: pasangan elemen dan tag uniknya. */
export interface ORSetEntry {
    /** Nilai elemen (string). Contoh: "apple", "task-001". */
    element: string;
    /** Tag UUID unik yang dihasilkan saat operasi add. */
    tag: string;
}

/**
 * State OR-Set untuk serialisasi (JSON / msgpackr).
 * Menggunakan array, bukan Set/Map, agar bisa diserialisasi.
 */
export interface ORSetState {
    /** Semua entri (element, tag) yang pernah ditambahkan. */
    entries: ORSetEntry[];
    /** Tag-tag yang sudah dinyatakan dihapus (tombstone). */
    tombstones: string[];
}

/** Payload operasi INSERT pada OR-Set. */
export interface ORSetAddPayload {
    element: string;
    /** Tag UUID unik yang dihasilkan oleh prepareAdd(). */
    tag: string;
}

/** Payload operasi DELETE pada OR-Set. */
export interface ORSetRemovePayload {
    element: string;
    /**
     * Tag-tag yang diobservasi oleh node ini saat remove dibuat.
     * Hanya tag ini yang akan di-tombstone.
     * Tag dari add concurrent yang belum diketahui tidak terpengaruh.
     */
    observedTags: string[];
}

/**
 * OR-Set CRDT — Observed-Remove Set dengan Add-Wins Semantics.
 *
 * Mendukung add dan remove secara concurrent tanpa konflik.
 * Jika add dan remove terjadi bersamaan, add selalu menang.
 *
 * Mekanisme:
 * - Setiap add menghasilkan tag UUID unik.
 * - Remove hanya mentombstone tag yang sudah diobservasi.
 * - Elemen hidup jika ada minimal satu tag yang tidak di-tombstone.
 */
export class ORSet {
    private readonly nodeId: NodeId;
    private readonly documentId: DocumentId;
    private readonly entries: ORSetEntry[];
    private readonly tombstones: Set<string>;

    /**
     * @param nodeId       Identifier node yang memiliki instance ini.
     * @param documentId   Identifier dokumen yang direpresentasikan set ini.
     * @param initialState State awal (opsional — untuk restore dari snapshot).
     */
    constructor(
        nodeId: NodeId,
        documentId: DocumentId,
        initialState?: ORSetState,
    ) {
        this.nodeId = nodeId;
        this.documentId = documentId;
        this.entries = initialState ? initialState.entries.map(function (e) { return { ...e }; }) : [];
        this.tombstones = new Set(initialState?.tombstones ?? []);
    }

    /**
     * Hitung payload untuk operasi add.
     * Menghasilkan tag UUID unik untuk identifikasi operasi add ini.
     * TIDAK mengubah state. State diubah via apply().
     *
     * @param element Nilai elemen yang akan ditambahkan.
     * @returns ORSetAddPayload berisi element dan tag UUID baru.
     */
    prepareAdd(element: string): ORSetAddPayload {
        return { element, tag: uuidv4() };
    }

    /**
     * Hitung payload untuk operasi remove.
     * Mengumpulkan semua tag "hidup" untuk elemen ini (observed tags).
     * TIDAK mengubah state. State diubah via apply().
     *
     * @param element Nilai elemen yang akan dihapus.
     * @returns ORSetRemovePayload jika elemen ada, null jika tidak ada.
     */
    prepareRemove(element: string): ORSetRemovePayload | null {
        const observedTags = this.entries
            .filter(e =>
                e.element === element &&
                !this.tombstones.has(e.tag)
            )
            .map(e => e.tag);

        if (observedTags.length === 0) {
            return null; // elemen tidak ada di set, tidak perlu operasi
        }
        return { element, observedTags };
    }

    /**
     * Terapkan operasi INSERT atau DELETE ke state OR-Set.
     * Idempoten untuk kedua tipe operasi.
     *
     * @param operation Operasi yang akan diterapkan.
     * @throws Error jika crdtType atau type operasi tidak valid.
     */
    apply(operation: Operation): void {
        if (operation.crdtType !== CRDTType.OR_SET) {
            throw new Error(
                `ORSet.apply: crdtType tidak valid. ` +
                `Expected: ${CRDTType.OR_SET}, Got: ${operation.crdtType}`,
            );
        }

        if (operation.type === OperationType.INSERT) {
            const payload = operation.payload as ORSetAddPayload;
            // Idempotent: hanya tambah jika tag belum ada
            const exists = this.entries.some(function (e) { return e.tag === payload.tag; });
            if (!exists) {
                this.entries.push({ element: payload.element, tag: payload.tag });
            }

        } else if (operation.type === OperationType.DELETE) {
            const payload = operation.payload as ORSetRemovePayload;
            // Idempotent: Set.add() pada tag yang sama tidak mengubah apapun
            for (const tag of payload.observedTags) {
                this.tombstones.add(tag);
            }

        } else {
            throw new Error(
                `ORSet hanya mendukung INSERT dan DELETE, bukan ${operation.type}`,
            );
        }
    }

    /**
     * Periksa apakah elemen ada di set.
     * Elemen hidup jika ada minimal satu entry dengan tag tidak di tombstones.
     */
    has(element: string): boolean {
        return this.entries.some(
            e =>
                e.element === element &&
                !this.tombstones.has(e.tag)
        );
    }

    /**
     * Kembalikan semua elemen yang hidup di set, tanpa duplikat.
     * Elemen hidup = punya minimal satu tag tidak di tombstones.
     */
    values(): string[] {
        const live = new Set<string>();
        for (const entry of this.entries) {
            if (!this.tombstones.has(entry.tag)) {
                live.add(entry.element);
            }
        }
        return Array.from(live);
    }

    /**
     * Jumlah elemen hidup di set.
     */
    size(): number {
        return this.values().length;
    }

    /**
     * Merge state dari node lain ke dalam state lokal.
     * Union entries (dedup by tag) dan union tombstones.
     *
     * @param remoteState ORSetState yang diterima dari node lain.
     */
    merge(remoteState: ORSetState): void {
        // Union entries — dedup by tag
        for (const remoteEntry of remoteState.entries) {
            const exists = this.entries.some(function (e) { return e.tag === remoteEntry.tag; });
            if (!exists) {
                this.entries.push({ ...remoteEntry });
            }
        }
        // Union tombstones
        for (const tag of remoteState.tombstones) {
            this.tombstones.add(tag);
        }
    }

    /**
     * Ambil snapshot state saat ini (deep copy).
     * Digunakan oleh Snapshot Manager (Langkah 10).
     */
    getState(): ORSetState {
        return {
            entries: this.entries.map(function (e) { return { ...e }; }),
            tombstones: Array.from(this.tombstones),
        };
    }

    /** Identifier dokumen yang dikelola set ini. */
    getDocumentId(): DocumentId { return this.documentId; }

    /** NodeId node yang memiliki instance ini. */
    getNodeId(): NodeId { return this.nodeId; }
}
