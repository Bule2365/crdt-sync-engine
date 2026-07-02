import { GCounter } from '../../../src/crdt/gcounter';
import type { GCounterPayload } from '../../../src/crdt/gcounter';
import { CRDTType, OperationType } from '../../../src/types';
import type { Operation } from '../../../src/types';

/** Helper: buat Operation mock untuk keperluan test. */
function makeOp(nodeId: string, newTotal: number): Operation {
    const payload: GCounterPayload = { newTotal };
    return {
        operationId: `op-${nodeId}-${newTotal}`,
        documentId: 'doc-001',
        nodeId,
        type: OperationType.INCREMENT,
        crdtType: CRDTType.G_COUNTER,
        timestamp: newTotal,
        vectorClock: { [nodeId]: newTotal },
        payload,
        createdAt: Date.now(),
    };
}

describe('GCounter — prepareIncrement', () => {
    it('should calculate newTotal without changing state', () => {
        const gc = new GCounter('node-A', 'doc-001');
        const payload = gc.prepareIncrement(3);
        expect(payload.newTotal).toBe(3);
        expect(gc.value()).toBe(0);
        expect(gc.getLocalCount()).toBe(0);
    });

    it('should use default amount 1', () => {
        const gc = new GCounter('node-A', 'doc-001');
        expect(gc.prepareIncrement().newTotal).toBe(1);
    });

    it('should accumulate from current local count', () => {
        const gc = new GCounter('node-A', 'doc-001', { 'node-A': 5 });
        expect(gc.prepareIncrement(3).newTotal).toBe(8);
    });

    it('should throw on non-positive amount', () => {
        const gc = new GCounter('node-A', 'doc-001');
        expect(() => gc.prepareIncrement(0)).toThrow();
        expect(() => gc.prepareIncrement(-1)).toThrow();
    });
});

describe('GCounter — apply', () => {
    it('should update state for the operating node', () => {
        const gc = new GCounter('node-A', 'doc-001');
        gc.apply(makeOp('node-A', 3));
        expect(gc.getLocalCount()).toBe(3);
        expect(gc.value()).toBe(3);
    });

    it('should be idempotent — applying same op twice yields same result', () => {
        const gc = new GCounter('node-A', 'doc-001');
        const op = makeOp('node-A', 5);
        gc.apply(op);
        gc.apply(op);
        expect(gc.value()).toBe(5);
    });

    it('should handle out-of-order delivery correctly', () => {
        const gc = new GCounter('node-A', 'doc-001');
        gc.apply(makeOp('node-B', 5)); // op2 arrives first
        gc.apply(makeOp('node-B', 2)); // op1 arrives late
        expect(gc.value()).toBe(5);    // MAX(5,2) = 5, correct
    });

    it('should accept operations from other nodes without touching local count', () => {
        const gc = new GCounter('node-A', 'doc-001');
        gc.apply(makeOp('node-B', 7));
        expect(gc.value()).toBe(7);
        expect(gc.getLocalCount()).toBe(0);
    });

    it('should throw on wrong crdtType', () => {
        const gc = new GCounter('node-A', 'doc-001');
        const badOp = { ...makeOp('node-A', 1), crdtType: 'or-set' as CRDTType };
        expect(() => gc.apply(badOp)).toThrow();
    });
});

describe('GCounter — value and merge', () => {
    it('should return sum of all node counters', () => {
        const gc = new GCounter('node-A', 'doc-001', {
            'node-A': 3, 'node-B': 5, 'node-C': 2
        });
        expect(gc.value()).toBe(10);
    });

    it('should merge by taking MAX per node, not SUM', () => {
        const gc = new GCounter('node-A', 'doc-001', { 'node-A': 3, 'node-B': 1 });
        gc.merge({ 'node-A': 2, 'node-B': 6, 'node-C': 4 });
        expect(gc.value()).toBe(3 + 6 + 4); // max(3,2)+max(1,6)+max(0,4)
    });

    it('should converge: both nodes reach same value after sync', () => {
        const gcA = new GCounter('node-A', 'doc-001');
        const gcB = new GCounter('node-B', 'doc-001');
        const opA1 = makeOp('node-A', 1);
        const opA2 = makeOp('node-A', 3);
        const opB1 = makeOp('node-B', 2);
        [opA1, opA2, opB1].forEach(op => gcA.apply(op));
        [opB1, opA2, opA1].forEach(op => gcB.apply(op)); // different order
        expect(gcA.value()).toBe(gcB.value());
    });

    it('should not double-count when merging concurrent states', () => {
        const gcA = new GCounter('node-A', 'doc-001', { 'node-A': 3, 'node-B': 1 });
        const gcB = new GCounter('node-B', 'doc-001', { 'node-A': 2, 'node-B': 4 });
        gcA.merge(gcB.getState());
        gcB.merge(gcA.getState());
        expect(gcA.value()).toBe(gcB.value()); // 3 + 4 = 7
        expect(gcA.value()).toBe(7);
    });
});
