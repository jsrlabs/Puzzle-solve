package com.jsrlabs.puzzlesolve.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

/**
 * Generates a fake jigsaw puzzle for testing: a random "box picture", and a "photo" of a subset
 * of its pieces (with knobs, random rotation, different scale, lighting change and noise) lying
 * on a plain table.
 */
class SyntheticPuzzle(
    val cols: Int,
    val rows: Int,
    val cellPx: Int = 40,
    seed: Int = 1,
) {
    private val rnd = Random(seed)
    val artW = cols * cellPx
    val artH = rows * cellPx
    private val art = makeArt()

    // Knob direction for each internal edge: +1 knob points to the right/down neighbor, -1 the other way.
    private val hEdges = Array(rows) { IntArray(cols - 1) { if (rnd.nextBoolean()) 1 else -1 } }
    private val vEdges = Array(rows - 1) { IntArray(cols) { if (rnd.nextBoolean()) 1 else -1 } }

    /** Ground truth of a piece placed in the photo. */
    data class Truth(val col: Int, val row: Int, val center: Vec2, val rotation: Double)

    fun boxImage(noise: Int = 6, outW: Int = artW): RgbImage {
        val img = RgbImage(artW, artH, IntArray(artW * artH) { i -> jitter(art[i], noise) })
        return if (outW == artW) img else img.resize(outW, (artH.toDouble() * outW / artW).roundToInt())
    }

    private fun jitter(p: Int, noise: Int): Int {
        fun ch(v: Int) = (v + rnd.nextInt(-noise, noise + 1)).coerceIn(0, 255)
        return (0xFF shl 24) or (ch((p shr 16) and 0xFF) shl 16) or (ch((p shr 8) and 0xFF) shl 8) or ch(p and 0xFF)
    }

    /**
     * Photo of [count] random pieces, scattered in a loose grid.
     * @param scale photo pixels per art pixel.
     */
    fun piecesPhoto(
        count: Int,
        scale: Double = 1.8,
        gain: Double = 0.85,
        offset: Int = 12,
        background: Int = 0xFF2E5A3C.toInt(),
        noise: Int = 8,
    ): Pair<RgbImage, List<Truth>> {
        val chosen = (0 until cols * rows).shuffled(rnd).take(count)
        val slot = (cellPx * scale * 2.0).roundToInt()
        val slotsX = max(1, kotlin.math.ceil(kotlin.math.sqrt(count * 1.5)).toInt())
        val slotsY = (count + slotsX - 1) / slotsX
        val w = slotsX * slot + slot / 2
        val h = slotsY * slot + slot / 2
        val px = IntArray(w * h) { jitter(background, noise) }
        val truths = ArrayList<Truth>()
        chosen.forEachIndexed { k, idx ->
            val col = idx % cols; val row = idx / cols
            val cx = (k % slotsX + 0.75) * slot + rnd.nextDouble(-0.12, 0.12) * slot
            val cy = (k / slotsX + 0.75) * slot + rnd.nextDouble(-0.12, 0.12) * slot
            val rotation = rnd.nextDouble(0.0, 2 * PI)
            truths += Truth(col, row, Vec2(cx, cy), rotation)
            val c = cos(rotation); val s = sin(rotation)
            val reach = (cellPx * scale * 0.95).toInt()
            for (y in (cy - reach).toInt()..(cy + reach).toInt()) for (x in (cx - reach).toInt()..(cx + reach).toInt()) {
                if (x !in 0 until w || y !in 0 until h) continue
                // Inverse map photo -> art coordinates.
                val dx = (x - cx) / scale; val dy = (y - cy) / scale
                val ax = (col + 0.5) * cellPx + (c * dx + s * dy)
                val ay = (row + 0.5) * cellPx + (-s * dx + c * dy)
                if (!inPiece(ax, ay, col, row)) continue
                val p = artAt(ax, ay)
                fun ch(v: Int) = (v * gain + offset + rnd.nextInt(-noise, noise + 1)).roundToInt().coerceIn(0, 255)
                px[y * w + x] = (0xFF shl 24) or (ch((p shr 16) and 0xFF) shl 16) or (ch((p shr 8) and 0xFF) shl 8) or ch(p and 0xFF)
            }
        }
        return RgbImage(w, h, px) to truths
    }

    private fun artAt(x: Double, y: Double): Int {
        val ix = x.roundToInt().coerceIn(0, artW - 1); val iy = y.roundToInt().coerceIn(0, artH - 1)
        return art[iy * artW + ix]
    }

    /** Is art point (x, y) part of the piece at (col, row)? Square body plus/minus round knobs. */
    fun inPiece(x: Double, y: Double, col: Int, row: Int): Boolean {
        val b = cellPx.toDouble()
        val knobR = 0.17 * b
        val knobOff = 0.13 * b
        fun inCircle(cx: Double, cy: Double) = (x - cx) * (x - cx) + (y - cy) * (y - cy) <= knobR * knobR
        val inBody = x >= col * b && x < (col + 1) * b && y >= row * b && y < (row + 1) * b
        // Right edge
        if (col < cols - 1) {
            val d = hEdges[row][col]
            val c = inCircle((col + 1) * b + d * knobOff, (row + 0.5) * b)
            if (c) return d > 0 // knob belongs to this piece if it points outward
        }
        if (col > 0) {
            val d = hEdges[row][col - 1]
            val c = inCircle(col * b + d * knobOff, (row + 0.5) * b)
            if (c) return d < 0
        }
        if (row < rows - 1) {
            val d = vEdges[row][col]
            val c = inCircle((col + 0.5) * b, (row + 1) * b + d * knobOff)
            if (c) return d > 0
        }
        if (row > 0) {
            val d = vEdges[row - 1][col]
            val c = inCircle((col + 0.5) * b, row * b + d * knobOff)
            if (c) return d < 0
        }
        return inBody
    }

    /** Smooth multi-octave value noise per channel plus a few hard-edged shapes: a stand-in for a real picture. */
    private fun makeArt(): IntArray {
        val channels = Array(3) { valueNoise(artW, artH, listOf(6, 14, 30, 60), rnd) }
        val out = IntArray(artW * artH)
        for (i in out.indices) {
            val r = (channels[0][i] * 255).roundToInt().coerceIn(0, 255)
            val g = (channels[1][i] * 255).roundToInt().coerceIn(0, 255)
            val b = (channels[2][i] * 255).roundToInt().coerceIn(0, 255)
            out[i] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
        }
        repeat(cols * rows / 3) {
            val cx = rnd.nextInt(artW); val cy = rnd.nextInt(artH)
            val rad = rnd.nextInt(cellPx / 6, cellPx / 2)
            val color = (0xFF shl 24) or rnd.nextInt(0x1000000)
            for (y in max(0, cy - rad) until min(artH, cy + rad)) for (x in max(0, cx - rad) until min(artW, cx + rad)) {
                if ((x - cx) * (x - cx) + (y - cy) * (y - cy) < rad * rad) out[y * artW + x] = color
            }
        }
        return out
    }

    private fun valueNoise(w: Int, h: Int, periods: List<Int>, rnd: Random): FloatArray {
        val out = FloatArray(w * h)
        var totalAmp = 0f
        for ((k, period) in periods.withIndex()) {
            val amp = 1f / (k + 1)
            totalAmp += amp
            val gw = w / period + 2; val gh = h / period + 2
            val grid = FloatArray(gw * gh) { rnd.nextFloat() }
            for (y in 0 until h) for (x in 0 until w) {
                val fx = x.toFloat() / period; val fy = y.toFloat() / period
                val x0 = floor(fx).toInt(); val y0 = floor(fy).toInt()
                val tx = smooth(fx - x0); val ty = smooth(fy - y0)
                val a = grid[y0 * gw + x0]; val b = grid[y0 * gw + x0 + 1]
                val c = grid[(y0 + 1) * gw + x0]; val d = grid[(y0 + 1) * gw + x0 + 1]
                out[y * w + x] += amp * ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty)
            }
        }
        for (i in out.indices) out[i] = ((out[i] / totalAmp - 0.5f) * 1.8f + 0.5f)
        return out
    }

    private fun smooth(t: Float) = t * t * (3 - 2 * t)
}
