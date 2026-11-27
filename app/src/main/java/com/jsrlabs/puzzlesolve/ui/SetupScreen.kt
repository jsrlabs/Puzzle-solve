package com.jsrlabs.puzzlesolve.ui

import android.content.ActivityNotFoundException
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.jsrlabs.puzzlesolve.ImageSlot
import com.jsrlabs.puzzlesolve.NormRect
import com.jsrlabs.puzzlesolve.PuzzleViewModel

@Composable
fun SetupScreen(vm: PuzzleViewModel) {
    var pendingSlot by rememberSaveable { mutableStateOf<ImageSlot?>(null) }
    var pendingUri by rememberSaveable { mutableStateOf<Uri?>(null) }
    var editingCrop by rememberSaveable { mutableStateOf(false) }
    val progress by vm.progress.collectAsState()

    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = pendingUri
        val slot = pendingSlot
        if (ok && uri != null && slot != null) vm.loadImage(slot, uri)
    }
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val slot = pendingSlot
        if (uri != null && slot != null) vm.loadImage(slot, uri)
    }
    fun capture(slot: ImageSlot) {
        pendingSlot = slot
        val uri = vm.newCaptureUri()
        pendingUri = uri
        try {
            takePicture.launch(uri)
        } catch (e: ActivityNotFoundException) {
            vm.error = "No camera app found. Use \"Choose photo\" instead."
        }
    }
    fun pick(slot: ImageSlot) {
        pendingSlot = slot
        pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Puzzle Helper", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text(
                "Photograph the box picture and your loose pieces. The app finds two loose pieces that belong next to each other and shows you how to join them.",
                style = MaterialTheme.typography.bodyMedium,
            )

            StepCard(
                title = "1. The box picture",
                hint = "Photograph the picture on the box from straight on, filling the frame. Then adjust the crop so only the puzzle picture is inside.",
                bitmap = vm.boxBitmap,
                onCamera = { capture(ImageSlot.BOX) },
                onGallery = { pick(ImageSlot.BOX) },
            ) { bmp ->
                if (editingCrop) {
                    CropEditor(bmp.asImageBitmap(), vm.boxCrop, onCropChange = { vm.boxCrop = it })
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { editingCrop = false }) { Text("Done") }
                        TextButton(onClick = { vm.boxCrop = NormRect() }) { Text("Reset") }
                    }
                } else {
                    val cropped = remember(bmp, vm.boxCrop) { vm.boxCrop.applyTo(bmp).asImageBitmap() }
                    FittedImage(cropped, maxHeight = 260.dp)
                    OutlinedButton(onClick = { editingCrop = true }) { Text("Adjust crop") }
                }
            }

            StepCard(
                title = "2. The loose pieces",
                hint = "Spread pieces picture-side up on a plain surface that contrasts with them (a dark cloth or a sheet of paper). Make sure no pieces touch, and photograph from straight above in good light.",
                bitmap = vm.piecesBitmap,
                onCamera = { capture(ImageSlot.PIECES) },
                onGallery = { pick(ImageSlot.PIECES) },
            ) { bmp ->
                val img = remember(bmp) { bmp.asImageBitmap() }
                FittedImage(img, maxHeight = 260.dp)
            }

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("3. Puzzle size", style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(
                        value = vm.pieceCountText,
                        onValueChange = { vm.pieceCountText = it.filter(Char::isDigit).take(5) },
                        label = { Text("Number of pieces") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("Optional: exact layout, if you know it", style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = vm.colsText,
                            onValueChange = { vm.colsText = it.filter(Char::isDigit).take(3) },
                            label = { Text("Columns") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.weight(1f),
                        )
                        OutlinedTextField(
                            value = vm.rowsText,
                            onValueChange = { vm.rowsText = it.filter(Char::isDigit).take(3) },
                            label = { Text("Rows") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.weight(1f),
                        )
                    }
                    val grid = vm.resolveGrid()
                    Text(
                        if (grid != null) "Using ${grid.cols} columns x ${grid.rows} rows (${grid.count} pieces)."
                        else "Add the box picture and the piece count to work out the layout.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            val p = progress
            if (p != null) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(p.message)
                    LinearProgressIndicator(progress = { p.fraction }, modifier = Modifier.fillMaxWidth())
                    TextButton(onClick = vm::cancelAnalysis) { Text("Cancel") }
                }
            } else {
                Button(
                    onClick = vm::analyze,
                    enabled = vm.boxBitmap != null && vm.piecesBitmap != null && vm.resolveGrid() != null,
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) { Text("Find a matching pair") }
                if (vm.analysis != null) {
                    OutlinedButton(onClick = { vm.screen = com.jsrlabs.puzzlesolve.Screen.RESULT }, modifier = Modifier.fillMaxWidth()) {
                        Text("Back to suggestions")
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    vm.error?.let { msg ->
        AlertDialog(
            onDismissRequest = { vm.error = null },
            confirmButton = { TextButton(onClick = { vm.error = null }) { Text("OK") } },
            title = { Text("Something went wrong") },
            text = { Text(msg) },
        )
    }
}

@Composable
private fun StepCard(
    title: String,
    hint: String,
    bitmap: Bitmap?,
    onCamera: () -> Unit,
    onGallery: () -> Unit,
    preview: @Composable (Bitmap) -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(hint, style = MaterialTheme.typography.bodySmall)
            if (bitmap != null) preview(bitmap)
            Row {
                Button(onClick = onCamera) { Text(if (bitmap == null) "Take photo" else "Retake") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(onClick = onGallery) { Text("Choose photo") }
            }
        }
    }
}
