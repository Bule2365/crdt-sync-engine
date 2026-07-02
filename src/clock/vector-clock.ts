import type { NodeId, VectorClockRecord } from '../types';

/**
 * Hasil perbandingan dua Vector Clock.
 * Menggambarkan hubungan kausalitas antara dua operasi.
 */
export enum ClockComparison {
    /** Clock A terjadi sebelum Clock B. (∀i: a[i]≤b[i] dan ∃i: a[i]<b[i]) **/
    BEFORE = 'before',
    /** Clock A terjadi setelah Clock B. (∀i: b[i]≤a[i] dan ∃i: b[i]<a[i]) **/
    AFTER = 'after',
    /** Kedua clock identik. (∀i: a[i]=b[i]) **/
    EQUAL = 'equal',
    /** Tidak ada hubungan kausalitas — operasi terjadi bersamaan. **/
    CONCURRENT = 'concurrent',
}

/**
 * Vector Clock Manager.
 *
 * Satu instance dimiliki oleh satu node.
 * Instance ini mengelola state logical clock node tersebut.
 *
 * Dua aturan wajib:
 * - Send Rule   : increment() LALU toRecord() SEBELUM membuat operasi.
 * - Receive Rule: merge(op.vectorClock) SEBELUM menerapkan operasi ke CRDT.
 */
export class VectorClock {
    private readonly nodeId: NodeId;
    private readonly clock: Record<string, number>;

    /**
     * @param nodeId       Identifier node yang memiliki instance ini.
     * @param initialClock State awal clock (opsional — untuk restore dari snapshot).
     */
    constructor(nodeId: NodeId, initialClock?: VectorClockRecord) {
        this.nodeId = nodeId;
        this.clock = { ...(initialClock ?? {}) };
        if (this.clock[nodeId] === undefined) {
            this.clock[nodeId] = 0;
        }
    }

    /**
     * Increment counter node ini sebesar 1.
     * WAJIB dipanggil sebelum membuat operasi baru (Send Rule).
     * @returns Nilai counter setelah increment.
     */
    increment(): number {
        this.clock[this.nodeId] = (this.clock[this.nodeId] ?? 0) + 1;
        return this.clock[this.nodeId] as number;
    }

    /**
     * Merge clock yang diterima dari node lain ke dalam clock lokal.
     * Ambil nilai MAX untuk setiap counter.
     * WAJIB dipanggil saat menerima operasi dari node lain (Receive Rule).
     * @param received VectorClockRecord dari operasi yang diterima.
     */
    merge(received: VectorClockRecord): void {
        for (const nodeId of Object.keys(received)) {
            const localVal = this.clock[nodeId] ?? 0;
            const receivedVal = received[nodeId] ?? 0;
            this.clock[nodeId] = Math.max(localVal, receivedVal);
        }
    }

    /**
     * Ambil snapshot immutable dari state clock saat ini.
     * Mengembalikan salinan baru — bukan referensi ke object internal.
     * Gunakan hasil ini untuk mengisi Operation.vectorClock.
     */
    toRecord(): VectorClockRecord {
        return { ...this.clock };
    }

    /**
     * Dapatkan counter node tertentu.
     * Mengembalikan 0 jika node belum pernah muncul di clock ini.
     */
    get(nodeId: NodeId): number {
        return this.clock[nodeId] ?? 0;
    }

    /** Dapatkan counter node yang memiliki instance ini. */
    getCurrent(): number {
        return this.clock[this.nodeId] ?? 0;
    }

    /** Dapatkan nodeId node yang memiliki instance ini. */
    getNodeId(): NodeId {
        return this.nodeId;
    }

    // ── Static Utility Methods ───────────────────────────────────────────────────────

    /**
     * Bandingkan dua VectorClockRecord dan kembalikan hubungan kausalitasnya.
     *
     * Algoritma:
     * 1. Kumpulkan semua nodeId dari kedua clock.
     * 2. Cek apakah a[i] ≤ b[i] untuk semua i (aLessOrEqualB).
     * 3. Cek apakah b[i] ≤ a[i] untuk semua i (bLessOrEqualA).
     * 4. Tentukan ClockComparison dari kombinasi keduanya.
     */
    static compare(
        a: VectorClockRecord,
        b: VectorClockRecord,
    ): ClockComparison {
        const allNodes = new Set([...Object.keys(a), ...Object.keys(b)]);
        let aLessOrEqualB = true;
        let bLessOrEqualA = true;

        for (const nodeId of allNodes) {
            const aVal = a[nodeId] ?? 0;
            const bVal = b[nodeId] ?? 0;
            if (aVal > bVal) aLessOrEqualB = false;
            if (bVal > aVal) bLessOrEqualA = false;
        }

        if (aLessOrEqualB && bLessOrEqualA) return ClockComparison.EQUAL;
        if (aLessOrEqualB) return ClockComparison.BEFORE;
        if (bLessOrEqualA) return ClockComparison.AFTER;
        return ClockComparison.CONCURRENT;
    }

    /** Periksa apakah dua clock identik. */
    static isEqual(
        a: VectorClockRecord,
        b: VectorClockRecord,
    ): boolean {
        return VectorClock.compare(a, b) === ClockComparison.EQUAL;
    }

    /** Periksa apakah dua clock concurrent (tidak ada hubungan kausalitas). */
    static isConcurrent(
        a: VectorClockRecord,
        b: VectorClockRecord,
    ): boolean {
        return VectorClock.compare(a, b) === ClockComparison.CONCURRENT;
    }

    /**
     * Gabungkan dua VectorClockRecord dengan mengambil nilai MAX per counter.
     * Pure function — tidak mengubah input a maupun b.
     * @returns VectorClockRecord baru hasil merge.
     */
    static mergeRecords(
        a: VectorClockRecord,
        b: VectorClockRecord,
    ): VectorClockRecord {
        const result: VectorClockRecord = {};
        const allNodes = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const nodeId of allNodes) {
            result[nodeId] = Math.max(a[nodeId] ?? 0, b[nodeId] ?? 0);
        }
        return result;
    }

    /** Buat VectorClockRecord kosong. */
    static empty(): VectorClockRecord {
        return {};
    }

    /** Buat VectorClockRecord awal untuk sebuah node dengan counter = 0. */
    static initial(nodeId: NodeId): VectorClockRecord {
        return { [nodeId]: 0 };
    }
}
