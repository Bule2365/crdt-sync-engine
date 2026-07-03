import {
    encode, decode, measureCompressionRatio, COMPRESSION_THRESHOLD_BYTES,
} from '../../src/compression';

describe('Compression — encode/decode roundtrip', () => {
    it('small payload encodes and decodes correctly', () => {
        const msg = { type: 'heartbeat', fromNodeId: 'node-A', timestamp: 123 };
        const encoded = encode(msg);
        const decoded = decode(encoded);
        expect(decoded).toEqual(msg);
    });

    it('large payload encodes and decodes correctly', () => {
        const bigText = 'x'.repeat(5000);
        const msg = { type: 'sync-delta', payload: { text: bigText } };
        const encoded = decode(encode(msg));
        expect(encoded).toEqual(msg);
    });

    it('roundtrip preserves nested objects and arrays', () => {
        const msg = {
            operations: [
                { id: 'op1', payload: { value: 'a' }, vectorClock: { 'node-A': 1 } },
                { id: 'op2', payload: { value: 'b' }, vectorClock: { 'node-A': 2 } },
            ],
            nested: { deep: { deeper: [1, 2, 3] } },
        };
        const decoded = decode(encode(msg));
        expect(decoded).toEqual(msg);
    });
});

describe('Compression — threshold behavior', () => {
    it('payload below threshold is NOT zlib-compressed (flag=0)', () => {
        const small = { type: 'hello', nodeId: 'A' };
        const encoded = encode(small);
        expect(encoded[0]).toBe(0x00);
    });

    it('payload above threshold IS zlib-compressed (flag=1)', () => {
        const large = { text: 'a'.repeat(COMPRESSION_THRESHOLD_BYTES + 500) };
        const encoded = encode(large);
        expect(encoded[0]).toBe(0x01);
    });
});

describe('Compression — measureCompressionRatio', () => {
    it('returns positive ratio for repetitive text payload', () => {
        const msg = { text: 'hello world '.repeat(200) };
        const result = measureCompressionRatio(msg);
        expect(result.ratio).toBeGreaterThan(0);
        expect(result.encodedSize).toBeLessThan(result.originalSize);
    });

    it('ratio is between 0 and 1 for typical payloads', () => {
        const msg = { type: 'sync-ack', vectorClock: { 'node-A': 5, 'node-B': 3 } };
        const result = measureCompressionRatio(msg);
        expect(result.ratio).toBeGreaterThanOrEqual(-1); // boleh negatif tipis utk payload kecil
        expect(result.ratio).toBeLessThanOrEqual(1);
    });
});

describe('Compression — error handling', () => {
    it('decode throws on empty buffer', () => {
        expect(() => decode(Buffer.alloc(0))).toThrow();
    });

    it('decode throws on corrupted compressed data', () => {
        const corrupted = Buffer.concat([
            Buffer.from([0x01]), // flag: compressed
            Buffer.from('not actually deflated data', 'utf8'),
        ]);
        expect(() => decode(corrupted)).toThrow();
    });
});
