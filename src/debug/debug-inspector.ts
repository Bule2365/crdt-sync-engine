import express, { Express, Request, Response } from 'express';
import type { Server } from 'http';
import type { CRDTEngine } from '../core';
import type { OperationLog, SnapshotManager } from '../storage';
import type { SyncEngine } from '../sync';
import type { TransportLayer } from '../transport';
import { CRDTType } from '../types';

/** Dependencies yang dibutuhkan Debug Inspector untuk mengekspos state. */
export interface DebugInspectorDeps {
    engine: CRDTEngine;
    log: OperationLog;
    snapshotManager: SnapshotManager;
    syncEngine: SyncEngine;
    transport: TransportLayer;
}

/**
 * Debug Inspector — REST API lokal untuk inspeksi state node.
 *
 * HANYA mendengarkan di 127.0.0.1. Tidak pernah diekspos ke jaringan LAN.
 * Murni read-only kecuali POST /debug/snapshot/create.
 * TIDAK PERNAH digunakan untuk komunikasi antar node (itu tugas Transport Layer/WebSocket).
 */
export class DebugInspector {
    private readonly app: Express;
    private readonly deps: DebugInspectorDeps;
    private server: Server | null = null;

    constructor(deps: DebugInspectorDeps) {
        this.deps = deps;
        this.app = express();
        this.app.use(express.json());
        this.registerRoutes();
    }

    /** Mulai mendengarkan di 127.0.0.1:port. */
    start(port: number): void {
        this.server = this.app.listen(port, '127.0.0.1');
    }

    /** Tutup server dengan rapi. */
    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve, reject) => {
            this.server!.close((err) => (err ? reject(err) : resolve()));
        });
        this.server = null;
    }

    /** Baca nilai akhir dokumen sesuai tipe CRDT-nya, via getter publik Engine. */
    private readDocumentValue(documentId: string, type: CRDTType): unknown {
        const { engine } = this.deps;
        switch (type) {
            case CRDTType.G_COUNTER: return engine.getCounterValue(documentId);
            case CRDTType.OR_SET: return engine.getSetValues(documentId);
            case CRDTType.LWW_REGISTER: return engine.getRegisterValue(documentId);
            case CRDTType.LSEQ_LIST: return engine.getListValues(documentId);
            case CRDTType.LSEQ_TEXT: return engine.getTextValue(documentId);
            default: return null;
        }
    }

    private registerRoutes(): void {
        const { engine, log, snapshotManager, syncEngine, transport } = this.deps;

        this.app.get('/health', (req: Request, res: Response) => {
            res.json({
                success: true,
                data: {
                    nodeId: engine.getNodeId(),
                    status: 'ok',
                    uptimeSeconds: process.uptime(),
                    documentCount: engine.getDocumentIds().length,
                    connectedPeers: transport.getConnectedPeerCount(),
                    timestamp: Date.now(),
                },
            });
        });

        this.app.get('/debug/state', (req: Request, res: Response) => {
            const documents = engine.getDocumentIds().map((docId) => {
                const meta = engine.getDocument(docId)!;
                return {
                    documentId: docId,
                    type: meta.type,
                    value: this.readDocumentValue(docId, meta.type),
                };
            });
            res.json({ success: true, data: { documents } });
        });

        this.app.get('/debug/state/:documentId', (req: Request, res: Response) => {
            const documentId = req.params['documentId'] as string;
            const meta = engine.getDocument(documentId);
            if (!meta) {
                res.status(404).json({
                    success: false,
                    error: `Document not found: ${documentId}`,
                });
                return;
            }
            res.json({
                success: true,
                data: {
                    documentId,
                    type: meta.type,
                    value: this.readDocumentValue(documentId, meta.type),
                },
            });
        });

        this.app.get('/debug/vectorclock', (req: Request, res: Response) => {
            res.json({ success: true, data: engine.getVectorClock() });
        });

        this.app.get('/debug/log', async (req: Request, res: Response) => {
            try {
                const limit = Number(req.query['limit']) || 50;
                const after = req.query['after'] !== undefined ? Number(req.query['after']) : -1;
                const entries = await log.getAfter(after);
                const limited = entries.slice(0, limit);
                res.json({
                    success: true,
                    data: {
                        entries: limited,
                        returnedCount: limited.length,
                        totalAvailable: entries.length,
                    },
                });
            } catch (err) {
                res.status(500).json({
                    success: false,
                    error: err instanceof Error ? err.message : 'Unknown error',
                });
            }
        });

        this.app.get('/debug/sync', (req: Request, res: Response) => {
            res.json({
                success: true,
                data: {
                    myVectorClock: syncEngine.getMyVectorClock(),
                    peers: syncEngine.getAllPeers(),
                    connections: transport.getPeerConnectionStatus(),
                    syncStatus: syncEngine.getSyncStatus(),
                },
            });
        });

        this.app.post('/debug/snapshot/create', async (req: Request, res: Response) => {
            try {
                const filePath = await snapshotManager.createSnapshot(engine, log);
                res.json({ success: true, data: { filePath } });
            } catch (err) {
                res.status(500).json({
                    success: false,
                    error: err instanceof Error ? err.message : 'Unknown error',
                });
            }
        });
    }
}
