package com.jsrlabs.puzzlesolve.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.jsrlabs.puzzlesolve.NormRect
import com.jsrlabs.puzzlesolve.core.Vec2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Maps image pixel coordinates to canvas coordinates (and back). */
class ImageMapping(val scale: Float, val dx: Float, val dy: Float) {
    fun map(x: Double, y: Double) = Offset((x * scale + dx).toFloat(), (y * scale + dy).toFloat())
    fun map(v: Vec2) = map(v.x, v.y)
    fun unmap(o: Offset) = Offset((o.x - dx) / scale, (o.y - dy) / scale)
}

/**
 * Draws [bitmap] (or just its [source] region, in image pixels) scaled to fit the available width,
 * then lets [overlay] draw on top using image coordinates via the [ImageMapping].
 */
@Composable
fun FittedImage(
    bitmap: ImageBitmap,
    modifier: Modifier = Modifier,
    source: Rect? = null,
    maxHeight: Dp = 420.dp,
    canvasModifier: Modifier = Modifier,
    onMapping: ((ImageMapping) -> Unit)? = null,
    overlay: DrawScope.(ImageMapping) -> Unit = {},
) {
    val full = Rect(0f, 0f, bitmap.width.toFloat(), bitmap.height.toFloat())
    val src = (source ?: full).intersect(full).let { if (it.width < 1f || it.height < 1f) full else it }
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val ratio = src.width / src.height
        val height = minOf(maxWidth / ratio, maxHeight)
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(height)
                .clipToBounds()
                .then(canvasModifier)
        ) {
            val scale = min(size.width / src.width, size.height / src.height)
            val dw = src.width * scale
            val dh = src.height * scale
            val ox = (size.width - dw) / 2
            val oy = (size.height - dh) / 2
            drawImage(
                image = bitmap,
                srcOffset = IntOffset(src.left.roundToInt(), src.top.roundToInt()),
                srcSize = IntSize(src.width.roundToInt(), src.height.roundToInt()),
                dstOffset = IntOffset(ox.roundToInt(), oy.roundToInt()),
                dstSize = IntSize(dw.roundToInt(), dh.roundToInt()),
            )
            val mapping = ImageMapping(scale, ox - src.left * scale, oy - src.top * scale)
            onMapping?.invoke(mapping)
            overlay(mapping)
        }
    }
}

/** Shows the box photo with a draggable crop rectangle (drag corners, or drag inside to move it). */
@Composable
fun CropEditor(bitmap: ImageBitmap, crop: NormRect, onCropChange: (NormRect) -> Unit, modifier: Modifier = Modifier) {
    val currentCrop by rememberUpdatedState(crop)
    val currentOnChange by rememberUpdatedState(onCropChange)
    val mappingHolder = remember { arrayOfNulls<ImageMapping>(1) }
    val w = bitmap.width.toFloat()
    val h = bitmap.height.toFloat()

    FittedImage(
        bitmap = bitmap,
        modifier = modifier,
        maxHeight = 480.dp,
        onMapping = { mappingHolder[0] = it },
        canvasModifier = Modifier.pointerInput(bitmap) {
            // 0..3 = corner (TL, TR, BR, BL), 4 = move whole rect, -1 = nothing
            var handle = -1
            val touchRadius = 36.dp.toPx()
            detectDragGestures(
                onDragStart = { pos ->
                    val m = mappingHolder[0] ?: return@detectDragGestures
                    val c = currentCrop
                    val corners = listOf(
                        m.map((c.left * w).toDouble(), (c.top * h).toDouble()),
                        m.map((c.right * w).toDouble(), (c.top * h).toDouble()),
                        m.map((c.right * w).toDouble(), (c.bottom * h).toDouble()),
                        m.map((c.left * w).toDouble(), (c.bottom * h).toDouble()),
                    )
                    val nearest = corners.indices.minByOrNull { (corners[it] - pos).getDistance() }!!
                    handle = when {
                        (corners[nearest] - pos).getDistance() < touchRadius -> nearest
                        Rect(corners[0], corners[2]).contains(pos) -> 4
                        else -> -1
                    }
                },
                onDrag = { change, drag ->
                    val m = mappingHolder[0] ?: return@detectDragGestures
                    if (handle < 0) return@detectDragGestures
                    change.consume()
                    val ddx = drag.x / m.scale / w
                    val ddy = drag.y / m.scale / h
                    val c = currentCrop
                    val minSize = 0.1f
                    val next = when (handle) {
                        0 -> c.copy(left = (c.left + ddx).coerceIn(0f, c.right - minSize), top = (c.top + ddy).coerceIn(0f, c.bottom - minSize))
                        1 -> c.copy(right = (c.right + ddx).coerceIn(c.left + minSize, 1f), top = (c.top + ddy).coerceIn(0f, c.bottom - minSize))
                        2 -> c.copy(right = (c.right + ddx).coerceIn(c.left + minSize, 1f), bottom = (c.bottom + ddy).coerceIn(c.top + minSize, 1f))
                        3 -> c.copy(left = (c.left + ddx).coerceIn(0f, c.right - minSize), bottom = (c.bottom + ddy).coerceIn(c.top + minSize, 1f))
                        else -> {
                            val mx = ddx.coerceIn(-c.left, 1f - c.right)
                            val my = ddy.coerceIn(-c.top, 1f - c.bottom)
                            NormRect(c.left + mx, c.top + my, c.right + mx, c.bottom + my)
                        }
                    }
                    currentOnChange(next)
                },
                onDragEnd = { handle = -1 },
            )
        },
    ) { m ->
        val c = crop
        val tl = m.map((c.left * w).toDouble(), (c.top * h).toDouble())
        val br = m.map((c.right * w).toDouble(), (c.bottom * h).toDouble())
        val imgTl = m.map(0.0, 0.0)
        val imgBr = m.map(w.toDouble(), h.toDouble())
        val shade = Color.Black.copy(alpha = 0.55f)
        // Darken everything outside the crop.
        drawRect(shade, imgTl, Size(imgBr.x - imgTl.x, tl.y - imgTl.y))
        drawRect(shade, Offset(imgTl.x, br.y), Size(imgBr.x - imgTl.x, imgBr.y - br.y))
        drawRect(shade, Offset(imgTl.x, tl.y), Size(tl.x - imgTl.x, br.y - tl.y))
        drawRect(shade, Offset(br.x, tl.y), Size(imgBr.x - br.x, br.y - tl.y))
        drawRect(Color.White, tl, Size(br.x - tl.x, br.y - tl.y), style = Stroke(2.dp.toPx()))
        for (p in listOf(tl, Offset(br.x, tl.y), br, Offset(tl.x, br.y))) {
            drawCircle(Color.White, 9.dp.toPx(), p)
            drawCircle(Color.Black, 9.dp.toPx(), p, style = Stroke(1.5.dp.toPx()))
        }
    }
}

/** Outline polygon through image-space points. */
fun DrawScope.drawPolygon(points: List<Vec2>, m: ImageMapping, color: Color, width: Dp) {
    if (points.isEmpty()) return
    val path = Path()
    points.forEachIndexed { i, p ->
        val o = m.map(p)
        if (i == 0) path.moveTo(o.x, o.y) else path.lineTo(o.x, o.y)
    }
    path.close()
    drawPath(path, Color.Black.copy(alpha = 0.6f), style = Stroke(width.toPx() + 2.dp.toPx()))
    drawPath(path, color, style = Stroke(width.toPx()))
}

/** Arrow from [from] along direction [dir] (unit vector) of [length], all in image coordinates. */
fun DrawScope.drawArrow(from: Vec2, dir: Vec2, length: Double, m: ImageMapping, color: Color) {
    val tip = from + dir * length
    val a = m.map(from)
    val b = m.map(tip)
    val head = max(8.dp.toPx(), (length * m.scale * 0.3).toFloat())
    val ux = (b.x - a.x); val uy = (b.y - a.y)
    val len = max(1f, kotlin.math.sqrt(ux * ux + uy * uy))
    val nx = ux / len; val ny = uy / len
    val left = Offset(b.x - nx * head - ny * head * 0.6f, b.y - ny * head + nx * head * 0.6f)
    val right = Offset(b.x - nx * head + ny * head * 0.6f, b.y - ny * head - nx * head * 0.6f)
    for ((c, wdt) in listOf(Color.Black.copy(alpha = 0.6f) to 6.dp.toPx(), color to 3.dp.toPx())) {
        drawLine(c, a, b, wdt)
        drawLine(c, b, left, wdt)
        drawLine(c, b, right, wdt)
    }
}

/** Bounding rectangle (image coordinates) around points, grown by [pad] and clamped to the image. */
fun boundsOf(points: List<Vec2>, pad: Double, imgW: Int, imgH: Int, minAspect: Float = 0.75f): Rect {
    var l = points.minOf { it.x } - pad
    var t = points.minOf { it.y } - pad
    var r = points.maxOf { it.x } + pad
    var b = points.maxOf { it.y } + pad
    // Avoid very tall/skinny views.
    val w = r - l; val h = b - t
    if (w / h < minAspect) { val grow = (h * minAspect - w) / 2; l -= grow; r += grow }
    if (h / w < minAspect) { val grow = (w * minAspect - h) / 2; t -= grow; b += grow }
    return Rect(
        l.coerceAtLeast(0.0).toFloat(), t.coerceAtLeast(0.0).toFloat(),
        r.coerceAtMost(imgW.toDouble()).toFloat(), b.coerceAtMost(imgH.toDouble()).toFloat(),
    )
}
