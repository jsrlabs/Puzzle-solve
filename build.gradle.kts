// Plugin versions live in settings.gradle.kts (pluginManagement). Declaring them here with
// `apply false` loads them once in a shared classloader for all modules.
plugins {
    id("com.android.application") apply false
    id("org.jetbrains.kotlin.android") apply false
    id("org.jetbrains.kotlin.plugin.compose") apply false
    id("org.jetbrains.kotlin.jvm") apply false
}
