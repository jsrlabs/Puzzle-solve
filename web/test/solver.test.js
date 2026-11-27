import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, DIRECTIONS, gridFromPieceCount } from '../src/engine/solver.js';
import { SyntheticPuzzle } from './synthetic.js';

function run(name, puzzle, count, boxWidth, scale) {
  const box = puzzle.boxImage(boxWidth);
  const { image, truths } = puzzle.piecesPhoto(count, { scale });
  const t0 = performance.now();
  const result = analyze(box, image, { cols: puzzle.cols, rows: puzzle.rows });
  const ms = Math.round(performance.now() - t0);

  let correctCell = 0, correctUp = 0;
  const truthOf = new Map();
  for (const p of result.pieces) {
    const t = truths.reduce((a, b) => (Math.hypot(a.center.x - p.center.x, a.center.y - p.center.y) <= Math.hypot(b.center.x - p.center.x, b.center.y - p.center.y) ? a : b));
    truthOf.set(p.id, t);
    if (p.placement && p.placement.col === t.col && p.placement.row === t.row) {
      correctCell++;
      const trueUp = { x: Math.sin(t.rotation), y: -Math.cos(t.rotation) };
      if (p.up.x * trueUp.x + p.up.y * trueUp.y > 0.9) correctUp++;
    }
  }
  const top = result.suggestions.slice(0, 5);
  const pairsCorrect = top.filter((s) => {
    const a = truthOf.get(s.anchor), m = truthOf.get(s.mover), d = DIRECTIONS[s.direction];
    return m.col - a.col === d.dc && m.row - a.row === d.dr;
  }).length;
  console.log(`[${name}] pieces=${truths.length} found=${result.pieces.length} cell=${correctCell} up=${correctUp} top5Correct=${pairsCorrect}/${top.length} time=${ms}ms warnings=${JSON.stringify(result.warnings)}`);
  return { found: result.pieces.length, correctCell, correctUp, pairsCorrect, topPairs: top.length };
}

test('locates pieces in a small puzzle', () => {
  const s = run('small', new SyntheticPuzzle(12, 9, 40, 7), 40, 600, 1.8);
  assert.equal(s.found, 40, 'segmentation should find every piece');
  assert.ok(s.correctCell >= 34, `at least 85% placed correctly, got ${s.correctCell}`);
  assert.ok(s.correctUp >= s.correctCell - 3, 'orientation right for correctly placed pieces');
  assert.ok(s.topPairs > 0 && s.pairsCorrect === s.topPairs, 'top suggestions all correct');
});

test('locates pieces in a larger puzzle with smaller pieces', () => {
  const s = run('large', new SyntheticPuzzle(30, 20, 32, 3), 120, 1200, 1.5);
  assert.ok(s.found >= 115, `found ${s.found}`);
  assert.ok(s.correctCell >= s.found * 0.75, `placed ${s.correctCell}/${s.found}`);
  assert.ok(s.topPairs > 0 && s.pairsCorrect >= s.topPairs - 1, 'top suggestions mostly correct');
});

test('grid from piece count', () => {
  assert.deepEqual(gridFromPieceCount(1000, 1.6), { cols: 40, rows: 25 });
  assert.deepEqual(gridFromPieceCount(1026, 38 / 27), { cols: 38, rows: 27 });
  const g = gridFromPieceCount(500, 4 / 3);
  assert.ok(g.cols * g.rows >= 480 && g.cols * g.rows <= 520);
});
