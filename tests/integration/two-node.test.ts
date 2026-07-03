import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CRDTEngine } from '../../src/core';
import { OperationLog, SnapshotManager } from '../../src/storage';
import { SyncEngine } from '../../src/sync';
import { TransportLayer } from '../../src/transport';
import { CRDTType } from '../../src/types';
import type { SystemConfig } from '../../src/types';

let portCounter = 41000;
function nextPort(): number { return portCounter++; }
function wait(ms: number): Promise<void> {
    return new Promise(function (r) { setTimeout(r, ms); });
}

async function makeFullNode(nodeId: string, port: number, peers: string[], tmpRoot: string) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, `${nodeId}-`));
    const engine = new CRDTEngine(nodeId);
    const log = new OperationLog(dir);
    await log.open();
    const sync = new SyncEngine(engine, log);
    const config: SystemConfig = {
        nodeId, dataDir: dir, websocketPort: port, peers,
        syncIntervalMs: 200, maxLogSizeMb: 50, snapshotInterval: 500,
        debugPort: 0, logLevel: 'info',
    };
    const transport = new TransportLayer(config, sync);
    return { engine, log, sync, transport, config };
}

describe('Integration — Two Node Scenario (TS04)', () => {
    let tmpRoot: string;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crdt-integration-'));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('TS04: node offline for 100 ops, then comes online and fully syncs', async () => {
        const portA = nextPort();
        const portB = nextPort();

        // Node A beroperasi "offline" — belum start() Transport
        const a = await makeFullNode('node-A', portA, [`ws://localhost:${portB}`], tmpRoot);
        a.engine.createDocument('tasks', CRDTType.OR_SET);

        for (let i = 0; i < 100; i++) {
            const op = a.engine.addToSet('tasks', `task-${i}`);
            await a.log.append(op);
        }
        expect(a.engine.getSetValues('tasks')).toHaveLength(100);

        // Node B baru dibuat, juga belum tahu apa-apa
        const b = await makeFullNode('node-B', portB, [`ws://localhost:${portA}`], tmpRoot);
        b.engine.createDocument('tasks', CRDTType.OR_SET);
        expect(b.engine.getSetValues('tasks')).toHaveLength(0);

        // Kedua node "online" sekarang (kembali terhubung)
        a.transport.start();
        b.transport.start();

        // Tunggu HELLO + auto SYNC_REQ + SYNC_DELTA terjadi
        await wait(800);

        // Verifikasi: semua 100 operasi tersinkronisasi ke Node B
        expect(b.engine.getSetValues('tasks')).toHaveLength(100);

        // Verifikasi: state identik persis (deep equality, terurut)
        expect(a.engine.getSetValues('tasks').sort()).toEqual(
            b.engine.getSetValues('tasks').sort(),
        );

        await a.transport.stop(); await b.transport.stop();
        await a.log.close(); await b.log.close();
    }, 10000);

    it('bidirectional concurrent edits converge to the same state', async () => {
        const portA = nextPort();
        const portB = nextPort();
        const a = await makeFullNode('node-A', portA, [`ws://localhost:${portB}`], tmpRoot);
        const b = await makeFullNode('node-B', portB, [`ws://localhost:${portA}`], tmpRoot);
        a.engine.createDocument('doc1', CRDTType.LWW_REGISTER);
        b.engine.createDocument('doc1', CRDTType.LWW_REGISTER);

        a.transport.start();
        b.transport.start();
        await wait(300);

        // Concurrent update dari kedua sisi
        const opA = a.engine.updateRegister('doc1', 'from-A');
        await a.log.append(opA);
        const opB = b.engine.updateRegister('doc1', 'from-B');
        await b.log.append(opB);

        await wait(800);

        expect(a.engine.getRegisterValue('doc1')).toBe(
            b.engine.getRegisterValue('doc1'),
        );

        await a.transport.stop(); await b.transport.stop();
        await a.log.close(); await b.log.close();
    }, 10000);

    it('snapshot and restore preserves state across simulated restart', async () => {
        const port = nextPort();
        const node = await makeFullNode('node-A', port, [], tmpRoot);
        node.engine.createDocument('counter', CRDTType.G_COUNTER);
        node.engine.incrementCounter('counter', 42);

        const snapDir = fs.mkdtempSync(path.join(tmpRoot, 'snap-'));
        const snapMgr = new SnapshotManager(snapDir);
        await snapMgr.createSnapshot(node.engine, node.log);

        // Simulasikan restart: buat Engine baru dari snapshot
        const snapshot = snapMgr.loadLatestSnapshot()!;
        const restoredEngine = new (require('../../src/core').CRDTEngine)(
            'node-A', snapshot.vectorClock,
        );
        const docEntry = snapshot.documents['counter']!;
        restoredEngine.restoreDocument('counter', docEntry.meta.type, docEntry.state);

        expect(restoredEngine.getCounterValue('counter')).toBe(42);
        await node.log.close();
    });

    it('three-way convergence: A, B, C all reach identical state', async () => {
        const portA = nextPort(), portB = nextPort(), portC = nextPort();
        const a = await makeFullNode('node-A', portA,
            [`ws://localhost:${portB}`, `ws://localhost:${portC}`], tmpRoot);
        const b = await makeFullNode('node-B', portB,
            [`ws://localhost:${portA}`, `ws://localhost:${portC}`], tmpRoot);
        const c = await makeFullNode('node-C', portC,
            [`ws://localhost:${portA}`, `ws://localhost:${portB}`], tmpRoot);

        [a, b, c].forEach(function (n) { n.engine.createDocument('s', CRDTType.OR_SET); });

        const opA = a.engine.addToSet('s', 'from-A'); await a.log.append(opA);
        const opB = b.engine.addToSet('s', 'from-B'); await b.log.append(opB);
        const opC = c.engine.addToSet('s', 'from-C'); await c.log.append(opC);

        a.transport.start(); b.transport.start(); c.transport.start();
        await wait(1200);

        const valsA = a.engine.getSetValues('s').sort();
        const valsB = b.engine.getSetValues('s').sort();
        const valsC = c.engine.getSetValues('s').sort();
        expect(valsA).toEqual(valsB);
        expect(valsB).toEqual(valsC);
        expect(valsA).toHaveLength(3);

        await a.transport.stop(); await b.transport.stop(); await c.transport.stop();
        await a.log.close(); await b.log.close(); await c.log.close();
    }, 15000);

    it('LSEQ text edits from two nodes merge into consistent text', async () => {
        const portA = nextPort(); const portB = nextPort();
        const a = await makeFullNode('node-A', portA, [`ws://localhost:${portB}`], tmpRoot);
        const b = await makeFullNode('node-B', portB, [`ws://localhost:${portA}`], tmpRoot);
        a.engine.createDocument('doc', CRDTType.LSEQ_TEXT);
        b.engine.createDocument('doc', CRDTType.LSEQ_TEXT);

        a.transport.start(); b.transport.start();
        await wait(300);

        const opA = a.engine.insertIntoList('doc', 'A', 0); await a.log.append(opA);
        const opB = b.engine.insertIntoList('doc', 'B', 0); await b.log.append(opB);

        await wait(800);

        expect(a.engine.getTextValue('doc')).toBe(b.engine.getTextValue('doc'));
        expect(a.engine.getTextValue('doc').length).toBe(2);

        await a.transport.stop(); await b.transport.stop();
        await a.log.close(); await b.log.close();
    }, 10000);
});
