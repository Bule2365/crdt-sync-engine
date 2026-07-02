import type { NodeId, DocumentId, Operation } from '../../types';
import { CRDTType, OperationType } from '../../types';

/**
 * Satu elemen dalam LSEQ sequence.
 * Elemen diidentifikasi secara unik oleh (pos, creatorId).
 */
export interface LSEQNode {
    /** Posisi fraksional di (0, 1). Menentukan urutan elemen. */
    pos: number;
    /** Nilai elemen: karakter (text) atau item string (list). */
    value: string;
    /** Tombstone flag. True = elemen dihapus tetapi tetap di array. */
    deleted: boolean;
    /** NodeId pencipta. Digunakan sebagai tiebreaker jika pos sama. */
    creatorId: NodeId;
}

/** State LSEQ: array LSEQNode yang diurutkan by (pos, creatorId). */
export type LSEQState = LSEQNode[];

/** Payload operasi INSERT pada LSEQ. */
export interface LSEQInsertPayload {
    /** Posisi fraksional yang dihasilkan oleh prepareInsert(). */
    pos: number;
    /** Nilai yang disisipkan. */
    value: string;
    /** NodeId pencipta — sama dengan operation.nodeId. */
    creatorId: NodeId;
}

/** Payload operasi DELETE pada LSEQ. */
export interface LSEQDeletePayload {
    /** Posisi fraksional elemen yang dihapus. */
    pos: number;
    /** NodeId pencipta elemen yang dihapus. */
    creatorId: NodeId;
}

/**
 * Fungsi perbandingan untuk mengurutkan LSEQNode.
 * Urutan primer: pos (ascending).
 * Urutan sekunder (tiebreaker): creatorId (leksikografis ascending).
 */
export function compareNodes(a: LSEQNode, b: LSEQNode): number {
    if (a.pos !== b.pos) return a.pos - b.pos;
    return a.creatorId.localeCompare(b.creatorId);
}

/**
 * LSEQ List CRDT.
 *
 * Mendukung insert dan delete pada ordered sequence secara concurrent.
 * Satu class melayani CRDT_TYPE.LSEQ_LIST (ordered list) dan LSEQ_TEXT (teks).
 *
 * Mekanisme kunci:
 * - Setiap elemen memiliki pos fraksional unik di (0, 1).
 * - Insert menghasilkan pos acak di antara tetangga kiri dan kanan.
 * - Delete = tombstone (deleted=true). Elemen tidak pernah benar-benar dihapus.
 * - Urutan ditentukan oleh (pos, creatorId), bukan posisi array.
 */
export class LSEQList {
    private readonly nodeId: NodeId;
    private readonly documentId: DocumentId;
    private readonly nodes: LSEQNode[];

    /**
     * @param nodeId       Identifier node yang memiliki instance ini.
     * @param documentId   Identifier dokumen yang direpresentasikan list ini.
     * @param initialState State awal (opsional — untuk restore dari snapshot).
     */
    constructor(
        nodeId: NodeId,
        documentId: DocumentId,
        initialState?: LSEQState,
    ) {
        this.nodeId = nodeId;
        this.documentId = documentId;
        this.nodes = initialState
            ? initialState.map(function (n) { return { ...n }; }).sort(compareNodes)
            : [];
    }

    /**
     * Hitung payload untuk operasi insert.
     * Menghasilkan posisi fraksional acak di antara elemen pada index-1 dan index.
     * TIDAK mengubah state.
     *
     * @param value Nilai yang akan disisipkan.
     * @param index Posisi dalam visible list. 0 = sebelum semua elemen.
     * @returns LSEQInsertPayload berisi pos, value, creatorId.
     */
    prepareInsert(value: string, index: number): LSEQInsertPayload {
        const visible = this.nodes.filter(function (n) { return !n.deleted; });
        const lo = index > 0 ? (visible[index - 1]?.pos ?? 0) : 0;
        const hi = index < visible.length ? (visible[index]?.pos ?? 1) : 1;
        const gap = hi - lo;
        const pos = gap > Number.EPSILON
            ? lo + Math.random() * gap
            : lo + Number.EPSILON;
        return { pos, value, creatorId: this.nodeId };
    }

    /**
     * Hitung payload untuk operasi delete.
     * Mengidentifikasi node berdasarkan posisi dalam visible list.
     * TIDAK mengubah state.
     *
     * @param index Indeks dalam visible list.
     * @returns LSEQDeletePayload atau null jika index tidak valid.
     */
    prepareDelete(index: number): LSEQDeletePayload | null {
        const visible = this.nodes.filter(function (n) { return !n.deleted; });
        if (index < 0 || index >= visible.length) return null;
        const node = visible[index]!;
        return { pos: node.pos, creatorId: node.creatorId };
    }

    /**
     * Terapkan operasi INSERT atau DELETE ke state LSEQ.
     * Idempoten untuk kedua tipe operasi.
     *
     * @param operation Operasi yang akan diterapkan.
     * @throws Error jika crdtType atau type operasi tidak valid.
     */
    apply(operation: Operation): void {
        if (
            operation.crdtType !== CRDTType.LSEQ_LIST &&
            operation.crdtType !== CRDTType.LSEQ_TEXT
        ) {
            throw new Error(
                `LSEQList.apply: crdtType tidak valid: ${operation.crdtType}`,
            );
        }

        if (operation.type === OperationType.INSERT) {
            const payload = operation.payload as LSEQInsertPayload;
            // Idempotent check: skip jika (pos, creatorId) sudah ada
            const exists = this.nodes.some(function (n) {
                return n.pos === payload.pos && n.creatorId === payload.creatorId;
            });
            if (!exists) {
                this.nodes.push({
                    pos: payload.pos,
                    value: payload.value,
                    deleted: false,
                    creatorId: payload.creatorId,
                });
                this.nodes.sort(compareNodes);
            }

        } else if (operation.type === OperationType.DELETE) {
            const payload = operation.payload as LSEQDeletePayload;
            const target = this.nodes.find(function (n) {
                return n.pos === payload.pos && n.creatorId === payload.creatorId;
            });
            if (target) {
                target.deleted = true; // tombstone — idempoten (set true berkali-kali = sama)
            }
            // Jika node belum ada: untuk prototipe, diabaikan.
            // Asumsi: INSERT selalu tiba sebelum DELETE untuk elemen yang sama.

        } else {
            throw new Error(
                `LSEQList hanya mendukung INSERT dan DELETE, bukan ${operation.type}`,
            );
        }
    }

    /**
     * Kembalikan nilai semua elemen yang hidup, dalam urutan pos.
     */
    toArray(): string[] {
        return this.nodes
            .filter(function (n) { return !n.deleted; })
            .map(function (n) { return n.value; });
    }

    /**
     * Gabungkan semua karakter menjadi string.
     * Digunakan untuk CRDTType.LSEQ_TEXT.
     */
    toText(): string {
        return this.toArray().join('');
    }

    /** Jumlah elemen yang hidup (tidak di-tombstone). */
    length(): number {
        return this.nodes.filter(function (n) { return !n.deleted; }).length;
    }

    /**
     * Ambil snapshot state saat ini (deep copy, termasuk tombstones).
     * Tombstones HARUS disertakan agar restore benar.
     */
    getState(): LSEQState {
        return this.nodes.map(function (n) { return { ...n }; });
    }

    /** Identifier dokumen yang dikelola list ini. */
    getDocumentId(): DocumentId { return this.documentId; }

    /** NodeId node yang memiliki instance ini. */
    getNodeId(): NodeId { return this.nodeId; }
}
