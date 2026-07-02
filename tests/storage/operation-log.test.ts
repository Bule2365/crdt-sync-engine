import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OperationLog } from '../../src/storage';
import { CRDTType, OperationType } from '../../src/types';
import type { Operation } from '../../src/types';

/** Helper: buat Operation mock sederhana. */
function makeOp(nodeId: string, timestamp: number): Operation {
    return {
        operationId: `op-${nodeId}-${timestamp}`,
        documentId: 'doc-001',
        nodeId,
        type: OperationType.INCREMENT,
        crdtType: CRDTType.G_COUNTER,
        timestamp,
        vectorClock: { [nodeId]: timestamp },
        payload: { newTotal: timestamp },
        createdAt: Date.now(),
    };
}

describe('OperationLog', () => {
    let log: OperationLog;
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crdt-log-test-'));
        log = new OperationLog(tmpDir);
        await log.open();
    });

    afterEach(async () => {
        await log.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should start with lastSeqNum -1 when empty', async () => {
        expect(await log.getLastSequenceNumber()).toBe(-1);
        expect(await log.getAll()).toEqual([]);
    });

    it('append returns LogEntry with correct sequenceNumber', async () => {
        const op = makeOp('node-A', 1);
        const entry = await log.append(op);
        expect(entry.sequenceNumber).toBe(0);
        expect(entry.operation.operationId).toBe(op.operationId);
        expect(entry.writtenAt).toBeGreaterThan(0);
    });

    it('sequenceNumber increments monotonically for each append', async () => {
        const e0 = await log.append(makeOp('node-A', 1));
        const e1 = await log.append(makeOp('node-A', 2));
        const e2 = await log.append(makeOp('node-A', 3));
        expect(e0.sequenceNumber).toBe(0);
        expect(e1.sequenceNumber).toBe(1);
        expect(e2.sequenceNumber).toBe(2);
        expect(await log.getLastSequenceNumber()).toBe(2);
    });

    it('getAll returns all entries in ascending order', async () => {
        await log.append(makeOp('node-A', 1));
        await log.append(makeOp('node-A', 2));
        const all = await log.getAll();
        expect(all).toHaveLength(2);
        expect(all[0]!.sequenceNumber).toBe(0);
        expect(all[1]!.sequenceNumber).toBe(1);
    });

    it('getAfter returns only entries after given seqNum', async () => {
        await log.append(makeOp('node-A', 1)); // seq 0
        await log.append(makeOp('node-A', 2)); // seq 1
        await log.append(makeOp('node-A', 3)); // seq 2
        const after = await log.getAfter(0);
        expect(after).toHaveLength(2);
        expect(after[0]!.sequenceNumber).toBe(1);
        expect(after[1]!.sequenceNumber).toBe(2);
    });

    it('getAfter returns empty array if no entries exist after seqNum', async () => {
        await log.append(makeOp('node-A', 1)); // seq 0
        const after = await log.getAfter(0);
        expect(after).toHaveLength(0);
    });

    it('persists data across close and reopen', async () => {
        await log.append(makeOp('node-A', 1));
        await log.append(makeOp('node-A', 2));
        await log.close();

        const log2 = new OperationLog(tmpDir);
        await log2.open();
        const all = await log2.getAll();
        expect(all).toHaveLength(2);
        expect(await log2.getLastSequenceNumber()).toBe(1);
        await log2.close();
    });

    it('getLastSequenceNumber updates after each append', async () => {
        expect(await log.getLastSequenceNumber()).toBe(-1);
        await log.append(makeOp('node-A', 1));
        expect(await log.getLastSequenceNumber()).toBe(0);
        await log.append(makeOp('node-A', 2));
        expect(await log.getLastSequenceNumber()).toBe(1);
    });

    it('throws if append called before open', async () => {
        const closedLog = new OperationLog(tmpDir + '-never-opened');
        await expect(closedLog.append(makeOp('node-A', 1))).rejects.toThrow();
    });

    it('getAfter(-1) returns all entries same as getAll', async () => {
        await log.append(makeOp('node-A', 1));
        await log.append(makeOp('node-A', 2));
        const all = await log.getAll();
        const afterMinus1 = await log.getAfter(-1);
        expect(afterMinus1).toHaveLength(all.length);
    });
});
