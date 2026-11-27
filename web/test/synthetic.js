// Generates fake jigsaw puzzles for tests: a random "box picture" and a "photo" of some of its pieces
// (with knobs, random rotation, different scale, lighting change and noise) lying on a plain table.

import { RgbaImage } from '../src/engine/images.js';

/** Small deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo)), // [lo, hi)
    range: (lo, hi) => lo + next() * (hi - lo),
    bool: () => next() < 0.5,
  };
}

export class SyntheticPuzzle {
  constructor(cols, rows, cellPx = 40, seed = 1) {
    this.cols = cols; this.rows = rows; this.cellPx = cellPx;
    this.r = rng(seed);
    this.artW = cols * cellPx; this.artH = rows * cellPx;
    this.art = this.makeArt();
    this.hEdges = Array.from({ length: rows }, () => Array.from({ length: cols - 1 }, () => (this.r.bool() ? 1 : -1)));
    this.vEdges = Array.from({ length: rows - 1 }, () => Array.from({ length: cols }, () => (this.r.bool() ? 1 : -1)));
  }

  boxImage(outW = this.artW, noise = 6) {
    const data = new Uint8ClampedArray(this.artW * this.artH * 4);
    for (let i = 0; i < this.artW * this.artH; i++) {
      for (let c = 0; c < 3; c++) data[i * 4 + c] = this.art[i * 3 + c] + this.r.int(-noise, noise + 1);
      data[i * 4 + 3] = 255;
    }
    const img = new RgbaImage(this.artW, this.artH, data);
    return outW === this.artW ? img : img.resize(outW, Math.round((this.artH * outW) / this.artW));
  }

  /** Photo of `count` random pieces scattered in a loose grid. Returns { image, truths }. */
  piecesPhoto(count, { scale = 1.8, gain = 0.85, offset = 12, background = [46, 90, 60], noise = 8 } = {}) {
    const all = Array.from({ length: this.cols * this.rows }, (_, i) => i);
    for (let i = all.length - 1; i > 0; i--) { const j = this.r.int(0, i + 1); [all[i], all[j]] = [all[j], all[i]]; }
    const chosen = all.slice(0, count);
    const slot = Math.round(this.cellPx * scale * 2);
    const slotsX = Math.max(1, Math.ceil(Math.sqrt(count * 1.5)));
    const slotsY = Math.ceil(count / slotsX);
    const w = slotsX * slot + (slot >> 1), h = slotsY * slot + (slot >> 1);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) data[i * 4 + c] = background[c] + this.r.int(-noise, noise + 1);
      data[i * 4 + 3] = 255;
    }
    const truths = [];
    chosen.forEach((idx, k) => {
      const col = idx % this.cols, row = Math.floor(idx / this.cols);
      const cx = ((k % slotsX) + 0.75) * slot + this.r.range(-0.07, 0.07) * slot;
      const cy = (Math.floor(k / slotsX) + 0.75) * slot + this.r.range(-0.07, 0.07) * slot;
      const rotation = this.r.range(0, 2 * Math.PI);
      truths.push({ col, row, center: { x: cx, y: cy }, rotation });
      const c = Math.cos(rotation), s = Math.sin(rotation);
      const reach = Math.floor(this.cellPx * scale * 0.95);
      for (let y = Math.floor(cy - reach); y <= cy + reach; y++) for (let x = Math.floor(cx - reach); x <= cx + reach; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const dx = (x - cx) / scale, dy = (y - cy) / scale;
        const ax = (col + 0.5) * this.cellPx + (c * dx + s * dy);
        const ay = (row + 0.5) * this.cellPx + (-s * dx + c * dy);
        if (!this.inPiece(ax, ay, col, row)) continue;
        const ai = (Math.min(this.artH - 1, Math.max(0, Math.round(ay))) * this.artW + Math.min(this.artW - 1, Math.max(0, Math.round(ax)))) * 3;
        for (let ch = 0; ch < 3; ch++) data[(y * w + x) * 4 + ch] = Math.round(this.art[ai + ch] * gain + offset + this.r.int(-noise, noise + 1));
      }
    });
    return { image: new RgbaImage(w, h, data), truths };
  }

  /** Square body plus/minus round knobs. */
  inPiece(x, y, col, row) {
    const b = this.cellPx, knobR = 0.17 * b, knobOff = 0.13 * b;
    const inCircle = (cx, cy) => (x - cx) ** 2 + (y - cy) ** 2 <= knobR * knobR;
    if (col < this.cols - 1) { const d = this.hEdges[row][col]; if (inCircle((col + 1) * b + d * knobOff, (row + 0.5) * b)) return d > 0; }
    if (col > 0) { const d = this.hEdges[row][col - 1]; if (inCircle(col * b + d * knobOff, (row + 0.5) * b)) return d < 0; }
    if (row < this.rows - 1) { const d = this.vEdges[row][col]; if (inCircle((col + 0.5) * b, (row + 1) * b + d * knobOff)) return d > 0; }
    if (row > 0) { const d = this.vEdges[row - 1][col]; if (inCircle((col + 0.5) * b, row * b + d * knobOff)) return d < 0; }
    return x >= col * b && x < (col + 1) * b && y >= row * b && y < (row + 1) * b;
  }

  /** Multi-octave value noise per channel plus small disks: a stand-in for a real picture. RGB bytes. */
  makeArt() {
    const w = this.artW, h = this.artH;
    const channels = [0, 1, 2].map(() => this.valueNoise(w, h, [6, 14, 30, 60]));
    const out = new Uint8ClampedArray(w * h * 3);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(channels[c][i] * 255);
    for (let n = 0; n < Math.floor((this.cols * this.rows) / 3); n++) {
      const cx = this.r.int(0, w), cy = this.r.int(0, h), rad = this.r.int(Math.floor(this.cellPx / 6), Math.floor(this.cellPx / 2));
      const color = [this.r.int(0, 256), this.r.int(0, 256), this.r.int(0, 256)];
      for (let y = Math.max(0, cy - rad); y < Math.min(h, cy + rad); y++) for (let x = Math.max(0, cx - rad); x < Math.min(w, cx + rad); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = color[c];
      }
    }
    return out;
  }

  valueNoise(w, h, periods) {
    const out = new Float32Array(w * h);
    let total = 0;
    const smooth = (t) => t * t * (3 - 2 * t);
    periods.forEach((period, k) => {
      const amp = 1 / (k + 1);
      total += amp;
      const gw = Math.floor(w / period) + 2, gh = Math.floor(h / period) + 2;
      const grid = Float32Array.from({ length: gw * gh }, () => this.r.next());
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const fx = x / period, fy = y / period, x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = smooth(fx - x0), ty = smooth(fy - y0);
        const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1], c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
        out[y * w + x] += amp * ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty);
      }
    });
    for (let i = 0; i < out.length; i++) out[i] = (out[i] / total - 0.5) * 1.8 + 0.5;
    return out;
  }
}
