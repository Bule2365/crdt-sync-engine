/**
 * Representasi Vector Clock sebagai plain object yang dapat diserialisasi.
 * Key   : NodeId (identifier node).
 * Value : Lamport counter node tersebut.
 *
 * Menggunakan Record (bukan Map) karena:
 * 1. JSON.stringify(Map) menghasilkan {} — tidak bisa diserialisasi.
 * 2. Record adalah plain object yang langsung bekerja dengan JSON dan msgpackr.
 * 3. Data yang diterima dari WebSocket sudah berbentuk plain object.
 */
export type VectorClockRecord = Record<string, number>;
