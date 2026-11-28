// Unpacks a "[Puzzle report]" issue body (from the app's "Report a problem" button) into a folder:
// report.json (the numbers) and one JPEG per picture (piece, boxSpot, boxWhole, tableSpot).
//   node tools/decode-report.mjs <issue-body.md> <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , input, out] = process.argv;
if (!input || !out) { console.error('usage: node tools/decode-report.mjs <issue-body.md> <out-dir>'); process.exit(1); }
const text = readFileSync(input, 'utf8').replace(/\r\n/g, '\n');
if (!text.includes('<!-- puzzle-report v1 -->')) console.warn('warning: no report marker found');
mkdirSync(out, { recursive: true });
const json = text.match(/```json\n([\s\S]*?)\n```/);
if (json) writeFileSync(join(out, 'report.json'), json[1]);
const found = [];
for (const m of text.matchAll(/```image\/jpeg (\w+)\n([A-Za-z0-9+/=\s]+?)\n```/g)) {
  writeFileSync(join(out, `${m[1]}.jpg`), Buffer.from(m[2].replace(/\s+/g, ''), 'base64'));
  found.push(m[1]);
}
console.log(JSON.stringify({ report: !!json, images: found }));
