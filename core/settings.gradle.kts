// Lets the engine be built and tested on its own, without the Android SDK:
//   cd core && ../gradlew test
// When building from the repository root this file is ignored and :core is part of the full build.
pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("org.jetbrains.kotlin.jvm") version "2.0.21"
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "puzzlesolve-core"
