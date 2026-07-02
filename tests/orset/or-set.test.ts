import { ORSet } from '../../src/crdt/orset';
import type { ORSetAddPayload, ORSetRemovePayload } from '../../src/crdt/orset';
import { CRDTType, OperationType } from '../../src/types';
import type { Operation } from '../../src/types';

/** Helper: buat Operation INSERT mock. */
function makeInsertOp(nodeId: string, payload: ORSetAddPayload): Operation {
    return {
        operationId: `ins-${payload.tag}`,
        documentId: 'doc-001',
        nodeId,
        type: OperationType.INSERT,
        crdtType: CRDTType.OR_SET,
        timestamp: 1,
        vectorClock: {},
        payload,
        createdAt: Date.now(),
    };
}

/** Helper: buat Operation DELETE mock. */
function makeDeleteOp(nodeId: string, payload: ORSetRemovePayload): Operation {
    return {
        operationId: `del-${nodeId}-${Date.now()}`,
        documentId: 'doc-001',
        nodeId,
        type: OperationType.DELETE,
        crdtType: CRDTType.OR_SET,
        timestamp: 2,
        vectorClock: {},
        payload,
        createdAt: Date.now(),
    };
}

describe('ORSet — add', () => {
    it('should add element to set', () => {
        const s = new ORSet('node-A', 'doc-001');
        s.apply(makeInsertOp('node-A', { element: 'apple', tag: 't1' }));
        expect(s.has('apple')).toBe(true);
        expect(s.values()).toContain('apple');
    });

    it('should be idempotent: same tag applied twice', () => {
        const s = new ORSet('node-A', 'doc-001');
        const op = makeInsertOp('node-A', { element: 'apple', tag: 't1' });
        s.apply(op);
        s.apply(op);
        expect(s.size()).toBe(1);
    });

    it('should generate unique tags via prepareAdd', () => {
        const s = new ORSet('node-A', 'doc-001');
        const p1 = s.prepareAdd('apple');
        const p2 = s.prepareAdd('apple');
        expect(p1.tag).not.toBe(p2.tag);
        expect(s.size()).toBe(0); // state belum berubah
    });
});

describe('ORSet — remove', () => {
    it('should remove element from set', () => {
        const s = new ORSet('node-A', 'doc-001');
        s.apply(makeInsertOp('node-A', { element: 'apple', tag: 't1' }));
        const payload = s.prepareRemove('apple')!;
        s.apply(makeDeleteOp('node-A', payload));
        expect(s.has('apple')).toBe(false);
    });

    it('should return null for non-existent element', () => {
        const s = new ORSet('node-A', 'doc-001');
        expect(s.prepareRemove('ghost')).toBeNull();
    });

    it('should be idempotent: same delete op applied twice', () => {
        const s = new ORSet('node-A', 'doc-001');
        s.apply(makeInsertOp('node-A', { element: 'apple', tag: 't1' }));
        const payload = s.prepareRemove('apple')!;
        const delOp = makeDeleteOp('node-A', payload);
        s.apply(delOp);
        s.apply(delOp); // apply twice
        expect(s.has('apple')).toBe(false);
    });
});

describe('ORSet — add-wins', () => {
    it('concurrent add and remove: add wins', () => {
        const sA = new ORSet('node-A', 'doc-001');
        const sB = new ORSet('node-B', 'doc-001');
        // Both start with apple (tag t1)
        const addT1 = makeInsertOp('node-A', { element: 'apple', tag: 't1' });
        sA.apply(addT1);
        sB.apply(addT1);
        // Node A removes apple (observing t1)
        const removePayload = sA.prepareRemove('apple')!;
        const removeOp = makeDeleteOp('node-A', removePayload);
        sA.apply(removeOp);
        // Node B concurrently adds apple with new tag t2
        const addT2 = makeInsertOp('node-B', { element: 'apple', tag: 't2' });
        sB.apply(addT2);
        // Sync: cross-apply
        sA.apply(addT2);
        sB.apply(removeOp);
        // Add wins: apple still present in both nodes
        expect(sA.has('apple')).toBe(true);
        expect(sB.has('apple')).toBe(true);
    });

    it('remove only affects observed tags, not concurrent add', () => {
        const s = new ORSet('node-A', 'doc-001');
        s.apply(makeInsertOp('node-A', { element: 'x', tag: 't1' }));
        const removePayload = s.prepareRemove('x')!;
        // New add with different tag (concurrent)
        s.apply(makeInsertOp('node-B', { element: 'x', tag: 't2' }));
        // Now remove (only targets t1)
        s.apply(makeDeleteOp('node-A', removePayload));
        expect(s.has('x')).toBe(true); // t2 still alive
    });
});

describe('ORSet — values and has', () => {
    it('values returns all live elements without duplicates', () => {
        const s = new ORSet('node-A', 'doc-001');
        s.apply(makeInsertOp('node-A', { element: 'a', tag: 't1' }));
        s.apply(makeInsertOp('node-B', { element: 'a', tag: 't2' })); // same element, different tag
        s.apply(makeInsertOp('node-A', { element: 'b', tag: 't3' }));
        const vals = s.values();
        expect(vals.length).toBe(2);
        expect(vals).toContain('a');
        expect(vals).toContain('b');
    });

    it('has returns false after element is fully removed', () => {
        const s = new ORSet('node-A', 'doc-001');
        s.apply(makeInsertOp('node-A', { element: 'apple', tag: 't1' }));
        s.apply(makeDeleteOp('node-A', { element: 'apple', observedTags: ['t1'] }));
        expect(s.has('apple')).toBe(false);
    });
});

describe('ORSet — convergence', () => {
    it('two nodes converge to same state after sync', () => {
        const sA = new ORSet('node-A', 'doc-001');
        const sB = new ORSet('node-B', 'doc-001');
        const op1 = makeInsertOp('node-A', { element: 'apple', tag: 'tag-a1' });
        const op2 = makeInsertOp('node-B', { element: 'banana', tag: 'tag-b1' });
        const op3 = makeDeleteOp('node-A', { element: 'apple', observedTags: ['tag-a1'] });
        // Node A: add apple, then remove apple
        [op1, op3].forEach(function (o) { sA.apply(o); });
        // Node B: add banana, receive all ops from A
        [op2, op1, op3].forEach(function (o) { sB.apply(o); });
        // Sync: A receives B's ops
        sA.apply(op2);
        // Both should agree: only banana remains
        expect(sA.values().sort()).toEqual(sB.values().sort());
        expect(sA.has('apple')).toBe(false);
        expect(sA.has('banana')).toBe(true);
    });
});
