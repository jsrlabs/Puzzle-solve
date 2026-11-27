package com.jsrlabs.puzzlesolve

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import com.jsrlabs.puzzlesolve.core.RgbImage
import kotlin.math.max
import kotlin.math.roundToInt

object ImageLoading {
    /**
     * Decodes a photo, applying its EXIF rotation and downscaling so the longest side is at most [maxDim].
     * The result is a software bitmap so its pixels can be read.
     */
    fun decode(context: Context, uri: Uri, maxDim: Int = 2400): Bitmap {
        val source = ImageDecoder.createSource(context.contentResolver, uri)
        return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val w = info.size.width
            val h = info.size.height
            val longest = max(w, h)
            if (longest > maxDim) {
                val s = maxDim.toFloat() / longest
                decoder.setTargetSize(max(1, (w * s).roundToInt()), max(1, (h * s).roundToInt()))
            }
        }
    }
}

/** Converts to the solver's platform-independent image type. */
fun Bitmap.toRgbImage(): RgbImage {
    val px = IntArray(width * height)
    getPixels(px, 0, width, 0, 0, width, height)
    return RgbImage(width, height, px)
}

/** Crop rectangle in normalized (0..1) image coordinates. */
data class NormRect(val left: Float = 0f, val top: Float = 0f, val right: Float = 1f, val bottom: Float = 1f) {
    val isFull get() = left <= 0f && top <= 0f && right >= 1f && bottom >= 1f

    fun applyTo(bitmap: Bitmap): Bitmap {
        if (isFull) return bitmap
        val x = (left * bitmap.width).roundToInt().coerceIn(0, bitmap.width - 1)
        val y = (top * bitmap.height).roundToInt().coerceIn(0, bitmap.height - 1)
        val w = ((right - left) * bitmap.width).roundToInt().coerceIn(1, bitmap.width - x)
        val h = ((bottom - top) * bitmap.height).roundToInt().coerceIn(1, bitmap.height - y)
        return Bitmap.createBitmap(bitmap, x, y, w, h)
    }
}
