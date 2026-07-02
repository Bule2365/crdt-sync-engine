import { v4 as uuidv4 } from 'uuid';

import { VectorClock } from '../clock';

import { GCounter, type GCounterState } from '../crdt/gcounter';
import { LSEQList, type LSEQState } from '../crdt/lseq';
import { LWWRegister, type LWWRegisterState } from '../crdt/lwwregister';
import { ORSet, type ORSetState } from '../crdt/orset';

import {
    CRDTDocument,
    CRDTType,
    DocumentId,
    NodeId,
    Operation,
    OperationType,
    VectorClockRecord,
} from '../types';

/** Entry internal registry: metadata dokumen + CRDT instance. */
interface DocumentEntry {
    meta: CRDTDocument;
    crdt: GCounter | ORSet | LWWRegister | LSEQList;
}

/**
 * CRDT Core Engine — Orkestrator semua komponen CRDT.
 *
 * Tanggung jawab:
 * - Mengelola registry dokumen (DocumentId → CRDT instance + metadata).
 * - Membuat Operation yang valid via createOperation() (satu-satunya titik pembuatan).
 * - Menerapkan operasi lokal dan remote via applyOperation().
 * - Mengelola VectorClock (satu instance per Engine / per node).
 *
 * Komponen lain TIDAK boleh membuat CRDT instance atau Operation secara langsung.
 */
export class CRDTEngine {
    private readonly nodeId: NodeId;
    private readonly vectorClock: VectorClock;
    private readonly registry: Map<DocumentId, DocumentEntry>;

    /**
     * @param nodeId      Identifier node yang memiliki engine ini.
     * @param initialClock State awal VectorClock (opsional, untuk restore).
     */
    constructor(nodeId: NodeId, initialClock?: VectorClockRecord) {
        this.nodeId = nodeId;
        this.vectorClock = new VectorClock(nodeId, initialClock);
        this.registry = new Map();
    }

    // ── Document Management ───────────────────────────────────────────────────

    /**
     * Buat dokumen CRDT baru dan daftarkan ke registry.
     * @throws Error jika documentId sudah ada.
     */
    createDocument(documentId: DocumentId, type: CRDTType): CRDTDocument {
        if (this.registry.has(documentId)) {
            throw new Error(`CRDTEngine: document "${documentId}" already exists`);
        }
        let crdt: GCounter | ORSet | LWWRegister | LSEQList;
        switch (type) {
            case CRDTType.G_COUNTER:
                crdt = new GCounter(this.nodeId, documentId); break;
            case CRDTType.OR_SET:
                crdt = new ORSet(this.nodeId, documentId); break;
            case CRDTType.LWW_REGISTER:
                crdt = new LWWRegister(this.nodeId, documentId); break;
            case CRDTType.LSEQ_LIST:
            case CRDTType.LSEQ_TEXT:
                crdt = new LSEQList(this.nodeId, documentId); break;
            default:
                throw new Error(`CRDTEngine: unknown CRDTType: ${type as string}`);
        }
        const meta: CRDTDocument = {
            documentId,
            type,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            vectorClock: this.vectorClock.toRecord(),
        };
        this.registry.set(documentId, { meta, crdt });
        return { ...meta };
    }

    // ── Core: Apply Operation ────────────────────────────────────────────

    /**
     * Terapkan operasi ke CRDT yang sesuai.
     *
     * @param operation  Operasi yang akan diterapkan.
     * @param isRemote   True jika operasi berasal dari node lain.
     *                   Jika true: merge VectorClock sebelum apply (Receive Rule).
     *                   Jika false: clock sudah di-increment oleh createOperation().
     * @throws Error jika documentId tidak ditemukan di registry.
     */
    applyOperation(operation: Operation, isRemote: boolean = false): void {
        if (isRemote) {
            this.vectorClock.merge(operation.vectorClock);
        }

        // const entry = this.registry.get(operation.documentId);
        // if (!entry) {
        //     throw new Error(`CRDTEngine.applyOperation: document not found: ${operation.documentId}`);
        // }

        let entry = this.registry.get(operation.documentId);

        if (!entry && isRemote) {
            this.createDocument(
                operation.documentId,
                operation.crdtType,
            );

            entry = this.registry.get(operation.documentId);
        }

        if (!entry) {
            throw new Error(
                `CRDTEngine.applyOperation: document not found: ${operation.documentId}`
            );
        }
        entry.crdt.apply(operation);
        entry.meta.updatedAt = Date.now();
        entry.meta.vectorClock = this.vectorClock.toRecord();
    }

    // ── Core: Create Operation (Private) ───────────────────────────────

    /**
     * Buat Operation yang valid. Satu-satunya tempat Operation dibuat.
     * Send Rule: increment SEBELUM snapshot clock.
     */
    private createOperation(
        documentId: DocumentId,
        type: OperationType,
        crdtType: CRDTType,
        payload: unknown,
    ): Operation {
        const timestamp = this.vectorClock.increment();
        const clockSnapshot = this.vectorClock.toRecord();
        return {
            operationId: uuidv4(),
            documentId,
            nodeId: this.nodeId,
            type,
            crdtType,
            timestamp,
            vectorClock: clockSnapshot,
            payload,
            createdAt: Date.now(),
        };
    }

    // ── Private Helper ───────────────────────────────────────────────────────

    private getEntry(documentId: DocumentId): DocumentEntry {
        const entry = this.registry.get(documentId);
        if (!entry) throw new Error(`CRDTEngine: document not found: ${documentId}`);
        return entry;
    }

    private getTypedEntry(documentId: DocumentId, expected: CRDTType): DocumentEntry {
        const entry = this.getEntry(documentId);
        if (entry.meta.type !== expected) {
            throw new Error(
                `CRDTEngine: type mismatch for "${documentId}". ` +
                `Expected ${expected}, got ${entry.meta.type}`,
            );
        }
        return entry;
    }

    // ── G-Counter API ─────────────────────────────────────────────────────────

    incrementCounter(documentId: DocumentId, amount: number = 1): Operation {
        const entry = this.getTypedEntry(documentId, CRDTType.G_COUNTER);
        const counter = entry.crdt as GCounter;
        const payload = counter.prepareIncrement(amount);
        const op = this.createOperation(documentId, OperationType.INCREMENT, CRDTType.G_COUNTER, payload);
        this.applyOperation(op, false);
        return op;
    }

    getCounterValue(documentId: DocumentId): number {
        return (this.getTypedEntry(documentId, CRDTType.G_COUNTER).crdt as GCounter).value();
    }

    // ── OR-Set API ───────────────────────────────────────────────────────────

    addToSet(documentId: DocumentId, element: string): Operation {
        const entry = this.getTypedEntry(documentId, CRDTType.OR_SET);
        const set = entry.crdt as ORSet;
        const payload = set.prepareAdd(element);
        const op = this.createOperation(documentId, OperationType.INSERT, CRDTType.OR_SET, payload);
        this.applyOperation(op, false);
        return op;
    }

    removeFromSet(documentId: DocumentId, element: string): Operation | null {
        const entry = this.getTypedEntry(documentId, CRDTType.OR_SET);
        const set = entry.crdt as ORSet;
        const payload = set.prepareRemove(element);
        if (!payload) return null;
        const op = this.createOperation(documentId, OperationType.DELETE, CRDTType.OR_SET, payload);
        this.applyOperation(op, false);
        return op;
    }

    getSetValues(documentId: DocumentId): string[] {
        return (this.getTypedEntry(documentId, CRDTType.OR_SET).crdt as ORSet).values();
    }

    // ── LWW-Register API ──────────────────────────────────────────────────

    updateRegister(documentId: DocumentId, value: unknown): Operation {
        const entry = this.getTypedEntry(documentId, CRDTType.LWW_REGISTER);
        const register = entry.crdt as LWWRegister;
        const payload = register.prepareUpdate(value);
        const op = this.createOperation(documentId, OperationType.UPDATE, CRDTType.LWW_REGISTER, payload);
        this.applyOperation(op, false);
        return op;
    }

    getRegisterValue(documentId: DocumentId): unknown {
        return (this.getTypedEntry(documentId, CRDTType.LWW_REGISTER).crdt as LWWRegister).getValue();
    }

    // ── LSEQ API ─────────────────────────────────────────────────────────────

    insertIntoList(
        documentId: DocumentId,
        value: string,
        index: number,
    ): Operation {
        const entry = this.getEntry(documentId);
        const crdtType = entry.meta.type;
        if (crdtType !== CRDTType.LSEQ_LIST && crdtType !== CRDTType.LSEQ_TEXT) {
            throw new Error(`insertIntoList: document "${documentId}" is not LSEQ type`);
        }
        const list = entry.crdt as LSEQList;
        const payload = list.prepareInsert(value, index);
        const op = this.createOperation(documentId, OperationType.INSERT, crdtType, payload);
        this.applyOperation(op, false);
        return op;
    }

    deleteFromList(documentId: DocumentId, index: number): Operation | null {
        const entry = this.getEntry(documentId);
        const crdtType = entry.meta.type;
        if (crdtType !== CRDTType.LSEQ_LIST && crdtType !== CRDTType.LSEQ_TEXT) {
            throw new Error(`deleteFromList: document "${documentId}" is not LSEQ type`);
        }
        const list = entry.crdt as LSEQList;
        const payload = list.prepareDelete(index);
        if (!payload) return null;
        const op = this.createOperation(documentId, OperationType.DELETE, crdtType, payload);
        this.applyOperation(op, false);
        return op;
    }

    getListValues(documentId: DocumentId): string[] {
        return (this.getEntry(documentId).crdt as LSEQList).toArray();
    }

    getTextValue(documentId: DocumentId): string {
        return (this.getEntry(documentId).crdt as LSEQList).toText();
    }

    // ── General Getters ───────────────────────────────────────────────────

    /** Snapshot VectorClock saat ini. */
    getVectorClock(): VectorClockRecord {
        return this.vectorClock.toRecord();
    }

    /** Metadata dokumen, atau null jika tidak ada. */
    getDocument(documentId: DocumentId): CRDTDocument | null {
        const entry = this.registry.get(documentId);
        return entry ? { ...entry.meta } : null;
    }

    /** Semua DocumentId yang terdaftar. */
    getDocumentIds(): DocumentId[] {
        return Array.from(this.registry.keys());
    }

    /** Apakah dokumen dengan id ini ada di registry. */
    hasDocument(documentId: DocumentId): boolean {
        return this.registry.has(documentId);
    }

    /** NodeId node yang memiliki engine ini. */
    getNodeId(): NodeId {
        return this.nodeId;
    }

    // ── Snapshot Support (Langkah 10) ────────────────────────────────────

    /** State mentah G-Counter (untuk Snapshot Manager). */
    getCounterState(documentId: DocumentId): GCounterState {
        return (this.getTypedEntry(documentId, CRDTType.G_COUNTER).crdt as GCounter).getState();
    }

    /** State mentah OR-Set, termasuk tombstones (untuk Snapshot Manager). */
    getSetState(documentId: DocumentId): ORSetState {
        return (this.getTypedEntry(documentId, CRDTType.OR_SET).crdt as ORSet).getState();
    }

    /** State mentah LWW-Register (untuk Snapshot Manager). */
    getRegisterState(documentId: DocumentId): LWWRegisterState {
        return (this.getTypedEntry(documentId, CRDTType.LWW_REGISTER).crdt as LWWRegister).getState();
    }

    /** State mentah LSEQ, termasuk tombstones (untuk Snapshot Manager). */
    getListState(documentId: DocumentId): LSEQState {
        return (this.getEntry(documentId).crdt as LSEQList).getState();
    }

    /**
     * Buat dokumen langsung dari state tersimpan (restore dari snapshot).
     * Berbeda dari createDocument(): tidak membuat instance kosong,
     * melainkan langsung menginisialisasi dengan state yang diberikan.
     */
    restoreDocument(
        documentId: DocumentId,
        type: CRDTType,
        state: unknown,
    ): void {
        if (this.registry.has(documentId)) {
            throw new Error(`CRDTEngine.restoreDocument: "${documentId}" already exists`);
        }
        let crdt: GCounter | ORSet | LWWRegister | LSEQList;
        switch (type) {
            case CRDTType.G_COUNTER:
                crdt = new GCounter(this.nodeId, documentId, state as GCounterState); break;
            case CRDTType.OR_SET:
                crdt = new ORSet(this.nodeId, documentId, state as ORSetState); break;
            case CRDTType.LWW_REGISTER:
                crdt = new LWWRegister(this.nodeId, documentId, state as LWWRegisterState); break;
            case CRDTType.LSEQ_LIST:
            case CRDTType.LSEQ_TEXT:
                crdt = new LSEQList(this.nodeId, documentId, state as LSEQState); break;
            default:
                throw new Error(`restoreDocument: unknown CRDTType: ${type as string}`);
        }
        const meta: CRDTDocument = {
            documentId,
            type,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            vectorClock: this.vectorClock.toRecord(),
        };
        this.registry.set(documentId, { meta, crdt });
    }

}
