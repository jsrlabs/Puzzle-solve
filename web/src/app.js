// Puzzle Helper web UI: photo capture, box cropping, running the solver in a worker, showing suggestions.
import { gridFromPieceCount } from './engine/solver.js';

const MAX_IMAGE_DIM = 2400;
const ANCHOR = '#00b8d4';
const MOVER = '#ff2d87';

const $ = (id) => document.getElementById(id);

const state = {
  box: null, // canvas holding the box photo
  crop: { l: 0, t: 0, r: 1, b: 1 }, // normalized crop of the box photo
  editingCrop: false,
  pieces: null, // canvas holding the pieces photo
  analysis: null,
  analyzedBox: null, // cropped box canvas the analysis refers to
  used: new Set(), // piece ids already joined
  skipped: new Set(), // "anchor-mover" keys the user skipped
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

function cropCanvas(src, c) {
  const x = Math.round(c.l * src.width), y = Math.round(c.t * src.height);
  const w = Math.max(1, Math.round((c.r - c.l) * src.width)), h = Math.max(1, Math.round((c.b - c.t) * src.height));
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return out;
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

function drawLabel(ctx, x, y, text, color) {
  const r = 13;
  const cx = x + r * 1.5, cy = y - r * 1.5; // beside the center so the arrow stays visible
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 1);
}

// ───────────────────────── Setup screen ─────────────────────────

function renderBoxPreview() {
  const canvas = $('boxPreview');
  const box = state.box;
  canvas.hidden = !box;
  $('cropToggle').hidden = !box;
  $('cropReset').hidden = !box || !state.editingCrop;
  if (!box) return;
  $('cropToggle').textContent = state.editingCrop ? 'Done' : 'Adjust crop';
  canvas.classList.toggle('editing', state.editingCrop);
  if (!state.editingCrop) {
    const c = state.crop;
    const rect = { x: c.l * box.width, y: c.t * box.height, w: (c.r - c.l) * box.width, h: (c.b - c.t) * box.height };
    drawFitted(canvas, box, rect, 260);
    return;
  }
  cropMap = drawFitted(canvas, box, null, 480, (ctx, map) => {
    const c = state.crop;
    const [x0, y0] = map.pt({ x: 0, y: 0 }), [x1, y1] = map.pt({ x: box.width, y: box.height });
    const [l, t] = map.pt({ x: c.l * box.width, y: c.t * box.height });
    const [r, b] = map.pt({ x: c.r * box.width, y: c.b * box.height });
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0, y0, x1 - x0, t - y0);
    ctx.fillRect(x0, b, x1 - x0, y1 - b);
    ctx.fillRect(x0, t, l - x0, b - t);
    ctx.fillRect(r, t, x1 - r, b - t);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(l, t, r - l, b - t);
    for (const [hx, hy] of [[l, t], [r, t], [r, b], [l, b]]) {
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
let cropDrag = null; // { handle: 0..3 corner | 4 move, start, crop }

function setupCropEditor() {
  const canvas = $('boxPreview');
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.editingCrop || !cropMap) return;
    const [px, py] = pos(e);
    const c = state.crop, W = state.box.width, H = state.box.height;
    const corners = [[c.l, c.t], [c.r, c.t], [c.r, c.b], [c.l, c.b]].map(([u, v]) => cropMap.pt({ x: u * W, y: v * H }));
    const dists = corners.map(([x, y]) => Math.hypot(x - px, y - py));
    const nearest = dists.indexOf(Math.min(...dists));
    const [l, t] = corners[0], [r, b] = corners[2];
    const handle = dists[nearest] < 36 ? nearest : px > l && px < r && py > t && py < b ? 4 : -1;
    if (handle < 0) return;
    cropDrag = { handle, start: [px, py], crop: { ...c } };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cropDrag) return;
    const [px, py] = pos(e);
    const dx = (px - cropDrag.start[0]) / cropMap.scale / state.box.width;
    const dy = (py - cropDrag.start[1]) / cropMap.scale / state.box.height;
    const c0 = cropDrag.crop, min = 0.1;
    const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    let c = { ...c0 };
    const left = () => { c.l = cl(c0.l + dx, 0, c0.r - min); };
    const right = () => { c.r = cl(c0.r + dx, c0.l + min, 1); };
    const top = () => { c.t = cl(c0.t + dy, 0, c0.b - min); };
    const bottom = () => { c.b = cl(c0.b + dy, c0.t + min, 1); };
    switch (cropDrag.handle) {
      case 0: left(); top(); break;
      case 1: right(); top(); break;
      case 2: right(); bottom(); break;
      case 3: left(); bottom(); break;
      default: {
        const mx = cl(dx, -c0.l, 1 - c0.r), my = cl(dy, -c0.t, 1 - c0.b);
        c = { l: c0.l + mx, t: c0.t + my, r: c0.r + mx, b: c0.b + my };
      }
    }
    state.crop = c;
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
  if (cols > 0 && rows > 0) return { cols, rows };
  const count = parseInt($('pieceCount').value, 10);
  if (!(count >= 4) || !state.box) return null;
  const c = state.crop;
  const aspect = ((c.r - c.l) * state.box.width) / ((c.b - c.t) * state.box.height);
  return gridFromPieceCount(count, aspect);
}

function updateGridInfo() {
  const g = resolveGrid();
  $('gridInfo').textContent = g
    ? `Using ${g.cols} columns × ${g.rows} rows (${g.cols * g.rows} pieces).`
    : 'Add the box picture and the piece count to work out the layout.';
  $('analyze').disabled = !(g && state.box && state.pieces) || busy;
}

// ───────────────────────── Running the solver ─────────────────────────

let worker = null;
let busy = false;
let jobId = 0;

function cancelAnalysis() {
  worker?.terminate();
  worker = null;
  busy = false;
  $('progress').hidden = true;
  updateGridInfo();
}

function runAnalysis() {
  const grid = resolveGrid();
  if (!grid || !state.box || !state.pieces) return;
  const cropped = cropCanvas(state.box, state.crop);
  const box = pixelsOf(cropped), pieces = pixelsOf(state.pieces);
  worker?.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const id = ++jobId;
  busy = true;
  $('progress').hidden = false;
  $('progressMsg').textContent = 'Starting…';
  $('progressFill').style.width = '0%';
  updateGridInfo();
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.id !== id) return;
    if (msg.type === 'progress') {
      $('progressMsg').textContent = msg.message;
      $('progressFill').style.width = `${Math.round(msg.fraction * 100)}%`;
      return;
    }
    cancelAnalysis();
    if (msg.type === 'error') return showError(`Analysis failed: ${msg.message}`);
    state.analysis = msg.result;
    state.analyzedBox = cropped;
    state.used.clear();
    state.skipped.clear();
    showScreen('result');
  };
  worker.onerror = (e) => {
    cancelAnalysis();
    showError(`Analysis failed: ${e.message || 'the background worker crashed (the photos may be too large).'}`);
  };
  worker.postMessage({ id, box, pieces, grid }, [box.data.buffer, pieces.data.buffer]);
}

// ───────────────────────── Result screen ─────────────────────────

const pairKey = (s) => `${s.anchor}-${s.mover}`;

function remainingSuggestions() {
  const a = state.analysis;
  return a ? a.suggestions.filter((s) => !state.used.has(s.anchor) && !state.used.has(s.mover) && !state.skipped.has(pairKey(s))) : [];
}

const DIRECTION_WORDS = {
  LEFT: 'on the LEFT side of',
  RIGHT: 'on the RIGHT side of',
  ABOVE: 'ABOVE',
  BELOW: 'BELOW',
};

/** How far to turn a piece, given where its top currently points in the photo. */
function turnHint(up) {
  if (!up) return 'orientation unknown';
  const deg = (Math.atan2(up.x, -up.y) * 180) / Math.PI; // clockwise from photo-up
  const rounded = Math.round(deg / 45) * 45;
  if (Math.abs(deg) < 20) return 'already upright';
  if (Math.abs(rounded) === 180) return 'turn it upside down';
  return deg > 0 ? `turn about ${Math.abs(rounded)}° counter-clockwise` : `turn about ${Math.abs(rounded)}° clockwise`;
}

function confidenceWord(score) {
  if (score >= 0.5) return 'high';
  if (score >= 0.2) return 'medium';
  return 'low (double-check before pushing them together)';
}

function drawAllPieces(ctx, map) {
  for (const p of state.analysis.pieces) {
    const color = state.used.has(p.id) ? 'rgba(160,160,160,0.8)' : p.placement ? 'rgba(255,255,255,0.85)' : 'rgba(255,60,60,0.85)';
    drawPolygon(ctx, map, p.corners, color, 1.5);
  }
}

function drawAllPlacements(ctx, map) {
  for (const p of state.analysis.pieces) {
    const pl = p.placement;
    if (!pl) continue;
    const half = pl.boxCellSize / 2;
    const [x0, y0] = map.pt({ x: pl.boxCenter.x - half, y: pl.boxCenter.y - half });
    const [x1, y1] = map.pt({ x: pl.boxCenter.x + half, y: pl.boxCenter.y + half });
    ctx.strokeStyle = `rgba(255,255,255,${0.3 + 0.7 * pl.confidence})`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
}

function drawPair(ctx, map, pair, labels) {
  pair.forEach((p, i) => {
    const color = i === 0 ? ANCHOR : MOVER;
    drawPolygon(ctx, map, p.corners, color, 3);
    if (p.up) drawArrow(ctx, map, p.center, p.up, p.bodySize * 0.42, color);
    const [cx, cy] = map.pt(p.center);
    if (labels) {
      drawLabel(ctx, cx, cy, i === 0 ? 'A' : 'B', color);
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(14, p.bodySize * map.scale * 0.9), 0, Math.PI * 2);
      strokeTwice(ctx, color, 3);
    }
  });
}

function drawTargets(ctx, map, pair, labels) {
  pair.forEach((p, i) => {
    const pl = p.placement, color = i === 0 ? ANCHOR : MOVER;
    const half = pl.boxCellSize / 2;
    const [x0, y0] = map.pt({ x: pl.boxCenter.x - half, y: pl.boxCenter.y - half });
    const [x1, y1] = map.pt({ x: pl.boxCenter.x + half, y: pl.boxCenter.y + half });
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    strokeTwice(ctx, color, 3);
    if (labels) drawLabel(ctx, (x0 + x1) / 2, (y0 + y1) / 2, i === 0 ? 'A' : 'B', color);
  });
}

function renderResult() {
  const a = state.analysis, pieces = state.pieces, box = state.analyzedBox;
  if (!a || !pieces || !box) return;
  $('foundCount').textContent = `${a.pieces.length} pieces found`;
  $('warnings').replaceChildren(...a.warnings.map((w) => Object.assign(document.createElement('p'), { className: 'warning', textContent: w })));

  const remaining = remainingSuggestions();
  const s = remaining[0];
  $('suggestion').hidden = !s;
  $('noSuggestion').hidden = !!s;

  if (!s) {
    const best = a.pieces.filter((p) => p.placement && !state.used.has(p.id)).sort((x, y) => y.placement.confidence - x.placement.confidence)[0];
    $('noSuggestionText').textContent = best
      ? `None of the remaining loose pieces seem to be neighbours. The most certain single piece is #${best.id + 1}: row ${best.placement.row + 1}, column ${best.placement.col + 1}. Take a new photo with more pieces to find more pairs.`
      : 'Take a new photo with more pieces (or in better light) to get suggestions.';
    drawFitted($('piecesAll'), pieces, null, 320, drawAllPieces);
    return;
  }

  const A = a.pieces[s.anchor], B = a.pieces[s.mover];
  const pa = A.placement, pb = B.placement, g = a.grid;
  $('joinText').innerHTML = `<span class="dot b"></span>B goes ${DIRECTION_WORDS[s.direction]} <span class="dot a"></span>A`;
  $('turnText').textContent = `Turn both pieces so their arrows point up (toward the top of the picture). A: ${turnHint(A.up)}. B: ${turnHint(B.up)}.`;
  const edge = [pa, pb].some((p) => p.col === 0 || p.row === 0 || p.col === g.cols - 1 || p.row === g.rows - 1);
  $('whereText').textContent = `A belongs at row ${pa.row + 1}, column ${pa.col + 1}; B at row ${pb.row + 1}, column ${pb.col + 1} (of ${g.rows} rows × ${g.cols} columns).${edge ? ' These are edge pieces.' : ''}`;
  $('confText').textContent = `Confidence: ${confidenceWord(s.score)}`;

  const pair = [A, B];
  const zoom = boundsOf(pair.flatMap((p) => p.corners), A.bodySize, pieces.width, pieces.height);
  drawFitted($('piecesZoom'), pieces, zoom, 320, (ctx, map) => drawPair(ctx, map, pair, true));
  drawFitted($('piecesFull'), pieces, null, 260, (ctx, map) => {
    if (state.showAll) drawAllPieces(ctx, map);
    drawPair(ctx, map, pair, false);
  });
  const cells = boundsOf([pa.boxCenter, pb.boxCenter], pa.boxCellSize * 3, box.width, box.height);
  drawFitted($('boxZoom'), box, cells, 300, (ctx, map) => drawTargets(ctx, map, pair, true));
  drawFitted($('boxFull'), box, null, 240, (ctx, map) => {
    if (state.showAll) drawAllPlacements(ctx, map);
    drawTargets(ctx, map, pair, false);
  });
  const more = remaining.length - 1;
  $('remaining').textContent = `${more} more suggestion${more === 1 ? '' : 's'} from this photo.`;
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
          state.crop = { l: 0, t: 0, r: 1, b: 1 };
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
  $('cropReset').addEventListener('click', () => { state.crop = { l: 0, t: 0, r: 1, b: 1 }; renderBoxPreview(); updateGridInfo(); });
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
  $('joined').addEventListener('click', () => {
    const s = remainingSuggestions()[0];
    if (s) { state.used.add(s.anchor); state.used.add(s.mover); }
    renderResult();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('skip').addEventListener('click', () => {
    const s = remainingSuggestions()[0];
    if (s) state.skipped.add(pairKey(s));
    renderResult();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
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
