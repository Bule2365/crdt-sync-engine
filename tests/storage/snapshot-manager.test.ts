import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CRDTEngine } from '../../src/core';
import { OperationLog } from '../../src/storage';
import { SnapshotManager } from '../../src/storage';
import { CRDTType } from '../../src/types';

describe('SnapshotManager', () => {
    let snapDir: string;
    let logDir: string;
    let mgr: SnapshotManager;
    let log: OperationLog;
    let engine: CRDTEngine;

    beforeEach(async () => {
        snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crdt-snap-test-'));
        logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crdt-snaplog-test-'));
        mgr = new SnapshotManager(snapDir);
        log = new OperationLog(logDir);
        await log.open();
        engine = new CRDTEngine('node-A');
    });

    afterEach(async () => {
        await log.close();
        fs.rmSync(snapDir, { recursive: true, force: true });
        fs.rmSync(logDir, { recursive: true, force: true });
    });

    describe('createSnapshot', () => {
        it('should create snapshot file containing all documents', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            const op = engine.incrementCounter('c1', 5);
            await log.append(op);
            const filePath = await mgr.createSnapshot(engine, log);
            expect(fs.existsSync(filePath)).toBe(true);
        });

        it('snapshot file should be gzip-compressed (not plain JSON)', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            const filePath = await mgr.createSnapshot(engine, log);
            const raw = fs.readFileSync(filePath);
            // Gzip magic bytes: 0x1f 0x8b
            expect(raw[0]).toBe(0x1f);
            expect(raw[1]).toBe(0x8b);
        });

        it('snapshot includes lastSequenceNumber matching the log', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            const op = engine.incrementCounter('c1', 1);
            await log.append(op);
            await mgr.createSnapshot(engine, log);
            const loaded = mgr.loadLatestSnapshot();
            expect(loaded!.lastSequenceNumber).toBe(0);
        });
    });

    describe('loadLatestSnapshot', () => {
        it('should return null when no snapshot exists', () => {
            expect(mgr.loadLatestSnapshot()).toBeNull();
        });

        it('should load the most recent snapshot by sequence number', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            engine.incrementCounter('c1', 1);
            await mgr.createSnapshot(engine, log);
            engine.incrementCounter('c1', 1);
            await new Promise(function (r) { setTimeout(r, 5); }); // ensure different timestamp
            const filePath2 = await mgr.createSnapshot(engine, log);
            const loaded = mgr.loadLatestSnapshot();
            expect(loaded!.documents['c1']).toBeDefined();
            expect(fs.existsSync(filePath2)).toBe(true);
        });

        it('restored state should match original engine state', async () => {
            engine.createDocument('s1', CRDTType.OR_SET);
            engine.addToSet('s1', 'apple');
            engine.addToSet('s1', 'banana');
            await mgr.createSnapshot(engine, log);
            const loaded = mgr.loadLatestSnapshot();

            const engine2 = new CRDTEngine('node-A', loaded!.vectorClock);
            const doc = loaded!.documents['s1']!;
            engine2.restoreDocument('s1', doc.meta.type, doc.state);
            expect(engine2.getSetValues('s1').sort()).toEqual(['apple', 'banana']);
        });
    });

    describe('pruneOldSnapshots', () => {
        it('should keep only the N most recent snapshots', async () => {
            engine.createDocument('c1', CRDTType.G_COUNTER);
            for (let i = 0; i < 7; i++) {
                engine.incrementCounter('c1', 1);
                await mgr.createSnapshot(engine, log);
                await new Promise(function (r) { setTimeout(r, 5); });
            }
            mgr.pruneOldSnapshots(3);
            const remaining = fs.readdirSync(snapDir).filter(function (f) { return f.endsWith('.snap.gz'); });
            expect(remaining.length).toBe(3);
        });
    });

    describe('shouldSnapshot', () => {
        it('returns true at exact interval multiples', () => {
            expect(mgr.shouldSnapshot(500, 500)).toBe(true);
            expect(mgr.shouldSnapshot(1000, 500)).toBe(true);
        });

        it('returns false between intervals and at zero', () => {
            expect(mgr.shouldSnapshot(499, 500)).toBe(false);
            expect(mgr.shouldSnapshot(0, 500)).toBe(false);
        });
    });
});
