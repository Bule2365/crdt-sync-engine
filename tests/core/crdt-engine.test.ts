import { CRDTEngine } from '../../src/core';
import { CRDTType, OperationType } from '../../src/types';

describe('CRDTEngine — createDocument', () => {
    it('should create G-Counter document', () => {
        const engine = new CRDTEngine('node-A');
        const doc = engine.createDocument('c1', CRDTType.G_COUNTER);
        expect(doc.documentId).toBe('c1');
        expect(doc.type).toBe(CRDTType.G_COUNTER);
        expect(engine.hasDocument('c1')).toBe(true);
        expect(engine.getDocumentIds()).toContain('c1');
    });

    it('should throw when creating duplicate document', () => {
        const engine = new CRDTEngine('node-A');
        engine.createDocument('doc-1', CRDTType.G_COUNTER);
        expect(() => engine.createDocument('doc-1', CRDTType.G_COUNTER)).toThrow();
    });
});

describe('CRDTEngine — G-Counter', () => {
    it('incrementCounter returns valid operation and updates value', () => {
        const engine = new CRDTEngine('node-A');
        engine.createDocument('c1', CRDTType.G_COUNTER);
        const op = engine.incrementCounter('c1', 3);
        expect(op.crdtType).toBe(CRDTType.G_COUNTER);
        expect(op.type).toBe(OperationType.INCREMENT);
        expect(op.nodeId).toBe('node-A');
        expect(op.operationId).toBeTruthy();
        expect(engine.getCounterValue('c1')).toBe(3);
    });
});

describe('CRDTEngine — OR-Set', () => {
    it('addToSet and removeFromSet work correctly', () => {
        const engine = new CRDTEngine('node-A');
        engine.createDocument('s1', CRDTType.OR_SET);
        engine.addToSet('s1', 'apple');
        expect(engine.getSetValues('s1')).toContain('apple');
        engine.removeFromSet('s1', 'apple');
        expect(engine.getSetValues('s1')).not.toContain('apple');
    });

    it('removeFromSet returns null for non-existent element', () => {
        const engine = new CRDTEngine('node-A');
        engine.createDocument('s1', CRDTType.OR_SET);
        expect(engine.removeFromSet('s1', 'ghost')).toBeNull();
    });
});

describe('CRDTEngine — LWW-Register', () => {
    it('updateRegister stores and returns new value', () => {
        const engine = new CRDTEngine('node-A');
        engine.createDocument('r1', CRDTType.LWW_REGISTER);
        const op = engine.updateRegister('r1', 'published');
        expect(op.type).toBe(OperationType.UPDATE);
        expect(engine.getRegisterValue('r1')).toBe('published');
    });
});

describe('CRDTEngine — LSEQ', () => {
    it('insertIntoList adds element and is retrievable', () => {
        const engine = new CRDTEngine('node-A');
        engine.createDocument('l1', CRDTType.LSEQ_LIST);
        engine.insertIntoList('l1', 'item-A', 0);
        expect(engine.getListValues('l1')).toContain('item-A');
    });
});

describe('CRDTEngine — applyOperation (remote)', () => {
    it('applies remote op and merges vector clock', () => {
        const engA = new CRDTEngine('node-A');
        const engB = new CRDTEngine('node-B');
        engA.createDocument('c1', CRDTType.G_COUNTER);
        engB.createDocument('c1', CRDTType.G_COUNTER);
        const op = engA.incrementCounter('c1', 5);
        engB.applyOperation(op, true);
        expect(engB.getCounterValue('c1')).toBe(5);
        expect(engB.getVectorClock()['node-A']).toBe(op.timestamp);
    });

    it('vectorClock increments after each local operation', () => {
        const engine = new CRDTEngine('node-A');
        engine.createDocument('c1', CRDTType.G_COUNTER);
        expect(engine.getVectorClock()['node-A']).toBe(0);
        engine.incrementCounter('c1', 1);
        expect(engine.getVectorClock()['node-A']).toBe(1);
        engine.incrementCounter('c1', 1);
        expect(engine.getVectorClock()['node-A']).toBe(2);
    });

    it('getDocument returns null for unknown documentId', () => {
        const engine = new CRDTEngine('node-A');
        expect(engine.getDocument('unknown')).toBeNull();
    });
});
