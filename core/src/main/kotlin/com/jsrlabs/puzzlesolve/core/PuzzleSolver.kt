package com.jsrlabs.puzzlesolve.core

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Entry point: give it a picture of the finished puzzle (the box) and a picture of loose pieces,
 * get back where each piece belongs and which pairs of loose pieces should be joined.
 *
 * Usage:
 * ```
 * val analysis = PuzzleSolver().analyze(boxImage, piecesImage, GridSpec.fromPieceCount(500, aspect))
 * analysis.suggestions.firstOrNull()?.describe(analysis.grid)
 * ```
 */
class PuzzleSolver(private val params: SolverParams = SolverParams()) {

    /**
     * @param box the picture on the box, cropped to just the puzzle picture.
     * @param pieces photo of loose pieces, picture side up, not touching, on a plain contrasting surface.
     * @param progress optional callback (fraction 0..1, message).
     */
    fun analyze(
        box: RgbImage,
        pieces: RgbImage,
        grid: GridSpec,
        progress: (Double, String) -> Unit = { _, _ -> },
    ): Analysis {
        val warnings = ArrayList<String>()
        val cell = params.cellPx

        progress(0.02, "Preparing box picture")
        val workW = grid.cols * cell
        val workH = grid.rows * cell
        val boxSmall = box.downscaleToMax(max(workW, workH) * 2)
        val boxLab = LabImage.from(boxSmall).resize(workW, workH).boxBlur(1)

        progress(0.08, "Finding pieces")
        val piecesSmall = pieces.downscaleToMax(params.piecesMaxDim)
        val toOriginal = pieces.width.toDouble() / piecesSmall.width
        val piecesLab = LabImage.from(piecesSmall)
        val seg = PieceSegmenter(params).segment(piecesLab)
        if (seg.clumps > 0) warnings += "${seg.clumps} blob(s) looked like several touching pieces and were skipped. Spread pieces apart."
        if (seg.cutOff > 0) warnings += "${seg.cutOff} piece(s) touching the edge of the photo were skipped."
        if (seg.pieces.isEmpty()) {
            warnings += "No pieces found. Lay pieces picture-side up on a plain surface that contrasts with them."
            return Analysis(grid, emptyList(), emptyList(), warnings)
        }

        val bodyPx = PieceSegmenter.median(seg.pieces.map { it.bodySize.toFloat() }).toDouble()
        // Blur the pieces photo so its detail level matches the reduced box picture: one box pixel spans
        // bodyPx / cell photo pixels and the box picture got an extra 3x3 blur.
        val blurR = max(0, (1.5 * bodyPx / cell).roundToInt())
        val piecesBlurred = if (blurR > 0) piecesLab.boxBlur(blurR) else piecesLab
        val samples = seg.pieces.map { sample(it, piecesBlurred, bodyPx) }

        progress(0.15, "Indexing box picture")
        val locator = PieceLocator(boxLab, params)

        // Pass 1 with a color model from global statistics, pass 2 with one fitted on confident matches.
        var color = initialColorModel(samples, boxLab)
        var matches: List<Match?> = emptyList()
        for (pass in 0 until 2) {
            val passStart = 0.2 + pass * 0.4
            matches = samples.mapIndexed { i, s ->
                progress(passStart + 0.4 * i / samples.size, "Matching pieces (pass ${pass + 1} of 2)")
                locator.locate(s, color)
            }
            if (pass == 0) color = fitColorModel(samples, matches, locator) ?: color
        }

        progress(0.98, "Building suggestions")
        val boxScaleX = box.width.toDouble() / workW
        val boxScaleY = box.height.toDouble() / workH
        val placementConf = matches.map { it?.confidence ?: 0.0 }.toMutableList()
        // Two pieces claiming the same cell: trust the more confident one.
        val byCell = HashMap<Int, MutableList<Int>>()
        matches.forEachIndexed { i, m ->
            if (m != null) byCell.getOrPut(cellIndex(m, grid)) { ArrayList() } += i
        }
        for (list in byCell.values) if (list.size > 1) {
            val keep = list.maxByOrNull { placementConf[it] }!!
            for (i in list) if (i != keep) placementConf[i] *= 0.3
        }

        val detected = seg.pieces.mapIndexed { i, p ->
            val m = matches[i]
            val placement = m?.let {
                Placement(
                    col = PieceLocator.cellOf(it.x, cell, grid.cols),
                    row = PieceLocator.cellOf(it.y, cell, grid.rows),
                    boxCenter = Vec2(it.x * boxScaleX, it.y * boxScaleY),
                    boxCellSize = cell * (boxScaleX + boxScaleY) / 2,
                    confidence = placementConf[i],
                    matchError = it.error,
                )
            }
            val half = bodyPx / 2
            val corners = listOf(-1 to -1, 1 to -1, 1 to 1, -1 to 1).map { (su, sv) ->
                (p.center + p.axisU * (su * half) + p.axisV * (sv * half)) * toOriginal
            }
            DetectedPiece(
                id = i,
                center = p.center * toOriginal,
                bodySize = bodyPx * toOriginal,
                corners = corners,
                upDirection = m?.let { upDirection(p, it.quarterTurns) },
                placement = placement,
            )
        }
        val located = detected.count { it.placement != null }
        if (located < detected.size) warnings += "${detected.size - located} piece(s) could not be matched."
        val suggestions = suggestPairs(detected, matches, cell)
        progress(1.0, "Done")
        return Analysis(grid, detected, suggestions, warnings)
    }

    private fun cellIndex(m: Match, grid: GridSpec): Int =
        PieceLocator.cellOf(m.y, params.cellPx, grid.rows) * grid.cols + PieceLocator.cellOf(m.x, params.cellPx, grid.cols)

    private fun sample(p: SegmentedPiece, img: LabImage, bodyPx: Double): PieceSamples {
        val g = params.sampleGrid
        val span = params.sampleSpan
        val u = ArrayList<Float>(); val v = ArrayList<Float>()
        val l = ArrayList<Float>(); val a = ArrayList<Float>(); val b = ArrayList<Float>()
        val au = p.axisU; val av = p.axisV
        val erosion = max(2.0, bodyPx * 0.04)
        for (j in 0 until g) for (i in 0 until g) {
            val su = (-span / 2 + span * i / (g - 1))
            val sv = (-span / 2 + span * j / (g - 1))
            val pt = p.center + au * (su * bodyPx) + av * (sv * bodyPx)
            // Only use samples well inside the piece (eroded mask), away from shadows/edges.
            if (!p.inMask(pt.x, pt.y) || !p.inMask(pt.x + erosion, pt.y) || !p.inMask(pt.x - erosion, pt.y) ||
                !p.inMask(pt.x, pt.y + erosion) || !p.inMask(pt.x, pt.y - erosion)
            ) continue
            u += su.toFloat(); v += sv.toFloat()
            l += img.l.sample(pt.x.toFloat(), pt.y.toFloat())
            a += img.a.sample(pt.x.toFloat(), pt.y.toFloat())
            b += img.b.sample(pt.x.toFloat(), pt.y.toFloat())
        }
        return PieceSamples(p, u.toFloatArray(), v.toFloatArray(), l.toFloatArray(), a.toFloatArray(), b.toFloatArray())
    }

    /** Match lightness mean/contrast of all piece samples to the box picture; shift color partially. */
    private fun initialColorModel(samples: List<PieceSamples>, box: LabImage): ColorModel {
        fun stats(values: FloatArray): Pair<Double, Double> {
            var m = 0.0
            for (x in values) m += x
            m /= values.size
            var v = 0.0
            for (x in values) v += (x - m) * (x - m)
            return m to sqrt(v / values.size)
        }
        val pl = samples.flatMap { it.l.asList() }.toFloatArray()
        val pa = samples.flatMap { it.a.asList() }.toFloatArray()
        val pb = samples.flatMap { it.b.asList() }.toFloatArray()
        if (pl.isEmpty()) return ColorModel()
        val (mpl, spl) = stats(pl); val (mpa, _) = stats(pa); val (mpb, _) = stats(pb)
        val (mbl, sbl) = stats(box.l.data); val (mba, _) = stats(box.a.data); val (mbb, _) = stats(box.b.data)
        // Only a partial correction: the loose pieces may show just part of the picture.
        val gain = if (spl > 1e-3) 1.0 + 0.5 * ((sbl / spl).coerceIn(0.6, 1.6) - 1.0) else 1.0
        val targetMean = mpl + 0.5 * (mbl - mpl)
        val lShift = targetMean - gain * mpl
        return ColorModel(
            gainL = gain.toFloat(), offL = lShift.toFloat(),
            offA = ((mba - mpa) * 0.3).toFloat(), offB = ((mbb - mpb) * 0.3).toFloat(),
        )
    }

    /** Least-squares per-channel gain/offset using the more confident half of the matches. */
    private fun fitColorModel(samples: List<PieceSamples>, matches: List<Match?>, locator: PieceLocator): ColorModel? {
        val good = matches.indices.filter { matches[it] != null }.sortedByDescending { matches[it]!!.confidence }
        val use = good.take(max(3, good.size / 2)).filter { matches[it]!!.confidence > 0.1 }
        if (use.size < 3) return null
        val xs = Array(3) { ArrayList<Float>() }
        val ys = Array(3) { ArrayList<Float>() }
        for (i in use) {
            val s = samples[i]
            val (bl, ba, bb) = locator.boxColorsAt(matches[i]!!, s)
            for (k in 0 until s.n) {
                xs[0] += s.l[k]; ys[0] += bl[k]
                xs[1] += s.a[k]; ys[1] += ba[k]
                xs[2] += s.b[k]; ys[2] += bb[k]
            }
        }
        fun fit(x: List<Float>, y: List<Float>): Pair<Float, Float> {
            val n = x.size.toDouble()
            val mx = x.sum() / n; val my = y.sum() / n
            var sxy = 0.0; var sxx = 0.0
            for (i in x.indices) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) * (x[i] - mx) }
            val gain = if (sxx > 1e-6) (sxy / sxx).coerceIn(0.6, 1.6) else 1.0
            return gain.toFloat() to (my - gain * mx).toFloat()
        }
        val (gl, ol) = fit(xs[0], ys[0]); val (ga, oa) = fit(xs[1], ys[1]); val (gb, ob) = fit(xs[2], ys[2])
        return ColorModel(gl, ol, ga, oa, gb, ob)
    }

    /** The direction (in pieces-photo coordinates) the top of the piece faces. */
    private fun upDirection(p: SegmentedPiece, q: Int): Vec2 {
        // Box "up" is (0, -1); find (u, v) with rot_q(u, v) = (0, -1).
        val (u, v) = when (q and 3) { 0 -> 0.0 to -1.0; 1 -> -1.0 to 0.0; 2 -> 0.0 to 1.0; else -> 1.0 to 0.0 }
        return p.axisU * u + p.axisV * v
    }

    private fun suggestPairs(pieces: List<DetectedPiece>, matches: List<Match?>, cell: Int): List<PairSuggestion> {
        val out = ArrayList<PairSuggestion>()
        for (i in pieces.indices) for (j in i + 1 until pieces.size) {
            val pi = pieces[i].placement ?: continue
            val pj = pieces[j].placement ?: continue
            val dc = pj.col - pi.col; val dr = pj.row - pi.row
            if (abs(dc) + abs(dr) != 1) continue
            // The refined positions should also be about one cell apart.
            val mi = matches[i]!!; val mj = matches[j]!!
            val dx = mj.x - mi.x; val dy = mj.y - mi.y
            val d = sqrt(dx * dx + dy * dy)
            val consistency = exp(-((d - cell) / (0.35 * cell)).let { it * it })
            val score = min(pi.confidence, pj.confidence) * consistency
            val (anchor, mover) = if (pi.confidence >= pj.confidence) pieces[i] to pieces[j] else pieces[j] to pieces[i]
            val ac = anchor.placement!!; val mc = mover.placement!!
            val dir = Direction.entries.first { it.dc == mc.col - ac.col && it.dr == mc.row - ac.row }
            out += PairSuggestion(anchor, mover, dir, score)
        }
        return out.sortedByDescending { it.score }
    }
}
