// Entry point of the solver: box picture + photo of the table (loose pieces, maybe the partly built puzzle)
// -> where each loose piece goes, which cells are already placed. Pure JavaScript; runs in a Web Worker or Node.

import { boardMask, detectBoard, fromBox, gridFromBoard, IDENTITY_AFFINE } from './board.js';
import { applyH } from './geometry.js';
import { LabImage, median } from './images.js';
import { PieceLocator } from './locator.js';
import { detectPictureQuad } from './quad.js';
import { inMask, segment } from './segmenter.js';

export const DEFAULT_PARAMS = Object.freeze({
  piecesMaxDim: 2400, // longest side the pieces photo is reduced to
  cellPx: 16, // pixels per puzzle cell in the internal box picture
  sampleGrid: 12, // samples per side taken from each piece body
  sampleSpan: 0.8, // fraction of the body that is sampled (avoids cut edges)
  prefilterFraction: 0.1, // fraction of positions kept by the mean-color prefilter
  minBackgroundDistance: 6,
  minPieceAreaFraction: 0.0002,
  minPieceAreaRatio: 0.35,
  maxPieceAreaRatio: 2.0,
  lightnessWeight: 0.7,
});

export const DIRECTIONS = {
  LEFT: { dc: -1, dr: 0 },
  RIGHT: { dc: 1, dr: 0 },
  ABOVE: { dc: 0, dr: -1 },
  BELOW: { dc: 0, dr: 1 },
};

/**
 * Guess the column/row layout from the advertised piece count and the picture's aspect ratio (width/height).
 * E.g. 1000 pieces at 1.6 -> 40 x 25.
 */
export function gridFromPieceCount(count, aspect) {
  let best = { cols: 1, rows: count }, bestErr = Infinity;
  const approx = Math.sqrt(count * aspect);
  for (let cols = Math.max(1, Math.floor(approx * 0.6)); cols <= Math.round(approx * 1.6) + 1; cols++) {
    const rows = Math.max(1, Math.round(count / cols));
    const err = (Math.abs(cols * rows - count) / count) * 4 + Math.abs(Math.log(cols / rows / aspect));
    if (err < bestErr) { bestErr = err; best = { cols, rows }; }
  }
  return best;
}

/**
 * @param {import('./images.js').RgbaImage} box the box picture, cropped to just the puzzle image
 * @param {import('./images.js').RgbaImage} pieces photo of loose pieces on a plain contrasting surface. It may
 *   also show the partly assembled puzzle: it is detected and its cells reported as placed.
 * @param {{cols:number, rows:number, pieceCount?:number, exact?:boolean}} layout the grid; unless `exact`,
 *   it may be corrected from the size of the assembled puzzle in the photo (using pieceCount).
 * @param {(fraction:number, message:string) => void} [progress]
 */
export function analyze(box, pieces, layout, progress = () => {}, params = DEFAULT_PARAMS) {
  const warnings = [];
  const cell = params.cellPx;
  let grid = { cols: layout.cols, rows: layout.rows };

  progress(0.02, 'Finding pieces');
  const small = pieces.downscaleToMax(params.piecesMaxDim);
  const toOriginal = pieces.width / small.width;
  const piecesLab = LabImage.from(small);
  const seg = segment(piecesLab, params);
  if (seg.pieces.length === 0) {
    warnings.push('No pieces found. Lay pieces picture-side up on a plain surface that contrasts with them.');
    return { grid, pieces: [], suggestions: [], warnings, board: null };
  }
  const bodyPx = median(seg.pieces.map((p) => p.bodySize));
  // Blur the pieces photo to match the detail level of the reduced box picture.
  const blurR = Math.max(0, Math.round((1.5 * bodyPx) / cell));
  const blurred = blurR > 0 ? piecesLab.boxBlur(blurR) : piecesLab;

  progress(0.12, 'Looking for the assembled puzzle');
  const found = detectPictureQuad(small);
  const boxLabFor = (g) => LabImage.from(box.downscaleToMax(Math.max(g.cols, g.rows) * cell * 2)).resize(g.cols * cell, g.rows * cell).boxBlur(1);
  // A little extra blur makes the board alignment tolerant of the box art differing slightly.
  const boardFor = (g, qs, lab, refine) => detectBoard({
    photo: small, photoLab: blurred.boxBlur(1), boxLab: lab.boxBlur(1), grid: g, cell, quads: qs, background: seg.background, refine,
  });
  let boxLab = boxLabFor(grid);
  const quads = found ? found.candidates.map((c) => c.quad) : [];
  let board = null;
  if (found && !layout.exact) {
    // The board's size in piece widths tells the real layout (e.g. 38 x 27 rather than 37 x 27 for "1000").
    // Measured on the outline found from edges, before corner fine-tuning (which adapts to the layout it is given).
    const first = boardFor(grid, quads, boxLab, false);
    const g = gridFromBoard(first ? first.edgeQuad : found.quad, bodyPx, layout.pieceCount || grid.cols * grid.rows);
    const boxAspect = box.width / box.height;
    if (g && (g.cols !== grid.cols || g.rows !== grid.rows) && Math.abs(Math.log(g.cols / g.rows / boxAspect)) < 0.12) {
      progress(0.15, 'Measuring the assembled puzzle');
      grid = g;
      boxLab = boxLabFor(g);
    }
  }
  if (found) board = boardFor(grid, quads, boxLab, true);
  const workW = grid.cols * cell, workH = grid.rows * cell;
  const affine = board?.affine ?? IDENTITY_AFFINE;

  // Loose pieces: drop anything that is part of the assembled puzzle.
  let loose = seg.pieces;
  if (board) {
    const mask = boardMask(board, grid, cell, small.width, small.height);
    loose = seg.pieces.filter((p) => {
      let inside = 0, total = 0;
      for (let y = 0; y < p.bboxH; y += 2) for (let x = 0; x < p.bboxW; x += 2) {
        if (!p.mask[y * p.bboxW + x]) continue;
        total++;
        if (mask[(y + p.bboxY) * small.width + x + p.bboxX]) inside++;
      }
      return inside < total * 0.3;
    });
  }
  if (seg.clumps > 0) warnings.push(`${seg.clumps} group(s) of overlapping pieces were skipped. Spread pieces apart so they don't touch.`);
  if (seg.cutOff > 0) warnings.push(`${seg.cutOff} piece(s) touching the edge of the photo or off the mat were skipped.`);
  const samples = loose.map((p) => samplePiece(p, blurred, bodyPx, params));

  progress(0.18, 'Indexing box picture');
  const locator = new PieceLocator(boxLab, params);

  // Color correction: from the assembled puzzle if we found it (exact), otherwise estimated in two passes.
  let color = board ? board.color : initialColorModel(samples, boxLab);
  let matches = [];
  const passes = board ? 1 : 2;
  for (let pass = 0; pass < passes; pass++) {
    matches = samples.map((s, i) => {
      if (i % 4 === 0) progress(0.2 + ((pass + i / samples.length) * 0.78) / passes, passes > 1 ? `Matching pieces (pass ${pass + 1} of 2)` : 'Matching pieces');
      return locator.locate(s, color);
    });
    if (pass === 0 && passes > 1) color = fitColorModel(samples, matches, locator) ?? color;
  }

  progress(0.98, 'Building suggestions');
  // Match positions are in box-picture coordinates; convert to the puzzle's own cells.
  const puzzlePos = matches.map((m) => m && fromBox(affine, m.x, m.y));
  const cellOf = (v, cells) => Math.min(cells - 1, Math.max(0, Math.floor(v / cell)));
  const conf = matches.map((m) => m?.confidence ?? 0);
  // Two pieces claiming the same cell: trust the more confident one.
  const byCell = new Map();
  puzzlePos.forEach((q, i) => {
    if (!q) return;
    const key = cellOf(q.y, grid.rows) * grid.cols + cellOf(q.x, grid.cols);
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(i);
  });
  for (const list of byCell.values()) {
    if (list.length < 2) continue;
    const keep = list.reduce((a, b) => (conf[b] > conf[a] ? b : a));
    for (const i of list) if (i !== keep) conf[i] *= 0.3;
  }

  // Cells in box-image pixels (the affine is an axis-aligned scale + shift).
  const sx = box.width / workW, sy = box.height / workH;
  const boxCells = { x0: affine.tx * sx, y0: affine.ty * sy, cw: cell * affine.sx * sx, ch: cell * affine.sy * sy };
  // Puzzle coordinates -> original photo pixels.
  const toPhoto = board && ((x, y) => { const q = applyH(board.H, x, y); return { x: q.x * toOriginal, y: q.y * toOriginal }; });

  const detected = loose.map((p, i) => {
    const m = matches[i];
    const au = [Math.cos(p.angle), Math.sin(p.angle)], av = [-Math.sin(p.angle), Math.cos(p.angle)];
    const half = bodyPx / 2;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => ({
      x: (p.cx + au[0] * su * half + av[0] * sv * half) * toOriginal,
      y: (p.cy + au[1] * su * half + av[1] * sv * half) * toOriginal,
    }));
    let up = null;
    if (m) {
      // Box "up" is (0,-1); find (u,v) with rot_q(u,v) = (0,-1), then express it in photo coordinates.
      const [u, v] = [[0, -1], [-1, 0], [0, 1], [1, 0]][m.q & 3];
      up = { x: au[0] * u + av[0] * v, y: au[1] * u + av[1] * v };
    }
    let placement = null;
    if (m) {
      const col = cellOf(puzzlePos[i].x, grid.cols), row = cellOf(puzzlePos[i].y, grid.rows);
      placement = {
        col,
        row,
        boxCenter: { x: boxCells.x0 + (col + 0.5) * boxCells.cw, y: boxCells.y0 + (row + 0.5) * boxCells.ch },
        boxCellSize: (boxCells.cw + boxCells.ch) / 2,
        photoTarget: toPhoto ? toPhoto((col + 0.5) * cell, (row + 0.5) * cell) : null,
        confidence: conf[i],
        matchError: m.error,
      };
    }
    return {
      id: i,
      center: { x: p.cx * toOriginal, y: p.cy * toOriginal },
      bodySize: bodyPx * toOriginal,
      corners,
      // The piece's actual detected outline, for highlighting exactly what was found.
      outline: p.outline.map(([x, y]) => ({ x: (x + 0.5) * toOriginal, y: (y + 0.5) * toOriginal })),
      up,
      placement,
    };
  });
  const unmatched = detected.filter((d) => !d.placement).length;
  if (unmatched > 0) warnings.push(`${unmatched} piece(s) could not be matched.`);
  const suggestions = suggestPairs(detected, puzzlePos, cell);

  let boardInfo = null;
  if (board) {
    // Corners of every cell in photo pixels, for drawing; and which way is "up" on the board.
    const c = toPhoto(workW / 2, workH / 2), t = toPhoto(workW / 2, workH / 2 - cell);
    const len = Math.hypot(t.x - c.x, t.y - c.y) || 1;
    boardInfo = {
      quad: board.quad.map((q) => ({ x: q.x * toOriginal, y: q.y * toOriginal })),
      // Homography puzzle cell units (col, row) -> original photo pixels.
      H: scaleH(board.H, toOriginal, cell),
      placed: [...board.placed],
      up: { x: (t.x - c.x) / len, y: (t.y - c.y) / len },
    };
  }
  progress(1, 'Done');
  return { grid, pieces: detected, suggestions, warnings, board: boardInfo, boxCells };
}

/** H maps puzzle work pixels -> analysis photo pixels; return one mapping cell units -> original photo pixels. */
function scaleH(H, toOriginal, cell) {
  const S = [toOriginal, 0, 0, 0, toOriginal, 0, 0, 0, 1];
  const C = [cell, 0, 0, 0, cell, 0, 0, 0, 1];
  const mul = (A, B) => Array.from({ length: 9 }, (_, k) => {
    const r = Math.floor(k / 3), c = k % 3;
    return A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  });
  return mul(mul(S, H), C);
}

function samplePiece(p, img, bodyPx, params) {
  const g = params.sampleGrid, span = params.sampleSpan;
  const cos = Math.cos(p.angle), sin = Math.sin(p.angle);
  const er = Math.max(2, bodyPx * 0.04);
  const u = [], v = [], l = [], a = [], b = [];
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
    const su = -span / 2 + (span * i) / (g - 1), sv = -span / 2 + (span * j) / (g - 1);
    const x = p.cx + (cos * su - sin * sv) * bodyPx;
    const y = p.cy + (sin * su + cos * sv) * bodyPx;
    // Only samples well inside the piece (eroded mask), away from shadows and edges.
    if (!inMask(p, x, y) || !inMask(p, x + er, y) || !inMask(p, x - er, y) || !inMask(p, x, y + er) || !inMask(p, x, y - er)) continue;
    u.push(su); v.push(sv);
    l.push(img.l.sample(x, y)); a.push(img.a.sample(x, y)); b.push(img.b.sample(x, y));
  }
  const F = Float32Array;
  return { u: F.from(u), v: F.from(v), l: F.from(l), a: F.from(a), b: F.from(b) };
}

function stats(values) {
  let m = 0;
  for (const x of values) m += x;
  m /= values.length;
  let v = 0;
  for (const x of values) v += (x - m) ** 2;
  return [m, Math.sqrt(v / values.length)];
}

/** Half-strength correction: the loose pieces may show only part of the picture. */
function initialColorModel(samples, box) {
  const cat = (key) => samples.flatMap((s) => Array.from(s[key]));
  const pl = cat('l'), pa = cat('a'), pb = cat('b');
  if (pl.length === 0) return identityColor();
  const [mpl, spl] = stats(pl), [mpa] = stats(pa), [mpb] = stats(pb);
  const [mbl, sbl] = stats(box.l.data), [mba] = stats(box.a.data), [mbb] = stats(box.b.data);
  const gain = spl > 1e-3 ? 1 + 0.5 * (Math.min(1.6, Math.max(0.6, sbl / spl)) - 1) : 1;
  const target = mpl + 0.5 * (mbl - mpl);
  return { gainL: gain, offL: target - gain * mpl, gainA: 1, offA: (mba - mpa) * 0.3, gainB: 1, offB: (mbb - mpb) * 0.3 };
}

function identityColor() { return { gainL: 1, offL: 0, gainA: 1, offA: 0, gainB: 1, offB: 0 }; }

/** Least-squares per-channel gain/offset from the more confident half of the matches. */
function fitColorModel(samples, matches, locator) {
  const good = matches.map((m, i) => i).filter((i) => matches[i]).sort((a, b) => matches[b].confidence - matches[a].confidence);
  const use = good.slice(0, Math.max(3, good.length >> 1)).filter((i) => matches[i].confidence > 0.1);
  if (use.length < 3) return null;
  const xs = [[], [], []], ys = [[], [], []];
  for (const i of use) {
    const s = samples[i], bc = locator.boxColorsAt(matches[i], s);
    for (let k = 0; k < s.u.length; k++) {
      xs[0].push(s.l[k]); ys[0].push(bc.l[k]);
      xs[1].push(s.a[k]); ys[1].push(bc.a[k]);
      xs[2].push(s.b[k]); ys[2].push(bc.b[k]);
    }
  }
  const fit = (x, y) => {
    const [mx] = stats(x), [my] = stats(y);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    const gain = sxx > 1e-6 ? Math.min(1.6, Math.max(0.6, sxy / sxx)) : 1;
    return [gain, my - gain * mx];
  };
  const [gainL, offL] = fit(xs[0], ys[0]), [gainA, offA] = fit(xs[1], ys[1]), [gainB, offB] = fit(xs[2], ys[2]);
  return { gainL, offL, gainA, offA, gainB, offB };
}

/** Pairs of loose pieces whose locations are neighbouring cells, best first. */
function suggestPairs(pieces, matches, cell) {
  const out = [];
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
    const pi = pieces[i].placement, pj = pieces[j].placement;
    if (!pi || !pj) continue;
    if (Math.abs(pj.col - pi.col) + Math.abs(pj.row - pi.row) !== 1) continue;
    // The refined positions should also be about one cell apart.
    const d = Math.hypot(matches[j].x - matches[i].x, matches[j].y - matches[i].y);
    const consistency = Math.exp(-(((d - cell) / (0.35 * cell)) ** 2));
    const score = Math.min(pi.confidence, pj.confidence) * consistency;
    const [anchor, mover] = pi.confidence >= pj.confidence ? [pieces[i], pieces[j]] : [pieces[j], pieces[i]];
    const dc = mover.placement.col - anchor.placement.col, dr = mover.placement.row - anchor.placement.row;
    const direction = Object.keys(DIRECTIONS).find((k) => DIRECTIONS[k].dc === dc && DIRECTIONS[k].dr === dr);
    out.push({ anchor: anchor.id, mover: mover.id, direction, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
