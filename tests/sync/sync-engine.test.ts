import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CRDTEngine } from '../../src/core';
import { OperationLog } from '../../src/storage';
import { SyncEngine } from '../../src/sync';
import { CRDTType } from '../../src/types';

/** Helper: buat CRDTEngine + OperationLog + SyncEngine yang siap dipakai untuk satu node. */
async function makeNode(nodeId: string, tmpRoot: string) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, `${nodeId}-`));
    const engine = new CRDTEngine(nodeId);
    const log = new OperationLog(dir);
    await log.open();
    const sync = new SyncEngine(engine, log);
    return { engine, log, sync, dir };
}

describe('SyncEngine', () => {
    let tmpRoot: string;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crdt-sync-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    describe('computeDelta', () => {
        it('returns empty delta when peer clock is fully up to date', async () => {
            const a = await makeNode('node-A', tmpRoot);
            a.engine.createDocument('c1', CRDTType.G_COUNTER);
            const op = a.engine.incrementCounter('c1', 1);
            await a.log.append(op);

            const delta = await a.sync.computeDelta('node-B', a.engine.getVectorClock());
            expect(delta.operations).toHaveLength(0);
            await a.log.close();
        });

        it('returns operations the peer has not seen (AFTER)', async () => {
            const a = await makeNode('node-A', tmpRoot);
            a.engine.createDocument('c1', CRDTType.G_COUNTER);
            const op = a.engine.incrementCounter('c1', 1);
            await a.log.append(op);

            const delta = await a.sync.computeDelta('node-B', {}); // empty peer clock
            expect(delta.operations).toHaveLength(1);
            expect(delta.operations[0]!.operationId).toBe(op.operationId);
            await a.log.close();
        });

        it('includes concurrent operations in the delta', async () => {
            const a = await makeNode('node-A', tmpRoot);
            a.engine.createDocument('s1', CRDTType.OR_SET);
            const op = a.engine.addToSet('s1', 'apple');
            await a.log.append(op);
            // Peer clock dengan node berbeda (concurrent, tidak overlap)
            const peerClock = { 'node-Z': 5 };
            const delta = await a.sync.computeDelta('node-Z', peerClock);
            expect(delta.operations.length).toBeGreaterThan(0);
            await a.log.close();
        });

        it('excludes operations already covered by peer clock', async () => {
            const a = await makeNode('node-A', tmpRoot);
            a.engine.createDocument('c1', CRDTType.G_COUNTER);
            const op = a.engine.incrementCounter('c1', 1);
            await a.log.append(op);
            // Peer clock SUDAH mencakup operasi ini (EQUAL/BEFORE)
            const peerClock = a.engine.getVectorClock();
            const delta = await a.sync.computeDelta('node-B', peerClock);
            expect(delta.operations).toHaveLength(0);
            await a.log.close();
        });
    });

    describe('receiveDelta', () => {
        it('applies received operations to local engine', async () => {
            const a = await makeNode('node-A', tmpRoot);
            const b = await makeNode('node-B', tmpRoot);
            a.engine.createDocument('c1', CRDTType.G_COUNTER);
            b.engine.createDocument('c1', CRDTType.G_COUNTER);
            const op = a.engine.incrementCounter('c1', 7);
            await a.log.append(op);

            const delta = await a.sync.computeDelta('node-B', {});
            await b.sync.receiveDelta(delta);
            expect(b.engine.getCounterValue('c1')).toBe(7);
            await a.log.close(); await b.log.close();
        });

        it('persists received operations to local log', async () => {
            const a = await makeNode('node-A', tmpRoot);
            const b = await makeNode('node-B', tmpRoot);
            a.engine.createDocument('c1', CRDTType.G_COUNTER);
            b.engine.createDocument('c1', CRDTType.G_COUNTER);
            const op = a.engine.incrementCounter('c1', 1);
            await a.log.append(op);
            const delta = await a.sync.computeDelta('node-B', {});
            await b.sync.receiveDelta(delta);
            expect(await b.log.getLastSequenceNumber()).toBe(0);
            await a.log.close(); await b.log.close();
        });

        it('skips operations already covered by local clock (idempotent)', async () => {
            const a = await makeNode('node-A', tmpRoot);
            const b = await makeNode('node-B', tmpRoot);
            a.engine.createDocument('c1', CRDTType.G_COUNTER);
            b.engine.createDocument('c1', CRDTType.G_COUNTER);
            const op = a.engine.incrementCounter('c1', 1);
            await a.log.append(op);
            const delta = await a.sync.computeDelta('node-B', {});
            await b.sync.receiveDelta(delta);
            const appliedAgain = await b.sync.receiveDelta(delta); // apply twice
            expect(appliedAgain).toBe(0);
            expect(b.engine.getCounterValue('c1')).toBe(1);
            await a.log.close(); await b.log.close();
        });

        it('updates peer tracking after receiving delta', async () => {
            const a = await makeNode('node-A', tmpRoot);
            const b = await makeNode('node-B', tmpRoot);
            a.engine.createDocument('c1', CRDTType.G_COUNTER);
            const op = a.engine.incrementCounter('c1', 1);
            await a.log.append(op);
            const delta = await a.sync.computeDelta('node-B', {});
            await b.sync.receiveDelta(delta);
            const peerState = b.sync.getPeerState('node-A');
            expect(peerState).not.toBeNull();
            expect(peerState!.lastSyncedAt).toBeGreaterThan(0);
            await a.log.close(); await b.log.close();
        });
    });

    describe('peer management', () => {
        it('registerPeer is idempotent', async () => {
            const a = await makeNode('node-A', tmpRoot);
            a.sync.registerPeer('node-B');
            a.sync.updatePeerClock('node-B', { 'node-B': 5 });
            a.sync.registerPeer('node-B'); // should not reset
            expect(a.sync.getPeerState('node-B')!.lastKnownClock).toEqual({ 'node-B': 5 });
            await a.log.close();
        });

        it('unregisterPeer removes peer from tracking', async () => {
            const a = await makeNode('node-A', tmpRoot);
            a.sync.registerPeer('node-B');
            a.sync.unregisterPeer('node-B');
            expect(a.sync.getPeerState('node-B')).toBeNull();
            await a.log.close();
        });
    });

    describe('end-to-end convergence', () => {
        it('two nodes converge after bidirectional sync', async () => {
            const a = await makeNode('node-A', tmpRoot);
            const b = await makeNode('node-B', tmpRoot);
            a.engine.createDocument('s1', CRDTType.OR_SET);
            b.engine.createDocument('s1', CRDTType.OR_SET);

            const opA = a.engine.addToSet('s1', 'apple');
            await a.log.append(opA);
            const opB = b.engine.addToSet('s1', 'banana');
            await b.log.append(opB);

            // A -> B
            const deltaAtoB = await a.sync.computeDelta('node-B', b.engine.getVectorClock());
            await b.sync.receiveDelta(deltaAtoB);
            // B -> A
            const deltaBtoA = await b.sync.computeDelta('node-A', a.engine.getVectorClock());
            await a.sync.receiveDelta(deltaBtoA);

            expect(a.engine.getSetValues('s1').sort()).toEqual(['apple', 'banana']);
            expect(b.engine.getSetValues('s1').sort()).toEqual(['apple', 'banana']);
            await a.log.close(); await b.log.close();
        });
    });
});
