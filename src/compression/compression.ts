import { pack, unpack } from 'msgpackr';
import * as zlib from 'zlib';

/** Batas ukuran (bytes) payload msgpackr sebelum kompresi zlib diterapkan. */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/** Flag byte: payload TIDAK dikompresi, hanya msgpackr. */
const FLAG_UNCOMPRESSED = 0x00;
/** Flag byte: payload dikompresi via msgpackr + zlib deflate. */
const FLAG_COMPRESSED = 0x01;

/**
 * Encode pesan menjadi Buffer biner, terkompresi jika melewati threshold.
 *
 * Format output: [flagByte][...payloadBytes]
 * - flagByte 0x00: payload adalah hasil msgpackr.pack() langsung.
 * - flagByte 0x01: payload adalah hasil zlib.deflateSync(msgpackr.pack()).
 *
 * @param message Objek apapun yang dapat diserialisasi msgpackr (SyncMessage, dll.).
 * @returns Buffer siap dikirim via WebSocket.
 */
export function encode(message: unknown): Buffer {
    const packed = pack(message);

    if (packed.length > COMPRESSION_THRESHOLD_BYTES) {
        const compressed = zlib.deflateSync(packed);
        return Buffer.concat([Buffer.from([FLAG_COMPRESSED]), compressed]);
    }

    return Buffer.concat([Buffer.from([FLAG_UNCOMPRESSED]), packed]);
}

/**
 * Decode Buffer hasil encode() kembali menjadi objek JavaScript.
 *
 * @param buffer Buffer yang diterima dari WebSocket (format encode()).
 * @returns Objek hasil deserialisasi, dengan tipe T sesuai ekspektasi caller.
 * @throws Error jika buffer kosong atau data corrupt.
 */
export function decode<T = unknown>(buffer: Buffer): T {
    if (buffer.length === 0) {
        throw new Error('Compression.decode: buffer kosong, tidak ada flag byte');
    }

    const flag = buffer[0];
    const body = buffer.subarray(1);
    const packed = flag === FLAG_COMPRESSED
        ? zlib.inflateSync(body)
        : body;

    return unpack(packed) as T;
}

/**
 * Ukur efektivitas kompresi untuk sebuah pesan.
 * Membandingkan ukuran JSON mentah vs ukuran hasil encode().
 * Digunakan oleh Debug Inspector (Langkah 14) untuk metrik.
 */
export function measureCompressionRatio(message: unknown): {
    originalSize: number;
    encodedSize: number;
    ratio: number;
} {
    const jsonSize = Buffer.byteLength(JSON.stringify(message), 'utf8');
    const encodedSize = encode(message).length;
    return {
        originalSize: jsonSize,
        encodedSize,
        ratio: jsonSize > 0 ? 1 - encodedSize / jsonSize : 0,
    };
}
