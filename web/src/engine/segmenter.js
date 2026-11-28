// Finds individual puzzle pieces lying on a plain surface (a mat, cloth or table).
//
// 1. The background is the most common color in the photo (the mat), not the photo border: the border is
//    often the table or floor around the mat.
// 2. Threshold each pixel's color distance from it (Otsu, capped just above the background's own noise).
// 3. Morphological opening (removes thin printed lines on mats), fill small holes.
// 4. Split pieces that touch with a distance-transform watershed (one seed per piece body). Regions far
//    larger than a typical piece are reported as clumps.
// 5. Per piece: orientation of the square body (the angle at which its row/column occupancy profiles jump
//    most sharply, i.e. its straight sides line up), body center/size from those profiles, and the outline.
//    Regions that aren't piece-shaped (two pieces stuck together, odd sizes) are dropped.

import { IntegralImage, Plane, median } from './images.js';

/** @typedef {{id:number,bboxX:number,bboxY:number,bboxW:number,bboxH:number,mask:Uint8Array,area:number,cx:number,cy:number,bodySize:number,angle:number}} Piece */

export function inMask(p, x, y) {
  const ix = Math.round(x) - p.bboxX, iy = Math.round(y) - p.bboxY;
  return ix >= 0 && iy >= 0 && ix < p.bboxW && iy < p.bboxH && p.mask[iy * p.bboxW + ix] === 1;
}

/**
 * @param {import('./images.js').LabImage} img
 * @param {Uint8Array} [exclude] optional mask (1 = ignore, e.g. the already-assembled puzzle)
 */
export function segment(img, params, exclude = null, photoEdges = ALL_EDGES, given = {}) {
  const w = img.width, h = img.height;
  // Which sides of this image are the real photo edge (a section of a bigger photo has cut sides too).
  const atEdge = (c) => (photoEdges.left && c.minX === 0) || (photoEdges.top && c.minY === 0) ||
    (photoEdges.right && c.maxX === w - 1) || (photoEdges.bottom && c.maxY === h - 1);
  const atAnySide = (c) => c.minX === 0 || c.minY === 0 || c.maxX === w - 1 || c.maxY === h - 1;
  // A section of a bigger photo uses the whole photo's measurements (`given`): its own could be skewed, e.g.
  // a corner that is mostly table.
  const bg = given.background ?? backgroundColor(img);
  const dist = backgroundDistance(img, bg);
  const cutoff = given.threshold ?? pickThreshold(dist, noiseLevel(dist), params);
  let mask = new Uint8Array(dist.data.length);
  for (let i = 0; i < mask.length; i++) mask[i] = dist.data[i] > cutoff ? 1 : 0;
  if (exclude) for (let i = 0; i < mask.length; i++) if (exclude[i]) mask[i] = 0;
  // Opening removes thin printed lines and specks. (No closing: it would bridge the narrow gaps between
  // neighbouring pieces; cracks inside pieces are handled by hole filling.)
  const r = given.body ? Math.max(1, Math.round(given.body * 0.06)) : Math.max(1, Math.round(Math.min(w, h) / 600));
  mask = dilateErode(dilateErode(mask, w, h, r, false), w, h, r, true); // open
  if (exclude) for (let i = 0; i < mask.length; i++) if (exclude[i]) mask[i] = 0;

  // Typical piece size from the plain connected components (most loose pieces are not touching).
  let minArea = Math.max(30, Math.floor(w * h * params.minPieceAreaFraction));
  let typical = given.typicalArea;
  if (typical) minArea = Math.max(30, typical * 0.2);
  else {
    const first = components(mask, w, h).filter((c) => c.area >= minArea && !atAnySide(c));
    if (first.length === 0) return { pieces: [], clumps: 0, cutOff: 0, background: bg, threshold: cutoff };
    typical = median(first.map((c) => c.area));
  }
  mask = fillSmallHoles(mask, w, h, typical * 0.25);

  const regions = splitTouching(mask, w, h, typical, atEdge, atAnySide);
  const result = classify(regions, w, h, params, minArea, given.body);
  result.background = bg; // the mat color, used to recognise bare mat elsewhere
  result.threshold = cutoff;
  result.typicalArea = typical;
  if (params.debug) result.debug = { mask, regions, typical, bg };
  return result;
}

/** Most common color: the center of the fullest cell of a coarse Lab histogram. */
export function backgroundColor(img) {
  const n = img.width * img.height, step = Math.max(1, Math.floor(n / 200000));
  const counts = new Map();
  const L = img.l.data, A = img.a.data, B = img.b.data;
  const key = (i) => `${Math.round(L[i] / 6)},${Math.round(A[i] / 6)},${Math.round(B[i] / 6)}`;
  for (let i = 0; i < n; i += step) { const k = key(i); counts.set(k, (counts.get(k) || 0) + 1); }
  let bestKey = null, best = 0;
  for (const [k, c] of counts) if (c > best) { best = c; bestKey = k; }
  // Average the pixels in that cell for a precise color.
  let sl = 0, sa = 0, sb = 0, m = 0;
  for (let i = 0; i < n; i += step) if (key(i) === bestKey) { sl += L[i]; sa += A[i]; sb += B[i]; m++; }
  return { l: sl / m, a: sa / m, b: sb / m };
}

function backgroundDistance(img, bg) {
  const w = img.width, h = img.height;
  const s = img.boxBlur(1);
  const out = new Plane(w, h);
  // On a light surface lightness is down-weighted (shadows mostly change L). On a dark mat shadows don't show,
  // and lightness is the main thing that separates dark pieces from the mat, so it counts fully.
  const lw = bg.l < 25 ? 1 : 0.6;
  for (let i = 0; i < w * h; i++) {
    const dl = (s.l.data[i] - bg.l) * lw, da = s.a.data[i] - bg.a, db = s.b.data[i] - bg.b;
    out.data[i] = Math.sqrt(dl * dl + da * da + db * db);
  }
  return out;
}

/** Spread of background pixels' distances: the 90th percentile among pixels that are clearly background. */
function noiseLevel(dist) {
  const near = [];
  const step = Math.max(1, Math.floor(dist.data.length / 200000));
  for (let i = 0; i < dist.data.length; i += step) if (dist.data[i] < 12) near.push(dist.data[i]);
  if (near.length === 0) return 4;
  near.sort((a, b) => a - b);
  return near[Math.floor(near.length * 0.9)];
}

function pickThreshold(dist, noise, params) {
  let maxV = 1;
  for (const v of dist.data) if (v > maxV) maxV = v;
  const bins = 256, hist = new Float64Array(bins);
  for (const v of dist.data) hist[Math.min(bins - 1, Math.floor((v / maxV) * (bins - 1)))]++;
  const total = dist.data.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, bestT = 0;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  const otsu = ((bestT + 0.5) / (bins - 1)) * maxV;
  // Otsu alone sits too high when some pieces are vivid and others dull.
  return Math.max(params.minBackgroundDistance, Math.min(otsu, noise * 1.6 + 2));
}

/** dilate=true: any pixel set in the window; dilate=false (erode): all pixels set. */
function dilateErode(mask, w, h, r, dilate) {
  const ii = new IntegralImage(new Plane(w, h, Float32Array.from(mask)));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const c = Math.round(ii.sum(x0, y0, x1, y1));
      out[y * w + x] = dilate ? (c > 0 ? 1 : 0) : (c === (x1 - x0 + 1) * (y1 - y0 + 1) ? 1 : 0);
    }
  }
  return out;
}

const ALL_EDGES = Object.freeze({ left: true, top: true, right: true, bottom: true });

/** 4-connected components: [{ area, minX, minY, maxX, maxY, touches }] plus labels if requested. */
function components(mask, w, h, wantLabels = false) {
  const labels = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  const out = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start] >= 0) continue;
    const id = out.length;
    let head = 0, tail = 0;
    queue[tail++] = start; labels[start] = id;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    while (head < tail) {
      const i = queue[head++], x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] && labels[i - 1] < 0) { labels[i - 1] = id; queue[tail++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && labels[i + 1] < 0) { labels[i + 1] = id; queue[tail++] = i + 1; }
      if (y > 0 && mask[i - w] && labels[i - w] < 0) { labels[i - w] = id; queue[tail++] = i - w; }
      if (y < h - 1 && mask[i + w] && labels[i + w] < 0) { labels[i + w] = id; queue[tail++] = i + w; }
    }
    out.push({ area: tail, minX, minY, maxX, maxY, touches: minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1 });
  }
  return wantLabels ? { comps: out, labels } : out;
}

/** Fills background holes smaller than maxArea that don't reach the photo border (dark spots on pieces). */
function fillSmallHoles(mask, w, h, maxArea) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const { comps, labels } = components(inv, w, h, true);
  const out = mask.slice();
  for (let i = 0; i < out.length; i++) {
    const l = labels[i];
    if (l >= 0 && !comps[l].touches && comps[l].area < maxArea) out[i] = 1;
  }
  return out;
}

/** Chamfer distance (in pixels) from each mask pixel to the nearest background pixel. */
function distanceTransform(mask, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + a); else v = Math.min(v, 1);
    if (y > 0) {
      v = Math.min(v, d[i - w] + a);
      if (x > 0) v = Math.min(v, d[i - w - 1] + b);
      if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
    } else v = Math.min(v, 1);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + a); else v = Math.min(v, 1);
    if (y < h - 1) {
      v = Math.min(v, d[i + w] + a);
      if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
      if (x > 0) v = Math.min(v, d[i + w - 1] + b);
    } else v = Math.min(v, 1);
    d[i] = v;
  }
  return d;
}

/**
 * Separates touching pieces with a distance-transform watershed. Each piece body is a "hill" in the
 * distance map (its center is ~half a piece away from the background) while contacts between pieces are
 * narrow valleys. One seed per hill, then regions grow downhill until they meet.
 * Blobs no bigger than ~1.5 pieces are left whole. Returns regions with their pixel lists.
 */
function splitTouching(mask, w, h, typicalArea, atEdge, atAnySide) {
  const { comps, labels: compOf } = components(mask, w, h, true);
  const labels = new Int32Array(w * h).fill(-1);
  let regionCount = 0;
  const regionComp = []; // blob each region came from
  const regionOfComp = comps.map((c, k) => (c.area <= typicalArea * 1.5 ? (regionComp.push(k), regionCount++) : -1));
  for (let i = 0; i < labels.length; i++) if (compOf[i] >= 0 && regionOfComp[compOf[i]] >= 0) labels[i] = regionOfComp[compOf[i]];

  const body = Math.sqrt(typicalArea);
  const dt = distanceTransform(mask, w, h);
  // Seeds: local maxima of the distance map deep enough to be a piece body, at least ~half a piece apart.
  const minDepth = 0.22 * body, minSep = 0.7 * body;
  const cands = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, v = dt[i];
    if (v < minDepth || labels[i] >= 0 || compOf[i] < 0) continue;
    if (v >= dt[i - 1] && v >= dt[i + 1] && v >= dt[i - w] && v >= dt[i + w] &&
        v >= dt[i - w - 1] && v >= dt[i - w + 1] && v >= dt[i + w - 1] && v >= dt[i + w + 1]) cands.push(i);
  }
  cands.sort((p, q) => dt[q] - dt[p]);
  const cell = Math.max(1, Math.ceil(minSep));
  const gw = Math.ceil(w / cell) + 1;
  const grid = new Map();
  const PQ = new BucketQueue(Math.ceil(body) + 2);
  for (const i of cands) {
    const x = i % w, y = (i / w) | 0, gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) {
      for (const j of grid.get((gy + dy) * gw + gx + dx) || []) {
        if (Math.hypot((j % w) - x, ((j / w) | 0) - y) < minSep) { near = true; break; }
      }
    }
    if (near) continue;
    const key = gy * gw + gx;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
    labels[i] = regionCount++;
    regionComp.push(compOf[i]);
    PQ.push(i, dt[i]);
  }
  // Priority flood: always extend the region at the highest remaining distance value.
  while (PQ.size > 0) {
    const i = PQ.pop(), l = labels[i], x = i % w;
    const grow = (j) => { if (mask[j] && labels[j] < 0) { labels[j] = l; PQ.push(j, dt[j]); } };
    if (x > 0) grow(i - 1);
    if (x < w - 1) grow(i + 1);
    if (i >= w) grow(i - w);
    if (i < w * (h - 1)) grow(i + w);
  }
  mergeFragments(labels, w, h, regionCount, typicalArea);
  const n = regionCount;
  // Collect pixels per region.
  const counts = new Int32Array(n);
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) counts[labels[i]]++;
  const start = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) start[k + 1] = start[k] + counts[k];
  const pixels = new Int32Array(start[n]);
  const fill = start.slice(0, n);
  const regions = Array.from({ length: n }, () => ({ minX: w, minY: h, maxX: 0, maxY: 0 }));
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l < 0) continue;
    pixels[fill[l]++] = i;
    const r = regions[l], x = i % w, y = (i / w) | 0;
    if (x < r.minX) r.minX = x; if (x > r.maxX) r.maxX = x;
    if (y < r.minY) r.minY = y; if (y > r.maxY) r.maxY = y;
  }
  return regions.map((r, k) => ({
    ...r,
    area: counts[k],
    pixels: pixels.subarray(start[k], start[k + 1]),
    // Anything split off a blob that reaches the photo edge (the table or floor around the mat, or pieces
    // cut off by the edge) is excluded; so is a piece cut by a section boundary (its neighbour section has it).
    touches: atEdge(comps[regionComp[k]]),
    cut: atAnySide(r),
  })).filter((r) => r.area > 0);
}

/**
 * Watershed over-splits some pieces (a long piece can have two hills). Merge each region smaller than a
 * piece into the neighbour it shares the longest border with, when the result is still piece-sized.
 */
function mergeFragments(labels, w, h, n, typicalArea) {
  const area = new Float64Array(n);
  for (const l of labels) if (l >= 0) area[l]++;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let pass = 0; pass < 3; pass++) {
    // Shared border lengths between current (merged) regions.
    const border = new Map();
    const add = (a, b) => {
      if (a === b) return;
      const key = a < b ? a * n + b : b * n + a;
      border.set(key, (border.get(key) || 0) + 1);
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, l = labels[i];
      if (l < 0) continue;
      const a = find(l);
      if (x < w - 1 && labels[i + 1] >= 0) add(a, find(labels[i + 1]));
      if (y < h - 1 && labels[i + w] >= 0) add(a, find(labels[i + w]));
    }
    const best = new Map(); // small region -> [neighbour, border]
    for (const [key, len] of border) {
      const a = Math.floor(key / n), b = key % n;
      for (const [s, o] of [[a, b], [b, a]]) {
        if (area[s] >= typicalArea * 0.75 || area[s] + area[o] > typicalArea * 1.5) continue;
        const cur = best.get(s);
        if (!cur || len > cur[1]) best.set(s, [o, len]);
      }
    }
    let merged = 0;
    for (const [s, [o]] of best) {
      const rs = find(s), ro = find(o);
      if (rs === ro || area[rs] + area[ro] > typicalArea * 1.5) continue;
      parent[rs] = ro;
      area[ro] += area[rs];
      merged++;
    }
    if (!merged) break;
  }
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) labels[i] = find(labels[i]);
}

function classify(regions, w, h, params, minArea, givenBody) {
  const candidates = regions.filter((r) => r.area >= minArea && !r.touches && !r.cut);
  const cutOff = regions.filter((r) => r.area >= minArea && r.touches).length;
  if (candidates.length === 0) return { pieces: [], clumps: 0, cutOff };
  const typical = median(candidates.map((r) => r.area));
  let clumps = 0;
  const measured = [];
  for (const r of candidates) {
    if (r.area > typical * params.maxPieceAreaRatio) { clumps++; continue; }
    if (r.area < typical * params.minPieceAreaRatio) continue;
    measured.push(measurePiece(measured.length, r, r.pixels, w));
  }
  // Keep only piece-shaped regions: a square body about the usual size, no wider than body + two knobs.
  // Two pieces stuck together, or a piece with a neighbour's knob attached, fail these checks.
  const body = givenBody ?? median(measured.map((p) => p.bodySize));
  const pieces = [];
  for (const p of measured) {
    const squareish = Math.max(p.bodyW, p.bodyH) / Math.max(1, Math.min(p.bodyW, p.bodyH)) < 1.45;
    const sized = p.bodySize > body * 0.72 && p.bodySize < body * 1.35;
    const compact = Math.max(p.spanU, p.spanV) < body * 2.15;
    // The body fit (solid corners, empty just outside them) is near-perfect for a single piece and poor for two
    // pieces stuck together or overlapping.
    const fits = p.fitScore >= 8;
    // Even with four big knobs a piece covers at most ~1.5 body squares; two overlapping pieces cover ~2.
    const oneArea = p.area < body * body * 1.55;
    if (squareish && sized && compact && fits && oneArea) pieces.push({ ...p, id: pieces.length });
    else { clumps++; if (params.debug) (params.rejected ??= []).push({ p, why: [squareish, sized, compact, fits, oneArea] }); }
  }
  return { pieces, clumps, cutOff };
}

function measurePiece(id, blob, pixels, imgW) {
  const pad = 3;
  const bx = blob.minX - pad, by = blob.minY - pad;
  const bw = blob.maxX - blob.minX + 1 + 2 * pad, bh = blob.maxY - blob.minY + 1 + 2 * pad;
  const local = new Uint8Array(bw * bh);
  let cx = 0, cy = 0;
  const xs = new Float32Array(pixels.length), ys = new Float32Array(pixels.length);
  pixels.forEach((i) => {
    const x = i % imgW, y = (i / imgW) | 0;
    local[(y - by) * bw + (x - bx)] = 1;
    cx += x; cy += y;
  });
  cx /= pixels.length; cy /= pixels.length;
  pixels.forEach((i, k) => { xs[k] = (i % imgW) - cx; ys[k] = ((i / imgW) | 0) - cy; });

  // Orientation: two estimates, keep the one that fits a square body best.
  //  - gradient: magnitude-weighted average of 4*theta over the outline (straight sides agree, round knobs
  //    mostly cancel) - accurate unless the knobs are large;
  //  - rectangle: the smallest rectangle around the whole piece (knobs sit mid-side, so it usually lines
  //    up with the body) - robust to large knobs, but tilts for some knob arrangements.
  const extent = Math.floor(Math.hypot(bw, bh) / 2 + 2), n = 2 * extent + 1;
  const histU = new Float64Array(n), histV = new Float64Array(n);
  // A row/column through the body holds a good part of a body width even across a deep hole; one through a
  // knob only holds the knob's width. The body size is roughly sqrt(area) (knobs and holes balance out).
  const minCount = 0.65 * Math.sqrt(pixels.length);
  const fitAt = (angle) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    histU.fill(0); histV.fill(0);
    for (let k = 0; k < xs.length; k++) {
      histU[clamp(Math.round(xs[k] * c + ys[k] * s) + extent, 0, n - 1)]++;
      histV[clamp(Math.round(-xs[k] * s + ys[k] * c) + extent, 0, n - 1)]++;
    }
    const [u0, u1] = bodyRange(histU, minCount), [v0, v1] = bodyRange(histV, minCount);
    const uc = (u0 + u1) / 2 - extent, vc = (v0 + v1) / 2 - extent, hw = (u1 - u0) / 2, hh = (v1 - v0) / 2;
    // Body corners are always solid piece; just diagonally outside them there is never any piece.
    const at = (u, v) => {
      const x = Math.round(cx + u * c - v * s) - bx, y = Math.round(cy + u * s + v * c) - by;
      return x >= 0 && y >= 0 && x < bw && y < bh && local[y * bw + x] ? 1 : 0;
    };
    let score = 0;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (const f of [0.75, 0.85]) score += at(uc + su * hw * f, vc + sv * hh * f);
      for (const f of [1.15, 1.3]) score -= at(uc + su * hw * f, vc + sv * hh * f);
    }
    const squareness = Math.min(hw, hh) / Math.max(hw, hh);
    return { angle, uc, vc, bodyW: 2 * hw, bodyH: 2 * hh, score: score + squareness * 2, hu: histU.slice(), hv: histV.slice() };
  };
  const soft = new Plane(bw, bh, Float32Array.from(local)).boxBlur(2);
  let c4 = 0, s4 = 0;
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const v = soft.get(x, y);
    if (v < 0.15 || v > 0.85) continue;
    const gx = soft.get(x + 1, y) - soft.get(x - 1, y), gy = soft.get(x, y + 1) - soft.get(x, y - 1);
    const mag = Math.hypot(gx, gy);
    if (mag < 1e-6) continue;
    const t = Math.atan2(gy, gx);
    c4 += mag * Math.cos(4 * t); s4 += mag * Math.sin(4 * t);
  }
  const rect = minAreaRect(local, bw, bh);
  const candidates = [Math.atan2(s4, c4) / 4];
  if (rect) candidates.push(rect.angle);
  let fit = null;
  for (const a0 of candidates) for (const d of [0, -3, 3]) {
    const f = fitAt(a0 + (d * Math.PI) / 180);
    if (!fit || f.score > fit.score) fit = f;
  }
  let angle = fit.angle;
  while (angle > Math.PI / 4) angle -= Math.PI / 2;
  while (angle <= -Math.PI / 4) angle += Math.PI / 2;
  // Turning the frame by quarter turns doesn't change the body; just express it in the normalized angle.
  const quarter = Math.round((fit.angle - angle) / (Math.PI / 2));
  const swap = Math.abs(quarter) % 2 === 1;
  const bodyW = swap ? fit.bodyH : fit.bodyW, bodyH = swap ? fit.bodyW : fit.bodyH;
  const cosF = Math.cos(fit.angle), sinF = Math.sin(fit.angle);
  const bodyCx = cx + fit.uc * cosF - fit.vc * sinF, bodyCy = cy + fit.uc * sinF + fit.vc * cosF;
  histU.set(fit.hu); histV.set(fit.hv);
  // Full width including knobs, to recognise blobs that are really two pieces.
  const span = (hst) => { let f = 0; while (f < n && !hst[f]) f++; let l = n - 1; while (l > f && !hst[l]) l--; return l - f + 1; };
  return {
    id, bboxX: bx, bboxY: by, bboxW: bw, bboxH: bh, mask: local, area: pixels.length,
    cx: bodyCx,
    cy: bodyCy,
    bodySize: (bodyW + bodyH) / 2,
    bodyW,
    bodyH,
    spanU: span(histU),
    spanV: span(histV),
    angle,
    fitScore: fit.score, // up to 10: corners solid, outside corners empty, square body
    outline: traceOutline(local, bw, bh).map(([x, y]) => [x + bx, y + by]),
  };
}

/**
 * Smallest-area rectangle around the set pixels of a mask (convex hull + rotating edge directions).
 * Returns { angle, cx, cy, w, h } in mask coordinates (w along `angle`), or null for an empty mask.
 */
function minAreaRect(mask, w, h) {
  // Pixel corners of the boundary pixels are enough for the hull.
  const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && mask[y * w + x - 1] && mask[y * w + x + 1] && mask[(y - 1) * w + x] && mask[(y + 1) * w + x]) continue;
    pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
  }
  if (pts.length < 3) return null;
  const hull = convexHull(pts);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i], [x1, y1] = hull[(i + 1) % hull.length];
    const a = Math.atan2(y1 - y0, x1 - x0), c = Math.cos(a), s = Math.sin(a);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c + y * s, v = -x * s + y * c;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const uc = (minU + maxU) / 2, vc = (minV + maxV) / 2;
      best = { area, angle: a, w: maxU - minU, h: maxV - minV, cx: uc * c - vc * s, cy: uc * s + vc * c };
    }
  }
  return best;
}

/** Andrew's monotone chain convex hull. */
function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Outline of a binary mask (Moore-neighbour tracing), thinned to at most ~80 points. */
function traceOutline(mask, w, h) {
  let start = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return [];
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
  const pts = [];
  let x = start % w, y = (start / w) | 0, dir = 6; // came from above-ish
  const sx = x, sy = y;
  for (let steps = 0; steps < 4 * (w + h) * 4; steps++) {
    pts.push([x, y]);
    // Look around clockwise starting from the direction after backtracking.
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;
      const nx = x + dirs[d][0], ny = y + dirs[d][1];
      if (at(nx, ny)) { x = nx; y = ny; dir = d; found = true; break; }
    }
    if (!found || (x === sx && y === sy && pts.length > 2)) break;
  }
  const step = Math.max(1, Math.ceil(pts.length / 80));
  return pts.filter((_, i) => i % step === 0);
}

/**
 * Body extent along one axis: the first/last index where the smoothed profile reaches `minCount`, refined to
 * sub-pixel precision at the middle of the jump from knob level to body level.
 */
function bodyRange(hist, minCount) {
  const n = hist.length;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = (hist[Math.max(0, i - 1)] + hist[i] + hist[Math.min(n - 1, i + 1)]) / 3;
  let first = 0; while (first < n - 1 && s[first] < minCount) first++;
  let last = n - 1; while (last > first && s[last] < minCount) last--;
  const refine = (i, dir) => {
    // Levels just outside and just inside the edge; return where the profile crosses halfway.
    const lo = s[Math.max(0, Math.min(n - 1, i - 4 * dir))], hi = s[Math.max(0, Math.min(n - 1, i + 4 * dir))];
    const mid = (lo + hi) / 2;
    for (let k = i - 4 * dir; k !== i + 4 * dir; k += dir) {
      if (k < 0 || k + dir < 0 || k >= n || k + dir >= n) continue;
      const a = s[k], b = s[k + dir];
      if ((a - mid) * (b - mid) <= 0 && a !== b) return k + (dir * (mid - a)) / (b - a);
    }
    return i;
  };
  return [refine(first, 1), refine(last, -1)];
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Max-priority queue over integer buckets (priorities are distances, so small non-negative numbers). */
class BucketQueue {
  constructor(maxPriority) {
    this.buckets = Array.from({ length: maxPriority + 1 }, () => []);
    this.top = 0;
    this.size = 0;
  }
  push(item, priority) {
    const p = Math.min(this.buckets.length - 1, Math.max(0, Math.floor(priority)));
    this.buckets[p].push(item);
    if (p > this.top) this.top = p;
    this.size++;
  }
  pop() {
    while (this.buckets[this.top].length === 0) this.top--;
    this.size--;
    return this.buckets[this.top].pop();
  }
}
