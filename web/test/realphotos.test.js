// Tests on real photos (testdata/): a 1000-piece puzzle box shot at an angle, and the table with the border
// assembled on a black mat and ~800 loose pieces around and inside it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { warpQuad } from '../src/engine/geometry.js';
import { detectPictureQuad } from '../src/engine/quad.js';
import { analyze, gridFromPieceCount } from '../src/engine/solver.js';
import { nextPlacement } from '../src/engine/planner.js';
import { loadPhoto } from './photos.js';

const near = (p, q, tol) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;

test('finds and straightens the picture on the box', () => {
  const photo = loadPhoto('box-hometown-1000.jpg'); // 2400 x 1807
  const found = detectPictureQuad(photo);
  assert.ok(found, 'picture found');
  // Hand-checked corners of the printed picture (inside the green frame).
  const expected = [{ x: 326, y: 255 }, { x: 2092, y: 255 }, { x: 2080, y: 1580 }, { x: 304, y: 1518 }];
  found.quad.forEach((p, i) => assert.ok(near(p, expected[i], 20), `corner ${i}: ${JSON.stringify(p)}`));
});

test('real table photo: finds the assembled border, its layout, and loose pieces', () => {
  const boxPhoto = loadPhoto('box-hometown-1000.jpg');
  const box = warpQuad(boxPhoto, detectPictureQuad(boxPhoto).quad);
  const table = loadPhoto('table-hometown-1000.jpg');
  const guess = gridFromPieceCount(1000, box.width / box.height);
  const t0 = performance.now();
  const a = analyze(box, table, { ...guess, pieceCount: 1000 });
  console.log(`[real] ${Math.round(performance.now() - t0)}ms grid=${a.grid.cols}x${a.grid.rows} loose=${a.pieces.length} placed=${a.board?.placed.length}`);

  assert.deepEqual(a.grid, { cols: 38, rows: 27 }, 'layout measured from the board (37x27 guessed from the count)');
  assert.ok(a.board, 'assembled puzzle detected');
  const placed = a.board.placed.map((k) => k.split(',').map(Number));
  const edge = placed.filter(([c, r]) => c === 0 || r === 0 || c === 37 || r === 26);
  const interior = placed.length - edge.length;
  assert.ok(edge.length >= 85, `most of the 126 border cells recognised (${edge.length})`);
  assert.ok(interior <= 15, `few interior cells (the wagon section is real): ${interior}`);
  assert.ok(a.pieces.length >= 350, `loose pieces found: ${a.pieces.length}`);

  // The board's "up" points up the photo (the box is upright on the table).
  assert.ok(a.board.up.y < -0.9, `board up ${JSON.stringify(a.board.up)}`);

  // Suggestions connect to the detected border.
  const s = nextPlacement({ grid: a.grid, pieces: a.pieces, placed: new Set(a.board.placed), excluded: new Set() });
  assert.equal(s?.kind, 'connect');
});
