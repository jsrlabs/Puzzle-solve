// Finds where each piece's picture fragment appears in the box picture.
//
// The box picture is resampled so each puzzle cell is exactly `cellPx` pixels. Each piece contributes a grid
// of Lab color samples from its body; these are compared (sum of squared differences) with the box picture
// at candidate positions, in all four 90-degree orientations. A cheap rotation-independent mean-color
// prefilter discards most positions first.

import { IntegralImage } from './images.js';

/** Rotate (u, v) by q quarter turns (image coordinates, y down). */
export function rot(q, u, v) {
  switch (q & 3) {
    case 0: return [u, v];
    case 1: return [-v, u];
    case 2: return [-u, -v];
    default: return [v, -u];
  }
}

export class PieceLocator {
  /** @param {import('./images.js').LabImage} box */
  constructor(box, params) {
    this.box = box;
    this.params = params;
    this.cell = params.cellPx;
    const w = (this.w = box.width), h = (this.h = box.height);
    // Window statistics for the prefilter, precomputed for every pixel.
    this.winL = new Float32Array(w * h);
    this.winA = new Float32Array(w * h);
    this.winB = new Float32Array(w * h);
    this.winStd = new Float32Array(w * h);
    const iiL = new IntegralImage(box.l), iiL2 = new IntegralImage(box.l, true);
    const iiA = new IntegralImage(box.a), iiB = new IntegralImage(box.b);
    const half = Math.round((this.cell * params.sampleSpan) / 2);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
        const n = (x1 - x0 + 1) * (y1 - y0 + 1), i = y * w + x;
        const mL = iiL.sum(x0, y0, x1, y1) / n;
        this.winL[i] = mL;
        this.winA[i] = iiA.sum(x0, y0, x1, y1) / n;
        this.winB[i] = iiB.sum(x0, y0, x1, y1) / n;
        this.winStd[i] = Math.sqrt(Math.max(0, iiL2.sum(x0, y0, x1, y1) / n - mL * mL));
      }
    }
  }

  /**
   * @param samples {{u:Float32Array,v:Float32Array,l:Float32Array,a:Float32Array,b:Float32Array}}
   * @param color per-channel gain/offset mapping piece colors onto box colors
   * @returns {{x:number,y:number,q:number,error:number,confidence:number}|null}
   */
  locate(samples, color, fineSamples = null) {
    const n = samples.u.length;
    if (n < 8) return null;
    const { box, cell, w, h } = this;
    const wl = this.params.lightnessWeight;
    const cl = new Float32Array(n), ca = new Float32Array(n), cb = new Float32Array(n);
    let mL = 0, mA = 0, mB = 0;
    for (let i = 0; i < n; i++) {
      cl[i] = color.gainL * samples.l[i] + color.offL;
      ca[i] = color.gainA * samples.a[i] + color.offA;
      cb[i] = color.gainB * samples.b[i] + color.offB;
      mL += cl[i]; mA += ca[i]; mB += cb[i];
    }
    mL /= n; mA /= n; mB /= n;
    let vL = 0;
    for (let i = 0; i < n; i++) vL += (cl[i] - mL) ** 2;
    const sL = Math.sqrt(vL / n);

    // Candidate body centers (stride 2) keeping the whole body inside the picture.
    const margin = Math.max(Math.round(cell * 0.45), Math.round((cell * this.params.sampleSpan) / 2));
    const xs = [], ys = [];
    for (let x = margin; x < w - margin; x += 2) xs.push(x);
    for (let y = margin; y < h - margin; y += 2) ys.push(y);
    if (xs.length === 0 || ys.length === 0) return null;

    // 1. Prefilter on window mean color and texture.
    const count = xs.length * ys.length;
    const pre = new Float32Array(count);
    let k = 0, maxPre = 0;
    for (const y of ys) for (const x of xs) {
      const i = y * w + x;
      const dl = (this.winL[i] - mL) * wl, da = this.winA[i] - mA, db = this.winB[i] - mB, ds = this.winStd[i] - sL;
      const d = dl * dl + da * da + db * db + 0.5 * ds * ds;
      pre[k++] = d;
      if (d > maxPre) maxPre = d;
    }
    const limit = kthSmallestBound(pre, Math.max(64, Math.floor(count * this.params.prefilterFraction)), maxPre);

    // 2. Sample comparison at surviving positions, all four orientations. Offsets are stored as linear
    // pixel offsets; the margin above keeps every sample inside the picture (|offset| <= span/2 * cell).
    const offs = [];
    for (let q = 0; q < 4; q++) {
      const o = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const [rx, ry] = rot(q, samples.u[i] * cell, samples.v[i] * cell);
        o[i] = Math.round(ry) * w + Math.round(rx);
      }
      offs.push(o);
    }
    const L = box.l.data, A = box.a.data, B = box.b.data;
    const clw = cl.map((v) => v * wl);
    // Error of placing the samples (every `step`-th one) at (x, y) in orientation q; stops early past `limitE`.
    const error = (x, y, q, step, limitE) => {
      const o = offs[q], base = y * w + x;
      let e = 0;
      for (let i = 0; i < n; i += step) {
        const j = base + o[i];
        const dl = L[j] * wl - clw[i], da = A[j] - ca[i], db = B[j] - cb[i];
        e += dl * dl + da * da + db * db;
        if (e >= limitE) break;
      }
      return e;
    };
    // 2a. Quick pass with a quarter of the samples...
    const quick = []; // [x, y, quickError]
    k = 0;
    for (const y of ys) for (const x of xs) {
      if (pre[k++] > limit) continue;
      let bestE = Infinity;
      for (let q = 0; q < 4; q++) bestE = Math.min(bestE, error(x, y, q, 4, bestE));
      quick.push([x, y, bestE]);
    }
    quick.sort((p, q) => p[2] - q[2]);
    // 2b. ...then all samples for the most promising positions.
    const cand = []; // [x, y, error]
    for (const [x, y] of quick.slice(0, Math.max(50, Math.ceil(quick.length * 0.2)))) {
      let bestE = Infinity;
      for (let q = 0; q < 4; q++) bestE = Math.min(bestE, error(x, y, q, 1, bestE));
      cand.push([x, y, bestE / n]);
    }
    if (cand.length === 0) return null;

    // 3. A few distinct locations (non-maximum suppression), refined to single-pixel precision.
    cand.sort((p, q) => p[2] - q[2]);
    const minSep = cell * 0.7;
    const useFine = this.fine && fineSamples && fineSamples.u.length >= 8;
    const want = useFine ? this.params.fineCandidates ?? 25 : 5;
    const picked = [];
    for (const c of cand) {
      if (picked.length >= want) break;
      if (picked.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) >= minSep)) picked.push(c);
    }
    // 4. With the high-detail second look, the coarse search only nominates candidates; a sharper comparison
    //    with finer samples decides. Otherwise refine the few best candidates at the coarse level.
    const refined = useFine
      ? picked.map((c) => this.fineCheck({ x: c[0], y: c[1], q: 0, error: c[2] }, fineSamples, color)).sort((p, q) => p.error - q.error)
      : picked.map((c) => this.refine(c[0], c[1], samples, cl, ca, cb)).sort((p, q) => p.error - q.error);
    const best = refined[0];
    const second = refined.length > 1 ? refined[1].error : best.error * 2 + 1;
    const confidence = second <= 0 ? 0 : Math.min(1, Math.max(0, 1 - best.error / second));
    return { ...best, confidence };
  }

  /** Local search (+/-2 px, all orientations) with exact (bilinear) sample offsets. */
  refine(x0, y0, samples, cl, ca, cb) {
    const n = samples.u.length, cell = this.cell, wl = this.params.lightnessWeight;
    const { l, a, b } = this.box;
    let best = { x: x0, y: y0, q: 0, error: Infinity };
    for (let q = 0; q < 4; q++) {
      const ox = new Float32Array(n), oy = new Float32Array(n);
      for (let i = 0; i < n; i++) [ox[i], oy[i]] = rot(q, samples.u[i] * cell, samples.v[i] * cell);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = x0 + dx, y = y0 + dy;
        let e = 0;
        for (let i = 0; i < n; i++) {
          const px = x + ox[i], py = y + oy[i];
          const dl = (l.sample(px, py) - cl[i]) * wl, da = a.sample(px, py) - ca[i], db = b.sample(px, py) - cb[i];
          e += dl * dl + da * da + db * db;
        }
        e /= n;
        if (e < best.error) best = { x, y, q, error: e };
      }
    }
    return best;
  }

  /** Enables the high-detail second look: `box` is the box picture at `cell` pixels per puzzle cell. */
  setFine(box, cell) {
    this.fine = { box, cell, ratio: cell / this.cell };
  }

  /**
   * Re-scores a candidate (coarse coordinates) with high-detail samples: small local search in all four
   * orientations. Returns the candidate with the fine error (position stays in coarse coordinates).
   */
  fineCheck(c, samples, color) {
    const { box, cell, ratio } = this.fine;
    const n = samples.u.length, wl = this.params.lightnessWeight;
    const cl = new Float32Array(n), ca = new Float32Array(n), cb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      cl[i] = (color.gainL * samples.l[i] + color.offL) * wl;
      ca[i] = color.gainA * samples.a[i] + color.offA;
      cb[i] = color.gainB * samples.b[i] + color.offB;
    }
    const step = Math.max(1, Math.round(cell * 0.04));
    const x0 = c.x * ratio, y0 = c.y * ratio;
    const offsets = [0, 1, 2, 3].map((q) => {
      const ox = new Float32Array(n), oy = new Float32Array(n);
      for (let i = 0; i < n; i++) [ox[i], oy[i]] = rot(q, samples.u[i] * cell, samples.v[i] * cell);
      return [ox, oy];
    });
    const err = (q, x, y, limit) => {
      const [ox, oy] = offsets[q];
      let e = 0;
      for (let i = 0; i < n; i++) {
        const px = x + ox[i], py = y + oy[i];
        const dl = box.l.sample(px, py) * wl - cl[i], da = box.a.sample(px, py) - ca[i], db = box.b.sample(px, py) - cb[i];
        e += dl * dl + da * da + db * db;
        if (e >= limit) return Infinity;
      }
      return e / n;
    };
    // All four orientations at the candidate itself, then a small local search for the two best.
    const qs = [0, 1, 2, 3].map((q) => [q, err(q, x0, y0, Infinity)]).sort((p, q) => p[1] - q[1]).slice(0, 2);
    let best = { ...c, x: c.x, y: c.y, q: qs[0][0], error: qs[0][1] };
    for (const [q] of qs) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy && q === best.q) continue;
        const x = x0 + dx * step, y = y0 + dy * step;
        const e = err(q, x, y, best.error * n);
        if (e < best.error) best = { x: x / ratio, y: y / ratio, q, error: e };
      }
    }
    return best;
  }

  /** Box colors under a match, for fitting the color model. */
  boxColorsAt(m, samples) {
    const n = samples.u.length, cell = this.cell;
    const l = new Float32Array(n), a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [ox, oy] = rot(m.q, samples.u[i] * cell, samples.v[i] * cell);
      l[i] = this.box.l.sample(m.x + ox, m.y + oy);
      a[i] = this.box.a.sample(m.x + ox, m.y + oy);
      b[i] = this.box.b.sample(m.x + ox, m.y + oy);
    }
    return { l, a, b };
  }
}

/** Upper bound for the k-th smallest value (histogram based, O(n)). */
function kthSmallestBound(values, k, maxV) {
  if (k >= values.length || maxV <= 0) return Infinity;
  const bins = 4096, hist = new Int32Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.floor((v / maxV) * (bins - 1)))]++;
  let acc = 0;
  for (let i = 0; i < bins; i++) {
    acc += hist[i];
    if (acc >= k) return ((i + 1) / (bins - 1)) * maxV;
  }
  return Infinity;
}
