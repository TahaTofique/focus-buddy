/**
 * signals.js — Extended behavioral signals from face mesh landmarks.
 *
 * All computed from Human's 468-point face mesh (MediaPipe topology),
 * entirely client-side, frame-by-frame. Nothing here stores or exports
 * raw landmark coordinates — only the derived booleans below ever reach
 * db.js.
 *
 *   eyesClosed        — sustained eye closure (drowsy / not looking, not a blink)
 *   talking            — mouth opening/closing rhythmically (chatting, singing along)
 *   excessiveMovement  — head/face bouncing around a lot (fidgeting, dancing, restless)
 *
 * These are heuristics built on landmark geometry, not a trained
 * classifier — deliberately, so every threshold is visible and
 * explainable rather than a black box.
 */

// MediaPipe FaceMesh landmark indices (standard 468-point topology)
const LEFT_EYE = [362, 385, 387, 263, 373, 380];   // corner, top, top, corner, bottom, bottom
const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const MOUTH_TOP = 13;
const MOUTH_BOTTOM = 14;
const MOUTH_LEFT = 78;
const MOUTH_RIGHT = 308;

function dist(p, q) {
  const dx = p[0] - q[0];
  const dy = p[1] - q[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function eyeAspectRatio(mesh, indices) {
  const [p1, p2, p3, p4, p5, p6] = indices.map((i) => mesh[i]);
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return null;
  const vertical = dist(p2, p6) + dist(p3, p5);
  const horizontal = dist(p1, p4) * 2;
  if (horizontal === 0) return null;
  return vertical / horizontal;
}

function mouthAspectRatio(mesh) {
  const top = mesh[MOUTH_TOP];
  const bottom = mesh[MOUTH_BOTTOM];
  const left = mesh[MOUTH_LEFT];
  const right = mesh[MOUTH_RIGHT];
  if (!top || !bottom || !left || !right) return null;
  const horizontal = dist(left, right);
  if (horizontal === 0) return null;
  return dist(top, bottom) / horizontal;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

class SignalTracker {
  constructor({
    earThreshold = 0.21,
    eyesClosedMs = 600,
    marWindowMs = 1200,
    marTalkStddevThreshold = 0.018,
    movementWindowMs = 900,
    movementRatioThreshold = 0.32,
  } = {}) {
    this.earThreshold = earThreshold;
    this.eyesClosedMs = eyesClosedMs;
    this.marWindowMs = marWindowMs;
    this.marTalkStddevThreshold = marTalkStddevThreshold;
    this.movementWindowMs = movementWindowMs;
    this.movementRatioThreshold = movementRatioThreshold;

    this._eyesClosedSince = null;
    this._marHistory = [];      // [{ t, value }]
    this._centerHistory = [];   // [{ t, x, y, scale }]
  }

  reset() {
    this._eyesClosedSince = null;
    this._marHistory = [];
    this._centerHistory = [];
  }

  /**
   * @param {Array} mesh - face.mesh array of [x,y,z] points, or null
   * @param {Array} box - face.box [x,y,w,h], or null
   * @returns {{eyesClosed: boolean, talking: boolean, excessiveMovement: boolean, ear: number|null}}
   */
  update(mesh, box) {
    const now = Date.now();

    if (!mesh || !box) {
      this._eyesClosedSince = null;
      return { eyesClosed: false, talking: false, excessiveMovement: false, ear: null };
    }

    // --- Eye closure ---
    const earL = eyeAspectRatio(mesh, LEFT_EYE);
    const earR = eyeAspectRatio(mesh, RIGHT_EYE);
    const ear = earL !== null && earR !== null ? (earL + earR) / 2 : null;

    let eyesClosed = false;
    if (ear !== null) {
      if (ear < this.earThreshold) {
        if (this._eyesClosedSince === null) this._eyesClosedSince = now;
        eyesClosed = now - this._eyesClosedSince >= this.eyesClosedMs;
      } else {
        this._eyesClosedSince = null;
      }
    }

    // --- Talking (mouth-opening variance over a short window) ---
    const mar = mouthAspectRatio(mesh);
    if (mar !== null) {
      this._marHistory.push({ t: now, value: mar });
      this._marHistory = this._marHistory.filter((p) => now - p.t <= this.marWindowMs);
    }
    let talking = false;
    if (this._marHistory.length >= 6) {
      const sd = stddev(this._marHistory.map((p) => p.value));
      talking = sd > this.marTalkStddevThreshold;
    }

    // --- Excessive movement (face center bouncing around, e.g. dancing/fidgeting) ---
    const faceScale = Math.max(box[2], box[3]) || 1;
    const center = { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 };
    this._centerHistory.push({ t: now, x: center.x, y: center.y, scale: faceScale });
    this._centerHistory = this._centerHistory.filter((p) => now - p.t <= this.movementWindowMs);

    let excessiveMovement = false;
    if (this._centerHistory.length >= 6) {
      const xs = this._centerHistory.map((p) => p.x);
      const ys = this._centerHistory.map((p) => p.y);
      const rangeX = Math.max(...xs) - Math.min(...xs);
      const rangeY = Math.max(...ys) - Math.min(...ys);
      const range = Math.max(rangeX, rangeY);
      excessiveMovement = range / faceScale > this.movementRatioThreshold;
    }

    return { eyesClosed, talking, excessiveMovement, ear };
  }
}
