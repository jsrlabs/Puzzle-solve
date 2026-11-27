package com.jsrlabs.puzzlesolve.core

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A loose piece found in the pieces photo. All coordinates are in the (possibly downscaled)
 * analysis image the segmenter was given.
 */
class SegmentedPiece(
    val id: Int,
    /** Bounding box of the piece mask. */
    val bboxX: Int, val bboxY: Int, val bboxW: Int, val bboxH: Int,
    /** Piece mask inside the bounding box (row-major, bboxW * bboxH). */
    val mask: BooleanArray,
    val area: Int,
    /** Center of the square "body" of the piece (ignoring knobs). */
    val center: Vec2,
    /** Side length of the square body, in pixels. */
    val bodySize: Double,
    /** Orientation of the body's sides, radians in (-PI/4, PI/4]. */
    val angle: Double,
) {
    fun inMask(x: Double, y: Double): Boolean {
        val ix = x.roundToInt() - bboxX
        val iy = y.roundToInt() - bboxY
        return ix in 0 until bboxW && iy in 0 until bboxH && mask[iy * bboxW + ix]
    }

    /** Unit vector along the body's first axis. */
    val axisU get() = Vec2(cos(angle), sin(angle))

    /** Unit vector along the body's second axis (axisU rotated +90 degrees in image coordinates). */
    val axisV get() = Vec2(-sin(angle), cos(angle))
}

class SegmentationResult(
    val pieces: List<SegmentedPiece>,
    /** Blobs that were much larger than a typical piece: probably several touching pieces. */
    val clumps: Int,
    /** Blobs that touched the photo border and were ignored. */
    val cutOff: Int,
)

/**
 * Finds individual puzzle pieces lying on a fairly uniform background.
 *
 * 1. Estimate the background color from the photo border.
 * 2. Threshold the color distance to the background (Otsu).
 * 3. Clean up with morphological close/open and fill holes.
 * 4. Connected components, filtered by size relative to the median piece.
 * 5. For each piece, estimate the orientation of the square body from the outline
 *    (4-fold symmetric angle average: round knobs cancel out, straight sides dominate)
 *    and measure the body extent from row/column occupancy profiles.
 */
class PieceSegmenter(private val params: SolverParams = SolverParams()) {

    fun segment(img: LabImage): SegmentationResult {
        val w = img.width
        val h = img.height
        val dist = backgroundDistance(img)
        var mask = threshold(dist, borderNoiseLevel(dist))
        val r = max(1, (min(w, h) / 400.0).roundToInt())
        mask = open(close(mask, w, h, r), w, h, r)
        mask = fillHoles(mask, w, h)
        return extractPieces(mask, w, h)
    }

    private fun backgroundDistance(img: LabImage): Plane {
        val w = img.width; val h = img.height
        val band = max(2, (min(w, h) * 0.02).roundToInt())
        val ls = ArrayList<Float>(); val as_ = ArrayList<Float>(); val bs = ArrayList<Float>()
        for (y in 0 until h) for (x in 0 until w) {
            if (x < band || y < band || x >= w - band || y >= h - band) {
                if ((x + y) % 3 != 0) continue // subsample
                val i = y * w + x
                ls += img.l.data[i]; as_ += img.a.data[i]; bs += img.b.data[i]
            }
        }
        val bgL = median(ls); val bgA = median(as_); val bgB = median(bs)
        val smooth = img.boxBlur(1)
        val out = Plane(w, h)
        for (i in 0 until w * h) {
            // Lightness differences are down-weighted: shadows and uneven lighting mostly change L.
            val dl = (smooth.l.data[i] - bgL) * 0.6f
            val da = smooth.a.data[i] - bgA
            val db = smooth.b.data[i] - bgB
            out.data[i] = sqrt(dl * dl + da * da + db * db)
        }
        return out
    }

    /** Distance level that background pixels (sampled at the photo border) rarely exceed. */
    private fun borderNoiseLevel(dist: Plane): Float {
        val w = dist.width; val h = dist.height
        val band = max(2, (min(w, h) * 0.02).roundToInt())
        val values = ArrayList<Float>()
        for (y in 0 until h) for (x in 0 until w) {
            if ((x < band || y < band || x >= w - band || y >= h - band) && (x + y) % 3 == 0) values += dist[x, y]
        }
        values.sort()
        return values[(values.size * 0.98).toInt().coerceAtMost(values.size - 1)]
    }

    private fun threshold(dist: Plane, noise: Float): BooleanArray {
        var maxV = 1f
        for (v in dist.data) if (v > maxV) maxV = v
        val bins = 256
        val hist = IntArray(bins)
        for (v in dist.data) hist[min(bins - 1, (v / maxV * (bins - 1)).toInt())]++
        val total = dist.data.size.toDouble()
        var sumAll = 0.0
        for (i in 0 until bins) sumAll += i * hist[i].toDouble()
        var wB = 0.0; var sumB = 0.0; var best = 0.0; var bestT = 0
        for (t in 0 until bins) {
            wB += hist[t]
            if (wB == 0.0) continue
            val wF = total - wB
            if (wF == 0.0) break
            sumB += t * hist[t].toDouble()
            val mB = sumB / wB; val mF = (sumAll - sumB) / wF
            val between = wB * wF * (mB - mF) * (mB - mF)
            if (between > best) { best = between; bestT = t }
        }
        val otsu = (bestT + 0.5f) / (bins - 1) * maxV
        // Otsu alone sits too high when some pieces are vivid and others are dull; a threshold just
        // above the background's own noise keeps dull pieces whole.
        val t = max(params.minBackgroundDistance, min(otsu, noise * 1.6f + 2f))
        return BooleanArray(dist.data.size) { dist.data[it] > t }
    }

    private fun boxCount(mask: BooleanArray, w: Int, h: Int, r: Int, op: (count: Int, full: Int) -> Boolean): BooleanArray {
        val p = Plane(w, h, FloatArray(w * h) { if (mask[it]) 1f else 0f })
        val ii = IntegralImage(p)
        val out = BooleanArray(w * h)
        for (y in 0 until h) {
            val y0 = max(0, y - r); val y1 = min(h - 1, y + r)
            for (x in 0 until w) {
                val x0 = max(0, x - r); val x1 = min(w - 1, x + r)
                val full = (x1 - x0 + 1) * (y1 - y0 + 1)
                out[y * w + x] = op((ii.sum(x0, y0, x1, y1) + 0.5).toInt(), full)
            }
        }
        return out
    }

    private fun dilate(m: BooleanArray, w: Int, h: Int, r: Int) = boxCount(m, w, h, r) { c, _ -> c > 0 }
    private fun erode(m: BooleanArray, w: Int, h: Int, r: Int) = boxCount(m, w, h, r) { c, full -> c == full }
    private fun close(m: BooleanArray, w: Int, h: Int, r: Int) = erode(dilate(m, w, h, r), w, h, r)
    private fun open(m: BooleanArray, w: Int, h: Int, r: Int) = dilate(erode(m, w, h, r), w, h, r)

    private fun fillHoles(mask: BooleanArray, w: Int, h: Int): BooleanArray {
        val outside = BooleanArray(w * h)
        val stack = IntArray(w * h)
        var sp = 0
        fun push(i: Int) {
            if (!mask[i] && !outside[i]) { outside[i] = true; stack[sp++] = i }
        }
        for (x in 0 until w) { push(x); push((h - 1) * w + x) }
        for (y in 0 until h) { push(y * w); push(y * w + w - 1) }
        while (sp > 0) {
            val i = stack[--sp]
            val x = i % w; val y = i / w
            if (x > 0) push(i - 1)
            if (x < w - 1) push(i + 1)
            if (y > 0) push(i - w)
            if (y < h - 1) push(i + w)
        }
        return BooleanArray(w * h) { !outside[it] }
    }

    private class Blob(val pixels: IntArray, val minX: Int, val minY: Int, val maxX: Int, val maxY: Int, val touchesBorder: Boolean)

    private fun extractPieces(mask: BooleanArray, w: Int, h: Int): SegmentationResult {
        val labels = IntArray(w * h) { -1 }
        val stack = IntArray(w * h)
        val blobs = ArrayList<Blob>()
        val minArea = max(30, (w * h * params.minPieceAreaFraction).toInt())
        for (start in 0 until w * h) {
            if (!mask[start] || labels[start] >= 0) continue
            val label = blobs.size
            var sp = 0; stack[sp++] = start; labels[start] = label
            val pix = ArrayList<Int>()
            var minX = w; var minY = h; var maxX = 0; var maxY = 0
            while (sp > 0) {
                val i = stack[--sp]
                pix += i
                val x = i % w; val y = i / w
                if (x < minX) minX = x; if (x > maxX) maxX = x
                if (y < minY) minY = y; if (y > maxY) maxY = y
                if (x > 0 && mask[i - 1] && labels[i - 1] < 0) { labels[i - 1] = label; stack[sp++] = i - 1 }
                if (x < w - 1 && mask[i + 1] && labels[i + 1] < 0) { labels[i + 1] = label; stack[sp++] = i + 1 }
                if (y > 0 && mask[i - w] && labels[i - w] < 0) { labels[i - w] = label; stack[sp++] = i - w }
                if (y < h - 1 && mask[i + w] && labels[i + w] < 0) { labels[i + w] = label; stack[sp++] = i + w }
            }
            val touches = minX == 0 || minY == 0 || maxX == w - 1 || maxY == h - 1
            // Keep a placeholder for tiny blobs so labels stay aligned with indices.
            blobs += if (pix.size >= minArea) Blob(pix.toIntArray(), minX, minY, maxX, maxY, touches)
            else Blob(IntArray(0), minX, minY, maxX, maxY, touches)
        }
        val candidates = blobs.filter { it.pixels.isNotEmpty() && !it.touchesBorder }
        val cutOff = blobs.count { it.pixels.isNotEmpty() && it.touchesBorder }
        if (candidates.isEmpty()) return SegmentationResult(emptyList(), 0, cutOff)
        val medianArea = median(candidates.map { it.pixels.size.toFloat() })
        var clumps = 0
        val pieces = ArrayList<SegmentedPiece>()
        for (blob in candidates) {
            val area = blob.pixels.size
            if (area > medianArea * params.maxPieceAreaRatio) { clumps++; continue }
            if (area < medianArea * params.minPieceAreaRatio) continue
            pieces += measurePiece(pieces.size, blob, w)
        }
        return SegmentationResult(pieces, clumps, cutOff)
    }

    private fun measurePiece(id: Int, blob: Blob, imgW: Int): SegmentedPiece {
        val pad = 3
        val bx = blob.minX - pad; val by = blob.minY - pad
        val bw = blob.maxX - blob.minX + 1 + 2 * pad; val bh = blob.maxY - blob.minY + 1 + 2 * pad
        val local = BooleanArray(bw * bh)
        var cx = 0.0; var cy = 0.0
        for (i in blob.pixels) {
            val x = i % imgW; val y = i / imgW
            local[(y - by) * bw + (x - bx)] = true
            cx += x; cy += y
        }
        cx /= blob.pixels.size; cy /= blob.pixels.size

        // Orientation: average of 4*theta over outline gradients. Straight sides at theta, theta+90,...
        // all map to the same 4*theta; round knobs spread uniformly and cancel.
        val soft = Plane(bw, bh, FloatArray(bw * bh) { if (local[it]) 1f else 0f }).boxBlur(2)
        var c4 = 0.0; var s4 = 0.0
        for (y in 1 until bh - 1) for (x in 1 until bw - 1) {
            val v = soft[x, y]
            if (v < 0.15f || v > 0.85f) continue
            val gx = (soft[x + 1, y] - soft[x - 1, y]).toDouble()
            val gy = (soft[x, y + 1] - soft[x, y - 1]).toDouble()
            val mag = sqrt(gx * gx + gy * gy)
            if (mag < 1e-6) continue
            val t = atan2(gy, gx)
            c4 += mag * cos(4 * t); s4 += mag * sin(4 * t)
        }
        var angle = atan2(s4, c4) / 4.0
        if (angle <= -PI / 4) angle += PI / 2

        // Body extent from occupancy profiles in the aligned frame.
        val cosA = cos(angle); val sinA = sin(angle)
        val extent = (sqrt((bw * bw + bh * bh).toDouble()) / 2 + 2).toInt()
        val n = 2 * extent + 1
        val histU = DoubleArray(n); val histV = DoubleArray(n)
        for (i in blob.pixels) {
            val dx = i % imgW - cx; val dy = i / imgW - cy
            val u = dx * cosA + dy * sinA
            val v = -dx * sinA + dy * cosA
            histU[(u.roundToInt() + extent).coerceIn(0, n - 1)] += 1.0
            histV[(v.roundToInt() + extent).coerceIn(0, n - 1)] += 1.0
        }
        val (u0, u1) = bodyRange(histU)
        val (v0, v1) = bodyRange(histV)
        val uc = (u0 + u1) / 2.0 - extent; val vc = (v0 + v1) / 2.0 - extent
        val size = ((u1 - u0 + 1) + (v1 - v0 + 1)) / 2.0
        val center = Vec2(cx + uc * cosA - vc * sinA, cy + uc * sinA + vc * cosA)
        return SegmentedPiece(id, bx, by, bw, bh, local, blob.pixels.size, center, size, angle)
    }

    /** First/last index where the smoothed profile reaches half of its maximum. */
    private fun bodyRange(hist: DoubleArray): Pair<Int, Int> {
        val n = hist.size
        val s = DoubleArray(n) { i -> (hist[max(0, i - 1)] + hist[i] + hist[min(n - 1, i + 1)]) / 3 }
        val peak = s.maxOrNull() ?: 0.0
        var first = 0; while (first < n - 1 && s[first] < peak * 0.5) first++
        var last = n - 1; while (last > first && s[last] < peak * 0.5) last--
        return first to last
    }

    companion object {
        fun median(values: List<Float>): Float {
            if (values.isEmpty()) return 0f
            val sorted = values.sorted()
            return sorted[sorted.size / 2]
        }
    }
}
