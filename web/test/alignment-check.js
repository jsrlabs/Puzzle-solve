// Checks how well the app lines the box picture up with the assembled puzzle, using hand-marked features
// (testdata/alignment-points.json) that are visible both on the border in the table photo and in the box photo.
// Reports the error in puzzle cells (1.0 = one piece off) for several image sizes.
//   node test/alignment-check.js
import { readFileSync } from 'node:fs';
import { applyH, homography, invertH, quadSize } from '../src/engine/geometry.js';
import { detectPictureQuad } from '../src/engine/quad.js';
import { warpQuad } from '../src/engine/geometry.js';
import { prepare, DEFAULT_PARAMS } from '../src/engine/solver.js';
import { loadPhoto, TESTDATA } from './photos.js';

const { pairs } = JSON.parse(readFileSync(new URL('alignment-points.json', TESTDATA)));

export function alignmentError(dim, overviewMaxDim, extraParams = {}) {
  const boxPhoto = loadPhoto('box-hometown-1000.jpg', dim);
  const quad = detectPictureQuad(boxPhoto).quad;
  const box = warpQuad(boxPhoto, quad, dim);
  // Raw box photo -> straightened box picture (the inverse of warpQuad's mapping).
  const toStraight = homography(quad, [{ x: 0, y: 0 }, { x: box.width, y: 0 }, { x: box.width, y: box.height }, { x: 0, y: box.height }]);
  const photo = loadPhoto('table-hometown-1000.jpg', dim);
  const k = photo.width / 4080; // hand marks are in 4080-px-wide originals
  const S = prepare(box, photo, { cols: 37, rows: 27, pieceCount: 1000 }, () => {}, { ...DEFAULT_PARAMS, overviewMaxDim, ...extraParams });
  if (!S.boardInfo) return { found: false };
  const toCells = invertH(S.boardInfo.H); // photo px -> puzzle (col, row)
  const bc = S.boxCells;
  // Straightened box px -> puzzle cells: through the polished corners if the alignment was refined.
  const corners = [{ x: 0, y: 0 }, { x: S.grid.cols, y: 0 }, { x: S.grid.cols, y: S.grid.rows }, { x: 0, y: S.grid.rows }];
  const boxToCells = S.boxQuad ? homography(S.boxQuad, corners) : null;
  const errs = pairs.map(({ photo: [px, py], box: [bx, by] }) => {
    const cellPos = applyH(toCells, px * k, py * k);
    const b = applyH(toStraight, bx * k, by * k);
    const want = boxToCells ? applyH(boxToCells, b.x, b.y) : { x: (b.x - bc.x0) / bc.cw, y: (b.y - bc.y0) / bc.ch };
    return Math.hypot(cellPos.x - want.x, cellPos.y - want.y);
  });
  errs.sort((a, b) => a - b);
  return { found: true, score: S.boxAlignScore, grid: `${S.grid.cols}x${S.grid.rows}`, median: errs[errs.length >> 1], max: errs[errs.length - 1], mean: errs.reduce((a, b) => a + b, 0) / errs.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const refine of [false, true]) for (const [dim, ov] of [[4096, 2400], [4096, 3200], [4096, 4096], [2400, 2400]]) {
    const r = alignmentError(dim, ov, { refineAlignment: refine });
    console.log(`${refine ? 'polished' : 'coarse  '} photo ${dim}px, overview ${ov}px:`, r.found ? `grid ${r.grid}, error in cells: median ${r.median.toFixed(2)}, mean ${r.mean.toFixed(2)}, max ${r.max.toFixed(2)}` : 'board not found');
  }
}
