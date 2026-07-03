import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CRDTEngine } from '../../src/core';
import { OperationLog, SnapshotManager } from '../../src/storage';
import { SyncEngine } from '../../src/sync';
import { TransportLayer } from '../../src/transport';
import { DebugInspector } from '../../src/debug';
import { CRDTType } from '../../src/types';
import type { SystemConfig } from '../../src/types';

let portCounter = 31000;
function nextPort(): number { return portCounter++; }

describe('DebugInspector', () => {
    let tmpRoot: string;
    let logDir: string;
    let snapDir: string;
    let engine: CRDTEngine;
    let log: OperationLog;
    let snapMgr: SnapshotManager;
    let sync: SyncEngine;
    let transport: TransportLayer;
    let inspector: DebugInspector;
    let port: number;
    let baseUrl: string;

    beforeEach(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crdt-debug-test-'));
        logDir = fs.mkdtempSync(path.join(tmpRoot, 'log-'));
        snapDir = fs.mkdtempSync(path.join(tmpRoot, 'snap-'));

        engine = new CRDTEngine('node-A');
        log = new OperationLog(logDir);
        await log.open();
        snapMgr = new SnapshotManager(snapDir);
        sync = new SyncEngine(engine, log);

        const config: SystemConfig = {
            nodeId: 'node-A', dataDir: '', websocketPort: nextPort(), peers: [],
            syncIntervalMs: 500, maxLogSizeMb: 50, snapshotInterval: 500,
            debugPort: 0, logLevel: 'info',
        };
        transport = new TransportLayer(config, sync);
        transport.start();

        inspector = new DebugInspector({ engine, log, snapshotManager: snapMgr, syncEngine: sync, transport });
        port = nextPort();
        baseUrl = `http://127.0.0.1:${port}`;
        inspector.start(port);

        await new Promise(function (r) { setTimeout(r, 50); });
    });

    afterEach(async () => {
        await inspector.stop();
        await transport.stop();
        await log.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    describe('/health', () => {
        it('returns 200 with nodeId and status ok', async () => {
            const res = await fetch(`${baseUrl}/health`);
            const body = await res.json() as any;
            expect(res.status).toBe(200);
            expect(body.data.nodeId).toBe('node-A');
            expect(body.data.status).toBe('ok');
        });
    });

    describe('/debug/state', () => {
        it('lists all active documents', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            engine.incrementCounter('c1', 3);
            const res = await fetch(`${baseUrl}/debug/state`);
            const body = await res.json() as any;
            expect(body.data.documents).toHaveLength(1);
            expect(body.data.documents[0].documentId).toBe('c1');
        });

        it('returns 404 for unknown documentId', async () => {
            const res = await fetch(`${baseUrl}/debug/state/ghost`);
            expect(res.status).toBe(404);
        });

        it('returns correct value for G-Counter document', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            engine.incrementCounter('c1', 5);
            const res = await fetch(`${baseUrl}/debug/state/c1`);
            const body = await res.json() as any;
            expect(body.data.value).toBe(5);
        });
    });

    describe('/debug/vectorclock', () => {
        it('returns current vector clock', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            engine.incrementCounter('c1', 1);
            const res = await fetch(`${baseUrl}/debug/vectorclock`);
            const body = await res.json() as any;
            expect(body.data['node-A']).toBe(1);
        });
    });

    describe('/debug/log', () => {
        it('respects limit query parameter', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            for (let i = 0; i < 5; i++) {
                const op = engine.incrementCounter('c1', 1);
                await log.append(op);
            }
            const res = await fetch(`${baseUrl}/debug/log?limit=2`);
            const body = await res.json() as any;
            expect(body.data.entries.length).toBeLessThanOrEqual(2);
        });

        it('respects after query parameter', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            for (let i = 0; i < 3; i++) {
                const op = engine.incrementCounter('c1', 1);
                await log.append(op);
            }
            const res = await fetch(`${baseUrl}/debug/log?after=1`);
            const body = await res.json() as any;
            expect(body.data.returnedCount).toBe(1);
        });
    });

    describe('/debug/sync', () => {
        it('returns peers and sync status', async () => {
            const res = await fetch(`${baseUrl}/debug/sync`);
            const body = await res.json() as any;
            expect(body.success).toBe(true);
            expect(Array.isArray(body.data.peers)).toBe(true);
            expect(Array.isArray(body.data.syncStatus)).toBe(true);
        });
    });

    describe('POST /debug/snapshot/create', () => {
        it('creates a snapshot file and returns its path', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            const res = await fetch(`${baseUrl}/debug/snapshot/create`, { method: 'POST' });
            const body = await res.json() as any;
            expect(body.success).toBe(true);
            expect(fs.existsSync(body.data.filePath)).toBe(true);
        });
    });
});
