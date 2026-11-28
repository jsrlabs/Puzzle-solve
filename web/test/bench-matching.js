// Matching benchmark on the real photo. Each piece already assembled on the board is treated as if it were
// loose, and we count how often the matcher puts it back in its own cell. Only cells whose spot is visible in
// the box art count (not the top row, which the box's title banner covers, nor cells cut off the box art);
// the mat showing through a piece's holes is ignored.
//   npm run bench               the app's matcher (coarse only, and with the high-detail second look)
//   WITH_CV=1 npm run bench     also OpenCV template matching, for comparison (slow; needs the dev dependency)
import { createRequire } from 'node:module';
import { loadPhoto } from './photos.js';
import { LabImage } from '../src/engine/images.js';
import { detectPictureQuad } from '../src/engine/quad.js';
import { warpQuad, applyH } from '../src/engine/geometry.js';
import { analyze, DEFAULT_PARAMS } from '../src/engine/solver.js';
import { backgroundColor } from '../src/engine/segmenter.js';
import { PieceLocator } from '../src/engine/locator.js';
let cv = null;
if (process.env.WITH_CV) {
  cv = createRequire(import.meta.url)('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => { cv.onRuntimeInitialized = r; });
}

const DIM = +(process.env.BENCH_DIM || 4096);
const bp = loadPhoto('box-hometown-1000.jpg', DIM);
const box = warpQuad(bp, detectPictureQuad(bp).quad, DIM);
const photo = loadPhoto('table-hometown-1000.jpg', DIM);
const a = analyze(box, photo, { cols: 37, rows: 27, pieceCount: 1000 }, () => {}, { ...DEFAULT_PARAMS, ...(process.env.OVERVIEW ? { overviewMaxDim: +process.env.OVERVIEW } : {}) });
const { board, boxCells, grid } = a;
const inside = ([c, r]) => r > 0 && boxCells.x0 + c * boxCells.cw >= 0 && boxCells.y0 + r * boxCells.ch >= 0 &&
  boxCells.x0 + (c + 1) * boxCells.cw <= box.width && boxCells.y0 + (r + 1) * boxCells.ch <= box.height;
const cells = board.placed.map((k) => k.split(',').map(Number)).filter(inside);
console.log(`grid ${grid.cols}x${grid.rows}, placed ${board.placed.length}, fair subset ${cells.length}`);
const photoLab = LabImage.from(photo);
const bg = backgroundColor(photoLab);
const isMat = (x, y) => Math.hypot((photoLab.l.sample(x, y) - bg.l), photoLab.a.sample(x, y) - bg.a, photoLab.b.sample(x, y) - bg.b) < 14;
const pitch = Math.hypot(applyH(board.H, 1, 0).x - applyH(board.H, 0, 0).x, applyH(board.H, 1, 0).y - applyH(board.H, 0, 0).y);
const report = (name, res, ms) => {
  const n = res.length, e = res.filter((x) => x[0]).length, nr = res.filter((x) => x[1]).length;
  console.log(`${name}: exact ${e}/${n} (${Math.round(100 * e / n)}%), within 1 cell ${nr}/${n} (${Math.round(100 * nr / n)}%)  ${Math.round(ms)}ms`);
};
const score = (c, r, pc, pr) => [pc === c && pr === r, Math.abs(pc - c) <= 1 && Math.abs(pr - r) <= 1];

// ---- Current matcher (color sample grid), at two resolutions ----
for (const [cellPx, g, fineCell, fineG] of [[16, 12, 0, 0], [16, 12, 48, 20], [16, 12, 48, 24]]) {
  const t0 = performance.now();
  const W = grid.cols * cellPx, H = grid.rows * cellPx;
  const kx = box.width / W, ky = box.height / H;
  const A = { sx: boxCells.cw / (cellPx * kx), sy: boxCells.ch / (cellPx * ky), tx: boxCells.x0 / kx, ty: boxCells.y0 / ky };
  const boxLab = LabImage.from(box.downscaleToMax(Math.max(W, H) * 2)).resize(W, H).boxBlur(1);
  const lab = photoLab.boxBlur(Math.round(1.5 * pitch / cellPx));
  const params = { ...DEFAULT_PARAMS, cellPx, sampleGrid: g, fineCandidates: 25 };
  const loc = new PieceLocator(boxLab, params);
  let fineAll = null;
  if (fineCell) {
    loc.setFine(LabImage.from(box.downscaleToMax(Math.max(grid.cols, grid.rows) * fineCell * 2)).resize(grid.cols * fineCell, grid.rows * fineCell).boxBlur(1), fineCell);
    const flab = photoLab.boxBlur(Math.max(1, Math.round(1.5 * pitch / fineCell)));
    fineAll = cells.map(([c, r]) => {
      const u = [], v = [], l = [], aa = [], b = [];
      for (let j = 0; j < fineG; j++) for (let i = 0; i < fineG; i++) {
        const su = -0.4 + 0.8 * i / (fineG - 1), sv = -0.4 + 0.8 * j / (fineG - 1);
        const q = applyH(board.H, c + 0.5 + su, r + 0.5 + sv);
        if (isMat(q.x, q.y)) continue;
        u.push(su); v.push(sv); l.push(flab.l.sample(q.x, q.y)); aa.push(flab.a.sample(q.x, q.y)); b.push(flab.b.sample(q.x, q.y));
      }
      const F = Float32Array; return { u: F.from(u), v: F.from(v), l: F.from(l), a: F.from(aa), b: F.from(b) };
    });
  }
  const all = cells.map(([c, r]) => {
    const u = [], v = [], l = [], aa = [], b = [];
    for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
      const su = -0.4 + 0.8 * i / (g - 1), sv = -0.4 + 0.8 * j / (g - 1);
      const q = applyH(board.H, c + 0.5 + su, r + 0.5 + sv);
      if (isMat(q.x, q.y)) continue; // the holes of the piece show the mat
      u.push(su); v.push(sv); l.push(lab.l.sample(q.x, q.y)); aa.push(lab.a.sample(q.x, q.y)); b.push(lab.b.sample(q.x, q.y));
    }
    const F = Float32Array; return { u: F.from(u), v: F.from(v), l: F.from(l), a: F.from(aa), b: F.from(b) };
  });
  // color model: global mean/std match over these samples vs. the box at the true cells (same for all methods)
  const st = (x) => { const m = x.reduce((s, y) => s + y, 0) / x.length; return [m, Math.sqrt(x.reduce((s, y) => s + (y - m) ** 2, 0) / x.length)]; };
  const color = {};
  for (const [k, K] of [['l', 'L'], ['a', 'A'], ['b', 'B']]) {
    const pv = all.flatMap((s) => [...s[k]]);
    const bv = cells.flatMap(([c, r], i) => [...all[i].u].map((su, n) => boxLab[k].sample(A.sx * (c + 0.5 + su) * cellPx + A.tx, A.sy * (r + 0.5 + all[i].v[n]) * cellPx + A.ty)));
    const [mp, sp] = st(pv), [mb, sb] = st(bv); color['gain' + K] = sb / sp; color['off' + K] = mb - (sb / sp) * mp;
  }
  const res = cells.map(([c, r], i) => {
    const m = loc.locate(all[i], color, fineAll && fineAll[i]);
    if (!m) return [false, false];
    return score(c, r, Math.floor(((m.x - A.tx) / A.sx) / cellPx), Math.floor(((m.y - A.ty) / A.sy) / cellPx));
  });
  report(`current matcher cell=${cellPx}px grid=${g}${fineCell ? ` + fine check ${fineCell}px grid=${fineG}` : ''}`, res, performance.now() - t0);
}

if (process.env.WITH_CV) { // OpenCV template matching (mat pixels filled with the piece's mean color)
  const t0 = performance.now();
  const toMat = (img) => { const m = new cv.Mat(img.height, img.width, cv.CV_8UC4); m.data.set(img.data); return m; };
  const down = 0.5;
  const boxMat = toMat(box), boxSmall = new cv.Mat(), boxS = new cv.Mat();
  cv.resize(boxMat, boxSmall, new cv.Size(0, 0), down, down, cv.INTER_AREA);
  cv.cvtColor(boxSmall, boxS, cv.COLOR_RGBA2RGB);
  const sz = Math.round(0.8 * boxCells.cw * down);
  const res = cells.map(([c, r]) => {
    // Upright patch of the inner 80% of the piece, sampled straight from the photo at template size.
    const t = new cv.Mat(sz, sz, cv.CV_8UC3);
    const mat = new Uint8Array(sz * sz);
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) {
      const q = applyH(board.H, c + 0.1 + 0.8 * (x + 0.5) / sz, r + 0.1 + 0.8 * (y + 0.5) / sz);
      const px = Math.min(photo.width - 1, Math.max(0, Math.round(q.x))), py = Math.min(photo.height - 1, Math.max(0, Math.round(q.y)));
      const i = (py * photo.width + px) * 4, o = (y * sz + x) * 3;
      t.data[o] = photo.data[i]; t.data[o + 1] = photo.data[i + 1]; t.data[o + 2] = photo.data[i + 2];
      if (isMat(q.x, q.y)) mat[y * sz + x] = 1; else { sr += photo.data[i]; sg += photo.data[i + 1]; sb += photo.data[i + 2]; n++; }
    }
    for (let k = 0; k < sz * sz; k++) if (mat[k]) { t.data[3 * k] = sr / n; t.data[3 * k + 1] = sg / n; t.data[3 * k + 2] = sb / n; }
    const turn = Math.floor(Math.random() * 4);
    let cand = t;
    for (let k = 0; k < turn; k++) { const u = new cv.Mat(); cv.rotate(cand, u, cv.ROTATE_90_CLOCKWISE); cand.delete(); cand = u; }
    let best = { v: -2 };
    for (let q = 0; q < 4; q++) {
      const out = new cv.Mat();
      cv.matchTemplate(boxS, cand, out, cv.TM_CCOEFF_NORMED);
      const mm = cv.minMaxLoc(out);
      if (mm.maxVal > best.v) best = { v: mm.maxVal, x: (mm.maxLoc.x + sz / 2) / down, y: (mm.maxLoc.y + sz / 2) / down };
      out.delete();
      const u = new cv.Mat(); cv.rotate(cand, u, cv.ROTATE_90_CLOCKWISE); cand.delete(); cand = u;
    }
    cand.delete();
    return score(c, r, Math.floor((best.x - boxCells.x0) / boxCells.cw), Math.floor((best.y - boxCells.y0) / boxCells.ch));
  });
  report('OpenCV template (half res, mat masked)', res, performance.now() - t0);
}
process.exit(0);
