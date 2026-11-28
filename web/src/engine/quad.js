// Finds the puzzle picture in a photo of the box: the quadrilateral whose sides are long straight edges,
// with a detailed picture on the inside and a plainer frame (or background) just outside.
//
// 1. Work on a ~800 px copy; color gradients (strongest of L, a, b) with non-maximum suppression.
// 2. Hough transform restricted to near-horizontal and near-vertical lines (allowing perspective tilt).
// 3. Every pair of horizontal x pair of vertical candidate lines forms a quad. Each side is scored by
//    how much of it lies on a real edge and by how much plainer the strip just outside it is than the strip
//    just inside (robust medians, so a banner or logo over part of the frame doesn't matter).

import { LabImage, Plane } from './images.js';
import { intersect } from './geometry.js';

const DEG = Math.PI / 180;

export function gradients(lab) {
  const w = lab.width, h = lab.height;
  const mag = new Plane(w, h), ang = new Float32Array(w * h);
  const chans = [lab.l.data, lab.a.data, lab.b.data];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    let best = 0, bx = 0, by = 0;
    for (const d of chans) {
      const gx = d[i - w + 1] + 2 * d[i + 1] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - 1] - d[i + w - 1];
      const gy = d[i + w - 1] + 2 * d[i + w] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - w] - d[i - w + 1];
      const m = gx * gx + gy * gy;
      if (m > best) { best = m; bx = gx; by = gy; }
    }
    mag.data[i] = Math.sqrt(best) / 8;
    ang[i] = Math.atan2(by, bx);
  }
  return { mag, ang };
}

/** Thin edges: keep pixels that are maximal along their gradient direction. */
export function thinEdges(mag, ang, thr) {
  const w = mag.width, h = mag.height, m = mag.data;
  const keep = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (m[i] < thr) continue;
    const dx = Math.round(Math.cos(ang[i])), dy = Math.round(Math.sin(ang[i]));
    if (m[i] >= m[i + dy * w + dx] && m[i] >= m[i - dy * w - dx]) keep[i] = 1;
  }
  return keep;
}

/** Hough peaks for lines whose normal angle theta is within `spread` of `center`. */
export function houghLines(keep, mag, ang, w, h, center, spread, maxLines) {
  const step = 0.5 * DEG;
  const nT = Math.round((2 * spread) / step) + 1;
  const D = Math.ceil(Math.hypot(w, h));
  const nR = 2 * D + 1;
  const acc = new Float32Array(nT * nR);
  const thetas = Array.from({ length: nT }, (_, k) => center - spread + k * step);
  const cs = thetas.map(Math.cos), sn = thetas.map(Math.sin);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!keep[i]) continue;
    // Normal direction of the edge, folded to [center - 90deg, center + 90deg).
    let phi = ang[i];
    while (phi < center - Math.PI / 2) phi += Math.PI;
    while (phi >= center + Math.PI / 2) phi -= Math.PI;
    if (Math.abs(phi - center) > spread + 3 * DEG) continue;
    const k0 = Math.max(0, Math.round((phi - 3 * DEG - thetas[0]) / step));
    const k1 = Math.min(nT - 1, Math.round((phi + 3 * DEG - thetas[0]) / step));
    const v = mag.data[i];
    for (let k = k0; k <= k1; k++) acc[k * nR + Math.round(x * cs[k] + y * sn[k]) + D] += v;
  }
  // Peaks with non-maximum suppression in (theta, rho).
  const order = [];
  let maxV = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > maxV) maxV = acc[i];
  for (let i = 0; i < acc.length; i++) if (acc[i] > maxV * 0.08) order.push(i);
  order.sort((a, b) => acc[b] - acc[a]);
  const lines = [];
  for (const i of order) {
    if (lines.length >= maxLines) break;
    const k = Math.floor(i / nR), r = (i % nR) - D;
    if (lines.some((l) => Math.abs(l.k - k) <= 8 && Math.abs(l.rho - r) <= 6)) continue;
    lines.push({ k, theta: thetas[k], rho: r, votes: acc[i] });
  }
  return lines;
}

/** Median distance of colors from their per-channel median: a spread measure robust to interruptions. */
function spread(colors) {
  if (colors.length === 0) return 0;
  const med = [0, 1, 2].map((c) => median(colors.map((v) => v[c])));
  return median(colors.map((v) => Math.hypot(v[0] - med[0], v[1] - med[1], v[2] - med[2])));
}

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Scores one side p->q of a quad whose interior lies in direction `inward` (unit normal).
 * Returns { support, uin, uout }: fraction of the side on a real edge, and the color spread of the strips
 * just inside and just outside it (a printed frame or plain background outside has a small spread).
 */
export function evalSide(p, q, inward, mag, ang, lab, band) {
  const w = mag.width, h = mag.height;
  const nx = inward.x, ny = inward.y;
  const N = 80;
  let support = 0, counted = 0;
  const inside = [], outside = [];
  const color = (x, y) => [lab.l.sample(x, y), lab.a.sample(x, y), lab.b.sample(x, y)];
  for (let s = 0; s < N; s++) {
    const t = (s + 0.5) / N;
    const x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
    counted++;
    // Edge support: strong gradient, aligned with the side normal, within 2 px of the line.
    for (let o = -2; o <= 2; o++) {
      const ix = Math.round(x + nx * o), iy = Math.round(y + ny * o);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
      const i = iy * w + ix;
      if (mag.data[i] > 4 && Math.abs(Math.cos(ang[i]) * nx + Math.sin(ang[i]) * ny) > 0.92) { support++; break; }
    }
  }
  if (counted < N * 0.6 || support < N * 0.25) return { support: support / N, uin: 0, uout: 1 };
  for (let s = 0; s < N; s++) {
    const t = (s + 0.5) / N;
    const x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
    inside.push(color(x + nx * band, y + ny * band));
    const ox = x - nx * band, oy = y - ny * band;
    if (ox >= 0 && oy >= 0 && ox < w && oy < h) outside.push(color(ox, oy));
  }
  // Outside the photo counts as perfectly plain (the picture may fill the photo).
  return { support: support / N, uin: spread(inside), uout: outside.length < N * 0.3 ? 0 : spread(outside) };
}

/**
 * @param {import('./images.js').RgbaImage} img
 * @returns {{quad: Array<{x:number,y:number}>, score:number, candidates: Array} | null} best corners
 *   [tl, tr, br, bl] in img pixels, plus the runner-up quads (best first) for callers that can verify them.
 */
export function detectPictureQuad(img, maxCandidates = 6) {
  const work = img.downscaleToMax(800);
  const s = img.width / work.width;
  const w = work.width, h = work.height;
  const lab = LabImage.from(work).boxBlur(1);
  const { mag, ang } = gradients(lab);
  const sorted = Float32Array.from(mag.data).sort();
  const thr = Math.max(4, sorted[Math.floor(sorted.length * 0.8)]);
  const keep = thinEdges(mag, ang, thr);

  const spread = 30 * DEG;
  const horiz = houghLines(keep, mag, ang, w, h, Math.PI / 2, spread, 14); // normals near vertical
  const vert = houghLines(keep, mag, ang, w, h, 0, spread, 14); // normals near horizontal
  const band = Math.max(5, Math.min(w, h) * 0.01);
  const minW = w * 0.25, minH = h * 0.25;

  const found = [];
  const cache = new Map();
  for (let a = 0; a < horiz.length; a++) for (let b = 0; b < horiz.length; b++) {
    if (a === b) continue;
    for (let c = 0; c < vert.length; c++) for (let d = 0; d < vert.length; d++) {
      if (c === d) continue;
      const top = horiz[a], bottom = horiz[b], left = vert[c], right = vert[d];
      const tl = intersect(top, left), tr = intersect(top, right), br = intersect(bottom, right), bl = intersect(bottom, left);
      if (!tl || !tr || !br || !bl) continue;
      // Orientation and size sanity.
      if (tr.x - tl.x < minW || br.x - bl.x < minW || bl.y - tl.y < minH || br.y - tr.y < minH) continue;
      const quad = [tl, tr, br, bl];
      if (quad.some((p) => p.x < -0.02 * w || p.y < -0.02 * h || p.x > 1.02 * w || p.y > 1.02 * h)) continue;
      // Each side is identified by its line and the two lines that cut it; scores are cached since every
      // side is shared by many candidate quads.
      const sides = [
        [tl, tr, `t${a},${c},${d}`], [tr, br, `r${d},${a},${b}`], [br, bl, `b${b},${d},${c}`], [bl, tl, `l${c},${b},${a}`],
      ];
      let logScore = 0, ok = true;
      for (const [p, q, key] of sides) {
        let sideScore = cache.get(key);
        if (sideScore === undefined) {
          const len = Math.hypot(q.x - p.x, q.y - p.y);
          // Inward normal for a clockwise (screen coordinates) quad: rotate the direction by +90deg.
          const inward = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
          const e = evalSide(p, q, inward, mag, ang, lab, band);
          const contrast = (e.uin + 2) / (e.uin + e.uout + 4); // plainer outside than inside
          sideScore = e.support * contrast * contrast;
          cache.set(key, sideScore);
        }
        if (sideScore < 0.02) { ok = false; break; }
        logScore += Math.log(sideScore);
      }
      if (!ok) continue;
      const area = Math.abs(((tr.x - bl.x) * (br.y - tl.y) - (br.x - tl.x) * (tr.y - bl.y)) / 2) / (w * h);
      const score = Math.exp(logScore / 4) * Math.pow(area, 0.25);
      found.push({ quad, score });
    }
  }
  found.sort((p, q) => q.score - p.score);
  // Distinct candidates (corners differ by more than 1.5% of the photo), best first.
  const distinct = [];
  for (const f of found) {
    if (f.score < 0.08 || distinct.length >= maxCandidates) break;
    const tol = 0.015 * Math.max(w, h);
    if (distinct.some((d) => d.quad.every((p, i) => Math.hypot(p.x - f.quad[i].x, p.y - f.quad[i].y) < tol))) continue;
    distinct.push(f);
  }
  if (distinct.length === 0) return null;
  const scaled = distinct.map((d) => ({ quad: d.quad.map((p) => ({ x: p.x * s, y: p.y * s })), score: d.score }));
  return { ...scaled[0], candidates: scaled };
}
