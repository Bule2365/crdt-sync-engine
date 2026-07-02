import type { NodeId, DocumentId, Operation } from '../../types';
import { CRDTType, OperationType } from '../../types';

/** State G-Counter: satu counter per node, disimpan sebagai plain object. */
export type GCounterState = Record<string, number>;

/**
 * Payload operasi INCREMENT pada G-Counter.
 * Menyimpan nilai total baru (bukan delta) agar apply() bersifat idempoten.
 */
export interface GCounterPayload {
    /**
     * Nilai total counter node ini SETELAH operasi ini diterapkan.
     * Contoh: jika sebelumnya counter = 3 dan increment 2, newTotal = 5.
     */
    newTotal: number;
}

/**
 * G-Counter CRDT — Grow-only Counter.
 *
 * Properti kunci:
 * - Hanya mendukung INCREMENT. Tidak ada decrement.
 * - Setiap node memiliki counter sendiri dalam state.
 * - value() = SUM semua counter.
 * - merge() dan apply() menggunakan MAX per counter (bukan SUM).
 * - apply() idempoten: memanggil dengan operasi yang sama berkali-kali = hasil sama.
 *
 * Alur penggunaan (oleh CRDT Core Engine, Langkah 8):
 * 1. prepareIncrement(amount) → dapatkan payload
 * 2. Buat Operation lengkap dengan payload dan vectorClock
 * 3. apply(operation) → perbarui state
 * 4. Simpan operation ke Operation Log
 */
export class GCounter {
    private readonly nodeId: NodeId;
    private readonly documentId: DocumentId;
    private readonly state: GCounterState;

    /**
     * @param nodeId       Identifier node yang memiliki instance ini.
     * @param documentId   Identifier dokumen yang direpresentasikan counter ini.
     * @param initialState State awal (opsional — untuk restore dari snapshot).
     */
    constructor(
        nodeId: NodeId,
        documentId: DocumentId,
        initialState?: GCounterState,
    ) {
        this.nodeId = nodeId;
        this.documentId = documentId;
        this.state = { ...(initialState ?? {}) };
        if (this.state[nodeId] === undefined) {
            this.state[nodeId] = 0;
        }
    }

    /**
     * Hitung payload untuk operasi increment.
     * TIDAK mengubah state GCounter.
     * State hanya berubah saat apply() dipanggil.
     *
     * @param amount Jumlah yang ditambahkan. Harus positif. Default: 1.
     * @returns GCounterPayload berisi newTotal untuk dimasukkan ke Operation.
     * @throws Error jika amount tidak positif.
     */
    prepareIncrement(amount: number = 1): GCounterPayload {
        if (amount <= 0) {
            throw new Error(
                `G-Counter hanya mendukung increment positif. Nilai diterima: ${amount}`,
            );
        }
        const currentTotal = this.state[this.nodeId] ?? 0;
        return { newTotal: currentTotal + amount };
    }

    /**
     * Terapkan operasi INCREMENT ke state G-Counter.
     *
     * Idempoten: memanggil dengan operasi yang sama berkali-kali
     * menghasilkan state yang sama.
     * Benar untuk out-of-order delivery: MAX memastikan nilai tertinggi selalu menang.
     *
     * @param operation Operasi yang akan diterapkan.
     * @throws Error jika crdtType atau type operasi tidak valid.
     */
    apply(operation: Operation): void {
        if (operation.crdtType !== CRDTType.G_COUNTER) {
            throw new Error(
                `G-Counter.apply: crdtType tidak valid. ` +
                `Expected: ${CRDTType.G_COUNTER}, Got: ${operation.crdtType}`,
            );
        }
        if (operation.type !== OperationType.INCREMENT) {
            throw new Error(
                `G-Counter hanya mendukung OperationType.INCREMENT, ` +
                `bukan ${operation.type}`,
            );
        }
        const payload = operation.payload as GCounterPayload;
        const currentVal = this.state[operation.nodeId] ?? 0;
        this.state[operation.nodeId] = Math.max(currentVal, payload.newTotal);
    }

    /**
     * Hitung nilai total G-Counter.
     * @returns Jumlah SUM dari semua counter node.
     */
    value(): number {
        return Object.values(this.state).reduce(
            (sum: number, v: number) => sum + v,
            0,
        );
    }

    /**
     * Merge state dari node lain ke dalam state lokal.
     * Mengambil nilai MAX untuk setiap counter.
     * Digunakan saat state-based sync (bukan op-based).
     *
     * @param remoteState GCounterState yang diterima dari node lain.
     */
    merge(remoteState: GCounterState): void {
        for (const nodeId of Object.keys(remoteState)) {
            this.state[nodeId] = Math.max(
                this.state[nodeId] ?? 0,
                remoteState[nodeId] ?? 0,
            );
        }
    }

    /**
     * Ambil snapshot state saat ini.
     * Mengembalikan salinan baru — bukan referensi ke object internal.
     * Digunakan oleh Snapshot Manager (Langkah 10).
     */
    getState(): GCounterState {
        return { ...this.state };
    }

    /** Counter lokal node ini saja (tidak termasuk node lain). */
    getLocalCount(): number {
        return this.state[this.nodeId] ?? 0;
    }

    /** Identifier dokumen yang dikelola counter ini. */
    getDocumentId(): DocumentId {
        return this.documentId;
    }

    /** NodeId node yang memiliki instance ini. */
    getNodeId(): NodeId {
        return this.nodeId;
    }
}
