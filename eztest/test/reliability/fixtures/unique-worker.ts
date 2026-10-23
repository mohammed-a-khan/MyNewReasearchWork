// A worker process for the cross-process uniqueness test: prints 2000 unique values as JSON.
import { uniqueValue } from '../../../src/core/index.js';

const out: string[] = [];
for (let i = 0; i < 2000; i++) out.push(uniqueValue('ORD-'));
process.stdout.write(JSON.stringify(out));
