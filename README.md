# Puzzle Helper

A web app that helps you solve jigsaw puzzles. It runs entirely in the browser, on a phone or a computer. Photos are processed on your device and never uploaded.

You take two photos:

1. **The box picture.** It doesn't have to be straight: the app finds the picture on the box (ignoring the frame
   and background) and straightens it. You can adjust the four corners if needed.
2. **Your table**: loose pieces spread picture-side up, and the puzzle you've started if you have one.

If the started puzzle (for example the border) is in the photo, the app recognises it:

* It lines the box picture up with what's assembled and marks those pieces as already placed.
* It measures the real layout from it (e.g. 38 × 27 for a "1000 piece" puzzle).
* It ignores the assembled pieces when looking for loose ones.

Then it tells you which **one piece** to place next:

* When your board is empty, it starts with a **corner** piece.
* After that, every suggested piece **connects to a piece already on your board**.
* It shows a **composite image**: your board, with placed areas tinted and the rest dimmed, next to the photo of your table. A big arrow runs from the piece to its spot. When the started puzzle is in the photo, the arrow points at the real spot on it.
* An arrow drawn on the piece shows which way is "up" (the top of your puzzle), and the text says how far to turn it.
* Close-ups show the piece and where it goes, both in the box picture and on your table. **Save image** shares or downloads the composite.

Photos are analysed at full resolution (up to 4096 px), in sections: the app first looks at a reduced copy of the whole photo (to find your board and the layout), then scans the busiest part of the table at full detail and shows the first good piece as soon as it has one. When you run out of suggestions it automatically looks at the next part of the photo; **Look at the rest of the photo** does that on request.

Tap **Placed it! Next** for the next piece. When none of the loose pieces connect any more, take a new photo; your board progress is kept. You can fix the app's idea of what is placed with **Mark pieces already placed**.

### Reporting a wrong suggestion

**Report a problem with this suggestion** (under the Placed / Skip buttons) makes a report about the current suggestion and opens a new issue on this repository.

The report holds the numbers behind the suggestion, plus small pictures:
* the piece;
* where it was sent in the box picture, and the whole box picture with that spot marked;
* the same spot on your table.

The pictures are base64 text, so they can be read from a private repository. Paste the report as the issue description and submit; the app copies it to the clipboard first.

A scheduled check picks up new `[Puzzle report]` issues, diagnoses them and comments on the issue. To unpack a report yourself, save the issue text to a file and run `node tools/decode-report.mjs report.md out/`.

## Getting good results

* Use a plain mat or cloth that contrasts with the pieces. A black puzzle mat works well.
* Spread the pieces so they don't touch or overlap. Pieces lying on top of each other, or off the mat, are skipped.
* Shoot from straight above in even light, without a flash, with the whole mat in the frame.
* Enter the piece count printed on the box. If the app gets the layout wrong, enter the exact columns and rows.
* Each suggestion shows a confidence level. Low-confidence suggestions are worth checking before you press the piece in.

## Web app (`web/`)

No build step and no dependencies: plain HTML, CSS and JavaScript modules.

| Path | What it is |
| --- | --- |
| `web/index.html`, `styles.css`, `src/app.js` | The UI: photo capture, crop editor, results with drawn overlays. |
| `web/src/worker.js` | Runs the solver in a Web Worker so the page stays responsive. |
| `web/src/engine/` | The solver and the next-piece planner (see "How the solver works" below). Pure JavaScript, no DOM, so it also runs in Node. |
| `web/test/` | Node tests: synthetic puzzles (pieces land in the right place, a simulated placing session), plus real photos from `testdata/`. |
| `testdata/` | Real photos used by the tests: a box shot at an angle, and a table with the border assembled. Kept outside `web/` so they aren't published with the site. |

**Matching benchmark.** `npm run bench` treats each piece of the assembled border in the real test photo as if it were loose and counts how often the matcher puts it back in its own cell. Pieces whose spot isn't visible in the box art (under the title banner, or past the edge of the box art) don't count. `WITH_CV=1 npm run bench` adds OpenCV.js template matching for comparison: it was a little more accurate (87% vs 82% at the time) but about 9× slower, plus a 10 MB download, so the app doesn't use it. The answer key comes from the app's own board alignment, so treat the numbers as relative.

**Run it locally.** The page uses module workers, so it must be served over HTTP; opening `index.html` as a file won't work:

```sh
cd web
npm start        # serves on http://localhost:8080 (or: python3 -m http.server 8080)
npm ci           # once: installs the JPEG decoder the tests use
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

The web engine (`web/src/engine/`) is described here. The Kotlin `core/` implements an earlier version (steps 1–3, without
box straightening or board detection).

0. **Straighten the box picture** (`quad.js`, `geometry.js`):
   * Find long straight edges with a restricted Hough transform.
   * Try candidate quadrilaterals made from those edges. Keep the one whose sides lie on real edges, with a plain strip just outside (the frame) and a busier strip inside (the picture). Robust medians mean a banner or logo over the frame doesn't matter.
   * Warp it to a rectangle with a homography.

1. **Find pieces** (`segmenter.js`):
   * The background is the most common color in the photo (the mat), not the photo border, which is often the table.
   * Threshold each pixel's color distance from it, and remove thin printed mat lines.
   * Separate touching pieces with a distance-transform watershed (one seed per piece body), then merge over-split fragments.
   * Anything connected to the photo edge (table, floor) is ignored.
   * For each piece, work out the angle of its square body from the outline. Round knobs cancel out in a 4-fold angle average.
   * Measure the body's center and size, ignoring the knobs.
2. **Locate each piece in the box picture** (`locator.js`). A coarse search over the whole picture nominates the 25 best spots; a second look at three times the detail decides between them:
   * Resample the box picture so every puzzle cell is 16 px.
   * Sample a 12x12 grid of Lab colors from each piece's body.
   * Compare those samples against every position in the box picture, in all four 90° orientations.
   * A rotation-independent mean-color prefilter keeps this fast.
   * Run two passes. The second pass uses a color correction fitted on the first pass's confident matches, which compensates for lighting differences.
   * Confidence is how much better the best location is than the runner-up.
2b. **Find the started puzzle** (`board.js`):
   * The assembled part is the table photo's best "picture quadrilateral" (same detector as for the box).
   * The box picture is aligned to it in each possible rotation: a scale/shift registration (box art is often cropped a little differently from the real puzzle), then a fine-tuning of the four corners.
   * Cells whose content matches are marked placed, rejecting cells that show bare mat. Isolated matches are dropped and small gaps along the edge are filled.
   * The colour correction for loose pieces is fitted on these cells.
   * The layout (columns × rows) is measured from the board's size in piece widths.
3. **Choose the next piece** (web: `planner.js`): among loose pieces whose cell is free and next to a placed cell, pick the most confident match, with a bonus for touching several placed pieces. When nothing connects, pick the most confident corner piece. (The Kotlin `PuzzleSolver` instead suggests pairs of loose pieces to join.)

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
