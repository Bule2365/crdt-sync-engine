import type { NodeId, DocumentId, Operation } from '../../types';
import { CRDTType, OperationType } from '../../types';

/**
 * State LWW-Register: nilai aktif beserta metadata penulis.
 */
export interface LWWRegisterState {
    /** Nilai yang disimpan. Tipe bebas (string, number, boolean, object, null). */
    value: unknown;
    /**
     * Lamport timestamp saat nilai ini ditulis.
     * Diambil dari Operation.timestamp, bukan dari wall clock.
     */
    timestamp: number;
    /** NodeId node yang menulis nilai ini. Digunakan sebagai tiebreaker. */
    nodeId: NodeId;
}

/**
 * Payload operasi UPDATE pada LWW-Register.
 * Hanya berisi value. Timestamp dan nodeId ada di Operation itu sendiri.
 */
export interface LWWRegisterPayload {
    value: unknown;
}

/** State awal: nilai null, timestamp 0, nodeId kosong (selalu kalah). */
const INITIAL_STATE: LWWRegisterState = {
    value: null,
    timestamp: 0,
    nodeId: '',
};

/**
 * LWW-Register CRDT — Last-Write-Wins Register.
 *
 * Menyimpan satu nilai tunggal yang dapat diperbarui.
 * Konflik diselesaikan: nilai dengan Lamport timestamp tertinggi menang.
 * Jika timestamp sama: nodeId leksikografis lebih besar menang (deterministik).
 *
 * Properti kunci:
 * - apply() idempoten: operasi yang sama berkali-kali = hasil sama.
 * - apply() komutatif: urutan penerimaan tidak mempengaruhi hasil akhir.
 *
 * Alur penggunaan (oleh CRDT Core Engine, Langkah 8):
 * 1. prepareUpdate(value) → dapatkan payload { value }
 * 2. Buat Operation dengan timestamp dari VectorClock.increment()
 * 3. apply(operation) → bandingkan timestamp, update jika menang
 */
export class LWWRegister {
    private readonly nodeId: NodeId;
    private readonly documentId: DocumentId;
    private state: LWWRegisterState;

    /**
     * @param nodeId       Identifier node yang memiliki instance ini.
     * @param documentId   Identifier dokumen yang direpresentasikan register ini.
     * @param initialState State awal (opsional — untuk restore dari snapshot).
     */
    constructor(
        nodeId: NodeId,
        documentId: DocumentId,
        initialState?: LWWRegisterState,
    ) {
        this.nodeId = nodeId;
        this.documentId = documentId;
        this.state = initialState ? { ...initialState } : { ...INITIAL_STATE };
    }

    /**
     * Siapkan payload untuk operasi update.
     * TIDAK mengubah state. State diubah via apply().
     *
     * Timestamp TIDAK dimasukkan ke payload.
     * Timestamp berasal dari VectorClock.increment() di CRDT Core Engine.
     *
     * @param value Nilai baru yang akan disimpan.
     * @returns LWWRegisterPayload berisi value.
     */
    prepareUpdate(value: unknown): LWWRegisterPayload {
        return { value };
    }

    /**
     * Terapkan operasi UPDATE ke state LWW-Register.
     *
     * Aturan pemenang:
     * 1. Jika operation.timestamp > state.timestamp → incoming menang.
     * 2. Jika operation.timestamp < state.timestamp → current tetap.
     * 3. Jika sama → bandingkan nodeId leksikografis, lebih besar menang.
     *
     * Idempoten: operasi dengan nodeId dan timestamp yang sama tidak mengubah state.
     *
     * @param operation Operasi UPDATE yang akan diterapkan.
     * @throws Error jika crdtType atau type operasi tidak valid.
     */
    apply(operation: Operation): void {
        if (operation.crdtType !== CRDTType.LWW_REGISTER) {
            throw new Error(
                `LWWRegister.apply: crdtType tidak valid. ` +
                `Expected: ${CRDTType.LWW_REGISTER}, Got: ${operation.crdtType}`,
            );
        }
        if (operation.type !== OperationType.UPDATE) {
            throw new Error(
                `LWWRegister hanya mendukung OperationType.UPDATE, bukan ${operation.type}`,
            );
        }
        const payload = operation.payload as LWWRegisterPayload;
        const incoming: LWWRegisterState = {
            value: payload.value,
            timestamp: operation.vectorClock[operation.nodeId] ?? 0,
            nodeId: operation.nodeId,
        };
        if (this.wins(incoming, this.state)) {
            this.state = incoming;
        }
    }

    /**
     * Tentukan apakah incoming "mengalahkan" current.
     *
     * Aturan:
     * - Timestamp lebih tinggi → incoming menang.
     * - Timestamp lebih rendah → incoming kalah.
     * - Timestamp sama → nodeId leksikografis lebih besar menang.
     * - Timestamp dan nodeId sama (op duplikat) → false (idempoten).
     */
    private wins(
        incoming: LWWRegisterState,
        current: LWWRegisterState,
    ): boolean {
        if (incoming.timestamp > current.timestamp) return true;
        if (incoming.timestamp < current.timestamp) return false;
        return incoming.nodeId > current.nodeId;
    }

    /** Nilai aktif saat ini. */
    getValue(): unknown {
        return this.state.value;
    }

    /** Lamport timestamp nilai aktif saat ini. */
    getTimestamp(): number {
        return this.state.timestamp;
    }

    /** NodeId node yang menulis nilai aktif saat ini. */
    getWriterNodeId(): NodeId {
        return this.state.nodeId;
    }

    /**
     * Ambil snapshot state saat ini (salinan baru).
     * Digunakan oleh Snapshot Manager (Langkah 10).
     */
    getState(): LWWRegisterState {
        return { ...this.state };
    }

    /** Identifier dokumen yang dikelola register ini. */
    getDocumentId(): DocumentId { return this.documentId; }

    /** NodeId node yang memiliki instance ini. */
    getNodeId(): NodeId { return this.nodeId; }
}
