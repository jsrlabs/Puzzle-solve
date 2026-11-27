// Image primitives for the solver. Pure JavaScript, no DOM: runs in a Web Worker or Node.

/** RGBA image, same layout as canvas ImageData (4 bytes per pixel). */
export class RgbaImage {
  /** @param {number} width @param {number} height @param {Uint8ClampedArray|Uint8Array} data */
  constructor(width, height, data) {
    if (data.length !== width * height * 4) throw new Error(`Pixel buffer does not match ${width}x${height}`);
    this.width = width;
    this.height = height;
    this.data = data;
  }

  /** Area-averaging downscale so the longest side is at most maxDim. */
  downscaleToMax(maxDim) {
    const longest = Math.max(this.width, this.height);
    if (longest <= maxDim) return this;
    const s = maxDim / longest;
    return this.resize(Math.max(1, Math.round(this.width * s)), Math.max(1, Math.round(this.height * s)));
  }

  /** Area-averaging resize (meant for shrinking). */
  resize(nw, nh) {
    const { width: w, height: h, data } = this;
    const out = new Uint8ClampedArray(nw * nh * 4);
    const sx = w / nw, sy = h / nh;
    for (let oy = 0; oy < nh; oy++) {
      const y0 = Math.min(h - 1, Math.floor(oy * sy));
      const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((oy + 1) * sy)));
      for (let ox = 0; ox < nw; ox++) {
        const x0 = Math.min(w - 1, Math.floor(ox * sx));
        const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((ox + 1) * sx)));
        let r = 0, g = 0, b = 0;
        for (let y = y0; y < y1; y++) {
          let i = (y * w + x0) * 4;
          for (let x = x0; x < x1; x++, i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
        }
        const n = (y1 - y0) * (x1 - x0);
        const o = (oy * nw + ox) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    return new RgbaImage(nw, nh, out);
  }
}

/** Single-channel float image. */
export class Plane {
  constructor(width, height, data = new Float32Array(width * height)) {
    this.width = width;
    this.height = height;
    this.data = data;
  }

  get(x, y) { return this.data[y * this.width + x]; }

  /** Bilinear sample with edge clamping. */
  sample(x, y) {
    const w = this.width, h = this.height, d = this.data;
    const fx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
    const fy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const a = d[y0 * w + x0], b = d[y0 * w + x1], c = d[y1 * w + x0], e = d[y1 * w + x1];
    const top = a + (b - a) * tx;
    const bot = c + (e - c) * tx;
    return top + (bot - top) * ty;
  }

  /** (2r+1)^2 box blur; edges use the partial window. */
  boxBlur(r) {
    if (r <= 0) return new Plane(this.width, this.height, this.data.slice());
    const w = this.width, h = this.height;
    const ii = new IntegralImage(this);
    const out = new Plane(w, h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        out.data[y * w + x] = ii.sum(x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1));
      }
    }
    return out;
  }

  /** Area-average when shrinking, bilinear when enlarging. */
  resize(nw, nh) {
    const w = this.width, h = this.height;
    const out = new Plane(nw, nh);
    const sx = w / nw, sy = h / nh;
    if (sx >= 1 && sy >= 1) {
      const ii = new IntegralImage(this);
      for (let oy = 0; oy < nh; oy++) {
        const y0 = Math.min(h - 1, Math.floor(oy * sy));
        const y1 = Math.min(h - 1, Math.max(y0, Math.max(y0 + 1, Math.floor((oy + 1) * sy)) - 1));
        for (let ox = 0; ox < nw; ox++) {
          const x0 = Math.min(w - 1, Math.floor(ox * sx));
          const x1 = Math.min(w - 1, Math.max(x0, Math.max(x0 + 1, Math.floor((ox + 1) * sx)) - 1));
          out.data[oy * nw + ox] = ii.sum(x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1));
        }
      }
    } else {
      for (let oy = 0; oy < nh; oy++) for (let ox = 0; ox < nw; ox++) {
        out.data[oy * nw + ox] = this.sample((ox + 0.5) * sx - 0.5, (oy + 0.5) * sy - 0.5);
      }
    }
    return out;
  }
}

/** Summed-area table for O(1) window sums. */
export class IntegralImage {
  constructor(plane, squared = false) {
    const w = plane.width, h = plane.height;
    this.w = w + 1;
    const t = (this.table = new Float64Array((w + 1) * (h + 1)));
    const d = plane.data;
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        const v = d[y * w + x];
        row += squared ? v * v : v;
        t[(y + 1) * this.w + x + 1] = t[y * this.w + x + 1] + row;
      }
    }
  }

  /** Sum over inclusive rectangle [x0..x1] x [y0..y1]. */
  sum(x0, y0, x1, y1) {
    const t = this.table, w = this.w;
    return t[(y1 + 1) * w + x1 + 1] - t[y0 * w + x1 + 1] - t[(y1 + 1) * w + x0] + t[y0 * w + x0];
  }
}

/** CIE L*a*b* image: Euclidean distances roughly match perceived color differences. */
export class LabImage {
  constructor(l, a, b) { this.l = l; this.a = a; this.b = b; }
  get width() { return this.l.width; }
  get height() { return this.l.height; }
  resize(w, h) { return new LabImage(this.l.resize(w, h), this.a.resize(w, h), this.b.resize(w, h)); }
  boxBlur(r) { return new LabImage(this.l.boxBlur(r), this.a.boxBlur(r), this.b.boxBlur(r)); }

  /** @param {RgbaImage} img */
  static from(img) {
    const n = img.width * img.height;
    const l = new Plane(img.width, img.height), a = new Plane(img.width, img.height), b = new Plane(img.width, img.height);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      const r = SRGB_TO_LINEAR[d[i * 4]], g = SRGB_TO_LINEAR[d[i * 4 + 1]], bl = SRGB_TO_LINEAR[d[i * 4 + 2]];
      const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047);
      const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * bl);
      const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883);
      l.data[i] = 116 * fy - 16;
      a.data[i] = 500 * (fx - fy);
      b.data[i] = 200 * (fy - fz);
    }
    return new LabImage(l, a, b);
  }
}

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function f(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }

export function median(values) {
  if (values.length === 0) return 0;
  const s = Array.from(values).sort((x, y) => x - y);
  return s[s.length >> 1];
}
