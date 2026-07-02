import { LSEQList } from '../../../src/crdt/lseq';
import type { LSEQInsertPayload, LSEQDeletePayload } from '../../../src/crdt/lseq';
import { CRDTType, OperationType } from '../../../src/types';
import type { Operation } from '../../../src/types';

let opCounter = 0;

function makeInsertOp(nodeId: string, payload: LSEQInsertPayload): Operation {
    return {
        operationId: `ins-${++opCounter}`,
        documentId: 'doc-001',
        nodeId,
        type: OperationType.INSERT,
        crdtType: CRDTType.LSEQ_LIST,
        timestamp: opCounter,
        vectorClock: {},
        payload,
        createdAt: Date.now(),
    };
}

function makeDeleteOp(nodeId: string, payload: LSEQDeletePayload): Operation {
    return {
        operationId: `del-${++opCounter}`,
        documentId: 'doc-001',
        nodeId,
        type: OperationType.DELETE,
        crdtType: CRDTType.LSEQ_LIST,
        timestamp: opCounter,
        vectorClock: {},
        payload,
        createdAt: Date.now(),
    };
}

describe('LSEQList — basic operations', () => {
    it('should start empty', () => {
        const list = new LSEQList('node-A', 'doc-001');
        expect(list.toArray()).toEqual([]);
        expect(list.length()).toBe(0);
    });

    it('should insert single element', () => {
        const list = new LSEQList('node-A', 'doc-001');
        const p = list.prepareInsert('hello', 0);
        list.apply(makeInsertOp('node-A', p));
        expect(list.toArray()).toEqual(['hello']);
    });

    it('should maintain sorted order after multiple inserts', () => {
        const list = new LSEQList('node-A', 'doc-001');
        const p1 = list.prepareInsert('a', 0); // insert first
        list.apply(makeInsertOp('node-A', p1));
        const p2 = list.prepareInsert('c', 1); // append
        list.apply(makeInsertOp('node-A', p2));
        const p3 = list.prepareInsert('b', 1); // insert between
        list.apply(makeInsertOp('node-A', p3));
        expect(list.toArray()).toEqual(['a', 'b', 'c']);
    });
});

describe('LSEQList — idempotency', () => {
    it('insert is idempotent: same op applied twice', () => {
        const list = new LSEQList('node-A', 'doc-001');
        const p = list.prepareInsert('x', 0);
        const op = makeInsertOp('node-A', p);
        list.apply(op);
        list.apply(op); // apply twice
        expect(list.toArray()).toEqual(['x']);
        expect(list.length()).toBe(1);
    });

    it('delete is idempotent: same op applied twice', () => {
        const list = new LSEQList('node-A', 'doc-001');
        const p = list.prepareInsert('x', 0);
        list.apply(makeInsertOp('node-A', p));
        const dp = list.prepareDelete(0)!;
        const delOp = makeDeleteOp('node-A', dp);
        list.apply(delOp);
        list.apply(delOp); // apply twice
        expect(list.toArray()).toEqual([]);
    });
});

describe('LSEQList — concurrent operations', () => {
    it('concurrent inserts from two nodes: both elements survive', () => {
        const listA = new LSEQList('node-A', 'doc-001');
        const listB = new LSEQList('node-B', 'doc-001');
        const pA = listA.prepareInsert('from-A', 0);
        const pB = listB.prepareInsert('from-B', 0);
        const opA = makeInsertOp('node-A', pA);
        const opB = makeInsertOp('node-B', pB);
        listA.apply(opA); listA.apply(opB);
        listB.apply(opB); listB.apply(opA); // different order
        expect(listA.length()).toBe(2);
        expect(listA.toArray()).toContain('from-A');
        expect(listA.toArray()).toContain('from-B');
    });

    it('convergence: two nodes reach identical state after sync', () => {
        const listA = new LSEQList('node-A', 'doc-001');
        const listB = new LSEQList('node-B', 'doc-001');
        const pA = listA.prepareInsert('A', 0);
        const pB = listB.prepareInsert('B', 0);
        const opA = makeInsertOp('node-A', pA);
        const opB = makeInsertOp('node-B', pB);
        listA.apply(opA); listA.apply(opB);
        listB.apply(opB); listB.apply(opA);
        expect(listA.toArray()).toEqual(listB.toArray());
        expect(listA.length()).toBe(2);
    });
});

describe('LSEQList — text', () => {
    it('toText joins characters in correct order', () => {
        const list = new LSEQList('node-A', 'doc-001');
        for (let i = 0; i < 5; i++) {
            const chars = ['h', 'e', 'l', 'l', 'o'];
            const p = list.prepareInsert(chars[i]!, i);
            list.apply(makeInsertOp('node-A', p));
        }
        expect(list.toText()).toBe('hello');
    });
});

describe('LSEQList — delete', () => {
    it('delete removes element from visible list', () => {
        const list = new LSEQList('node-A', 'doc-001');
        const p = list.prepareInsert('remove-me', 0);
        list.apply(makeInsertOp('node-A', p));
        const dp = list.prepareDelete(0)!;
        list.apply(makeDeleteOp('node-A', dp));
        expect(list.toArray()).toEqual([]);
        expect(list.length()).toBe(0);
    });

    it('prepareDelete returns null for out-of-bounds index', () => {
        const list = new LSEQList('node-A', 'doc-001');
        expect(list.prepareDelete(0)).toBeNull();
        expect(list.prepareDelete(-1)).toBeNull();
    });
});
