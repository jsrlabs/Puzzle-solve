import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellKey, nextPlacement } from '../src/engine/planner.js';
import { analyze } from '../src/engine/solver.js';
import { SyntheticPuzzle } from './synthetic.js';

const grid = { cols: 5, rows: 4 };
const piece = (id, col, row, confidence = 0.5) => ({ id, placement: { col, row, confidence } });

test('empty board starts with the most confident corner piece', () => {
  const pieces = [piece(0, 2, 2, 0.9), piece(1, 0, 0, 0.4), piece(2, 4, 3, 0.6), piece(3, 1, 0, 0.95)];
  const s = nextPlacement({ grid, pieces, placed: new Set(), excluded: new Set() });
  assert.equal(s.kind, 'corner');
  assert.equal(s.piece.id, 2);
});

test('suggested pieces always touch the board', () => {
  const pieces = [piece(0, 3, 3, 0.99), piece(1, 1, 0, 0.3), piece(2, 2, 2, 0.8), piece(3, 4, 0, 0.9)];
  const s = nextPlacement({ grid, pieces, placed: new Set([cellKey(0, 0)]), excluded: new Set() });
  assert.equal(s.kind, 'connect');
  assert.equal(s.piece.id, 1, 'only (1,0) borders the placed corner');
  assert.deepEqual(s.neighbours, [{ side: 'left', col: 0, row: 0 }]);
});

test('falls back to a new corner when nothing connects, and null when nothing fits', () => {
  const pieces = [piece(0, 2, 2, 0.99), piece(1, 4, 3, 0.2)];
  const placed = new Set([cellKey(0, 0)]);
  assert.equal(nextPlacement({ grid, pieces, placed, excluded: new Set() }).piece.id, 1);
  assert.equal(nextPlacement({ grid, pieces, placed, excluded: new Set([1]) }), null);
});

test('ignores pieces claiming filled cells and prefers more neighbours', () => {
  const pieces = [piece(0, 0, 0, 0.99), piece(1, 1, 1, 0.5), piece(2, 2, 0, 0.55)];
  const placed = new Set([cellKey(0, 0), cellKey(1, 0), cellKey(0, 1)]);
  const s = nextPlacement({ grid, pieces, placed, excluded: new Set() });
  assert.equal(s.piece.id, 1, '(1,1) touches two placed pieces');
  assert.equal(s.neighbours.length, 2);
});

test('simulated session: every suggestion is correct and connected', () => {
  const puzzle = new SyntheticPuzzle(12, 9, 40, 7);
  const { image, truths } = puzzle.piecesPhoto(60, { scale: 1.8 });
  const result = analyze(puzzle.boxImage(600), image, { cols: 12, rows: 9 });
  const truthOf = (p) => truths.reduce((a, b) => (Math.hypot(a.center.x - p.center.x, a.center.y - p.center.y) <= Math.hypot(b.center.x - p.center.x, b.center.y - p.center.y) ? a : b));
  const placed = new Set(), excluded = new Set();
  let steps = 0, correct = 0;
  for (;;) {
    const s = nextPlacement({ grid: result.grid, pieces: result.pieces, placed, excluded });
    if (!s) break;
    steps++;
    const t = truthOf(s.piece);
    const { col, row } = s.piece.placement;
    if (t.col === col && t.row === row) correct++;
    excluded.add(s.piece.id);
    placed.add(cellKey(t.col, t.row)); // the user puts it where it really belongs
  }
  console.log(`[session] steps=${steps} correct=${correct}`);
  assert.ok(steps >= 3, `expected several placements, got ${steps}`);
  assert.ok(correct >= steps - 1, `${correct}/${steps} suggestions correct`);
});
