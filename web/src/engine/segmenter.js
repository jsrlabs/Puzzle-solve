// Finds individual puzzle pieces lying on a plain background.
//
// 1. Estimate the background color from the photo border.
// 2. Threshold each pixel's color distance from it (Otsu, capped just above the background's own noise).
// 3. Morphological close/open, fill holes.
// 4. Connected components, filtered by size relative to the median piece.
// 5. Per piece: orientation of the square body from the outline (a 4-fold angle average, where round
//    knobs cancel out and straight sides dominate), then body center/size from occupancy profiles.

import { IntegralImage, Plane, median } from './images.js';

/** @typedef {{id:number,bboxX:number,bboxY:number,bboxW:number,bboxH:number,mask:Uint8Array,area:number,cx:number,cy:number,bodySize:number,angle:number}} Piece */

export function inMask(p, x, y) {
  const ix = Math.round(x) - p.bboxX, iy = Math.round(y) - p.bboxY;
  return ix >= 0 && iy >= 0 && ix < p.bboxW && iy < p.bboxH && p.mask[iy * p.bboxW + ix] === 1;
}

/** @param {import('./images.js').LabImage} img */
export function segment(img, params) {
  const w = img.width, h = img.height;
  const dist = backgroundDistance(img);
  let mask = threshold(dist, borderNoiseLevel(dist), params);
  const r = Math.max(1, Math.round(Math.min(w, h) / 400));
  mask = dilateErode(dilateErode(mask, w, h, r, true), w, h, r, false); // close
  mask = dilateErode(dilateErode(mask, w, h, r, false), w, h, r, true); // open
  mask = fillHoles(mask, w, h);
  return extractPieces(mask, w, h, params);
}

function borderBand(w, h) { return Math.max(2, Math.round(Math.min(w, h) * 0.02)); }

function forBorder(w, h, fn) {
  const band = borderBand(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if ((x < band || y < band || x >= w - band || y >= h - band) && (x + y) % 3 === 0) fn(y * w + x);
  }
}

function backgroundDistance(img) {
  const w = img.width, h = img.height;
  const ls = [], as = [], bs = [];
  forBorder(w, h, (i) => { ls.push(img.l.data[i]); as.push(img.a.data[i]); bs.push(img.b.data[i]); });
  const bgL = median(ls), bgA = median(as), bgB = median(bs);
  const s = img.boxBlur(1);
  const out = new Plane(w, h);
  for (let i = 0; i < w * h; i++) {
    // Lightness is down-weighted: shadows and uneven light mostly change L.
    const dl = (s.l.data[i] - bgL) * 0.6, da = s.a.data[i] - bgA, db = s.b.data[i] - bgB;
    out.data[i] = Math.sqrt(dl * dl + da * da + db * db);
  }
  return out;
}

/** Distance that background pixels (at the photo border) rarely exceed. */
function borderNoiseLevel(dist) {
  const values = [];
  forBorder(dist.width, dist.height, (i) => values.push(dist.data[i]));
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * 0.98))];
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

function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp > 0) {
    const i = stack[--sp], x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

function extractPieces(mask, w, h, params) {
  const labels = new Int32Array(w * h).fill(-1);
  const order = new Int32Array(w * h); // pixels of each blob stored contiguously
  let filled = 0;
  const blobs = [];
  const minArea = Math.max(30, Math.floor(w * h * params.minPieceAreaFraction));
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start] >= 0) continue;
    const label = blobs.length, begin = filled;
    labels[start] = label;
    order[filled++] = start;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let k = begin; k < filled; k++) { // BFS using the order array as the queue
      const i = order[k], x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] && labels[i - 1] < 0) { labels[i - 1] = label; order[filled++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && labels[i + 1] < 0) { labels[i + 1] = label; order[filled++] = i + 1; }
      if (y > 0 && mask[i - w] && labels[i - w] < 0) { labels[i - w] = label; order[filled++] = i - w; }
      if (y < h - 1 && mask[i + w] && labels[i + w] < 0) { labels[i + w] = label; order[filled++] = i + w; }
    }
    const area = filled - begin;
    blobs.push({
      begin, area, minX, minY, maxX, maxY,
      big: area >= minArea,
      touches: minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1,
    });
  }
  const candidates = blobs.filter((b) => b.big && !b.touches);
  const cutOff = blobs.filter((b) => b.big && b.touches).length;
  if (candidates.length === 0) return { pieces: [], clumps: 0, cutOff };
  const medianArea = median(candidates.map((b) => b.area));
  let clumps = 0;
  const pieces = [];
  for (const blob of candidates) {
    if (blob.area > medianArea * params.maxPieceAreaRatio) { clumps++; continue; }
    if (blob.area < medianArea * params.minPieceAreaRatio) continue;
    pieces.push(measurePiece(pieces.length, blob, order.subarray(blob.begin, blob.begin + blob.area), w));
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
