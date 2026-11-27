package com.jsrlabs.puzzlesolve.core

import kotlin.math.cbrt
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt

// NOTE: everything in this module deliberately uses only the Kotlin standard library
// (no java.*, no android.*) so it can later move into a Kotlin Multiplatform `commonMain`
// source set and be compiled to JavaScript / WebAssembly for a web version of the app.

/**
 * An 8-bit RGB image stored as packed 0xAARRGGBB ints, row-major.
 * This is the same layout as Android's `Bitmap.getPixels`, and is trivially produced from an
 * HTML canvas `ImageData` on the web.
 */
class RgbImage(val width: Int, val height: Int, val argb: IntArray) {
    init {
        require(width > 0 && height > 0) { "Image must not be empty" }
        require(argb.size == width * height) { "Pixel buffer size does not match ${width}x$height" }
    }

    fun crop(x: Int, y: Int, w: Int, h: Int): RgbImage {
        val x0 = x.coerceIn(0, width - 1)
        val y0 = y.coerceIn(0, height - 1)
        val cw = w.coerceIn(1, width - x0)
        val ch = h.coerceIn(1, height - y0)
        val out = IntArray(cw * ch)
        for (row in 0 until ch) {
            argb.copyInto(out, row * cw, (y0 + row) * width + x0, (y0 + row) * width + x0 + cw)
        }
        return RgbImage(cw, ch, out)
    }

    /** Area-averaging downscale so that the longest side is at most [maxDim]. Returns this if already small. */
    fun downscaleToMax(maxDim: Int): RgbImage {
        val longest = max(width, height)
        if (longest <= maxDim) return this
        val s = maxDim.toDouble() / longest
        return resize(max(1, (width * s).roundToInt()), max(1, (height * s).roundToInt()))
    }

    /** Area-averaging resize (intended for downscaling; upscaling falls back to nearest pixel). */
    fun resize(newW: Int, newH: Int): RgbImage {
        val out = IntArray(newW * newH)
        val sx = width.toDouble() / newW
        val sy = height.toDouble() / newH
        for (oy in 0 until newH) {
            val y0 = floor(oy * sy).toInt().coerceIn(0, height - 1)
            val y1 = max(y0 + 1, floor((oy + 1) * sy).toInt()).coerceAtMost(height)
            for (ox in 0 until newW) {
                val x0 = floor(ox * sx).toInt().coerceIn(0, width - 1)
                val x1 = max(x0 + 1, floor((ox + 1) * sx).toInt()).coerceAtMost(width)
                var r = 0L; var g = 0L; var b = 0L
                for (yy in y0 until y1) {
                    var i = yy * width + x0
                    for (xx in x0 until x1) {
                        val p = argb[i++]
                        r += (p shr 16) and 0xFF; g += (p shr 8) and 0xFF; b += p and 0xFF
                    }
                }
                val n = (y1 - y0) * (x1 - x0)
                out[oy * newW + ox] = (0xFF shl 24) or ((r / n).toInt() shl 16) or ((g / n).toInt() shl 8) or (b / n).toInt()
            }
        }
        return RgbImage(newW, newH, out)
    }
}

/** A single-channel float image. */
class Plane(val width: Int, val height: Int, val data: FloatArray = FloatArray(width * height)) {
    operator fun get(x: Int, y: Int): Float = data[y * width + x]

    /** Bilinear sample with edge clamping. */
    fun sample(x: Float, y: Float): Float {
        val fx = x.coerceIn(0f, (width - 1).toFloat())
        val fy = y.coerceIn(0f, (height - 1).toFloat())
        val x0 = fx.toInt(); val y0 = fy.toInt()
        val x1 = min(x0 + 1, width - 1); val y1 = min(y0 + 1, height - 1)
        val tx = fx - x0; val ty = fy - y0
        val a = data[y0 * width + x0]; val b = data[y0 * width + x1]
        val c = data[y1 * width + x0]; val d = data[y1 * width + x1]
        return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty
    }

    /** Box blur with a (2r+1)x(2r+1) window using an integral image; edges use the partial window. */
    fun boxBlur(r: Int): Plane {
        if (r <= 0) return Plane(width, height, data.copyOf())
        val ii = IntegralImage(this)
        val out = Plane(width, height)
        for (y in 0 until height) {
            val y0 = max(0, y - r); val y1 = min(height - 1, y + r)
            for (x in 0 until width) {
                val x0 = max(0, x - r); val x1 = min(width - 1, x + r)
                out.data[y * width + x] = (ii.sum(x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1))).toFloat()
            }
        }
        return out
    }

    /** Resize; area-average when shrinking, bilinear when enlarging. */
    fun resize(newW: Int, newH: Int): Plane {
        val out = Plane(newW, newH)
        val sx = width.toDouble() / newW
        val sy = height.toDouble() / newH
        if (sx >= 1.0 && sy >= 1.0) {
            val ii = IntegralImage(this)
            for (oy in 0 until newH) {
                val y0 = floor(oy * sy).toInt().coerceIn(0, height - 1)
                val y1 = (max(y0 + 1, floor((oy + 1) * sy).toInt()) - 1).coerceIn(y0, height - 1)
                for (ox in 0 until newW) {
                    val x0 = floor(ox * sx).toInt().coerceIn(0, width - 1)
                    val x1 = (max(x0 + 1, floor((ox + 1) * sx).toInt()) - 1).coerceIn(x0, width - 1)
                    out.data[oy * newW + ox] = (ii.sum(x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1))).toFloat()
                }
            }
        } else {
            for (oy in 0 until newH) for (ox in 0 until newW) {
                out.data[oy * newW + ox] = sample(((ox + 0.5) * sx - 0.5).toFloat(), ((oy + 0.5) * sy - 0.5).toFloat())
            }
        }
        return out
    }
}

/** Summed-area table (double precision) for fast window sums. */
class IntegralImage(plane: Plane, squared: Boolean = false) {
    private val w = plane.width + 1
    private val table = DoubleArray(w * (plane.height + 1))

    init {
        for (y in 0 until plane.height) {
            var rowSum = 0.0
            for (x in 0 until plane.width) {
                val v = plane.data[y * plane.width + x].toDouble()
                rowSum += if (squared) v * v else v
                table[(y + 1) * w + x + 1] = table[y * w + x + 1] + rowSum
            }
        }
    }

    /** Sum over the inclusive rectangle [x0..x1] x [y0..y1]. */
    fun sum(x0: Int, y0: Int, x1: Int, y1: Int): Double =
        table[(y1 + 1) * w + x1 + 1] - table[y0 * w + x1 + 1] - table[(y1 + 1) * w + x0] + table[y0 * w + x0]
}

/** CIE L*a*b* image (D65). Lab is used because Euclidean distances roughly match perceived color differences. */
class LabImage(val l: Plane, val a: Plane, val b: Plane) {
    val width get() = l.width
    val height get() = l.height

    fun resize(newW: Int, newH: Int) = LabImage(l.resize(newW, newH), a.resize(newW, newH), b.resize(newW, newH))
    fun boxBlur(r: Int) = LabImage(l.boxBlur(r), a.boxBlur(r), b.boxBlur(r))

    companion object {
        private val srgbToLinear = FloatArray(256) { i ->
            val c = i / 255.0
            (if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)).toFloat()
        }

        private fun f(t: Float): Float = if (t > 0.008856f) cbrt(t) else 7.787f * t + 16f / 116f

        fun from(img: RgbImage): LabImage {
            val n = img.width * img.height
            val l = Plane(img.width, img.height); val a = Plane(img.width, img.height); val b = Plane(img.width, img.height)
            for (i in 0 until n) {
                val p = img.argb[i]
                val r = srgbToLinear[(p shr 16) and 0xFF]
                val g = srgbToLinear[(p shr 8) and 0xFF]
                val bl = srgbToLinear[p and 0xFF]
                val x = (0.4124f * r + 0.3576f * g + 0.1805f * bl) / 0.95047f
                val y = 0.2126f * r + 0.7152f * g + 0.0722f * bl
                val z = (0.0193f * r + 0.1192f * g + 0.9505f * bl) / 1.08883f
                val fx = f(x); val fy = f(y); val fz = f(z)
                l.data[i] = 116f * fy - 16f
                a.data[i] = 500f * (fx - fy)
                b.data[i] = 200f * (fy - fz)
            }
            return LabImage(l, a, b)
        }
    }
}

/** Simple 2D point/vector. */
data class Vec2(val x: Double, val y: Double) {
    operator fun plus(o: Vec2) = Vec2(x + o.x, y + o.y)
    operator fun minus(o: Vec2) = Vec2(x - o.x, y - o.y)
    operator fun times(s: Double) = Vec2(x * s, y * s)
    fun length() = sqrt(x * x + y * y)
}
