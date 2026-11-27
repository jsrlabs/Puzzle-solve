package com.jsrlabs.puzzlesolve.core

import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** Tunable parameters. Defaults work for typical phone photos. */
data class SolverParams(
    /** Longest side the pieces photo is reduced to before analysis. */
    val piecesMaxDim: Int = 1400,
    /** Pixels per puzzle cell in the internal reference (box) image. */
    val cellPx: Int = 16,
    /** Samples per side of the square grid taken from each piece's body. */
    val sampleGrid: Int = 12,
    /** Fraction of the body (centered) that is sampled; avoids the cut edges. */
    val sampleSpan: Double = 0.80,
    /** Fraction of candidate positions kept by the cheap mean-color prefilter. */
    val prefilterFraction: Double = 0.10,
    /** Minimum Lab distance from background that can count as "piece". */
    val minBackgroundDistance: Float = 6f,
    val minPieceAreaFraction: Double = 0.0002,
    val minPieceAreaRatio: Double = 0.35,
    val maxPieceAreaRatio: Double = 2.0,
    /** Weight of lightness differences vs. color differences when comparing a piece to the box. */
    val lightnessWeight: Float = 0.7f,
)

/** How the finished puzzle is divided into pieces. */
data class GridSpec(val cols: Int, val rows: Int) {
    init { require(cols > 0 && rows > 0) }
    val count get() = cols * rows

    companion object {
        /**
         * Guess the column/row layout from the advertised piece count and the picture's aspect ratio
         * (width / height). E.g. 1000 pieces at 1.6 -> 40 x 25.
         */
        fun fromPieceCount(count: Int, aspect: Double): GridSpec {
            require(count > 1)
            var best = GridSpec(1, count)
            var bestErr = Double.MAX_VALUE
            val approxCols = sqrt(count * aspect)
            for (cols in max(1, (approxCols * 0.6).toInt())..(approxCols * 1.6).roundToInt() + 1) {
                val rows = max(1, (count.toDouble() / cols).roundToInt())
                // Prefer layouts whose count is close to the advertised one and whose cells are square.
                val countErr = kotlin.math.abs(cols * rows - count).toDouble() / count
                val aspectErr = kotlin.math.abs(kotlin.math.ln((cols.toDouble() / rows) / aspect))
                val err = countErr * 4 + aspectErr
                if (err < bestErr) { bestErr = err; best = GridSpec(cols, rows) }
            }
            return best
        }
    }
}

/** Where a piece belongs in the finished puzzle. */
data class Placement(
    /** Zero-based column / row in the finished puzzle. */
    val col: Int,
    val row: Int,
    /** Center of the piece's body in the box image (coordinates of the image passed to the solver). */
    val boxCenter: Vec2,
    /** Side length of one piece in box image pixels. */
    val boxCellSize: Double,
    /** 0..1, how much better the best location is than the runner-up. */
    val confidence: Double,
    /** Mean color difference at the best location (lower is better). */
    val matchError: Double,
)

/** A piece detected in the pieces photo, in the coordinates of the pieces image passed to the solver. */
data class DetectedPiece(
    val id: Int,
    val center: Vec2,
    val bodySize: Double,
    /** Four corners of the piece's square body (for drawing an outline). */
    val corners: List<Vec2>,
    /** Unit vector (image coordinates, y down) pointing to the side of the piece that faces the top of the picture. */
    val upDirection: Vec2?,
    val placement: Placement?,
)

enum class Direction(val dc: Int, val dr: Int, val phrase: String) {
    LEFT(-1, 0, "to the left of"),
    RIGHT(1, 0, "to the right of"),
    ABOVE(0, -1, "above"),
    BELOW(0, 1, "below"),
}

/** "Put [mover] [direction] [anchor]": two loose pieces that should snap together. */
data class PairSuggestion(
    val anchor: DetectedPiece,
    val mover: DetectedPiece,
    /** Where the mover goes relative to the anchor, as seen with the picture upright. */
    val direction: Direction,
    /** 0..1 overall confidence in this suggestion. */
    val score: Double,
) {
    fun describe(grid: GridSpec): String {
        val a = anchor.placement!!
        val m = mover.placement!!
        return "Join piece ${mover.id + 1} ${direction.phrase} piece ${anchor.id + 1}. " +
            "Piece ${anchor.id + 1} belongs at row ${a.row + 1}, column ${a.col + 1}; " +
            "piece ${mover.id + 1} at row ${m.row + 1}, column ${m.col + 1} (of ${grid.rows} rows x ${grid.cols} columns)."
    }
}

data class Analysis(
    val grid: GridSpec,
    val pieces: List<DetectedPiece>,
    /** Best first. */
    val suggestions: List<PairSuggestion>,
    val warnings: List<String>,
)
