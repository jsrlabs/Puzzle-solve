// Runs the solver off the main thread so the page stays responsive. Keeps the prepared session, so the app
// can ask it to look at more sections of the photo later ("more") without starting over.
import { RgbaImage } from './engine/images.js';
import { prepare, scan } from './engine/solver.js';

let session = null;

self.onmessage = (e) => {
  const msg = e.data;
  let lastPost = 0;
  const progress = (from, to) => (fraction, message) => {
    const now = Date.now();
    if (now - lastPost > 50 || fraction >= 1) {
      lastPost = now;
      self.postMessage({ id: msg.id, type: 'progress', fraction: from + (to - from) * fraction, message });
    }
  };
  try {
    if (msg.type === 'start') {
      session = null;
      session = prepare(
        new RgbaImage(msg.box.width, msg.box.height, msg.box.data),
        new RgbaImage(msg.pieces.width, msg.pieces.height, msg.pieces.data),
        msg.grid,
        progress(0, 0.6),
      );
      const result = scan(session, { placed: msg.placed, excluded: msg.excluded }, progress(0.6, 1));
      self.postMessage({ id: msg.id, type: 'result', kind: 'start', result });
    } else if (msg.type === 'more') {
      if (!session) throw new Error('Nothing to continue: analyse the photos first.');
      const result = scan(session, { placed: msg.placed, excluded: msg.excluded }, progress(0, 1));
      self.postMessage({ id: msg.id, type: 'result', kind: 'more', result });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, type: 'error', message: String(err?.message ?? err) });
  }
};
