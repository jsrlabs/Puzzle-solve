package com.jsrlabs.puzzlesolve.core

import java.awt.BasicStroke
import java.awt.Color
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import kotlin.math.cos
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PuzzleSolverTest {

    private data class Score(val found: Int, val correctCell: Int, val correctUp: Int, val pairsCorrect: Int, val topPairs: Int)

    private fun run(name: String, puzzle: SyntheticPuzzle, count: Int, boxWidth: Int, scale: Double, seedNote: String = ""): Score {
        val box = puzzle.boxImage(outW = boxWidth)
        val (photo, truths) = puzzle.piecesPhoto(count, scale = scale)
        val grid = GridSpec(puzzle.cols, puzzle.rows)
        val t0 = System.nanoTime()
        val analysis = PuzzleSolver().analyze(box, photo, grid)
        val ms = (System.nanoTime() - t0) / 1e6

        // Associate detections with ground truth by nearest center.
        var correctCell = 0; var correctUp = 0
        val truthOf = HashMap<Int, SyntheticPuzzle.Truth>()
        for (p in analysis.pieces) {
            val t = truths.minByOrNull { (it.center - p.center).length() }!!
            truthOf[p.id] = t
            val pl = p.placement ?: continue
            if (pl.col != t.col || pl.row != t.row) {
                println("  miss #${p.id + 1}: got (${pl.col},${pl.row}) want (${t.col},${t.row}) conf=${"%.2f".format(pl.confidence)} err=${"%.1f".format(pl.matchError)}")
            }
            if (pl.col == t.col && pl.row == t.row) {
                correctCell++
                val up = p.upDirection!!
                val trueUp = Vec2(sin(t.rotation), -cos(t.rotation))
                if (up.x * trueUp.x + up.y * trueUp.y > 0.9) correctUp++
            }
        }
        val top = analysis.suggestions.take(5)
        val pairsCorrect = top.count { s ->
            val a = truthOf[s.anchor.id]!!; val m = truthOf[s.mover.id]!!
            m.col - a.col == s.direction.dc && m.row - a.row == s.direction.dr
        }
        println(
            "[$name$seedNote] pieces=${truths.size} found=${analysis.pieces.size} cell=$correctCell up=$correctUp " +
                "suggestions=${analysis.suggestions.size} top5Correct=$pairsCorrect/${top.size} time=${ms.toInt()}ms warnings=${analysis.warnings}"
        )
        analysis.suggestions.firstOrNull()?.let { println("  top: " + it.describe(grid) + " score=${"%.2f".format(it.score)}") }
        debugDump(name, box, photo, analysis)
        return Score(analysis.pieces.size, correctCell, correctUp, pairsCorrect, top.size)
    }

    @Test
    fun locatesPiecesInSmallPuzzle() {
        val puzzle = SyntheticPuzzle(cols = 12, rows = 9, seed = 7)
        val s = run("small", puzzle, count = 40, boxWidth = 600, scale = 1.8)
        assertEquals(40, s.found, "segmentation should find every piece")
        assertTrue(s.correctCell >= 34, "at least 85% of pieces placed in the right cell, got ${s.correctCell}")
        assertTrue(s.correctUp >= s.correctCell - 3, "orientation should be right for correctly placed pieces")
        assertTrue(s.topPairs > 0 && s.pairsCorrect == s.topPairs, "top suggestions should all be correct")
    }

    @Test
    fun locatesPiecesInLargerPuzzleWithSmallerPieces() {
        val puzzle = SyntheticPuzzle(cols = 30, rows = 20, cellPx = 32, seed = 3)
        val s = run("large", puzzle, count = 120, boxWidth = 1200, scale = 1.5)
        assertTrue(s.found >= 115, "found ${s.found}")
        assertTrue(s.correctCell >= s.found * 0.75, "at least 75% placed correctly, got ${s.correctCell}/${s.found}")
        assertTrue(s.topPairs > 0 && s.pairsCorrect >= s.topPairs - 1, "top suggestions mostly correct")
    }

    @Test
    fun gridFromPieceCount() {
        assertEquals(GridSpec(40, 25), GridSpec.fromPieceCount(1000, 1.6))
        assertEquals(GridSpec(38, 27), GridSpec.fromPieceCount(1026, 38.0 / 27))
        val g = GridSpec.fromPieceCount(500, 4.0 / 3)
        assertTrue(g.count in 480..520, "$g")
    }

    private fun debugDump(name: String, box: RgbImage, photo: RgbImage, analysis: Analysis) {
        val dir = System.getenv("PUZZLE_DEBUG_DIR").orEmpty()
        if (dir.isEmpty()) return
        File(dir).mkdirs()
        fun toBuffered(img: RgbImage) = BufferedImage(img.width, img.height, BufferedImage.TYPE_INT_RGB).also {
            it.setRGB(0, 0, img.width, img.height, img.argb, 0, img.width)
        }
        val p = toBuffered(photo)
        val g = p.createGraphics()
        g.stroke = BasicStroke(2f)
        val best = analysis.suggestions.firstOrNull()
        for (piece in analysis.pieces) {
            g.color = when (piece.id) { best?.anchor?.id -> Color.CYAN; best?.mover?.id -> Color.MAGENTA; else -> Color.WHITE }
            val xs = piece.corners.map { it.x.toInt() }.toIntArray(); val ys = piece.corners.map { it.y.toInt() }.toIntArray()
            g.drawPolygon(xs, ys, 4)
            piece.upDirection?.let { u ->
                g.drawLine(piece.center.x.toInt(), piece.center.y.toInt(), (piece.center.x + u.x * piece.bodySize * 0.4).toInt(), (piece.center.y + u.y * piece.bodySize * 0.4).toInt())
            }
            g.drawString("${piece.id + 1}", piece.center.x.toInt(), piece.center.y.toInt())
        }
        ImageIO.write(p, "png", File(dir, "$name-pieces.png"))
        val b = toBuffered(box)
        val gb = b.createGraphics()
        gb.stroke = BasicStroke(2f)
        for (piece in analysis.pieces) {
            val pl = piece.placement ?: continue
            gb.color = when (piece.id) { best?.anchor?.id -> Color.CYAN; best?.mover?.id -> Color.MAGENTA; else -> Color.WHITE }
            val half = pl.boxCellSize / 2
            gb.drawRect((pl.boxCenter.x - half).toInt(), (pl.boxCenter.y - half).toInt(), pl.boxCellSize.toInt(), pl.boxCellSize.toInt())
            gb.drawString("${piece.id + 1}", pl.boxCenter.x.toInt() - 4, pl.boxCenter.y.toInt() + 4)
        }
        ImageIO.write(b, "png", File(dir, "$name-box.png"))
    }
}
