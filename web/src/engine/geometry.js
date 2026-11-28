// Perspective geometry: homographies and warping a quadrilateral to a rectangle. Pure JavaScript.

import { RgbaImage } from './images.js';

/**
 * Homography H (row-major 3x3, h33 = 1) mapping each src[i] = {x,y} to dst[i], from 4 point pairs.
 */
export function homography(src, dst) {
  // Solve the standard 8x8 linear system A h = b.
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

/** Gaussian elimination with partial pivoting. Returns null for a singular system. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map((v) => v / inv[8]);
}

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/** Natural output size of a quad [tl, tr, br, bl]: average lengths of opposite sides. */
export function quadSize(q) {
  return {
    w: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2,
    h: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2,
  };
}

/**
 * Warps the quadrilateral `quad` ([tl, tr, br, bl] in image pixels) of `img` into an upright rectangle.
 * Output size defaults to the quad's natural size, limited to maxDim on the long side.
 */
export function warpQuad(img, quad, maxDim = 2400) {
  let { w, h } = quadSize(quad);
  const s = Math.min(1, maxDim / Math.max(w, h));
  const ow = Math.max(2, Math.round(w * s)), oh = Math.max(2, Math.round(h * s));
  const H = homography(
    [{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }],
    quad,
  );
  const out = new Uint8ClampedArray(ow * oh * 4);
  const { width: iw, height: ih, data } = img;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const px = x + 0.5, py = y + 0.5;
      const wz = H[6] * px + H[7] * py + H[8];
      let sx = (H[0] * px + H[1] * py + H[2]) / wz - 0.5;
      let sy = (H[3] * px + H[4] * py + H[5]) / wz - 0.5;
      sx = sx < 0 ? 0 : sx > iw - 1 ? iw - 1 : sx;
      sy = sy < 0 ? 0 : sy > ih - 1 ? ih - 1 : sy;
      const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(iw - 1, x0 + 1), y1 = Math.min(ih - 1, y0 + 1);
      const tx = sx - x0, ty = sy - y0;
      const o = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = data[(y0 * iw + x0) * 4 + c], b = data[(y0 * iw + x1) * 4 + c];
        const d = data[(y1 * iw + x0) * 4 + c], e = data[(y1 * iw + x1) * 4 + c];
        out[o + c] = (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
      }
      out[o + 3] = 255;
    }
  }
  return new RgbaImage(ow, oh, out);
}

/** Intersection of two lines given in normal form x*cos(t) + y*sin(t) = r. */
export function intersect(l1, l2) {
  const a = Math.cos(l1.theta), b = Math.sin(l1.theta), c = Math.cos(l2.theta), d = Math.sin(l2.theta);
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (l1.rho * d - b * l2.rho) / det, y: (a * l2.rho - l1.rho * c) / det };
}
