package com.jsrlabs.puzzlesolve.core

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** Color samples taken from one piece's body, in the piece's own (u, v) frame. */
internal class PieceSamples(
    val piece: SegmentedPiece,
    /** Sample positions in body units, each in [-span/2, span/2]. */
    val u: FloatArray, val v: FloatArray,
    /** Raw Lab values from the pieces photo. */
    val l: FloatArray, val a: FloatArray, val b: FloatArray,
) {
    val n get() = u.size
}

/** Per-channel linear color transform mapping pieces-photo Lab values onto box-image Lab values. */
internal data class ColorModel(
    val gainL: Float = 1f, val offL: Float = 0f,
    val gainA: Float = 1f, val offA: Float = 0f,
    val gainB: Float = 1f, val offB: Float = 0f,
)

/** Result of matching one piece against the reference picture (work-image coordinates). */
internal class Match(
    val x: Double, val y: Double,
    /** Number of quarter turns k: the piece's (u, v) frame maps to box offsets rot_k(u, v). */
    val quarterTurns: Int,
    val error: Double,
    val confidence: Double,
)

/**
 * Finds where each piece's picture fragment appears in the box picture.
 *
 * The box picture is resampled so every puzzle cell is exactly [SolverParams.cellPx] pixels. Each piece
 * contributes a grid of color samples taken from its body; these are compared (sum of squared Lab
 * differences) to the box picture at every candidate position and in all four 90-degree orientations.
 * A cheap rotation-independent mean-color prefilter discards most positions first.
 */
internal class PieceLocator(
    private val box: LabImage,
    private val params: SolverParams,
) {
    private val cell = params.cellPx
    private val w = box.width
    private val h = box.height

    // Window statistics for the prefilter, computed once for every pixel position.
    private val winMeanL = FloatArray(w * h)
    private val winMeanA = FloatArray(w * h)
    private val winMeanB = FloatArray(w * h)
    private val winStdL = FloatArray(w * h)

    init {
        val iiL = IntegralImage(box.l); val iiL2 = IntegralImage(box.l, squared = true)
        val iiA = IntegralImage(box.a); val iiB = IntegralImage(box.b)
        val half = (cell * params.sampleSpan / 2).roundToInt()
        for (y in 0 until h) {
            val y0 = max(0, y - half); val y1 = min(h - 1, y + half)
            for (x in 0 until w) {
                val x0 = max(0, x - half); val x1 = min(w - 1, x + half)
                val n = ((x1 - x0 + 1) * (y1 - y0 + 1)).toDouble()
                val i = y * w + x
                val mL = iiL.sum(x0, y0, x1, y1) / n
                winMeanL[i] = mL.toFloat()
                winMeanA[i] = (iiA.sum(x0, y0, x1, y1) / n).toFloat()
                winMeanB[i] = (iiB.sum(x0, y0, x1, y1) / n).toFloat()
                winStdL[i] = sqrt(max(0.0, iiL2.sum(x0, y0, x1, y1) / n - mL * mL)).toFloat()
            }
        }
    }

    fun locate(s: PieceSamples, color: ColorModel): Match? {
        val n = s.n
        if (n < 8) return null
        val wl = params.lightnessWeight
        val cl = FloatArray(n) { color.gainL * s.l[it] + color.offL }
        val ca = FloatArray(n) { color.gainA * s.a[it] + color.offA }
        val cb = FloatArray(n) { color.gainB * s.b[it] + color.offB }
        var mL = 0.0; var mA = 0.0; var mB = 0.0
        for (i in 0 until n) { mL += cl[i]; mA += ca[i]; mB += cb[i] }
        mL /= n; mA /= n; mB /= n
        var vL = 0.0
        for (i in 0 until n) vL += (cl[i] - mL) * (cl[i] - mL)
        val sL = sqrt(vL / n)

        // Candidate body centers keep the whole body inside the picture.
        val margin = (cell * 0.45).roundToInt()
        val xs = margin until w - margin step 2
        val ys = margin until h - margin step 2

        // 1. Prefilter on window mean color / texture (rotation independent).
        val count = ((xs.last - xs.first) / 2 + 1) * ((ys.last - ys.first) / 2 + 1)
        val pre = FloatArray(count)
        var k = 0
        var maxPre = 0f
        for (y in ys) for (x in xs) {
            val i = y * w + x
            val dl = (winMeanL[i] - mL).toFloat() * wl; val da = (winMeanA[i] - mA).toFloat(); val db = (winMeanB[i] - mB).toFloat()
            val ds = (winStdL[i] - sL).toFloat()
            val d = dl * dl + da * da + db * db + 0.5f * ds * ds
            pre[k++] = d
            if (d > maxPre) maxPre = d
        }
        val keep = max(64, (count * params.prefilterFraction).toInt())
        val limit = kthSmallestBound(pre, keep, maxPre)

        // 2. Full sample comparison at surviving positions, all four orientations.
        val offX = Array(4) { IntArray(n) }
        val offY = Array(4) { IntArray(n) }
        for (q in 0 until 4) for (i in 0 until n) {
            val (ox, oy) = rot(q, s.u[i] * cell, s.v[i] * cell)
            offX[q][i] = ox.roundToInt(); offY[q][i] = oy.roundToInt()
        }
        val candX = ArrayList<Int>(); val candY = ArrayList<Int>(); val candQ = ArrayList<Int>(); val candE = ArrayList<Double>()
        k = 0
        for (y in ys) for (x in xs) {
            if (pre[k++] > limit) continue
            var bestE = Double.MAX_VALUE; var bestQ = 0
            for (q in 0 until 4) {
                val ox = offX[q]; val oy = offY[q]
                var e = 0.0
                for (i in 0 until n) {
                    val px = (x + ox[i]).coerceIn(0, w - 1); val py = (y + oy[i]).coerceIn(0, h - 1)
                    val j = py * w + px
                    val dl = (box.l.data[j] - cl[i]) * wl; val da = box.a.data[j] - ca[i]; val db = box.b.data[j] - cb[i]
                    e += dl * dl + da * da + db * db
                    if (e >= bestE) break
                }
                if (e < bestE) { bestE = e; bestQ = q }
            }
            candX += x; candY += y; candQ += bestQ; candE += bestE / n
        }
        if (candE.isEmpty()) return null

        // 3. Non-maximum suppression: a few distinct locations, refined at single-pixel precision.
        val order = candE.indices.sortedBy { candE[it] }
        val picked = ArrayList<Int>()
        val minSep = cell * 0.7
        for (idx in order) {
            if (picked.size >= 5) break
            if (picked.none { p -> dist(candX[p], candY[p], candX[idx], candY[idx]) < minSep }) picked += idx
        }
        val refined = picked.map { refine(candX[it], candY[it], s, cl, ca, cb) }.sortedBy { it.third }
        val best = refined[0]
        val second = if (refined.size > 1) refined[1].third else best.third * 2 + 1.0
        val confidence = if (second <= 0.0) 0.0 else (1.0 - best.third / second).coerceIn(0.0, 1.0)
        return Match(best.first.first, best.first.second, best.second, best.third, confidence)
    }

    /** Local search (+/-2 px, all orientations) with exact (bilinear) sample offsets. */
    private fun refine(x0: Int, y0: Int, s: PieceSamples, cl: FloatArray, ca: FloatArray, cb: FloatArray): Triple<Pair<Double, Double>, Int, Double> {
        val n = s.n
        val wl = params.lightnessWeight
        var best = Triple(x0.toDouble() to y0.toDouble(), 0, Double.MAX_VALUE)
        for (q in 0 until 4) {
            val ox = FloatArray(n); val oy = FloatArray(n)
            for (i in 0 until n) { val r = rot(q, s.u[i] * cell, s.v[i] * cell); ox[i] = r.first; oy[i] = r.second }
            for (dy in -2..2) for (dx in -2..2) {
                val x = x0 + dx; val y = y0 + dy
                var e = 0.0
                for (i in 0 until n) {
                    val px = x + ox[i]; val py = y + oy[i]
                    val dl = (box.l.sample(px, py) - cl[i]) * wl; val da = box.a.sample(px, py) - ca[i]; val db = box.b.sample(px, py) - cb[i]
                    e += dl * dl + da * da + db * db
                }
                e /= n
                if (e < best.third) best = Triple(x.toDouble() to y.toDouble(), q, e)
            }
        }
        return best
    }

    /** Box-image colors at a match, for fitting the color model. */
    fun boxColorsAt(m: Match, s: PieceSamples): Triple<FloatArray, FloatArray, FloatArray> {
        val l = FloatArray(s.n); val a = FloatArray(s.n); val b = FloatArray(s.n)
        for (i in 0 until s.n) {
            val (ox, oy) = rot(m.quarterTurns, s.u[i] * cell, s.v[i] * cell)
            val px = (m.x + ox).toFloat(); val py = (m.y + oy).toFloat()
            l[i] = box.l.sample(px, py); a[i] = box.a.sample(px, py); b[i] = box.b.sample(px, py)
        }
        return Triple(l, a, b)
    }

    companion object {
        /** Rotate (u, v) by q quarter turns (image coordinates, y down). */
        fun rot(q: Int, u: Float, v: Float): Pair<Float, Float> = when (q and 3) {
            0 -> u to v
            1 -> -v to u
            2 -> -u to -v
            else -> v to -u
        }

        private fun dist(x0: Int, y0: Int, x1: Int, y1: Int): Double {
            val dx = (x0 - x1).toDouble(); val dy = (y0 - y1).toDouble()
            return sqrt(dx * dx + dy * dy)
        }

        /** An upper bound for the k-th smallest value (histogram based, O(n)). */
        fun kthSmallestBound(values: FloatArray, k: Int, maxV: Float): Float {
            if (k >= values.size || maxV <= 0f) return Float.MAX_VALUE
            val bins = 4096
            val hist = IntArray(bins)
            for (v in values) hist[min(bins - 1, (v / maxV * (bins - 1)).toInt())]++
            var acc = 0
            for (i in 0 until bins) {
                acc += hist[i]
                if (acc >= k) return (i + 1).toFloat() / (bins - 1) * maxV
            }
            return Float.MAX_VALUE
        }

        fun cellOf(coord: Double, cell: Int, cells: Int): Int = floor(coord / cell).toInt().coerceIn(0, cells - 1)
    }
}
