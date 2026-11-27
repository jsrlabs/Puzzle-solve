package com.jsrlabs.puzzlesolve

import android.app.Application
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.jsrlabs.puzzlesolve.core.Analysis
import com.jsrlabs.puzzlesolve.core.GridSpec
import com.jsrlabs.puzzlesolve.core.PairSuggestion
import com.jsrlabs.puzzlesolve.core.PuzzleSolver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

enum class ImageSlot { BOX, PIECES }
enum class Screen { SETUP, RESULT }

data class Progress(val fraction: Float, val message: String)

class PuzzleViewModel(app: Application) : AndroidViewModel(app) {

    var screen by mutableStateOf(Screen.SETUP)

    var boxBitmap by mutableStateOf<Bitmap?>(null)
        private set
    var boxCrop by mutableStateOf(NormRect())
    var piecesBitmap by mutableStateOf<Bitmap?>(null)
        private set

    var pieceCountText by mutableStateOf("500")
    var colsText by mutableStateOf("")
    var rowsText by mutableStateOf("")

    /** The (cropped) box picture the current analysis refers to. */
    var analyzedBox by mutableStateOf<Bitmap?>(null)
        private set
    var analysis by mutableStateOf<Analysis?>(null)
        private set

    private val _progress = MutableStateFlow<Progress?>(null)
    val progress: StateFlow<Progress?> = _progress

    var error by mutableStateOf<String?>(null)

    /** Pieces the user has already joined (they are no longer where the photo shows them). */
    val usedPieces = mutableStateListOf<Int>()
    /** Suggestions the user skipped, as (anchorId, moverId). */
    val skipped = mutableStateListOf<Pair<Int, Int>>()

    private var job: Job? = null

    val currentSuggestion: PairSuggestion?
        get() = remainingSuggestions.firstOrNull()

    val remainingSuggestions: List<PairSuggestion>
        get() = analysis?.suggestions.orEmpty().filter {
            it.anchor.id !in usedPieces && it.mover.id !in usedPieces && (it.anchor.id to it.mover.id) !in skipped
        }

    /** A content:// Uri the camera app can write a new photo to. */
    fun newCaptureUri(): Uri {
        val app = getApplication<Application>()
        val dir = File(app.cacheDir, "captures").apply { mkdirs() }
        // Keep the cache small: only the latest few photos are needed.
        dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(4)?.forEach { it.delete() }
        val file = File(dir, "photo_${System.currentTimeMillis()}.jpg")
        return FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
    }

    fun loadImage(slot: ImageSlot, uri: Uri) {
        viewModelScope.launch {
            try {
                val bmp = withContext(Dispatchers.IO) { ImageLoading.decode(getApplication(), uri) }
                when (slot) {
                    ImageSlot.BOX -> { boxBitmap = bmp; boxCrop = NormRect() }
                    ImageSlot.PIECES -> piecesBitmap = bmp
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = "Could not open that picture: ${e.message ?: e.javaClass.simpleName}"
            }
        }
    }

    /** The grid that will be used, or null if the piece count / box picture is missing. */
    fun resolveGrid(): GridSpec? {
        val cols = colsText.trim().toIntOrNull()
        val rows = rowsText.trim().toIntOrNull()
        if (cols != null && rows != null && cols > 0 && rows > 0) return GridSpec(cols, rows)
        val count = pieceCountText.trim().toIntOrNull() ?: return null
        if (count < 4) return null
        val box = boxBitmap ?: return null
        val aspect = (box.width * (boxCrop.right - boxCrop.left)) / (box.height * (boxCrop.bottom - boxCrop.top))
        return GridSpec.fromPieceCount(count, aspect.toDouble())
    }

    fun analyze() {
        val box = boxBitmap ?: return
        val pieces = piecesBitmap ?: return
        val grid = resolveGrid() ?: run { error = "Enter the number of pieces (it's printed on the box)."; return }
        val crop = boxCrop
        job?.cancel()
        _progress.value = Progress(0f, "Starting")
        job = viewModelScope.launch {
            try {
                val (cropped, result) = withContext(Dispatchers.Default) {
                    val cropped = crop.applyTo(box)
                    val result = PuzzleSolver().analyze(cropped.toRgbImage(), pieces.toRgbImage(), grid) { f, msg ->
                        _progress.value = Progress(f.toFloat(), msg)
                    }
                    cropped to result
                }
                analyzedBox = cropped
                analysis = result
                usedPieces.clear()
                skipped.clear()
                screen = Screen.RESULT
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                error = "Analysis failed: ${e.message ?: e.javaClass.simpleName}"
            } finally {
                _progress.value = null
            }
        }
    }

    fun cancelAnalysis() {
        job?.cancel()
        _progress.value = null
    }

    /** The user joined the current pair. */
    fun markJoined(s: PairSuggestion) {
        usedPieces += s.anchor.id
        usedPieces += s.mover.id
    }

    fun skip(s: PairSuggestion) {
        skipped += s.anchor.id to s.mover.id
    }

    /** Go back to take a fresh photo of the remaining loose pieces, keeping the box picture. */
    fun retakePieces() {
        piecesBitmap = null
        analysis = null
        screen = Screen.SETUP
    }
}
