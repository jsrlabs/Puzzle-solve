// Runs the solver off the main thread so the page stays responsive.
import { RgbaImage } from './engine/images.js';
import { analyze } from './engine/solver.js';

self.onmessage = (e) => {
  const { id, box, pieces, grid } = e.data;
  let lastPost = 0;
  try {
    const result = analyze(
      new RgbaImage(box.width, box.height, box.data),
      new RgbaImage(pieces.width, pieces.height, pieces.data),
      grid,
      (fraction, message) => {
        const now = Date.now();
        if (now - lastPost > 50 || fraction >= 1) {
          lastPost = now;
          self.postMessage({ id, type: 'progress', fraction, message });
        }
      },
    );
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message ?? err) });
  }
};
