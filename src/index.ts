import { CRDTEngine } from './core';
import { OperationLog, SnapshotManager } from './storage';
import { SyncEngine } from './sync';
import { TransportLayer } from './transport';
import { DebugInspector } from './debug';
import type { SystemConfig } from './types';

/** Baca konfigurasi dari environment variable, dengan default yang aman. */
function loadConfig(): SystemConfig {
    const env = process.env;
    return {
        nodeId: env['NODE_ID'] ?? 'node-001',
        dataDir: env['DATA_DIR'] ?? './data/node-001',
        websocketPort: Number(env['WEBSOCKET_PORT']) || 8001,
        peers: env['PEERS'] ? JSON.parse(env['PEERS']) as string[] : [],
        syncIntervalMs: Number(env['SYNC_INTERVAL_MS']) || 500,
        maxLogSizeMb: Number(env['MAX_LOG_SIZE_MB']) || 50,
        snapshotInterval: Number(env['SNAPSHOT_INTERVAL']) || 500,
        debugPort: Number(env['DEBUG_PORT']) || 3001,
        logLevel: (env['LOG_LEVEL'] as SystemConfig['logLevel']) ?? 'info',
    };
}

/** Kumpulan referensi komponen yang sedang berjalan, untuk shutdown nanti. */
interface RunningSystem {
    config: SystemConfig;
    log: OperationLog;
    snapshotManager: SnapshotManager;
    engine: CRDTEngine;
    syncEngine: SyncEngine;
    transport: TransportLayer;
    debugInspector: DebugInspector;
    syncTimer: ReturnType<typeof setInterval>;
}

/** Jalankan urutan startup lengkap sesuai dokumentasi Langkah 15, bagian 3.1. */
async function startup(config: SystemConfig): Promise<RunningSystem> {
    // 2. Buka Operation Log
    const log = new OperationLog(`${config.dataDir}/log`);
    await log.open();

    // 3. Muat snapshot terbaru (jika ada)
    const snapshotManager = new SnapshotManager(`${config.dataDir}/snapshots`);
    const snapshot = snapshotManager.loadLatestSnapshot();

    // 4. Buat Engine, gunakan vectorClock dari snapshot jika tersedia
    const engine = new CRDTEngine(
        config.nodeId,
        snapshot ? snapshot.vectorClock : undefined,
    );

    // 5. Restore dokumen dari snapshot
    let replayFromSeq = -1;
    if (snapshot) {
        for (const [docId, entry] of Object.entries(snapshot.documents)) {
            engine.restoreDocument(docId, entry.meta.type, entry.state);
        }
        replayFromSeq = snapshot.lastSequenceNumber;
        console.log(`[startup] Restored ${Object.keys(snapshot.documents).length} documents from snapshot (seq=${replayFromSeq})`);
    }

    // 6. Replay log setelah snapshot
    const remaining = await log.getAfter(replayFromSeq);
    for (const entry of remaining) {
        engine.applyOperation(entry.operation, false);
    }
    console.log(`[startup] Replayed ${remaining.length} log entries after snapshot`);

    // 7. Sync Engine
    const syncEngine = new SyncEngine(engine, log);

    // 8. Transport Layer
    const transport = new TransportLayer(config, syncEngine);
    transport.start();
    console.log(`[startup] Transport listening on port ${config.websocketPort}`);

    // 9. Debug Inspector
    const debugInspector = new DebugInspector({
        engine, log, snapshotManager, syncEngine, transport,
    });
    debugInspector.start(config.debugPort);
    console.log(`[startup] Debug Inspector listening on port ${config.debugPort}`);

    // 10. Sync periodik
    const syncTimer = setInterval(
        () => transport.triggerSync(),
        config.syncIntervalMs,
    );

    return {
        config, log, snapshotManager, engine, syncEngine,
        transport, debugInspector, syncTimer,
    };
}

/** Jalankan urutan shutdown lengkap, kebalikan dari startup(). */
async function shutdown(sys: RunningSystem): Promise<void> {
    console.log('[shutdown] Stopping sync timer...');
    clearInterval(sys.syncTimer);

    console.log('[shutdown] Stopping Debug Inspector...');
    await sys.debugInspector.stop();

    console.log('[shutdown] Stopping Transport Layer...');
    await sys.transport.stop();

    console.log('[shutdown] Creating final checkpoint snapshot...');
    await sys.snapshotManager.createSnapshot(sys.engine, sys.log);

    console.log('[shutdown] Closing Operation Log...');
    await sys.log.close();

    console.log('[shutdown] Complete.');
}

/** Entry point utama. */
async function main(): Promise<void> {
    const config = loadConfig();

    console.log('='.repeat(45));
    console.log('  CRDT Sync Engine v1.0.0');
    console.log('='.repeat(45));
    console.log(`  Node ID  : ${config.nodeId}`);
    console.log(`  Node.js  : ${process.version}`);
    console.log(`  Platform : ${process.platform}`);
    console.log(`  WS Port  : ${config.websocketPort}`);
    console.log(`  Debug Port: ${config.debugPort}`);
    console.log(`  Peers    : ${JSON.stringify(config.peers)}`);
    console.log('='.repeat(45));

    const system = await startup(config);
    console.log('[main] System ready.');

    const handleSignal = (): void => {
        console.log('\n[main] Shutdown signal received...');
        shutdown(system)
            .then(() => process.exit(0))
            .catch((err) => {
                console.error('[main] Error during shutdown:', err);
                process.exit(1);
            });
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
}

main().catch((err) => {
    console.error('[main] Fatal error during startup:', err);
    process.exit(1);
});
