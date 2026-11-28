// Matching benchmark on the real photo: each piece already assembled on the board (about 115 border pieces) is
// treated as if it were loose, and we count how often the matcher puts it back in its own cell.
// Run with: npm run bench
import { loadPhoto } from './photos.js';
import { LabImage } from '../src/engine/images.js';
import { detectPictureQuad } from '../src/engine/quad.js';
import { warpQuad, applyH } from '../src/engine/geometry.js';
import { analyze, DEFAULT_PARAMS } from '../src/engine/solver.js';
import { PieceLocator } from '../src/engine/locator.js';
const bp = loadPhoto('box-hometown-1000.jpg');
const box = warpQuad(bp, detectPictureQuad(bp).quad);
const photo = loadPhoto('table-hometown-1000.jpg');
const a = analyze(box, photo, { cols: 37, rows: 27, pieceCount: 1000 });
const { grid, board, boxCells } = a;
const cell = DEFAULT_PARAMS.cellPx, workW = grid.cols * cell, workH = grid.rows * cell;
const kx = box.width / workW, ky = box.height / workH;
const A = { sx: boxCells.cw / (cell * kx), sy: boxCells.ch / (cell * ky), tx: boxCells.x0 / kx, ty: boxCells.y0 / ky };
const boxLab = LabImage.from(box.downscaleToMax(Math.max(workW, workH) * 2)).resize(workW, workH).boxBlur(1);
const pitch = Math.hypot(...['x', 'y'].map(k => applyH(board.H, 1, 0)[k] - applyH(board.H, 0, 0)[k]));
const blurR = Math.round(1.5 * pitch / cell);
const lab = LabImage.from(photo).boxBlur(blurR);
const locator = new PieceLocator(boxLab, DEFAULT_PARAMS);
// Color model: fit photo->box on the placed cells themselves would leak; use a plain global-mean model per channel.
const g = 12, span = 0.8;
const samplesFor = (c, r) => {
  const u = [], v = [], l = [], aa = [], b = [];
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
    const su = -span / 2 + span * i / (g - 1), sv = -span / 2 + span * j / (g - 1);
    const q = applyH(board.H, c + 0.5 + su, r + 0.5 + sv);
    u.push(su); v.push(sv); l.push(lab.l.sample(q.x, q.y)); aa.push(lab.a.sample(q.x, q.y)); b.push(lab.b.sample(q.x, q.y));
  }
  const F = Float32Array; return { u: F.from(u), v: F.from(v), l: F.from(l), a: F.from(aa), b: F.from(b) };
};
const cells = board.placed.map(k => k.split(',').map(Number));
const all = cells.map(([c, r]) => samplesFor(c, r));
// color model from all placed cells vs box (as the app does via board.color) - approximated by mean/std match
const stat = (arr) => { const m = arr.reduce((s, x) => s + x, 0) / arr.length; return [m, Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length)]; };
const cat = (k) => all.flatMap(s => [...s[k]]);
const boxCat = (k) => cells.flatMap(([c, r]) => { const out = []; for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) { const x = A.sx * (c + 0.5 - span / 2 + span * i / (g - 1)) * cell + A.tx, y = A.sy * (r + 0.5 - span / 2 + span * j / (g - 1)) * cell + A.ty; out.push(boxLab[k].sample(x, y)); } return out; });
const color = {};
for (const [k, K] of [['l', 'L'], ['a', 'A'], ['b', 'B']]) { const [mp, sp] = stat(cat(k)), [mb, sb] = stat(boxCat(k)); const gain = sb / sp; color['gain' + K] = gain; color['off' + K] = mb - gain * mp; }
let exact = 0, near = 0, n = 0;
const t0 = performance.now();
cells.forEach(([c, r], i) => {
  const m = locator.locate(all[i], color);
  if (!m) return;
  n++;
  const pc = Math.floor(((m.x - A.tx) / A.sx) / cell), pr = Math.floor(((m.y - A.ty) / A.sy) / cell);
  if (pc === c && pr === r) exact++;
  if (Math.abs(pc - c) <= 1 && Math.abs(pr - r) <= 1) near++;
});
console.log(`grid ${grid.cols}x${grid.rows} placed ${cells.length}: exact ${exact}/${n} (${(100 * exact / n).toFixed(0)}%), within 1 cell ${near}/${n} (${(100 * near / n).toFixed(0)}%)  ${Math.round(performance.now() - t0)}ms`);
