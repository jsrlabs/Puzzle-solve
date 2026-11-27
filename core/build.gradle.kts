import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    maxHeapSize = "2g"
    // Set PUZZLE_DEBUG_DIR=/some/dir to write visualizations of the synthetic test puzzles.
    environment("PUZZLE_DEBUG_DIR", System.getenv("PUZZLE_DEBUG_DIR") ?: "")
    testLogging { events("passed", "failed"); showStandardStreams = true }
}
