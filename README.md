# Puzzle Helper

A web app that helps you solve jigsaw puzzles. It runs entirely in the browser, on a phone or a computer. Photos are processed on your device and never uploaded.

You take two photos:

1. **The box picture**, which is the finished image.
2. **Your loose pieces**, spread out picture-side up.

The app finds two loose pieces that belong next to each other and tells you how to join them:

* It circles both pieces in your photo and labels them **A** and **B**.
* It draws an arrow on each piece showing which way is "up", and says how far to turn it.
* It says which side of A that B attaches to.
* It highlights the two spots in the box picture.

Tap **Joined! Next** to get another pair, or take a new photo of the remaining pieces.

## Getting good results

* Lay pieces on a plain surface that contrasts with them, such as a dark cloth or white paper. Pieces must not touch or overlap.
* Shoot from straight above in even light, without a flash.
* Crop the box photo to just the puzzle picture. Use **Adjust crop** to drag the corners.
* Enter the piece count printed on the box. If you know the exact layout (e.g. 40 x 25), enter the columns and rows.
* Each suggestion shows a confidence level. Low-confidence pairs are worth checking before you push them together.

## Web app (`web/`)

No build step and no dependencies: plain HTML, CSS and JavaScript modules.

| Path | What it is |
| --- | --- |
| `web/index.html`, `styles.css`, `src/app.js` | The UI: photo capture, crop editor, results with drawn overlays. |
| `web/src/worker.js` | Runs the solver in a Web Worker so the page stays responsive. |
| `web/src/engine/` | The solver (see "How the solver works" below). Pure JavaScript, no DOM, so it also runs in Node. |
| `web/test/` | Node tests that generate synthetic puzzles and check pieces land in the right place. |

**Run it locally.** The page uses module workers, so it must be served over HTTP; opening `index.html` as a file won't work:

```sh
cd web
npm start        # serves on http://localhost:8080 (or: python3 -m http.server 8080)
npm test         # solver tests (Node 20+)
```

To try it on your phone, open the page from a computer on the same network, or use the hosted version below. Browsers only allow the camera over HTTPS or `localhost`; the "Choose photo" button works anywhere.

**Hosting.** `.github/workflows/web.yml` runs the tests and publishes `web/` to GitHub Pages from the default branch. One-time setup: in the repository's Settings → Pages, set Source to "GitHub Actions". Any static host works too (Netlify, Cloudflare Pages, S3, …): upload the `web/` folder.

## Android app (paused)

`app/` (Android, Jetpack Compose) and `core/` (the same solver in Kotlin) came first. Work on them is paused in favor of the web app, and they may be out of date.

## Kotlin project layout

| Module | What it is |
| --- | --- |
| `core/` | The solver engine. It is pure Kotlin with no Android or Java APIs, and it has unit tests that run on synthetic puzzles. |
| `app/` | The Android app (Kotlin + Jetpack Compose). It handles the UI, the camera/gallery and drawing the overlays, and calls `core`. |

## How the solver works

The web engine (`web/src/engine/`) and the Kotlin `core/` implement the same algorithm.

1. **Find pieces** (`segmenter.js` / `PieceSegmenter`):
   * Estimate the background color from the photo border and threshold each pixel's color distance from it.
   * Clean up the mask, then split it into individual blobs. Blobs that are much larger than a typical piece are reported as touching pieces.
   * For each piece, work out the angle of its square body from the outline. Round knobs cancel out in a 4-fold angle average.
   * Measure the body's center and size, ignoring the knobs.
2. **Locate each piece in the box picture** (`locator.js` / `PieceLocator`):
   * Resample the box picture so every puzzle cell is 16 px.
   * Sample a 12x12 grid of Lab colors from each piece's body.
   * Compare those samples against every position in the box picture, in all four 90° orientations.
   * A rotation-independent mean-color prefilter keeps this fast.
   * Run two passes. The second pass uses a color correction fitted on the first pass's confident matches, which compensates for lighting differences.
   * Confidence is how much better the best location is than the runner-up.
3. **Suggest pairs** (`solver.js` / `PuzzleSolver`): find loose pieces whose locations are adjacent cells, and rank them by the lower of the two confidences.

## Building the Android app (paused)

* **Android app:** open the project in Android Studio, or run `./gradlew :app:assembleDebug`. Requirements are the Android SDK (API 35) and JDK 17+. The app needs Android 9 or later.
* **Engine tests only (no Android SDK needed):** run `cd core && ../gradlew test`. To write debug images of the synthetic test puzzles, set `PUZZLE_DEBUG_DIR=/some/dir`.
* **CI:** GitHub Actions (`.github/workflows/android.yml`) runs the engine tests and builds a debug APK. You can download the APK from the workflow run's artifacts.

## Limitations / ideas

* It assumes a roughly rectangular grid of similar-sized pieces. Irregular (whimsy) cuts won't map well.
* Large areas of flat color, such as sky, are inherently ambiguous. Their suggestions get low confidence.
* Possible next steps:
  * Detect edge pieces from their flat sides.
  * Use the shape of the knobs to confirm that two pieces fit.
  * Support photos of the partly built puzzle, to suggest pieces that attach to it.
