import { VectorClock, ClockComparison } from '../../src/clock';

describe('VectorClock — Instance Methods', () => {
    it('should initialize with counter 0 for own node', () => {
        const vc = new VectorClock('node-A');
        expect(vc.getCurrent()).toBe(0);
        expect(vc.get('node-A')).toBe(0);
    });

    it('should increment own counter and return new value', () => {
        const vc = new VectorClock('node-A');
        expect(vc.increment()).toBe(1);
        expect(vc.increment()).toBe(2);
        expect(vc.getCurrent()).toBe(2);
    });

    it('should return immutable snapshot via toRecord', () => {
        const vc = new VectorClock('node-A');
        vc.increment();
        const record = vc.toRecord();
        record['node-A'] = 999;           // mutasi salinan
        expect(vc.getCurrent()).toBe(1);  // internal tidak berubah
    });

    it('should merge by taking max of each counter', () => {
        const vc = new VectorClock('node-A', { 'node-A': 3, 'node-B': 1 });
        vc.merge({ 'node-A': 2, 'node-B': 5, 'node-C': 1 });
        expect(vc.get('node-A')).toBe(3); // max(3, 2) = 3
        expect(vc.get('node-B')).toBe(5); // max(1, 5) = 5
        expect(vc.get('node-C')).toBe(1); // max(0, 1) = 1
    });

    it('should return 0 for unknown node', () => {
        const vc = new VectorClock('node-A');
        expect(vc.get('node-unknown')).toBe(0);
    });
});

describe('VectorClock.compare', () => {
    it('should detect EQUAL clocks', () => {
        const a = { 'A': 2, 'B': 3 };
        const b = { 'A': 2, 'B': 3 };
        expect(VectorClock.compare(a, b)).toBe(ClockComparison.EQUAL);
    });

    it('should detect BEFORE — a < b', () => {
        const a = { 'A': 1, 'B': 2 };
        const b = { 'A': 2, 'B': 3 };
        expect(VectorClock.compare(a, b)).toBe(ClockComparison.BEFORE);
    });

    it('should detect AFTER — a > b', () => {
        const a = { 'A': 3, 'B': 3 };
        const b = { 'A': 1, 'B': 2 };
        expect(VectorClock.compare(a, b)).toBe(ClockComparison.AFTER);
    });

    it('should detect CONCURRENT clocks', () => {
        const a = { 'A': 2, 'B': 1 };
        const b = { 'A': 1, 'B': 2 };
        expect(VectorClock.compare(a, b)).toBe(ClockComparison.CONCURRENT);
    });

    it('should treat missing node as counter 0', () => {
        const a = { 'A': 1 };
        const b = { 'A': 1, 'B': 0 };
        expect(VectorClock.compare(a, b)).toBe(ClockComparison.EQUAL);
    });
});

describe('VectorClock.mergeRecords', () => {
    it('should take max of each counter and produce new object', () => {
        const a = { 'A': 3, 'B': 1 };
        const b = { 'A': 2, 'B': 5, 'C': 1 };
        const result = VectorClock.mergeRecords(a, b);
        expect(result).toEqual({ 'A': 3, 'B': 5, 'C': 1 });
        expect(a['B']).toBe(1); // input tidak berubah
    });
});
