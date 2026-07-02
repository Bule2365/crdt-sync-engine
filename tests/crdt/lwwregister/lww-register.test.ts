import { LWWRegister } from '../../../src/crdt/lwwregister';
import type { LWWRegisterPayload } from '../../../src/crdt/lwwregister';
import { CRDTType, OperationType } from '../../../src/types';
import type { Operation } from '../../../src/types';

/** Helper: buat Operation UPDATE mock. */
function makeUpdateOp(
    nodeId: string,
    value: unknown,
    timestamp: number,
): Operation {
    const payload: LWWRegisterPayload = { value };
    return {
        operationId: `upd-${nodeId}-${timestamp}`,
        documentId: 'doc-001',
        nodeId,
        type: OperationType.UPDATE,
        crdtType: CRDTType.LWW_REGISTER,
        timestamp,
        vectorClock: { [nodeId]: timestamp },
        payload,
        createdAt: Date.now(),
    };
}

describe('LWWRegister — initialization', () => {
    it('should initialize with null value and timestamp 0', () => {
        const r = new LWWRegister('node-A', 'doc-001');
        expect(r.getValue()).toBeNull();
        expect(r.getTimestamp()).toBe(0);
        expect(r.getWriterNodeId()).toBe('');
    });
});

describe('LWWRegister — apply', () => {
    it('should update value when op has higher timestamp', () => {
        const r = new LWWRegister('node-A', 'doc-001');
        r.apply(makeUpdateOp('node-A', 'hello', 3));
        expect(r.getValue()).toBe('hello');
        expect(r.getTimestamp()).toBe(3);
    });

    it('should keep current value when op has lower timestamp', () => {
        const r = new LWWRegister('node-A', 'doc-001');
        r.apply(makeUpdateOp('node-A', 'newer', 5));
        r.apply(makeUpdateOp('node-B', 'older', 3));
        expect(r.getValue()).toBe('newer');
        expect(r.getTimestamp()).toBe(5);
    });

    it('should use nodeId as tiebreaker when timestamps are equal', () => {
        const r = new LWWRegister('node-A', 'doc-001');
        r.apply(makeUpdateOp('node-A', 'from-A', 5));
        r.apply(makeUpdateOp('node-Z', 'from-Z', 5)); // same ts, Z > A
        expect(r.getValue()).toBe('from-Z');
        expect(r.getWriterNodeId()).toBe('node-Z');
    });

    it('should not update when incoming nodeId is lower (same timestamp)', () => {
        const r = new LWWRegister('node-A', 'doc-001');
        r.apply(makeUpdateOp('node-Z', 'from-Z', 5));
        r.apply(makeUpdateOp('node-A', 'from-A', 5)); // same ts, A < Z
        expect(r.getValue()).toBe('from-Z'); // Z still wins
    });

    it('should be idempotent: applying same op twice', () => {
        const r = new LWWRegister('node-A', 'doc-001');
        const op = makeUpdateOp('node-A', 'hello', 3);
        r.apply(op);
        r.apply(op);
        expect(r.getValue()).toBe('hello');
        expect(r.getTimestamp()).toBe(3);
    });

    it('should throw on wrong crdtType', () => {
        const r = new LWWRegister('node-A', 'doc-001');
        const bad = { ...makeUpdateOp('node-A', 'x', 1), crdtType: 'g-counter' as CRDTType };
        expect(() => r.apply(bad)).toThrow();
    });
});

describe('LWWRegister — prepareUpdate', () => {
    it('should return payload without changing state', () => {
        const r = new LWWRegister('node-A', 'doc-001');
        const payload = r.prepareUpdate('new-value');
        expect(payload.value).toBe('new-value');
        expect(r.getValue()).toBeNull();
    });
});

describe('LWWRegister — convergence', () => {
    it('two nodes converge to same value after concurrent updates', () => {
        const rA = new LWWRegister('node-A', 'doc-001');
        const rB = new LWWRegister('node-B', 'doc-001');
        const opA = makeUpdateOp('node-A', 'value-A', 3);
        const opB = makeUpdateOp('node-B', 'value-B', 5);
        rA.apply(opA); rA.apply(opB);
        rB.apply(opB); rB.apply(opA); // different order
        expect(rA.getValue()).toBe(rB.getValue());
        expect(rA.getValue()).toBe('value-B');
    });

    it('nodeId tiebreaker is deterministic regardless of arrival order', () => {
        const rA = new LWWRegister('node-A', 'doc-001');
        const rB = new LWWRegister('node-B', 'doc-001');
        const opA = makeUpdateOp('node-A', 'value-A', 5);
        const opZ = makeUpdateOp('node-Z', 'value-Z', 5);
        rA.apply(opA); rA.apply(opZ);
        rB.apply(opZ); rB.apply(opA);
        expect(rA.getValue()).toBe(rB.getValue());
        expect(rA.getValue()).toBe('value-Z');
    });
});
