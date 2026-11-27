// Chooses the next single piece to put on the board.
//
// Rules:
//  * A suggested piece must connect to something when placed: it must be next to (left/right/above/below)
//    a cell that is already on the board.
//  * When nothing is on the board yet (or nothing on the board borders a loose piece), start with a corner:
//    a corner piece is held in place by the two straight edges of the board.
//  * Among valid pieces, prefer the most confident match; a piece that would touch several placed
//    neighbours gets a bonus (it is more constrained, so easier to check and to fit).

export const NEIGHBOURS = [
  { dc: -1, dr: 0, side: 'left' },
  { dc: 1, dr: 0, side: 'right' },
  { dc: 0, dr: -1, side: 'top' },
  { dc: 0, dr: 1, side: 'bottom' },
];

export const cellKey = (col, row) => `${col},${row}`;

export function isCorner(grid, col, row) {
  return (col === 0 || col === grid.cols - 1) && (row === 0 || row === grid.rows - 1);
}

export function isEdge(grid, col, row) {
  return col === 0 || row === 0 || col === grid.cols - 1 || row === grid.rows - 1;
}

/** Human description of a corner cell, e.g. "top-left". */
export function cornerName(grid, col, row) {
  return `${row === 0 ? 'top' : 'bottom'}-${col === 0 ? 'left' : 'right'}`;
}

/**
 * @param {{grid:{cols:number,rows:number}, pieces:Array, placed:Set<string>, excluded:Set<number>}} args
 *   pieces: detected pieces from analyze(); placed: cellKey()s already on the board;
 *   excluded: ids of loose pieces that were placed or skipped.
 * @returns {null | {piece:object, kind:'corner'|'connect', neighbours:Array<{side:string,col:number,row:number}>, score:number}}
 *   neighbours: the placed cells this piece attaches to; `side` is which side of the new piece they are on.
 */
export function nextPlacement({ grid, pieces, placed, excluded }) {
  // One candidate per free cell: if two loose pieces claim the same cell, only trust the more confident one.
  const byCell = new Map();
  for (const p of pieces) {
    const pl = p.placement;
    if (!pl || excluded.has(p.id)) continue;
    const key = cellKey(pl.col, pl.row);
    if (placed.has(key)) continue; // that spot is already filled, so this match must be wrong
    const prev = byCell.get(key);
    if (!prev || pl.confidence > prev.placement.confidence) byCell.set(key, p);
  }

  let best = null;
  for (const p of byCell.values()) {
    const { col, row, confidence } = p.placement;
    const neighbours = NEIGHBOURS
      .map((n) => ({ side: n.side, col: col + n.dc, row: row + n.dr }))
      .filter((n) => placed.has(cellKey(n.col, n.row)));
    if (neighbours.length === 0) continue;
    const score = confidence * (1 + 0.15 * (neighbours.length - 1));
    if (!best || score > best.score) best = { piece: p, kind: 'connect', neighbours, score };
  }
  if (best) return best;

  // Nothing connects to the board (or the board is empty): start a corner.
  for (const p of byCell.values()) {
    const { col, row, confidence } = p.placement;
    if (!isCorner(grid, col, row)) continue;
    if (!best || confidence > best.score) best = { piece: p, kind: 'corner', neighbours: [], score: confidence };
  }
  return best;
}
