// Puzzle Helper web UI: photo capture, finding/straightening the box picture, running the solver in a worker,
// suggesting the next piece.
import { applyH, quadSize, warpQuad } from './engine/geometry.js';
import { RgbaImage } from './engine/images.js';
import { cellKey, cornerName, isEdge, nextPlacement } from './engine/planner.js';
import { detectPictureQuad } from './engine/quad.js';
import { gridFromPieceCount } from './engine/solver.js';

const MAX_IMAGE_DIM = 4096; // full resolution for typical phone photos (12 MP)
const MOVER = '#ff2d87';

const $ = (id) => document.getElementById(id);

const state = {
  box: null, // canvas holding the box photo
  quad: null, // corners [tl, tr, br, bl] of the puzzle picture in the box photo
  straightBox: null, // cached perspective-corrected picture
  editingCrop: false,
  pieces: null, // canvas holding the pieces photo
  analysis: null,
  analyzedBox: null, // straightened box picture the analysis refers to
  placed: new Set(), // cellKey()s of cells already on the user's board (kept across new pieces photos)
  boardGrid: null, // grid the placed cells refer to
  usedPieces: new Set(), // ids of loose pieces (in the current photo) that were placed
  skipped: new Set(), // ids of loose pieces the user skipped
  editingBoard: false,
  showAll: false,
};

// ───────────────────────── Images ─────────────────────────

/** Decodes a photo (EXIF rotation applied) into a canvas no larger than MAX_IMAGE_DIM. */
async function loadImage(file) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This file is not an image the browser can read.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = source.width, h = source.height;
  const s = Math.min(1, MAX_IMAGE_DIM / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * s));
  canvas.height = Math.max(1, Math.round(h * s));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  return canvas;
}

function pixelsOf(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  return { width: d.width, height: d.height, data: d.data };
}

// ───────────────────────── Drawing ─────────────────────────

/**
 * Draws region `rect` (image px) of `src` scaled to fit `canvas` (full width, height capped at maxH CSS px),
 * then calls overlay(ctx, map) where map converts image coordinates to canvas coordinates.
 * `pad` (CSS px) leaves room around the image, e.g. for crop handles.
 */
function drawFitted(canvas, src, rect, maxH, overlay, pad = 0) {
  rect ??= { x: 0, y: 0, w: src.width, h: src.height };
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cssH = Math.min((cssW - 2 * pad) / (rect.w / rect.h) + 2 * pad, maxH);
  canvas.style.height = `${cssH}px`;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const scale = Math.min((cssW - 2 * pad) / rect.w, (cssH - 2 * pad) / rect.h);
  const ox = (cssW - rect.w * scale) / 2, oy = (cssH - rect.h * scale) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, ox, oy, rect.w * scale, rect.h * scale);
  const map = {
    scale,
    pt: (p) => [ox + (p.x - rect.x) * scale, oy + (p.y - rect.y) * scale],
    unmap: (cx, cy) => ({ x: (cx - ox) / scale + rect.x, y: (cy - oy) / scale + rect.y }),
  };
  overlay?.(ctx, map);
  return map;
}

/** Bounding rectangle around points, padded, not too skinny, clamped to the image. */
function boundsOf(points, pad, imgW, imgH, minAspect = 0.75) {
  let l = Math.min(...points.map((p) => p.x)) - pad, r = Math.max(...points.map((p) => p.x)) + pad;
  let t = Math.min(...points.map((p) => p.y)) - pad, b = Math.max(...points.map((p) => p.y)) + pad;
  const w = r - l, h = b - t;
  if (w / h < minAspect) { const g = (h * minAspect - w) / 2; l -= g; r += g; }
  if (h / w < minAspect) { const g = (w * minAspect - h) / 2; t -= g; b += g; }
  l = Math.max(0, l); t = Math.max(0, t); r = Math.min(imgW, r); b = Math.min(imgH, b);
  return { x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, b - t) };
}

function strokeTwice(ctx, color, width) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = width + 2.5;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawPolygon(ctx, map, points, color, width) {
  ctx.beginPath();
  points.forEach((p, i) => { const [x, y] = map.pt(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
  strokeTwice(ctx, color, width);
}

function drawArrow(ctx, map, from, dir, length, color) {
  const [ax, ay] = map.pt(from);
  const [bx, by] = map.pt({ x: from.x + dir.x * length, y: from.y + dir.y * length });
  const len = Math.max(1, Math.hypot(bx - ax, by - ay));
  const nx = (bx - ax) / len, ny = (by - ay) / len;
  const head = Math.max(8, len * 0.35);
  ctx.beginPath();
  ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  ctx.moveTo(bx - nx * head - ny * head * 0.6, by - ny * head + nx * head * 0.6);
  ctx.lineTo(bx, by);
  ctx.lineTo(bx - nx * head + ny * head * 0.6, by - ny * head - nx * head * 0.6);
  strokeTwice(ctx, color, 3);
}

// ───────────────────────── Setup screen ─────────────────────────

const fullQuad = (img) => [{ x: 0, y: 0 }, { x: img.width, y: 0 }, { x: img.width, y: img.height }, { x: 0, y: img.height }];
const toRgba = (canvas) => { const p = pixelsOf(canvas); return new RgbaImage(p.width, p.height, p.data); };

function rgbaToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height), 0, 0);
  return c;
}

/** Finds the puzzle picture in the box photo and straightens it. */
function autoDetectBox() {
  const found = detectPictureQuad(toRgba(state.box));
  state.quad = found ? found.quad : fullQuad(state.box);
  state.straightBox = null;
  $('cropHint').textContent = found
    ? 'Picture found and straightened automatically. If the corners are off, tap "Adjust corners".'
    : "Couldn't find the picture's edges. Tap \"Adjust corners\" and drag the four corners onto the picture's corners.";
  $('cropHint').hidden = false;
}

/** The box picture, perspective-corrected to an upright rectangle (cached until the corners change). */
function straightBox() {
  if (!state.straightBox) state.straightBox = rgbaToCanvas(warpQuad(toRgba(state.box), state.quad, MAX_IMAGE_DIM));
  return state.straightBox;
}

function renderBoxPreview() {
  const canvas = $('boxPreview');
  const box = state.box;
  canvas.hidden = !box;
  for (const id of ['cropToggle', 'cropAuto', 'cropFull']) $(id).hidden = !box;
  $('cropAuto').hidden = $('cropFull').hidden = !box || !state.editingCrop;
  if (!box) { $('cropHint').hidden = true; return; }
  $('cropToggle').textContent = state.editingCrop ? 'Done' : 'Adjust corners';
  canvas.classList.toggle('editing', state.editingCrop);
  if (!state.editingCrop) {
    drawFitted(canvas, straightBox(), null, 260);
    return;
  }
  cropMap = drawFitted(canvas, box, null, 480, (ctx, map) => {
    const pts = state.quad.map((p) => map.pt(p));
    const [x0, y0] = map.pt({ x: 0, y: 0 }), [x1, y1] = map.pt({ x: box.width, y: box.height });
    // Darken everything outside the quad (even-odd fill of image rect + quad).
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    for (const [hx, hy] of pts) {
      ctx.beginPath();
      ctx.arc(hx, hy, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, 14);
}

let cropMap = null;
let cropDrag = null; // { handle: 0..3 corner | 4 move all, start: image point, quad }

function insideQuad(q, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (cross !== 0) { if (sign && Math.sign(cross) !== sign) return false; sign = Math.sign(cross); }
  }
  return true;
}

function setupCropEditor() {
  const canvas = $('boxPreview');
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.editingCrop || !cropMap) return;
    const [px, py] = pos(e);
    const corners = state.quad.map((p) => cropMap.pt(p));
    const dists = corners.map(([x, y]) => Math.hypot(x - px, y - py));
    const nearest = dists.indexOf(Math.min(...dists));
    const handle = dists[nearest] < 36 ? nearest : insideQuad(corners, px, py) ? 4 : -1;
    if (handle < 0) return;
    cropDrag = { handle, start: cropMap.unmap(px, py), quad: state.quad.map((p) => ({ ...p })) };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cropDrag) return;
    const [px, py] = pos(e);
    const p = cropMap.unmap(px, py);
    const W = state.box.width, H = state.box.height;
    let dx = p.x - cropDrag.start.x, dy = p.y - cropDrag.start.y;
    const q = cropDrag.quad.map((c) => ({ ...c }));
    if (cropDrag.handle === 4) {
      // Move the whole quad, keeping it on the photo.
      dx = Math.min(W - Math.max(...q.map((c) => c.x)), Math.max(-Math.min(...q.map((c) => c.x)), dx));
      dy = Math.min(H - Math.max(...q.map((c) => c.y)), Math.max(-Math.min(...q.map((c) => c.y)), dy));
      q.forEach((c) => { c.x += dx; c.y += dy; });
    } else {
      const c = q[cropDrag.handle];
      c.x = Math.min(W, Math.max(0, c.x + dx));
      c.y = Math.min(H, Math.max(0, c.y + dy));
    }
    state.quad = q;
    state.straightBox = null;
    renderBoxPreview();
    updateGridInfo();
  });
  const end = () => { cropDrag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function renderPiecesPreview() {
  const canvas = $('piecesPreview');
  canvas.hidden = !state.pieces;
  if (state.pieces) drawFitted(canvas, state.pieces, null, 260);
}

function resolveGrid() {
  const cols = parseInt($('cols').value, 10), rows = parseInt($('rows').value, 10);
  if (cols > 0 && rows > 0) return { cols, rows, exact: true };
  const count = parseInt($('pieceCount').value, 10);
  if (!(count >= 4) || !state.box) return null;
  const { w, h } = quadSize(state.quad);
  return { ...gridFromPieceCount(count, w / h), pieceCount: count };
}

function updateGridInfo() {
  const g = resolveGrid();
  $('gridInfo').textContent = g
    ? `Using ${g.cols} columns × ${g.rows} rows (${g.cols * g.rows} pieces)${g.exact ? '' : '. If your photo shows the started puzzle, the layout is measured from it'}.`
    : 'Add the box picture and the piece count to work out the layout.';
  $('analyze').disabled = !(g && state.box && state.pieces) || busy;
}

// ───────────────────────── Running the solver ─────────────────────────

let worker = null;
let busy = false; // the worker is analysing (initial run or looking at more of the photo)
let jobId = 0;

function cancelAnalysis() {
  worker?.terminate();
  worker = null;
  busy = false;
  $('progress').hidden = true;
  updateGridInfo();
}

/** Progress from the worker: on the setup screen for the first run, on the result screen when scanning more. */
function showProgress(fraction, message) {
  const onResult = !$('result').hidden;
  $(onResult ? 'scanMsg' : 'progressMsg').textContent = message;
  $(onResult ? 'scanFill' : 'progressFill').style.width = `${Math.round(fraction * 100)}%`;
}

function runAnalysis() {
  const grid = resolveGrid();
  if (!grid || !state.box || !state.pieces) return;
  const cropped = straightBox();
  state.layoutAsked = grid;
  const box = pixelsOf(cropped), pieces = pixelsOf(state.pieces);
  worker?.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const id = ++jobId;
  busy = true;
  $('progress').hidden = false;
  showProgress(0, 'Starting…');
  updateGridInfo();
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.id !== jobId) return;
    if (msg.type === 'progress') return showProgress(msg.fraction, msg.message);
    busy = false;
    $('progress').hidden = true;
    updateGridInfo();
    if (msg.type === 'error') {
      worker?.terminate();
      worker = null;
      return showError(`Analysis failed: ${msg.message}`);
    }
    const g = msg.result.grid;
    if (msg.kind === 'start') {
      if (!state.boardGrid || state.boardGrid.cols !== g.cols || state.boardGrid.rows !== g.rows) state.placed.clear();
      state.boardGrid = g;
      state.analyzedBox = cropped;
      state.usedPieces.clear();
      state.skipped.clear();
    }
    // Cells the app saw already assembled in the photo.
    for (const key of msg.result.board?.placed ?? []) state.placed.add(key);
    state.analysis = msg.result;
    if (msg.kind === 'start') showScreen('result');
    else renderResult();
  };
  worker.onerror = (e) => {
    cancelAnalysis();
    showError(`Analysis failed: ${e.message || 'the background worker crashed (the photos may be too large).'}`);
  };
  // The worker gets the full-resolution photos; it scans the table photo in sections and stops at the first
  // section that gives a good next piece.
  worker.postMessage({ type: 'start', id, box, pieces, grid, placed: [...state.placed], excluded: [] }, [box.data.buffer, pieces.data.buffer]);
}

/** Parts of the table photo not looked at yet. */
const sectionsLeft = () => (state.analysis?.scan ? state.analysis.scan.total - state.analysis.scan.scanned : 0);

/** Asks the worker to look at more sections of the photo (keeps going until it finds a piece to place). */
function scanMore() {
  if (!worker || busy || sectionsLeft() <= 0) return;
  busy = true;
  jobId++;
  showProgress(0, 'Looking at more of your photo…');
  renderResult();
  worker.postMessage({ type: 'more', id: jobId, placed: [...state.placed], excluded: [...state.usedPieces, ...state.skipped] });
}

// ───────────────────────── Result screen ─────────────────────────

const SIDE_WORDS = { left: 'the piece on its left', right: 'the piece on its right', top: 'the piece above it', bottom: 'the piece below it' };

/** The current suggestion for the loose pieces in this photo, or null. */
function currentStep() {
  const a = state.analysis;
  if (!a) return null;
  const excluded = new Set([...state.usedPieces, ...state.skipped]);
  return nextPlacement({ grid: a.grid, pieces: a.pieces, placed: state.placed, excluded });
}

/** How far to turn a piece, given where its top currently points in the photo. */
function turnHint(up) {
  if (!up) return 'orientation unknown';
  // "Up" is the top of the started puzzle if it is in the photo, else the top of the photo.
  const ref = state.analysis?.board?.up ?? { x: 0, y: -1 };
  const deg = (Math.atan2(ref.x * up.y - ref.y * up.x, ref.x * up.x + ref.y * up.y) * 180) / Math.PI; // clockwise from ref
  const rounded = Math.round(deg / 45) * 45;
  if (Math.abs(deg) < 20) return 'it is already upright';
  if (Math.abs(rounded) === 180) return 'turn it upside down';
  return deg > 0 ? `turn it about ${Math.abs(rounded)}° counter-clockwise` : `turn it about ${Math.abs(rounded)}° clockwise`;
}

function confidenceWord(score) {
  if (score >= 0.5) return 'high';
  if (score >= 0.2) return 'medium';
  return 'low (check that it really fits before pressing it in)';
}

function listWords(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Map for drawing an image placed at rect {x, y, scale} on a canvas. */
const rectMap = (r) => ({
  scale: r.scale,
  pt: (p) => [r.x + p.x * r.scale, r.y + p.y * r.scale],
  unmap: (cx, cy) => ({ x: (cx - r.x) / r.scale, y: (cy - r.y) / r.scale }),
});

/**
 * Darkens board cells that are not on the board yet; placed cells and the target cell stay bright.
 * Works in box-image coordinates through `map`.
 */
/** Box-picture pixel rectangle of puzzle cell (col, row) (the picture may be cropped differently). */
function cellRect(col, row) {
  const b = state.analysis.boxCells;
  return { x: b.x0 + col * b.cw, y: b.y0 + row * b.ch, w: b.cw, h: b.ch };
}

function shadeBoard(ctx, map, target) {
  const a = state.analysis, g = a.grid;
  const cw = a.boxCells.cw;
  const targetKey = target ? cellKey(target.col, target.row) : null;
  // The puzzle can extend a little past the box art: keep the shading on the picture.
  const box = state.analyzedBox;
  const [ix0, iy0] = map.pt({ x: 0, y: 0 }), [ix1, iy1] = map.pt({ x: box.width, y: box.height });
  ctx.save();
  ctx.beginPath();
  ctx.rect(ix0, iy0, ix1 - ix0, iy1 - iy0);
  ctx.clip();
  const dim = new Path2D(), done = new Path2D();
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const key = cellKey(c, r);
    if (key === targetKey) continue;
    const rc = cellRect(c, r);
    const [x0, y0] = map.pt(rc), [x1, y1] = map.pt({ x: rc.x + rc.w, y: rc.y + rc.h });
    (state.placed.has(key) ? done : dim).rect(x0, y0, x1 - x0, y1 - y0);
  }
  ctx.fillStyle = 'rgba(14, 15, 22, 0.68)';
  ctx.fill(dim);
  ctx.fillStyle = 'rgba(60, 230, 130, 0.22)'; // a light green tint marks pieces already on the board
  ctx.fill(done);
  ctx.restore();
  if (cw * map.scale >= 7) { // grid lines, when cells are big enough to see
    const tl = cellRect(0, 0), br = cellRect(g.cols, g.rows);
    ctx.beginPath();
    for (let c = 1; c < g.cols; c++) { const x = cellRect(c, 0).x; const [px, y0] = map.pt({ x, y: tl.y }); const [, y1] = map.pt({ x, y: br.y }); ctx.moveTo(px, y0); ctx.lineTo(px, y1); }
    for (let r = 1; r < g.rows; r++) { const y = cellRect(0, r).y; const [x0, py] = map.pt({ x: tl.x, y }); const [x1] = map.pt({ x: br.x, y }); ctx.moveTo(x0, py); ctx.lineTo(x1, py); }
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (target) {
    const rc = cellRect(target.col, target.row);
    const [x0, y0] = map.pt(rc), [x1, y1] = map.pt({ x: rc.x + rc.w, y: rc.y + rc.h });
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    strokeTwice(ctx, MOVER, 3);
    if (x1 - x0 < 16) { // tiny cells: add a ring so the spot is easy to find
      ctx.beginPath();
      ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, 16, 0, Math.PI * 2);
      strokeTwice(ctx, MOVER, 2.5);
    }
  }
}

/** A piece's detected outline (older results only have the body square). */
const shapeOf = (p) => (p.outline?.length > 2 ? p.outline : p.corners);

/** Highlights the piece to place; dims pieces already used; optionally outlines all the others. */
function markPieces(ctx, map, piece, ring) {
  for (const p of state.analysis.pieces) {
    if (state.usedPieces.has(p.id)) {
      // Already on the board: grey it out (the photo still shows it on the table).
      ctx.beginPath();
      shapeOf(p).forEach((q, i) => { const [x, y] = map.pt(q); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(120,120,130,0.8)';
      ctx.fill();
    } else if (state.showAll && p !== piece) {
      drawPolygon(ctx, map, shapeOf(p), p.placement ? 'rgba(255,255,255,0.85)' : 'rgba(255,60,60,0.85)', 1.5);
    }
  }
  if (!piece) return;
  // Trace the piece's real outline, so it's clear exactly which piece is meant.
  drawPolygon(ctx, map, shapeOf(piece), MOVER, 2.5);
  if (piece.up) drawArrow(ctx, map, piece.center, piece.up, piece.bodySize * 0.42, MOVER);
  if (ring) {
    const [cx, cy] = map.pt(piece.center);
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius(piece, map), 0, Math.PI * 2);
    strokeTwice(ctx, MOVER, 3);
  }
}

const ringRadius = (piece, map) => Math.max(16, piece.bodySize * map.scale * 0.95);

/** Big curved arrow between two canvas points; `startGap`/`endGap` keep it off the marked spots. */
function drawBigArrow(ctx, [x0, y0], [x1, y1], startGap, endGap) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  if (len < startGap + endGap + 10) return;
  const ux = dx / len, uy = dy / len;
  const sx = x0 + ux * startGap, sy = y0 + uy * startGap;
  const ex = x1 - ux * endGap, ey = y1 - uy * endGap;
  // Bend sideways a little so the arrow doesn't hide the straight line between the images.
  const bend = Math.min(80, len * 0.18);
  const cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(cx, cy, ex, ey);
  strokeTwice(ctx, MOVER, 5);
  // Head, aligned with the curve's end tangent.
  const tx = ex - cx, ty = ey - cy, tl = Math.hypot(tx, ty) || 1;
  const hx = tx / tl, hy = ty / tl, head = 18;
  ctx.beginPath();
  ctx.moveTo(ex - hx * head - hy * head * 0.6, ey - hy * head + hx * head * 0.6);
  ctx.lineTo(ex, ey);
  ctx.lineTo(ex - hx * head + hy * head * 0.6, ey - hy * head - hx * head * 0.6);
  strokeTwice(ctx, MOVER, 5);
}

/**
 * The composite: your board (box picture with only placed cells bright) and the loose-pieces photo,
 * side by side on wide screens or stacked on phones, with an arrow from the piece to its spot.
 */
function drawComposite(canvas, step) {
  const box = state.analyzedBox, pieces = state.pieces, g = state.analysis.grid;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth;
  const pad = 12, caption = 24;
  const wide = cssW >= 640;
  const colW = wide ? (cssW - 3 * pad) / 2 : cssW - 2 * pad;
  const maxH = wide ? 460 : 380;
  const fit = (img) => {
    const scale = Math.min(colW / img.width, maxH / img.height);
    return { w: img.width * scale, h: img.height * scale, scale };
  };
  const fb = fit(box), fp = fit(pieces);
  let rb, rp, cssH;
  if (wide) {
    const rowH = Math.max(fb.h, fp.h);
    rb = { ...fb, x: pad + (colW - fb.w) / 2, y: pad + caption + (rowH - fb.h) / 2 };
    rp = { ...fp, x: 2 * pad + colW + (colW - fp.w) / 2, y: pad + caption + (rowH - fp.h) / 2 };
    cssH = pad + caption + rowH + pad;
  } else {
    rb = { ...fb, x: pad + (colW - fb.w) / 2, y: pad + caption };
    rp = { ...fp, x: pad + (colW - fp.w) / 2, y: rb.y + fb.h + pad * 2 + caption };
    cssH = rp.y + fp.h + pad;
  }
  canvas.style.height = `${cssH}px`;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--card').trim() || '#fff';
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.fillStyle = css.getPropertyValue('--text').trim() || '#000';
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`Your board (${state.placed.size} of ${g.cols * g.rows} placed)`, rb.x, rb.y - 8);
  ctx.fillText(state.analysis.board ? 'Your table' : 'Loose pieces', rp.x, rp.y - 8);

  const mb = rectMap(rb), mp = rectMap(rp);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(box, rb.x, rb.y, rb.w, rb.h);
  shadeBoard(ctx, mb, step?.piece.placement);
  ctx.drawImage(pieces, rp.x, rp.y, rp.w, rp.h);
  markPieces(ctx, mp, step?.piece, true);

  if (step) {
    const t = step.piece.placement;
    if (state.analysis.board && t.photoTarget) {
      // The started puzzle is in the photo: point at the real spot on it.
      const corners = cellOnPhoto(t.col, t.row);
      ctx.beginPath();
      corners.forEach((c, i) => { const [x, y] = mp.pt(c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      strokeTwice(ctx, MOVER, 3);
      const size = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) * mp.scale;
      drawBigArrow(ctx, mp.pt(step.piece.center), mp.pt(t.photoTarget), ringRadius(step.piece, mp) + 4, Math.max(10, size / 2) + 6);
    } else {
      const rc = cellRect(t.col, t.row);
      const target = mb.pt({ x: rc.x + rc.w / 2, y: rc.y + rc.h / 2 });
      const cellR = Math.max(16, (rc.w * mb.scale) / 2) + 6;
      drawBigArrow(ctx, mp.pt(step.piece.center), target, ringRadius(step.piece, mp) + 4, cellR);
    }
  }
}

/** Corners of puzzle cell (col, row) in the table photo (when the started puzzle was found in it). */
function cellOnPhoto(col, row) {
  const H = state.analysis.board.H;
  return [[col, row], [col + 1, row], [col + 1, row + 1], [col, row + 1]].map(([x, y]) => applyH(H, x, y));
}

function renderBoardEditor() {
  const canvas = $('boardEdit');
  canvas.hidden = !state.editingBoard;
  $('editHint').hidden = !state.editingBoard;
  $('editBoard').textContent = state.editingBoard ? 'Done marking' : 'Mark pieces already placed';
  canvas.classList.toggle('editing', state.editingBoard);
  if (state.editingBoard) boardEditMap = drawFitted(canvas, state.analyzedBox, null, 480, (ctx, map) => shadeBoard(ctx, map, null));
}

let boardEditMap = null;
let boardPaint = null; // 'add' | 'remove' while dragging

function setupBoardEditor() {
  const canvas = $('boardEdit');
  const cellAt = (e) => {
    if (!boardEditMap || !state.analysis) return null;
    const r = canvas.getBoundingClientRect();
    const p = boardEditMap.unmap(e.clientX - r.left, e.clientY - r.top);
    const g = state.analysis.grid, b = state.analysis.boxCells;
    const col = Math.floor((p.x - b.x0) / b.cw), row = Math.floor((p.y - b.y0) / b.ch);
    return col >= 0 && row >= 0 && col < g.cols && row < g.rows ? cellKey(col, row) : null;
  };
  const paint = (key) => {
    if (!key) return;
    const had = state.placed.has(key);
    if (boardPaint === 'add' && !had) state.placed.add(key);
    else if (boardPaint === 'remove' && had) state.placed.delete(key);
    else return;
    renderBoardEditor();
  };
  canvas.addEventListener('pointerdown', (e) => {
    const key = cellAt(e);
    if (!state.editingBoard || !key) return;
    boardPaint = state.placed.has(key) ? 'remove' : 'add';
    canvas.setPointerCapture(e.pointerId);
    paint(key);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => { if (boardPaint) paint(cellAt(e)); });
  const end = () => { if (boardPaint) { boardPaint = null; renderResult(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function renderResult() {
  const a = state.analysis, pieces = state.pieces, box = state.analyzedBox;
  if (!a || !pieces || !box) return;
  const g = a.grid;
  const loose = a.pieces.filter((p) => !state.usedPieces.has(p.id)).length;
  $('foundCount').textContent = `${a.pieces.length} pieces found · ${loose} still loose`;
  const guessed = state.layoutAsked && !state.layoutAsked.exact &&
    (state.layoutAsked.cols !== g.cols || state.layoutAsked.rows !== g.rows);
  $('layoutInfo').textContent = `Layout: ${g.cols} columns × ${g.rows} rows${guessed ? ', measured from the puzzle in your photo' : ''}. ` +
    'If that\'s wrong, enter the exact columns and rows under "Puzzle size" and run again.';
  $('warnings').replaceChildren(...a.warnings.map((w) => Object.assign(document.createElement('p'), { className: 'warning', textContent: w })));
  const seen = a.board ? ` The app recognised ${a.board.placed.length} already in place in your photo; fix any mistakes with the button below.` : '';
  $('boardInfo').textContent = `${state.placed.size} of ${g.cols * g.rows} pieces on your board (${g.cols} columns × ${g.rows} rows).${seen}`;
  renderBoardEditor();

  // How much of the photo has been looked at; more is scanned automatically when the suggestions run out.
  const left = sectionsLeft();
  const sc = a.scan;
  $('scanStatus').hidden = !sc;
  if (sc) {
    $('scanInfo').textContent = left > 0
      ? `Looked at ${sc.scanned} of ${sc.total} parts of your photo so far.`
      : `Looked at all ${sc.total} parts of your photo.`;
    $('scanBar').hidden = !busy;
    $('scanMore').hidden = busy || left <= 0;
  }

  const step = currentStep();
  if (!step && left > 0 && !busy) { scanMore(); return; }
  $('suggestion').hidden = !step;
  $('noSuggestion').hidden = !!step;

  if (!step) {
    if (busy) {
      $('noSuggestionText').textContent = 'Looking at more of your photo for a piece that fits…';
      drawComposite($('compositeEmpty'), null);
      return;
    }
    $('noSuggestionText').textContent = state.placed.size === 0
      ? 'No corner pieces were found among these loose pieces. Corners have two straight edges: include some in your next photo. If you have already started the puzzle, use "Mark pieces already placed" below so suggestions can connect to them.'
      : 'None of these loose pieces seem to connect to your board yet. Take a new photo with more pieces, or check that your board below matches the table.';
    drawComposite($('compositeEmpty'), null);
    return;
  }

  const p = step.piece, pl = p.placement;
  if (step.kind === 'corner') {
    $('stepTitle').textContent = state.placed.size === 0 ? 'Start with a corner' : 'Start a new corner';
    $('placeText').textContent = `Put the highlighted piece in the ${cornerName(g, pl.col, pl.row)} corner of your board.`;
  } else {
    $('stepTitle').textContent = 'Place this piece';
    const sides = step.neighbours.map((n) => SIDE_WORDS[n.side]);
    $('placeText').textContent = `Put the highlighted piece next to ${listWords(sides)}.`;
  }
  $('turnText').textContent = a.board
    ? `Turn it so the small arrow on the piece points the same way as the top of your puzzle: ${turnHint(p.up)}.`
    : `Turn it so the small arrow on the piece points to the top of the picture: ${turnHint(p.up)}.`;
  $('whereText').textContent = `Row ${pl.row + 1}, column ${pl.col + 1} of ${g.rows} × ${g.cols}.${isEdge(g, pl.col, pl.row) && step.kind !== 'corner' ? ' It is an edge piece.' : ''}`;
  $('confText').textContent = `Confidence: ${confidenceWord(step.score)}`;

  drawComposite($('composite'), step);
  const zoom = boundsOf(shapeOf(p), p.bodySize * 0.7, pieces.width, pieces.height, 1);
  drawFitted($('pieceZoom'), pieces, zoom, 220, (ctx, map) => markPieces(ctx, map, p, false));
  const rc = cellRect(pl.col, pl.row);
  const around = boundsOf([rc, { x: rc.x + rc.w, y: rc.y + rc.h }], Math.max(rc.w, rc.h) * 2, box.width, box.height, 1);
  drawFitted($('boardZoom'), box, around, 220, (ctx, map) => shadeBoard(ctx, map, pl));
  // On the started puzzle in the photo, if it was found.
  $('tableZoomFig').hidden = !a.board;
  if (a.board) {
    const corners = cellOnPhoto(pl.col, pl.row);
    const side = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    drawFitted($('tableZoom'), pieces, boundsOf(corners, side * 2.5, pieces.width, pieces.height, 1), 220, (ctx, map) => {
      ctx.beginPath();
      corners.forEach((c, i) => { const [x, y] = map.pt(c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      strokeTwice(ctx, MOVER, 3);
    });
  }
}

async function saveComposite() {
  const blob = await new Promise((resolve) => $('composite').toBlob(resolve, 'image/png'));
  if (!blob) return;
  const file = new File([blob], 'puzzle-next-piece.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Next puzzle piece' }); return; } catch { /* cancelled: fall back to download */ }
  }
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ───────────────────────── Navigation & wiring ─────────────────────────

function showScreen(name) {
  $('setup').hidden = name !== 'setup';
  $('result').hidden = name !== 'result';
  $('backToResult').hidden = !state.analysis;
  window.scrollTo(0, 0);
  render();
}

function render() {
  if (!$('setup').hidden) {
    renderBoxPreview();
    renderPiecesPreview();
    updateGridInfo();
  } else {
    renderResult();
  }
}

function showError(message) {
  $('errorText').textContent = message;
  $('errorDialog').showModal();
}

function store(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }
function load(key) { try { return localStorage.getItem(key); } catch { return null; } }

function init() {
  for (const input of document.querySelectorAll('input[type=file]')) {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      try {
        const canvas = await loadImage(file);
        if (input.dataset.slot === 'box') {
          state.box = canvas;
          autoDetectBox();
          state.placed.clear(); // a new box means a new puzzle
          state.analysis = null;
          state.editingCrop = false;
        } else {
          state.pieces = canvas;
        }
        render();
      } catch (err) {
        showError(`Could not open that picture: ${err.message || err}`);
      }
    });
  }
  $('cropToggle').addEventListener('click', () => { state.editingCrop = !state.editingCrop; renderBoxPreview(); });
  $('cropAuto').addEventListener('click', () => { autoDetectBox(); renderBoxPreview(); updateGridInfo(); });
  $('cropFull').addEventListener('click', () => {
    state.quad = fullQuad(state.box);
    state.straightBox = null;
    renderBoxPreview();
    updateGridInfo();
  });
  setupCropEditor();

  for (const id of ['pieceCount', 'cols', 'rows']) {
    const saved = load(`puzzle.${id}`);
    if (saved !== null) $(id).value = saved;
    $(id).addEventListener('input', () => { store(`puzzle.${id}`, $(id).value); updateGridInfo(); });
  }

  $('analyze').addEventListener('click', runAnalysis);
  $('cancel').addEventListener('click', cancelAnalysis);
  $('backToResult').addEventListener('click', () => showScreen('result'));
  $('back').addEventListener('click', () => showScreen('setup'));
  $('scanMore').addEventListener('click', scanMore);
  $('placed').addEventListener('click', () => {
    const s = currentStep();
    if (s) {
      state.usedPieces.add(s.piece.id);
      state.placed.add(cellKey(s.piece.placement.col, s.piece.placement.row));
    }
    renderResult();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('skip').addEventListener('click', () => {
    const s = currentStep();
    if (s) state.skipped.add(s.piece.id);
    renderResult();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('download').addEventListener('click', saveComposite);
  $('editBoard').addEventListener('click', () => { state.editingBoard = !state.editingBoard; renderResult(); });
  $('clearBoard').addEventListener('click', () => {
    if (state.placed.size && !confirm('Clear all pieces from your board?')) return;
    state.placed.clear();
    renderResult();
  });
  setupBoardEditor();
  $('showAll').addEventListener('change', (e) => { state.showAll = e.target.checked; renderResult(); });
  $('retake').addEventListener('click', () => {
    state.pieces = null;
    state.analysis = null;
    showScreen('setup');
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
  render();
}

init();

// For debugging and automated browser tests: /?debug exposes the app state.
if (new URLSearchParams(location.search).has("debug")) window.puzzleHelper = { state };
