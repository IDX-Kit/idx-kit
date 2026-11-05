import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync('contract-lint.json', 'utf8'));
if (!Array.isArray(report.problems)) throw new Error('Unrecognized lint report');
if (report.problems.length) throw new Error(JSON.stringify(report.problems));
