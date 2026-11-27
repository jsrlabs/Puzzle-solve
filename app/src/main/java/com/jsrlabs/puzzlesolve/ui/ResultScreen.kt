package com.jsrlabs.puzzlesolve.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jsrlabs.puzzlesolve.PuzzleViewModel
import com.jsrlabs.puzzlesolve.Screen
import com.jsrlabs.puzzlesolve.core.Analysis
import com.jsrlabs.puzzlesolve.core.DetectedPiece
import com.jsrlabs.puzzlesolve.core.Direction
import com.jsrlabs.puzzlesolve.core.PairSuggestion
import com.jsrlabs.puzzlesolve.core.Vec2
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.roundToInt

@Composable
fun ResultScreen(vm: PuzzleViewModel) {
    val analysis = vm.analysis
    val pieces = vm.piecesBitmap
    val box = vm.analyzedBox
    var showAll by rememberSaveable { mutableStateOf(false) }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (analysis == null || pieces == null || box == null) {
            Column(Modifier.safeDrawingPadding().padding(16.dp)) {
                Text("No analysis yet.")
                Button(onClick = { vm.screen = Screen.SETUP }) { Text("Back") }
            }
            return@Surface
        }
        val piecesImg = remember(pieces) { pieces.asImageBitmap() }
        val boxImg = remember(box) { box.asImageBitmap() }
        val textMeasurer = rememberTextMeasurer()
        val suggestion = vm.currentSuggestion

        Column(
            Modifier
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { vm.screen = Screen.SETUP }) { Text("< Photos") }
                Spacer(Modifier.weight(1f))
                Text(
                    "${analysis.pieces.size} pieces found",
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            for (w in analysis.warnings) {
                Text(w, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }

            if (suggestion != null) {
                SuggestionCard(suggestion, analysis)

                Text("Find these pieces", style = MaterialTheme.typography.titleMedium)
                val pair = listOf(suggestion.anchor, suggestion.mover)
                val zoom = boundsOf(pair.flatMap { it.corners }, pair[0].bodySize * 1.0, pieces.width, pieces.height)
                FittedImage(piecesImg, source = zoom, maxHeight = 320.dp) { m ->
                    drawPieceHighlights(pair, suggestion, m, textMeasurer, labels = true)
                }
                Text("Where they are in your photo:", style = MaterialTheme.typography.bodySmall)
                FittedImage(piecesImg, maxHeight = 260.dp) { m ->
                    if (showAll) drawAllPieces(analysis, vm.usedPieces, m)
                    drawPieceHighlights(pair, suggestion, m, textMeasurer, labels = false)
                }

                Text("Where they go in the picture", style = MaterialTheme.typography.titleMedium)
                val pa = suggestion.anchor.placement!!
                val pm = suggestion.mover.placement!!
                val cellBounds = boundsOf(listOf(pa.boxCenter, pm.boxCenter), pa.boxCellSize * 3.0, box.width, box.height)
                FittedImage(boxImg, source = cellBounds, maxHeight = 300.dp) { m ->
                    drawTargetCells(suggestion, m, textMeasurer)
                }
                FittedImage(boxImg, maxHeight = 240.dp) { m ->
                    if (showAll) drawAllPlacements(analysis, m)
                    drawTargetCells(suggestion, m, null)
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.markJoined(suggestion) }, modifier = Modifier.weight(1f)) { Text("Joined! Next") }
                    OutlinedButton(onClick = { vm.skip(suggestion) }, modifier = Modifier.weight(1f)) { Text("Doesn't fit / skip") }
                }
                Text(
                    "${vm.remainingSuggestions.size - 1} more suggestion(s) from this photo.",
                    style = MaterialTheme.typography.bodySmall,
                )
            } else {
                NoSuggestionCard(analysis, vm.usedPieces)
                FittedImage(piecesImg, maxHeight = 320.dp) { m -> drawAllPieces(analysis, vm.usedPieces, m) }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = showAll, onCheckedChange = { showAll = it })
                Spacer(Modifier.size(8.dp))
                Text("Show every detected piece", style = MaterialTheme.typography.bodyMedium)
            }
            OutlinedButton(onClick = vm::retakePieces, modifier = Modifier.fillMaxWidth()) {
                Text("New photo of remaining pieces")
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun SuggestionCard(s: PairSuggestion, analysis: Analysis) {
    val a = s.anchor.placement!!
    val m = s.mover.placement!!
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Join these two pieces", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Dot(MoverColor); Text(" B goes ${directionWords(s.direction)} ", fontWeight = FontWeight.Bold)
                Dot(AnchorColor); Text(" A", fontWeight = FontWeight.Bold)
            }
            Text(
                "Turn both pieces so their arrows point up (the top of the picture). " +
                    "A: ${turnHint(s.anchor.upDirection)}. B: ${turnHint(s.mover.upDirection)}.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                "A belongs at row ${a.row + 1}, column ${a.col + 1}; B at row ${m.row + 1}, column ${m.col + 1} " +
                    "(of ${analysis.grid.rows} rows x ${analysis.grid.cols} columns)." + edgeNote(s, analysis),
                style = MaterialTheme.typography.bodySmall,
            )
            Text("Confidence: ${confidenceWord(s.score)}", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun NoSuggestionCard(analysis: Analysis, used: List<Int>) {
    val best = analysis.pieces
        .filter { it.placement != null && it.id !in used }
        .maxByOrNull { it.placement!!.confidence }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("No more matching pairs in this photo", style = MaterialTheme.typography.titleMedium)
            Text(
                if (best != null) {
                    val p = best.placement!!
                    "None of the remaining loose pieces seem to be neighbours. The most certain single piece is #${best.id + 1}: " +
                        "row ${p.row + 1}, column ${p.col + 1}. Take a new photo with more pieces to find more pairs."
                } else {
                    "Take a new photo with more pieces (or better light) to get suggestions."
                },
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun Dot(color: Color) {
    Box(Modifier.size(14.dp).background(color, CircleShape))
}

private fun directionWords(d: Direction) = when (d) {
    Direction.LEFT -> "on the LEFT side of"
    Direction.RIGHT -> "on the RIGHT side of"
    Direction.ABOVE -> "ABOVE (on top of)"
    Direction.BELOW -> "BELOW"
}

/** How far to turn a piece, given where its top currently points in the photo. */
private fun turnHint(up: Vec2?): String {
    if (up == null) return "orientation unknown"
    // Clockwise angle from "photo up" to the piece's top, in degrees (-180, 180].
    val deg = Math.toDegrees(atan2(up.x, -up.y))
    val rounded = ((deg / 45.0).roundToInt() * 45)
    return when {
        abs(deg) < 20 -> "already upright"
        rounded == 180 || rounded == -180 -> "turn it upside down"
        deg > 0 -> "turn about ${abs(rounded)}° counter-clockwise"
        else -> "turn about ${abs(rounded)}° clockwise"
    }
}

private fun edgeNote(s: PairSuggestion, analysis: Analysis): String {
    val cells = listOf(s.anchor.placement!!, s.mover.placement!!)
    val onEdge = cells.any { it.col == 0 || it.row == 0 || it.col == analysis.grid.cols - 1 || it.row == analysis.grid.rows - 1 }
    return if (onEdge) " These are edge pieces." else ""
}

private fun confidenceWord(score: Double) = when {
    score >= 0.5 -> "high"
    score >= 0.2 -> "medium"
    else -> "low (double-check before pushing them together)"
}

private fun DrawScope.drawPieceHighlights(
    pair: List<DetectedPiece>,
    s: PairSuggestion,
    m: ImageMapping,
    tm: TextMeasurer,
    labels: Boolean,
) {
    for (p in pair) {
        val isAnchor = p.id == s.anchor.id
        val color = if (isAnchor) AnchorColor else MoverColor
        drawPolygon(p.corners, m, color, 3.dp)
        p.upDirection?.let { drawArrow(p.center, it, p.bodySize * 0.42, m, color) }
        if (labels) {
            drawLabel(tm, if (isAnchor) "A" else "B", m.map(p.center), color)
        } else {
            // Rings make the pair easy to spot in the full photo.
            drawCircle(color, (p.bodySize * m.scale * 0.9).toFloat().coerceAtLeast(14.dp.toPx()), m.map(p.center), style = Stroke(3.dp.toPx()))
        }
    }
}

private fun DrawScope.drawTargetCells(s: PairSuggestion, m: ImageMapping, tm: TextMeasurer?) {
    for ((p, color, label) in listOf(Triple(s.anchor, AnchorColor, "A"), Triple(s.mover, MoverColor, "B"))) {
        val pl = p.placement ?: continue
        val half = pl.boxCellSize / 2
        val tl = m.map(pl.boxCenter.x - half, pl.boxCenter.y - half)
        val br = m.map(pl.boxCenter.x + half, pl.boxCenter.y + half)
        val size = Size(br.x - tl.x, br.y - tl.y)
        drawRect(Color.Black.copy(alpha = 0.6f), tl, size, style = Stroke(5.dp.toPx()))
        drawRect(color, tl, size, style = Stroke(3.dp.toPx()))
        if (tm != null) drawLabel(tm, label, m.map(pl.boxCenter), color)
    }
}

private fun DrawScope.drawAllPieces(analysis: Analysis, used: List<Int>, m: ImageMapping) {
    for (p in analysis.pieces) {
        val c = when {
            p.id in used -> Color.Gray
            p.placement == null -> Color.Red
            else -> Color.White
        }
        drawPolygon(p.corners, m, c.copy(alpha = 0.8f), 1.5.dp)
    }
}

private fun DrawScope.drawAllPlacements(analysis: Analysis, m: ImageMapping) {
    for (p in analysis.pieces) {
        val pl = p.placement ?: continue
        val half = pl.boxCellSize / 2
        val tl = m.map(pl.boxCenter.x - half, pl.boxCenter.y - half)
        val br = m.map(pl.boxCenter.x + half, pl.boxCenter.y + half)
        val alpha = (0.3 + 0.7 * pl.confidence).toFloat().coerceIn(0f, 1f)
        drawRect(Color.White.copy(alpha = alpha), tl, Size(br.x - tl.x, br.y - tl.y), style = Stroke(1.5.dp.toPx()))
    }
}

private fun DrawScope.drawLabel(tm: TextMeasurer, text: String, center: Offset, color: Color) {
    val style = TextStyle(color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
    val layout = tm.measure(text, style)
    val r = maxOf(layout.size.width, layout.size.height) * 0.75f
    // Offset the label from the center so it doesn't hide the arrow.
    val c = Offset(center.x + r * 1.4f, center.y - r * 1.4f)
    drawCircle(color, r, c)
    drawCircle(Color.Black.copy(alpha = 0.6f), r, c, style = Stroke(1.5.dp.toPx()))
    drawText(layout, topLeft = Offset(c.x - layout.size.width / 2f, c.y - layout.size.height / 2f))
}
