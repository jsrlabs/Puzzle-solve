package com.jsrlabs.puzzlesolve

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.lifecycle.viewmodel.compose.viewModel
import com.jsrlabs.puzzlesolve.ui.PuzzleTheme
import com.jsrlabs.puzzlesolve.ui.ResultScreen
import com.jsrlabs.puzzlesolve.ui.SetupScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            PuzzleTheme {
                PuzzleApp()
            }
        }
    }
}

@Composable
fun PuzzleApp(vm: PuzzleViewModel = viewModel()) {
    when (vm.screen) {
        Screen.SETUP -> SetupScreen(vm)
        Screen.RESULT -> {
            BackHandler { vm.screen = Screen.SETUP }
            ResultScreen(vm)
        }
    }
}
