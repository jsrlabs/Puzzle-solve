// Entry point of the solver: box picture + photo of the table (loose pieces, maybe the partly built puzzle)
// -> where each loose piece goes, which cells are already placed. Pure JavaScript; runs in a Web Worker or Node.

import { detectBoard, fromBox, gridFromBoard, IDENTITY_AFFINE, onBoard } from './board.js';
import { applyH } from './geometry.js';
import { LabImage, median } from './images.js';
import { PieceLocator } from './locator.js';
import { nextPlacement } from './planner.js';
import { detectPictureQuad } from './quad.js';
import { inMask, segment } from './segmenter.js';

export const DEFAULT_PARAMS = Object.freeze({
  overviewMaxDim: 2400, // reduced copy of the photo used to find the board and plan the sections
  sectionPx: 1600, // the full-resolution photo is scanned in sections about this size
  stopScore: 0.25, // stop scanning sections once a piece to place next scores this well
  cellPx: 16, // pixels per puzzle cell in the internal box picture
  sampleGrid: 12, // samples per side taken from each piece body
  sampleSpan: 0.8, // fraction of the body that is sampled (avoids cut edges)
  prefilterFraction: 0.1, // fraction of positions kept by the mean-color prefilter
  minBackgroundDistance: 6,
  minPieceAreaFraction: 0.0002,
  minPieceAreaRatio: 0.35,
  maxPieceAreaRatio: 2.0,
  lightnessWeight: 0.7,
  // Second, high-detail look at the best candidates of the coarse search (0 disables it).
  fineCellPx: 48,
  fineSampleGrid: 20,
  fineCandidates: 25,
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
 * Analyses the whole photo at once (all sections). See prepare() and scan() for the incremental version the
 * app uses.
 * @param {import('./images.js').RgbaImage} box the box picture, cropped to just the puzzle image
 * @param {import('./images.js').RgbaImage} photo the table: loose pieces on a plain mat, and maybe the partly
 *   assembled puzzle (detected, and its cells reported as placed)
 * @param {{cols:number, rows:number, pieceCount?:number, exact?:boolean}} layout the grid; unless `exact`,
 *   it may be corrected from the size of the assembled puzzle in the photo (using pieceCount).
 * @param {(fraction:number, message:string) => void} [progress]
 */
export function analyze(box, photo, layout, progress = () => {}, params = DEFAULT_PARAMS) {
  const session = prepare(box, photo, layout, (f, m) => progress(f * 0.4, m), params);
  return scan(session, { stopScore: Infinity }, (f, m) => progress(0.4 + f * 0.6, m));
}

/**
 * Step 1: a quick look at a reduced copy of the whole photo: background, roughly where loose pieces are, the
 * assembled puzzle and the layout. Also splits the full-resolution photo into overlapping sections (busiest
 * first) for scan(). Returns a session object.
 */
export function prepare(box, photo, layout, progress = () => {}, params = DEFAULT_PARAMS) {
  const cell = params.cellPx;
  let grid = { cols: layout.cols, rows: layout.rows };
  const warnings = [];

  progress(0.05, 'Looking at the whole photo');
  const ov = photo.downscaleToMax(params.overviewMaxDim);
  const toFull = photo.width / ov.width; // full-resolution pixels per overview pixel
  const ovLab = LabImage.from(ov);
  const ovSeg = segment(ovLab, params);
  const background = ovSeg.background;

  // Sections of the full-resolution photo. Each piece belongs to the section whose core holds its center; a
  // section extends past its core by more than a piece's reach, so every piece lies whole inside its section.
  const ovBody = ovSeg.pieces.length ? median(ovSeg.pieces.map((p) => p.bodySize)) : Math.min(ov.width, ov.height) / 20;
  const margin = Math.ceil(1.4 * ovBody * toFull);
  const nx = Math.max(1, Math.ceil(photo.width / params.sectionPx)), ny = Math.max(1, Math.ceil(photo.height / params.sectionPx));
  const tiles = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const core = { x0: Math.round((i * photo.width) / nx), y0: Math.round((j * photo.height) / ny), x1: Math.round(((i + 1) * photo.width) / nx), y1: Math.round(((j + 1) * photo.height) / ny) };
    const rect = { x: Math.max(0, core.x0 - margin), y: Math.max(0, core.y0 - margin) };
    rect.w = Math.min(photo.width, core.x1 + margin) - rect.x;
    rect.h = Math.min(photo.height, core.y1 + margin) - rect.y;
    tiles.push({ index: tiles.length, core, rect, estimate: 0 });
  }
  for (const p of ovSeg.pieces) {
    const x = p.cx * toFull, y = p.cy * toFull;
    const t = tiles.find((t) => x >= t.core.x0 && x < t.core.x1 && y >= t.core.y0 && y < t.core.y1);
    if (t) t.estimate++;
  }
  const order = tiles.filter((t) => t.estimate > 0).sort((a, b) => b.estimate - a.estimate).map((t) => t.index);

  // Piece size at full resolution, from the busiest section (more precise than the overview).
  progress(0.25, 'Measuring pieces');
  let first = null, bodyFull = ovBody * toFull;
  // Sections reuse the whole photo's background and cutoff, scaled piece size and area.
  const given = { background, threshold: ovSeg.threshold, typicalArea: ovSeg.typicalArea * toFull * toFull };
  if (order.length) {
    first = segmentTile(photo, tiles[order[0]], params, given);
    if (first.seg.pieces.length) bodyFull = median(first.seg.pieces.map((p) => p.bodySize));
  }
  given.body = bodyFull;
  const bodyOv = bodyFull / toFull;

  progress(0.4, 'Looking for the assembled puzzle');
  const blurOv = Math.max(0, Math.round((1.5 * bodyOv) / cell));
  const boardPhoto = ovLab.boxBlur(blurOv + 1);
  const found = detectPictureQuad(ov);
  const boxLabFor = (g) => LabImage.from(box.downscaleToMax(Math.max(g.cols, g.rows) * cell * 2)).resize(g.cols * cell, g.rows * cell).boxBlur(1);
  const boardFor = (g, qs, lab, refine) => detectBoard({
    // A little extra blur makes the board alignment tolerant of the box art differing slightly.
    photo: ov, photoLab: boardPhoto, boxLab: lab.boxBlur(1), grid: g, cell, quads: qs, background, refine,
  });
  let boxLab = boxLabFor(grid);
  const quads = found ? found.candidates.map((c) => c.quad) : [];
  if (found && !layout.exact) {
    // The board's size in piece widths tells the real layout (e.g. 38 x 27 rather than 37 x 27 for "1000").
    // Measured on the outline found from edges, before corner fine-tuning (which adapts to the layout it is given).
    const firstBoard = boardFor(grid, quads, boxLab, false);
    const g = gridFromBoard(firstBoard ? firstBoard.edgeQuad : found.quad, bodyOv, layout.pieceCount || grid.cols * grid.rows);
    const boxAspect = box.width / box.height;
    if (g && (g.cols !== grid.cols || g.rows !== grid.rows) && Math.abs(Math.log(g.cols / g.rows / boxAspect)) < 0.12) {
      progress(0.6, 'Measuring the assembled puzzle');
      grid = g;
      boxLab = boxLabFor(g);
    }
  }
  const board = found ? boardFor(grid, quads, boxLab, true) : null;

  progress(0.85, 'Indexing box picture');
  const locator = new PieceLocator(boxLab, params);
  if (params.fineCellPx) {
    const f = params.fineCellPx;
    locator.setFine(LabImage.from(box.downscaleToMax(Math.max(grid.cols, grid.rows) * f * 2)).resize(grid.cols * f, grid.rows * f).boxBlur(1), f);
  }
  const workW = grid.cols * cell, workH = grid.rows * cell;
  const affine = board?.affine ?? IDENTITY_AFFINE;
  const sx = box.width / workW, sy = box.height / workH;
  const boxCells = { x0: affine.tx * sx, y0: affine.ty * sy, cw: cell * affine.sx * sx, ch: cell * affine.sy * sy };
  const toPhoto = board && ((x, y) => { const q = applyH(board.H, x, y); return { x: q.x * toFull, y: q.y * toFull }; });
  let boardInfo = null;
  if (board) {
    const c = toPhoto(workW / 2, workH / 2), t = toPhoto(workW / 2, workH / 2 - cell);
    const len = Math.hypot(t.x - c.x, t.y - c.y) || 1;
    boardInfo = {
      quad: board.quad.map((q) => ({ x: q.x * toFull, y: q.y * toFull })),
      H: scaleH(board.H, toFull, cell), // puzzle cell units (col, row) -> photo pixels
      placed: [...board.placed],
      up: { x: (t.x - c.x) / len, y: (t.y - c.y) / len }, // which way the top of the puzzle faces in the photo
    };
  }
  progress(1, 'Ready');
  return {
    params, box, photo, grid, cell, board, boardInfo, boxLab, locator, affine, boxCells, toPhoto, toFull, bodyFull,
    color: board ? board.color : null, tiles, order, first, given, scanned: [], pieces: [], puzzlePos: [], warnings,
    clumps: 0, cutOff: 0,
  };
}

/** Segments one section of the full-resolution photo (pieces in section coordinates). */
function segmentTile(photo, tile, params, given) {
  const { x, y, w, h } = tile.rect;
  const lab = LabImage.from(photo.crop(x, y, w, h));
  const edges = { left: x === 0, top: y === 0, right: x + w >= photo.width, bottom: y + h >= photo.height };
  return { lab, seg: segment(lab, params, null, edges, given) };
}

/**
 * Step 2: scans sections (busiest first) at full resolution, matching their loose pieces, until a piece that
 * can be placed next scores at least `stopScore` (or all sections are done). Call again to look further.
 * @param {{placed?: string[], excluded?: number[], stopScore?: number}} options cells already on the user's
 *   board and pieces already used or skipped (so they don't count as a find)
 * @returns the analysis so far: { grid, pieces, suggestions, warnings, board, boxCells, scan }
 */
export function scan(session, options = {}, progress = () => {}) {
  const S = session, { params, grid, cell } = S;
  const stopScore = options.stopScore ?? params.stopScore;
  const placed = new Set([...(S.boardInfo?.placed ?? []), ...(options.placed ?? [])]);
  const excluded = new Set(options.excluded ?? []);
  const todo = S.order.filter((i) => !S.scanned.includes(i));
  for (let k = 0; k < todo.length; k++) {
    const tile = S.tiles[todo[k]];
    const base = k / todo.length, span = 1 / todo.length;
    progress(base, `Looking at part ${S.scanned.length + 1} of ${S.order.length} of your photo`);
    // The busiest section was already segmented by prepare() to measure the pieces.
    const reuse = S.first && S.order[0] === tile.index;
    const { lab, seg } = reuse ? S.first : segmentTile(S.photo, tile, params, S.given);
    if (reuse) S.first = null; // free its memory
    S.clumps += seg.clumps;
    S.cutOff += seg.cutOff;
    const ox = tile.rect.x, oy = tile.rect.y;
    // Pieces of this section: center in its core, not part of the assembled puzzle.
    const pieces = seg.pieces.filter((p) => {
      const x = p.cx + ox, y = p.cy + oy;
      if (x < tile.core.x0 || x >= tile.core.x1 || y < tile.core.y0 || y >= tile.core.y1) return false;
      if (!S.board) return true;
      let inside = 0, total = 0;
      for (let yy = 0; yy < p.bboxH; yy += 3) for (let xx = 0; xx < p.bboxW; xx += 3) {
        if (!p.mask[yy * p.bboxW + xx]) continue;
        total++;
        if (onBoard(S.board, cell, (xx + p.bboxX + ox) / S.toFull, (yy + p.bboxY + oy) / S.toFull)) inside++;
      }
      return inside < total * 0.3;
    });
    const body = S.bodyFull;
    const blurR = Math.max(0, Math.round((1.5 * body) / cell));
    const blurred = blurR > 0 ? lab.boxBlur(blurR) : lab;
    const samples = pieces.map((p) => samplePiece(p, blurred, body, params));
    let fine = null;
    if (params.fineCellPx) {
      const sharp = lab.boxBlur(Math.max(1, Math.round((1.5 * body) / params.fineCellPx)));
      fine = pieces.map((p) => samplePiece(p, sharp, body, { ...params, sampleGrid: params.fineSampleGrid }));
    }
    // Without an assembled puzzle to calibrate on, estimate the color correction from the first section.
    if (!S.color) {
      S.color = initialColorModel(samples, S.boxLab);
      const trial = samples.map((s) => S.locator.locate(s, S.color));
      S.color = fitColorModel(samples, trial, S.locator) ?? S.color;
    }
    pieces.forEach((p, i) => {
      if (i % 4 === 0) progress(base + (span * i) / pieces.length, `Matching pieces in part ${S.scanned.length + 1} of ${S.order.length}`);
      const m = S.locator.locate(samples[i], S.color, fine && fine[i]);
      S.pieces.push(describePiece(S, p, m, S.pieces.length, ox, oy));
      S.puzzlePos.push(m && fromBox(S.affine, m.x, m.y));
    });
    S.scanned.push(tile.index);
    const analysis = result(S);
    const next = nextPlacement({ grid, pieces: analysis.pieces, placed, excluded });
    if (next && next.score >= stopScore) return analysis;
  }
  progress(1, 'Done');
  return result(S);
}

/** A loose piece in photo coordinates, with where it belongs. */
function describePiece(S, p, m, id, ox, oy) {
  const { grid, cell, bodyFull, affine, boxCells, toPhoto } = S;
  const cellOf = (v, cells) => Math.min(cells - 1, Math.max(0, Math.floor(v / cell)));
  const au = [Math.cos(p.angle), Math.sin(p.angle)], av = [-Math.sin(p.angle), Math.cos(p.angle)];
  const half = bodyFull / 2;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => ({
    x: p.cx + ox + au[0] * su * half + av[0] * sv * half,
    y: p.cy + oy + au[1] * su * half + av[1] * sv * half,
  }));
  let up = null, placement = null;
  if (m) {
    // Box "up" is (0,-1); find (u,v) with rot_q(u,v) = (0,-1), then express it in photo coordinates.
    const [u, v] = [[0, -1], [-1, 0], [0, 1], [1, 0]][m.q & 3];
    up = { x: au[0] * u + av[0] * v, y: au[1] * u + av[1] * v };
    const q = fromBox(affine, m.x, m.y);
    const col = cellOf(q.x, grid.cols), row = cellOf(q.y, grid.rows);
    placement = {
      col,
      row,
      boxCenter: { x: boxCells.x0 + (col + 0.5) * boxCells.cw, y: boxCells.y0 + (row + 0.5) * boxCells.ch },
      boxCellSize: (boxCells.cw + boxCells.ch) / 2,
      photoTarget: toPhoto ? toPhoto((col + 0.5) * cell, (row + 0.5) * cell) : null,
      confidence: m.confidence,
      rawConfidence: m.confidence,
      matchError: m.error,
    };
  }
  return {
    id,
    center: { x: p.cx + ox, y: p.cy + oy },
    bodySize: bodyFull,
    corners,
    // The piece's actual detected outline, for highlighting exactly what was found.
    outline: p.outline.map(([x, y]) => ({ x: x + 0.5 + ox, y: y + 0.5 + oy })),
    up,
    placement,
  };
}

/** The analysis so far (pieces from all scanned sections). */
function result(S) {
  const { grid, cell } = S;
  const cellOf = (v, cells) => Math.min(cells - 1, Math.max(0, Math.floor(v / cell)));
  // Two pieces claiming the same cell: trust the more confident one.
  const byCell = new Map();
  S.pieces.forEach((p, i) => {
    if (!p.placement) return;
    p.placement.confidence = p.placement.rawConfidence;
    const key = p.placement.row * grid.cols + p.placement.col;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(i);
  });
  for (const list of byCell.values()) {
    if (list.length < 2) continue;
    const keep = list.reduce((a, b) => (S.pieces[b].placement.rawConfidence > S.pieces[a].placement.rawConfidence ? b : a));
    for (const i of list) if (i !== keep) S.pieces[i].placement.confidence *= 0.3;
  }
  const warnings = [...S.warnings];
  if (S.clumps > 0) warnings.push(`${S.clumps} group(s) of touching or overlapping pieces were skipped. Spread pieces apart so they don't touch.`);
  if (S.cutOff > 0) warnings.push('Pieces touching the edge of the photo or lying off the mat are skipped.');
  if (S.order.length === 0) warnings.push('No pieces found. Lay pieces picture-side up on a plain surface that contrasts with them.');
  const pieces = S.pieces.map((p) => ({ ...p, placement: p.placement && { ...p.placement } }));
  return {
    grid,
    pieces,
    suggestions: suggestPairs(pieces, S.puzzlePos.map((q) => q || { x: 0, y: 0 }), cell),
    warnings,
    board: S.boardInfo,
    boxCells: S.boxCells,
    scan: {
      total: S.order.length,
      scanned: S.scanned.length,
      sections: S.order.map((i) => ({ ...S.tiles[i].core, done: S.scanned.includes(i) })),
    },
  };
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
