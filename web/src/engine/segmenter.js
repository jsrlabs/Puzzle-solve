// Finds individual puzzle pieces lying on a plain surface (a mat, cloth or table).
//
// 1. The background is the most common color in the photo (the mat), not the photo border: the border is
//    often the table or floor around the mat.
// 2. Threshold each pixel's color distance from it (Otsu, capped just above the background's own noise).
// 3. Morphological opening (removes thin printed lines on mats), fill small holes.
// 4. Split pieces that touch with a distance-transform watershed (one seed per piece body). Regions far
//    larger than a typical piece are reported as clumps.
// 5. Per piece: orientation of the square body from the outline (a 4-fold angle average, where round
//    knobs cancel out and straight sides dominate), then body center/size from occupancy profiles.

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
export function segment(img, params, exclude = null) {
  const w = img.width, h = img.height;
  const bg = backgroundColor(img);
  const dist = backgroundDistance(img, bg);
  let mask = threshold(dist, noiseLevel(dist), params);
  if (exclude) for (let i = 0; i < mask.length; i++) if (exclude[i]) mask[i] = 0;
  // Opening removes thin printed lines and specks. (No closing: it would bridge the narrow gaps between
  // neighbouring pieces; cracks inside pieces are handled by hole filling.)
  const r = Math.max(1, Math.round(Math.min(w, h) / 600));
  mask = dilateErode(dilateErode(mask, w, h, r, false), w, h, r, true); // open
  if (exclude) for (let i = 0; i < mask.length; i++) if (exclude[i]) mask[i] = 0;

  // Typical piece size from the plain connected components (most loose pieces are not touching).
  const minArea = Math.max(30, Math.floor(w * h * params.minPieceAreaFraction));
  const first = components(mask, w, h).filter((c) => c.area >= minArea && !c.touches);
  if (first.length === 0) return { pieces: [], clumps: 0, cutOff: 0 };
  const typical = median(first.map((c) => c.area));
  mask = fillSmallHoles(mask, w, h, typical * 0.25);

  const regions = splitTouching(mask, w, h, typical);
  const result = classify(regions, w, h, params, minArea);
  result.background = bg; // the mat color, used to recognise bare mat elsewhere
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
  for (let i = 0; i < w * h; i++) {
    // Lightness is down-weighted: shadows and uneven light mostly change L.
    const dl = (s.l.data[i] - bg.l) * 0.6, da = s.a.data[i] - bg.a, db = s.b.data[i] - bg.b;
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

function threshold(dist, noise, params) {
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
  const t = Math.max(params.minBackgroundDistance, Math.min(otsu, noise * 1.6 + 2));
  const mask = new Uint8Array(dist.data.length);
  for (let i = 0; i < mask.length; i++) mask[i] = dist.data[i] > t ? 1 : 0;
  return mask;
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
function splitTouching(mask, w, h, typicalArea) {
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
    // cut off by the edge) is excluded.
    touches: comps[regionComp[k]].touches,
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

function classify(regions, w, h, params, minArea) {
  const candidates = regions.filter((r) => r.area >= minArea && !r.touches);
  const cutOff = regions.filter((r) => r.area >= minArea && r.touches).length;
  if (candidates.length === 0) return { pieces: [], clumps: 0, cutOff };
  const typical = median(candidates.map((r) => r.area));
  let clumps = 0;
  const pieces = [];
  for (const r of candidates) {
    if (r.area > typical * params.maxPieceAreaRatio) { clumps++; continue; }
    if (r.area < typical * params.minPieceAreaRatio) continue;
    pieces.push(measurePiece(pieces.length, r, r.pixels, w));
  }
  return { pieces, clumps, cutOff };
}

function measurePiece(id, blob, pixels, imgW) {
  const pad = 3;
  const bx = blob.minX - pad, by = blob.minY - pad;
  const bw = blob.maxX - blob.minX + 1 + 2 * pad, bh = blob.maxY - blob.minY + 1 + 2 * pad;
  const local = new Uint8Array(bw * bh);
  let cx = 0, cy = 0;
  for (const i of pixels) {
    const x = i % imgW, y = (i / imgW) | 0;
    local[(y - by) * bw + (x - bx)] = 1;
    cx += x; cy += y;
  }
  cx /= pixels.length; cy /= pixels.length;

  // Orientation: magnitude-weighted average of 4*theta over outline gradients.
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
  let angle = Math.atan2(s4, c4) / 4;
  if (angle <= -Math.PI / 4) angle += Math.PI / 2;

  // Body extent from occupancy profiles in the aligned frame (knobs are narrower than half the body).
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const extent = Math.floor(Math.hypot(bw, bh) / 2 + 2), n = 2 * extent + 1;
  const histU = new Float64Array(n), histV = new Float64Array(n);
  for (const i of pixels) {
    const dx = (i % imgW) - cx, dy = ((i / imgW) | 0) - cy;
    const u = dx * cosA + dy * sinA, v = -dx * sinA + dy * cosA;
    histU[clamp(Math.round(u) + extent, 0, n - 1)]++;
    histV[clamp(Math.round(v) + extent, 0, n - 1)]++;
  }
  const [u0, u1] = bodyRange(histU), [v0, v1] = bodyRange(histV);
  const uc = (u0 + u1) / 2 - extent, vc = (v0 + v1) / 2 - extent;
  return {
    id, bboxX: bx, bboxY: by, bboxW: bw, bboxH: bh, mask: local, area: pixels.length,
    cx: cx + uc * cosA - vc * sinA,
    cy: cy + uc * sinA + vc * cosA,
    bodySize: (u1 - u0 + 1 + (v1 - v0 + 1)) / 2,
    angle,
  };
}

/** First/last index where the smoothed profile reaches half its maximum. */
function bodyRange(hist) {
  const n = hist.length;
  const s = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    s[i] = (hist[Math.max(0, i - 1)] + hist[i] + hist[Math.min(n - 1, i + 1)]) / 3;
    if (s[i] > peak) peak = s[i];
  }
  let first = 0; while (first < n - 1 && s[first] < peak * 0.5) first++;
  let last = n - 1; while (last > first && s[last] < peak * 0.5) last--;
  return [first, last];
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
