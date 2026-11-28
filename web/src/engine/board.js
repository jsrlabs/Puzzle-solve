// Finds the partly assembled puzzle in the table photo and works out which cells are already in place.
//
// 1. The assembled puzzle (usually at least its border) is the photo's best "picture quadrilateral": long
//    straight outer edges with the picture inside and the plain mat outside (same detector as the box).
// 2. The box picture is mapped onto that quad in each of the 4 possible rotations; the rotation whose
//    content correlates best with the photo wins (and must clearly beat the others).
// 3. Every cell is compared with the box picture under a color correction fitted on well-matching cells.
//    Cells that match are "placed". Loose pieces lying inside the frame don't match, so they aren't.

import { applyH, homography, invertH, quadSize } from './geometry.js';
import { median } from './images.js';
import { detectPictureQuad } from './quad.js';

const S = 6; // samples per side inside each cell

/** Sample positions (box work coordinates) for every cell: S x S points over the cell's inner 70%. */
function cellSamples(grid, cell) {
  const pts = [];
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
    const list = [];
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      list.push({ x: (c + 0.15 + (0.7 * (i + 0.5)) / S) * cell, y: (r + 0.15 + (0.7 * (j + 0.5)) / S) * cell });
    }
    pts.push(list);
  }
  return pts;
}

function ncc(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa < 1e-6 || sbb < 1e-6 ? 0 : sab / Math.sqrt(saa * sbb);
}

/**
 * Layout suggested by the assembled puzzle in the photo. Pieces are close to square, so the board's shape
 * (width / height) pins down columns / rows precisely; the piece size measured from loose pieces (accurate to
 * only a few percent) sets the overall scale, and the advertised piece count breaks ties.
 */
export function gridFromBoard(quad, bodyPx, count) {
  const { w, h } = quadSize(quad);
  const ec = w / bodyPx, er = h / bodyPx, aspect = w / h;
  let best = null;
  for (let cols = Math.max(2, Math.floor(ec * 0.8)); cols <= Math.ceil(ec * 1.2); cols++) {
    for (let rows = Math.max(2, Math.floor(er * 0.8)); rows <= Math.ceil(er * 1.2); rows++) {
      const countErr = count ? Math.abs(cols * rows - count) / count : 0;
      if (count && countErr > 0.08) continue;
      const shapeErr = Math.abs(Math.log(cols / rows / aspect));
      const sizeErr = Math.abs(Math.log(cols / ec)) + Math.abs(Math.log(rows / er));
      const err = 3 * shapeErr + 0.5 * sizeErr + 0.3 * countErr;
      if (!best || err < best.err) best = { cols, rows, err };
    }
  }
  return best && { cols: best.cols, rows: best.rows };
}

/**
 * Box art is often cropped slightly differently from the real puzzle. `affine` maps puzzle coordinates
 * (cols*cell x rows*cell) to box-picture coordinates: b = (sx * p.x + tx, sy * p.y + ty).
 */
export const IDENTITY_AFFINE = Object.freeze({ sx: 1, sy: 1, tx: 0, ty: 0 });

export function toBox(A, x, y) { return { x: A.sx * x + A.tx, y: A.sy * y + A.ty }; }
export function fromBox(A, x, y) { return { x: (x - A.tx) / A.sx, y: (y - A.ty) / A.sy }; }

/** Mean correlation of the best-matching `frac` of cells, with the box sampled through affine A. */
function alignmentScore(cells, boxLab, A, frac) {
  const scores = new Float32Array(cells.length);
  const n = S * S;
  const bl = new Float32Array(n), ba = new Float32Array(n), bb = new Float32Array(n);
  cells.forEach((c, k) => {
    for (let i = 0; i < n; i++) {
      const q = toBox(A, c.pts[i].x, c.pts[i].y);
      bl[i] = boxLab.l.sample(q.x, q.y); ba[i] = boxLab.a.sample(q.x, q.y); bb[i] = boxLab.b.sample(q.x, q.y);
    }
    scores[k] = 0.5 * ncc(c.pl, bl) + 0.25 * ncc(c.pa, ba) + 0.25 * ncc(c.pb, bb);
  });
  scores.sort();
  const m = Math.max(4, Math.round(cells.length * frac));
  let sum = 0;
  for (let i = scores.length - m; i < scores.length; i++) sum += scores[i];
  return sum / m;
}

/** Finds the scale/shift of the box picture that best lines it up with the assembled part. */
function registerAffine(cells, boxLab, W, H) {
  const frac = 0.06;
  let best = { ...IDENTITY_AFFINE }, bestScore = alignmentScore(cells, boxLab, best, frac);
  // Coarse search over shifts (up to 4% of the picture), then refine scales and shifts.
  for (let ty = -0.04; ty <= 0.0401; ty += 0.01) for (let tx = -0.04; tx <= 0.0401; tx += 0.01) {
    const A = { sx: 1, sy: 1, tx: tx * W, ty: ty * H };
    const sc = alignmentScore(cells, boxLab, A, frac);
    if (sc > bestScore) { bestScore = sc; best = A; }
  }
  let step = { s: 0.02, t: 0.005 };
  for (let iter = 0; iter < 40 && step.s > 0.002; iter++) {
    let improved = false;
    for (const [key, d] of [['sx', step.s], ['sy', step.s], ['tx', step.t * W], ['ty', step.t * H]]) {
      for (const sign of [1, -1]) {
        const A = { ...best, [key]: best[key] + sign * d };
        if (key === 'sx' || key === 'sy') {
          // Scale about the center so shifts and scales stay independent.
          const center = key === 'sx' ? W / 2 : H / 2, t = key === 'sx' ? 'tx' : 'ty';
          A[t] = best[t] - sign * d * center;
          if (A[key] < 0.85 || A[key] > 1.15) continue;
        }
        const sc = alignmentScore(cells, boxLab, A, frac);
        if (sc > bestScore + 1e-4) { bestScore = sc; best = A; improved = true; }
      }
    }
    if (!improved) step = { s: step.s / 2, t: step.t / 2 };
  }
  return { A: best, score: bestScore };
}

/** Photo colors at every cell's sample points, for puzzle->photo homography H. */
function photoCells(samples, H, photoLab) {
  return samples.map((pts) => {
    const n = pts.length, pl = new Float32Array(n), pa = new Float32Array(n), pb = new Float32Array(n);
    pts.forEach((s, i) => {
      const q = applyH(H, s.x, s.y);
      pl[i] = photoLab.l.sample(q.x, q.y); pa[i] = photoLab.a.sample(q.x, q.y); pb[i] = photoLab.b.sample(q.x, q.y);
    });
    return { pts, pl, pa, pb };
  });
}

/** Moves the four photo corners a little at a time while that improves the alignment. */
function refineCorners(target, corners, samples, photoLab, boxLab, A, cellPx) {
  let quad = target.map((p) => ({ ...p }));
  const score = (q) => {
    const H = homography(corners, q);
    return H ? alignmentScore(photoCells(samples, H, photoLab), boxLab, A, 0.06) : -1;
  };
  let best = score(quad);
  let step = cellPx * 0.8;
  while (step > cellPx * 0.04) {
    let improved = false;
    for (let k = 0; k < 4; k++) for (const axis of ['x', 'y']) for (const sign of [1, -1]) {
      const q = quad.map((p) => ({ ...p }));
      q[k][axis] += sign * step;
      const sc = score(q);
      if (sc > best + 1e-4) { best = sc; quad = q; improved = true; }
    }
    if (!improved) step /= 2;
  }
  return { quad, score: best };
}

/**
 * @param photo RgbaImage (analysis resolution); photoLab: its LabImage blurred to roughly piece-detail level
 * @param boxLab box picture resized to grid.cols*cell x grid.rows*cell (lightly blurred)
 * @param quads candidate outlines of the assembled puzzle in the photo (best first); detected if omitted
 * @returns null, or { quad, H (puzzle coords -> photo), Hinv, affine (puzzle -> box), placed: Set<"c,r">,
 *          color (photo -> box Lab), quarterTurns, matchScore }
 */
export function detectBoard({ photo, photoLab, boxLab, grid, cell, quads = null, background = null, refine = true }) {
  if (!quads) {
    const found = detectPictureQuad(photo);
    quads = found ? found.candidates.map((c) => c.quad) : [];
  }
  if (quads.length === 0) return null;
  const W = grid.cols * cell, Hh = grid.rows * cell;
  const corners = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hh }, { x: 0, y: Hh }];
  const allSamples = cellSamples(grid, cell);
  // Registration uses every other cell (checkerboard) to halve the work.
  const regSamples = allSamples.filter((_, k) => (k % grid.cols + Math.floor(k / grid.cols)) % 2 === 0);
  const boxAspect = W / Hh;

  // Quick score for every candidate outline in every compatible rotation.
  const tries = [];
  for (const quad of quads) {
    const { w: qw, h: qh } = quadSize(quad);
    for (let o = 0; o < 4; o++) {
      const target = [0, 1, 2, 3].map((k) => quad[(k + o) % 4]);
      const aspect = o % 2 ? qh / qw : qw / qh;
      if (Math.abs(Math.log(aspect / boxAspect)) > 0.25) continue;
      const H = homography(corners, target);
      if (!H) continue;
      const cells = photoCells(regSamples, H, photoLab);
      tries.push({ quad, o, target, cells, score: alignmentScore(cells, boxLab, IDENTITY_AFFINE, 0.06) });
    }
  }
  if (tries.length === 0) return null;
  tries.sort((a, b) => b.score - a.score);
  // Full registration of the most promising few, plus the best of another rotation for a fair comparison.
  const contenders = tries.slice(0, 3);
  const other = tries.find((t) => t.o !== tries[0].o);
  if (other && !contenders.includes(other)) contenders.push(other);
  for (const t of contenders) {
    const { A, score } = registerAffine(t.cells, boxLab, W, Hh);
    t.A = A; t.score = score;
  }
  contenders.sort((a, b) => b.score - a.score);
  const best = contenders[0];
  // The correct rotation must clearly beat the best wrong one.
  const runnerUp = Math.max(0, ...contenders.filter((t) => t.o !== best.o).map((t) => t.score));
  // Fine-tune the corners in the photo (the outline found from edges can be a few pixels off).
  const photoCell = quadSize(best.target).w / (best.o % 2 ? grid.rows : grid.cols);
  best.rawQuad = best.quad;
  if (refine) {
    const refined = refineCorners(best.target, corners, regSamples, photoLab, boxLab, best.A, photoCell);
    best.target = refined.quad;
    best.score = Math.max(best.score, refined.score);
  }
  best.H = homography(corners, best.target);
  best.cells = photoCells(allSamples, best.H, photoLab);
  if (best.score < 0.5 || best.score - runnerUp < 0.1) return null;

  // Per-cell comparison through the chosen alignment.
  const n = S * S;
  const cells = best.cells.map((c) => {
    const b = new Float32Array(3 * n), p = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const q = toBox(best.A, c.pts[i].x, c.pts[i].y);
      b[3 * i] = boxLab.l.sample(q.x, q.y); b[3 * i + 1] = boxLab.a.sample(q.x, q.y); b[3 * i + 2] = boxLab.b.sample(q.x, q.y);
      p[3 * i] = c.pl[i]; p[3 * i + 1] = c.pa[i]; p[3 * i + 2] = c.pb[i];
    }
    const ch = (arr, k) => arr.filter((_, i) => i % 3 === k);
    const corr = 0.5 * ncc(ch(p, 0), ch(b, 0)) + 0.25 * ncc(ch(p, 1), ch(b, 1)) + 0.25 * ncc(ch(p, 2), ch(b, 2));
    // How much of the cell shows the bare mat, and how much detail the box picture has there.
    let mat = 0, mean = 0, varL = 0;
    for (let i = 0; i < n; i++) {
      if (background && Math.hypot((p[3 * i] - background.l) * 0.6, p[3 * i + 1] - background.a, p[3 * i + 2] - background.b) < 10) mat++;
      mean += b[3 * i];
    }
    mean /= n;
    for (let i = 0; i < n; i++) varL += (b[3 * i] - mean) ** 2;
    return { p, b, ncc: corr, mat: mat / n, textured: Math.sqrt(varL / n) > 6 };
  });
  const good = cells.filter((c) => c.ncc > 0.6);
  // A real assembled area has a fair number of clearly matching cells (chance alignments of loose pieces
  // produce only a handful).
  if (good.length < Math.max(8, cells.length * 0.02)) return null;
  const color = fitColor(good);
  const errs = cells.map((c) => {
    let e = 0;
    for (let i = 0; i < c.p.length; i += 3) {
      const dl = color.gainL * c.p[i] + color.offL - c.b[i];
      const da = color.gainA * c.p[i + 1] + color.offA - c.b[i + 1];
      const db = color.gainB * c.p[i + 2] + color.offB - c.b[i + 2];
      e += dl * dl + da * da + db * db;
    }
    return Math.sqrt(e / (c.p.length / 3));
  });
  const ref = median(cells.map((c, k) => (c.ncc > 0.6 ? errs[k] : null)).filter((v) => v !== null));
  if (ref > 25) return null; // matching structure but wrong colors: not the puzzle
  const limit = Math.max(10, ref * 2);
  const placed = new Set();
  errs.forEach((e, k) => {
    const c = cells[k];
    if (c.mat > 0.25) return; // mostly bare mat: nothing there
    // Detailed cells must match in structure; plain cells (sky, water) can only be judged by color.
    let ok = c.textured ? (c.ncc > 0.35 && e <= limit) || (c.ncc > 0.7 && e <= limit * 1.5) : e <= limit * 0.7;
    // The board outline was found from the assembled edge, so a non-mat edge cell that roughly matches is
    // almost certainly part of the frame.
    const col = k % grid.cols, row = Math.floor(k / grid.cols);
    const onEdge = col === 0 || row === 0 || col === grid.cols - 1 || row === grid.rows - 1;
    if (onEdge && c.mat < 0.15 && (c.ncc > 0.1 || e <= limit * 1.3)) ok = true;
    if (ok) placed.add(`${k % grid.cols},${Math.floor(k / grid.cols)}`);
  });
  tidyPlaced(placed, cells, grid);
  return {
    quad: [0, 1, 2, 3].map((k) => best.target[(k - best.o + 4) % 4]), // back in [tl, tr, br, bl] photo order
    edgeQuad: best.rawQuad, // the outline as found from edges, before fine-tuning
    H: best.H,
    Hinv: invertH(best.H),
    affine: best.A,
    placed,
    color,
    quarterTurns: best.o,
    matchScore: best.score,
  };
}

/**
 * Assembled areas are connected: drop isolated cells (a loose piece that happens to look right), and close
 * small gaps along the edge of the puzzle where the frame clearly continues (e.g. under a box-art banner).
 */
function tidyPlaced(placed, cells, grid) {
  const key = (c, r) => `${c},${r}`;
  const isEdge = (c, r) => c === 0 || r === 0 || c === grid.cols - 1 || r === grid.rows - 1;
  // Close gaps of up to 2 cells along the edge, if the gap doesn't show bare mat.
  const edge = [];
  for (let c = 0; c < grid.cols; c++) edge.push([c, 0]);
  for (let r = 1; r < grid.rows; r++) edge.push([grid.cols - 1, r]);
  for (let c = grid.cols - 2; c >= 0; c--) edge.push([c, grid.rows - 1]);
  for (let r = grid.rows - 2; r > 0; r--) edge.push([0, r]);
  const m = edge.length;
  for (let i = 0; i < m; i++) {
    const [c, r] = edge[i];
    if (placed.has(key(c, r))) continue;
    for (let gap = 1; gap <= 2; gap++) {
      // Is this cell inside a run of `gap` unplaced cells bounded by placed cells?
      for (let start = i - gap + 1; start <= i; start++) {
        const before = edge[(start - 1 + m) % m], after = edge[(start + gap) % m];
        const run = Array.from({ length: gap }, (_, k) => edge[(start + k + m) % m]);
        if (!placed.has(key(...before)) || !placed.has(key(...after))) continue;
        if (run.some(([cc, rr]) => placed.has(key(cc, rr)) || cells[rr * grid.cols + cc].mat > 0.25)) continue;
        for (const [cc, rr] of run) placed.add(key(cc, rr));
      }
    }
  }
  // Remove components of fewer than 3 cells (edge cells next to the frame are kept by the step above).
  const seen = new Set();
  for (const k of [...placed]) {
    if (seen.has(k)) continue;
    const comp = [k], stack = [k];
    seen.add(k);
    while (stack.length) {
      const [c, r] = stack.pop().split(',').map(Number);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = key(c + dc, r + dr);
        if (placed.has(nk) && !seen.has(nk)) { seen.add(nk); comp.push(nk); stack.push(nk); }
      }
    }
    const touchesEdge = comp.some((ck) => isEdge(...ck.split(',').map(Number)));
    if (comp.length < 3 && !(touchesEdge && comp.length >= 2)) for (const ck of comp) placed.delete(ck);
  }
}

function fitColor(cells) {
  const fit = (ch) => {
    let n = 0, mx = 0, my = 0;
    for (const c of cells) for (let i = ch; i < c.p.length; i += 3) { mx += c.p[i]; my += c.b[i]; n++; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0;
    for (const c of cells) for (let i = ch; i < c.p.length; i += 3) { sxy += (c.p[i] - mx) * (c.b[i] - my); sxx += (c.p[i] - mx) ** 2; }
    const gain = sxx > 1e-6 ? Math.min(1.6, Math.max(0.6, sxy / sxx)) : 1;
    return [gain, my - gain * mx];
  };
  const [gainL, offL] = fit(0), [gainA, offA] = fit(1), [gainB, offB] = fit(2);
  return { gainL, offL, gainA, offA, gainB, offB };
}

/**
 * Mask (1 = part of the assembled puzzle) over the photo: placed cells plus a margin for their knobs.
 */
export function boardMask(board, grid, cell, w, h) {
  const mask = new Uint8Array(w * h);
  const xs = board.quad.map((p) => p.x), ys = board.quad.map((p) => p.y);
  const pad = 0.6 * Math.max(...[0, 1, 2, 3].map((k) => Math.hypot(board.quad[k].x - board.quad[(k + 1) % 4].x, board.quad[k].y - board.quad[(k + 1) % 4].y))) / Math.max(grid.cols, grid.rows);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad)), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys) + pad));
  const knob = 0.3; // knobs reach ~0.3 cell beyond a piece's body
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = applyH(board.Hinv, x, y);
    const u = p.x / cell, v = p.y / cell;
    const c0 = Math.floor(u - knob), c1 = Math.floor(u + knob), r0 = Math.floor(v - knob), r1 = Math.floor(v + knob);
    let hit = false;
    for (let r = r0; r <= r1 && !hit; r++) for (let c = c0; c <= c1 && !hit; c++) {
      if (board.placed.has(`${c},${r}`)) hit = true;
    }
    if (hit) mask[y * w + x] = 1;
  }
  return mask;
}


/** Is photo point (x, y) (board detection coordinates) on a placed piece, including its knobs? */
export function onBoard(board, cell, x, y) {
  const p = applyH(board.Hinv, x, y);
  const u = p.x / cell, v = p.y / cell, knob = 0.3;
  for (let r = Math.floor(v - knob); r <= Math.floor(v + knob); r++) {
    for (let c = Math.floor(u - knob); c <= Math.floor(u + knob); c++) if (board.placed.has(`${c},${r}`)) return true;
  }
  return false;
}
