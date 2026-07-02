import type { NodeId } from './types';

const nodeId: NodeId = process.env['NODE_ID'] ?? 'node-001';
const version: string = '1.0.0';

function printStartupInfo(): void {
    const line: string = '='.repeat(45);
    console.log(line);
    console.log('  CRDT Sync Engine');
    console.log(line);
    console.log(`  Version  : ${version}`);
    console.log(`  Node ID  : ${nodeId}`);
    console.log(`  Node.js  : ${process.version}`);
    console.log(`  Platform : ${process.platform}`);
    console.log(`  Status   : Ready`);
    console.log(line);
}

printStartupInfo();
