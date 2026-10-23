// A "test run" that creates three records, journals them, and crashes before cleanup (exit code 3).
import { CleanupJournal } from '../../../src/data/index.js';

const dir = process.argv[2];
const j = new CleanupJournal(dir);
for (const id of ['R1', 'R2', 'R3']) await j.record({ provider: 'mem', entity: 'Customer', recordId: id, record: { id } });
process.exit(3);
