// "Report a problem": builds a diagnostic report about the current suggestion (small pictures as base64 JPEG
// plus the numbers behind the suggestion) for pasting into a new GitHub issue. The site is static and has no
// GitHub login of its own, so the report goes via the clipboard into a pre-filled "new issue" page.

export const REPORT_REPO = 'jsrlabs/Puzzle-solve';
export const REPORT_TITLE_PREFIX = '[Puzzle report]';
export const REPORT_MARKER = '<!-- puzzle-report v1 -->';
const MAX_BODY = 60000; // GitHub allows 65,536 characters in an issue body

/** JPEG of `rect` (source pixels) of `src`, `outW` pixels wide, as base64 (no data: prefix). */
function cropJpeg(src, rect, outW, quality, annotate) {
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const w = Math.max(1, Math.min(src.width - x, rect.w - (x - rect.x)));
  const h = Math.max(1, Math.min(src.height - y, rect.h - (y - rect.y)));
  const scale = outW / w;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  if (annotate) annotate(ctx, (px, py) => [(px - x) * scale, (py - y) * scale], scale);
  return c.toDataURL('image/jpeg', quality).split(',')[1];
}

function markRect(ctx, map, r) {
  const [x0, y0] = map(r.x, r.y), [x1, y1] = map(r.x + r.w, r.y + r.h);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ff2d87';
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function markPoly(ctx, map, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = map(p.x, p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ff2d87';
  ctx.stroke();
}

const round = (v, d = 1) => (typeof v === 'number' ? Math.round(v * 10 ** d) / 10 ** d : v);

/**
 * @param ctx { problem, note, version, analysis, step, pieces (canvas), box (canvas), cellRect(col,row),
 *   cellOnPhoto(col,row) | null, placedCount, layoutAsked }
 * @returns { title, body } the issue title and the full report text (to paste as the description)
 */
export function buildReport(ctx) {
  const { analysis: a, step, pieces, box } = ctx;
  const p = step?.piece, pl = p?.placement;
  const meta = {
    report: 1,
    problem: ctx.problem,
    note: ctx.note || undefined,
    app: ctx.version,
    time: new Date().toISOString(),
    browser: navigator.userAgent,
    photos: { table: [pieces.width, pieces.height], box: [box.width, box.height] },
    layout: { used: a.grid, asked: ctx.layoutAsked },
    board: a.board ? { detected: true, placedByApp: a.board.placed.length, quad: a.board.quad.map((q) => [round(q.x), round(q.y)]), up: [round(a.board.up.x, 3), round(a.board.up.y, 3)] } : { detected: false },
    placedOnBoard: ctx.placedCount,
    scan: a.scan && { scanned: a.scan.scanned, total: a.scan.total },
    piecesFound: a.pieces.length,
    suggestion: step && {
      kind: step.kind,
      score: round(step.score, 3),
      neighbours: step.neighbours,
      piece: {
        id: p.id,
        center: [round(p.center.x), round(p.center.y)],
        bodySize: round(p.bodySize),
        up: p.up && [round(p.up.x, 3), round(p.up.y, 3)],
      },
      placement: pl && {
        col: pl.col,
        row: pl.row,
        confidence: round(pl.confidence, 3),
        matchError: round(pl.matchError, 2),
        boxCenter: [round(pl.boxCenter.x), round(pl.boxCenter.y)],
        photoTarget: pl.photoTarget && [round(pl.photoTarget.x), round(pl.photoTarget.y)],
      },
    },
    boxCells: a.boxCells && Object.fromEntries(Object.entries(a.boxCells).map(([k, v]) => [k, round(v, 2)])),
    warnings: a.warnings,
  };

  // Pictures, made smaller until the whole report fits in an issue.
  let body = '';
  for (const q of [0.8, 0.65, 0.5, 0.35]) {
    const images = {};
    if (p) {
      const r = 1.6 * p.bodySize;
      images.piece = cropJpeg(pieces, { x: p.center.x - r, y: p.center.y - r, w: 2 * r, h: 2 * r }, 160, q,
        (c, map) => markPoly(c, map, p.outline?.length > 2 ? p.outline : p.corners));
    }
    if (pl) {
      const cell = ctx.cellRect(pl.col, pl.row);
      const m = 2.5 * Math.max(cell.w, cell.h);
      images.boxSpot = cropJpeg(box, { x: cell.x - m, y: cell.y - m, w: cell.w + 2 * m, h: cell.h + 2 * m }, 200, q, (c, map) => markRect(c, map, cell));
      images.boxWhole = cropJpeg(box, { x: 0, y: 0, w: box.width, h: box.height }, q > 0.5 ? 480 : 360, q, (c, map) => markRect(c, map, cell));
      const corners = ctx.cellOnPhoto?.(pl.col, pl.row);
      if (corners) {
        const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
        const side = Math.max(...xs) - Math.min(...xs), cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
        const r = 3 * side;
        images.tableSpot = cropJpeg(pieces, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, 200, q, (c, map) => markPoly(c, map, corners));
      }
    }
    meta.images = Object.keys(images);
    body = [
      REPORT_MARKER,
      `**Problem:** ${ctx.problem}${ctx.note ? `\n\n**Note:** ${ctx.note}` : ''}`,
      pl ? `**Suggested:** piece at (${Math.round(p.center.x)}, ${Math.round(p.center.y)}) in the table photo → row ${pl.row + 1}, column ${pl.col + 1} of ${a.grid.rows} × ${a.grid.cols} (confidence ${round(pl.confidence, 2)}).` : '',
      '',
      '<details><summary>Diagnostic data (for the automated check)</summary>',
      '',
      '```json',
      JSON.stringify(meta, null, 1),
      '```',
      ...Object.entries(images).flatMap(([name, b64]) => [`\`\`\`image/jpeg ${name}`, b64, '```']),
      '',
      '</details>',
    ].join('\n');
    if (body.length <= MAX_BODY) break;
  }
  const where = pl ? ` (row ${pl.row + 1}, column ${pl.col + 1})` : '';
  return { title: `${REPORT_TITLE_PREFIX} ${ctx.problem}${where}`, body };
}

/** A pre-filled "new issue" page; the description is pasted by the user (it is too long for a link). */
export function newIssueUrl(title) {
  const body = 'Paste the copied report here (long-press or right-click → Paste), then press Submit.';
  return `https://github.com/${REPORT_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
