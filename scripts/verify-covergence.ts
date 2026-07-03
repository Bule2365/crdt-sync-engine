import { CRDTEngine } from '../src/core';
import { OperationLog } from '../src/storage';
import { SyncEngine } from '../src/sync';
import { TransportLayer } from '../src/transport';
import { CRDTType } from '../src/types';
import type { SystemConfig } from '../src/types';
import * as fs from 'fs';

function wait(ms: number): Promise<void> {
    return new Promise(function (r) { setTimeout(r, ms); });
}

async function main(): Promise<void> {
    console.log('Starting Node A (port 8001)...');
    fs.mkdirSync('./data/verify-a', { recursive: true });
    const engineA = new CRDTEngine('node-A');
    const logA = new OperationLog('./data/verify-a/log');
    await logA.open();
    engineA.createDocument('tasks', CRDTType.OR_SET);

    console.log('Node A: performing 100 operations offline...');
    for (let i = 0; i < 100; i++) {
        const op = engineA.addToSet('tasks', `task-${i}`);
        await logA.append(op);
    }

    const syncA = new SyncEngine(engineA, logA);
    const configA: SystemConfig = {
        nodeId: 'node-A', dataDir: './data/verify-a', websocketPort: 8001,
        peers: ['ws://localhost:8002'], syncIntervalMs: 300, maxLogSizeMb: 50,
        snapshotInterval: 500, debugPort: 3001, logLevel: 'info',
    };
    const transportA = new TransportLayer(configA, syncA);

    console.log('Starting Node B (port 8002, peer: A)...');
    fs.mkdirSync('./data/verify-b', { recursive: true });
    const engineB = new CRDTEngine('node-B');
    const logB = new OperationLog('./data/verify-b/log');
    await logB.open();
    engineB.createDocument('tasks', CRDTType.OR_SET);
    const syncB = new SyncEngine(engineB, logB);
    const configB: SystemConfig = {
        nodeId: 'node-B', dataDir: './data/verify-b', websocketPort: 8002,
        peers: ['ws://localhost:8001'], syncIntervalMs: 300, maxLogSizeMb: 50,
        snapshotInterval: 500, debugPort: 3002, logLevel: 'info',
    };
    const transportB = new TransportLayer(configB, syncB);

    transportA.start();
    transportB.start();

    console.log('Waiting for sync (3000ms)...');
    await wait(3000);

    const valuesA = engineA.getSetValues('tasks').sort();
    const valuesB = engineB.getSetValues('tasks').sort();

    console.log(`Node A document state: ${valuesA.length} items`);
    console.log(`Node B document state: ${valuesB.length} items`);

    const identical = JSON.stringify(valuesA) === JSON.stringify(valuesB);
    if (identical && valuesB.length === 100) {
        console.log('CONVERGENCE VERIFIED: states are identical ✔');
    } else {
        console.error('CONVERGENCE FAILED: states differ or incomplete ✖');
        process.exitCode = 1;
    }

    console.log('Shutting down both nodes...');
    await transportA.stop(); await transportB.stop();
    await logA.close(); await logB.close();
}

main().catch((err) => {
    console.error('Verification script failed:', err);
    process.exit(1);
});
