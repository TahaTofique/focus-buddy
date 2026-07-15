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
 * Accuracy layers, in order of impact:
 *   1. CALIBRATION — per-user baseline (see app.js runCalibration + the
 *      trimmed-mean logic there) instead of one generic threshold.
 *   2. SMOOTHING — EMA on raw EAR to kill frame-to-frame landmark jitter
 *      before it's ever compared to a threshold.
 *   3. HYSTERESIS — every signal below now requires a short sustained
 *      streak (not just one qualifying frame) before it flips true, and
 *      a streak of good frames before it clears. This is what kills
 *      single-frame false positives like a passing hand or a stray
 *      lighting flicker triggering "phone" or "talking" for one tick.
 *   4. SHAPE, not just amount — movement is no longer "did it move a
 *      lot", it's "did it move a lot *and* reverse direction repeatedly"
 *      (oscillation counting), which is what actually distinguishes
 *      fidgeting/dancing from a single calm shift in seating position.
 *
 * These remain heuristics built on landmark geometry, not a trained
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

/** Robust average that trims the lowest fraction of samples — used for
 * EAR baselines specifically, since a blink during calibration drags a
 * plain mean down and makes the "eyes closed" threshold too lenient. */
function trimmedMeanLow(arr, trimFraction = 0.35) {
  if (arr.length < 3) return arr.reduce((a, b) => a + b, 0) / arr.length;
  const sorted = [...arr].sort((a, b) => a - b);
  const start = Math.floor(sorted.length * trimFraction);
  const trimmed = sorted.slice(start);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

/** Hysteresis helper: needs `onStreak` consecutive true-frames to turn
 * on, `offStreak` consecutive false-frames to turn off. Everything in
 * between holds its last state, which is exactly what stops one noisy
 * frame from toggling a badge. */
class Hysteresis {
  constructor(onStreak = 3, offStreak = 2) {
    this.onStreak = onStreak;
    this.offStreak = offStreak;
    this._on = 0;
    this._off = 0;
    this.state = false;
  }
  update(raw) {
    if (raw) {
      this._on++;
      this._off = 0;
      if (this._on >= this.onStreak) this.state = true;
    } else {
      this._off++;
      this._on = 0;
      if (this._off >= this.offStreak) this.state = false;
    }
    return this.state;
  }
  reset() {
    this._on = 0;
    this._off = 0;
    this.state = false;
  }
}

class SignalTracker {
  constructor({
    // Fallback generic thresholds, used only when no calibration is
    // available (calibration overrides these — see applyCalibration()).
    earThreshold = 0.21,
    eyesClosedMs = 450,
    marWindowMs = 1200,
    marTalkStddevThreshold = 0.018,
    movementWindowMs = 1000,
    movementRatioThreshold = 0.38,
    minOscillations = 3,          // direction reversals required within window
    earSmoothingAlpha = 0.4,      // lower = smoother/slower, higher = more responsive
    talkHysteresis = [3, 2],      // [onStreak, offStreak] in evaluation ticks
    movementHysteresis = [3, 2],
  } = {}) {
    this.earThreshold = earThreshold;
    this.eyesClosedMs = eyesClosedMs;
    this.marWindowMs = marWindowMs;
    this.marTalkStddevThreshold = marTalkStddevThreshold;
    this.movementWindowMs = movementWindowMs;
    this.movementRatioThreshold = movementRatioThreshold;
    this.minOscillations = minOscillations;
    this.earSmoothingAlpha = earSmoothingAlpha;

    this._eyesClosedSince = null;
    this._marHistory = [];      // [{ t, value }]
    this._centerHistory = [];   // [{ t, x, y }]
    this._earEMA = null;
    this._talkHyst = new Hysteresis(...talkHysteresis);
    this._moveHyst = new Hysteresis(...movementHysteresis);
  }

  /**
   * Apply per-user calibration measured during a short baseline capture.
   * @param {{ ear: number, marNoise: number }} calibration
   */
  applyCalibration(calibration) {
    if (!calibration) return;
    if (calibration.ear) {
      // Eyes are "closed" once EAR drops to ~72% of this user's own
      // natural open-eye value — far more precise than a fixed constant,
      // since resting EAR varies a lot with eye shape and camera angle.
      // The baseline itself is a trimmed mean (see trimmedMeanLow) so a
      // blink during calibration doesn't drag the threshold down.
      this.earThreshold = calibration.ear * 0.72;
    }
    if (calibration.marNoise !== undefined && calibration.marNoise !== null) {
      // Talking threshold must clear this user's natural landmark-jitter
      // noise floor at rest, or a shaky webcam feed causes false positives.
      this.marTalkStddevThreshold = Math.max(0.014, calibration.marNoise * 3.2);
    }
  }

  reset() {
    this._eyesClosedSince = null;
    this._marHistory = [];
    this._centerHistory = [];
    this._earEMA = null;
    this._talkHyst.reset();
    this._moveHyst.reset();
  }

  /**
   * @param {Array} mesh - face.mesh array of [x,y,z] points, or null
   * @param {Array} box - face.box [x,y,w,h], or null
   * @returns {{eyesClosed: boolean, talking: boolean, excessiveMovement: boolean, ear: number|null, mar: number|null}}
   */
  update(mesh, box) {
    const now = Date.now();

    if (!mesh || !box) {
      this._eyesClosedSince = null;
      this._earEMA = null;
      return { eyesClosed: false, talking: false, excessiveMovement: false, ear: null, mar: null };
    }

    // --- Eye closure (EMA-smoothed EAR + sustained-duration check) ---
    const earL = eyeAspectRatio(mesh, LEFT_EYE);
    const earR = eyeAspectRatio(mesh, RIGHT_EYE);
    const earRaw = earL !== null && earR !== null ? (earL + earR) / 2 : null;

    let ear = earRaw;
    if (earRaw !== null) {
      this._earEMA = this._earEMA === null
        ? earRaw
        : this.earSmoothingAlpha * earRaw + (1 - this.earSmoothingAlpha) * this._earEMA;
      ear = this._earEMA;
    }

    let eyesClosed = false;
    if (ear !== null) {
      if (ear < this.earThreshold) {
        if (this._eyesClosedSince === null) this._eyesClosedSince = now;
        eyesClosed = now - this._eyesClosedSince >= this.eyesClosedMs;
      } else {
        this._eyesClosedSince = null;
      }
    }

    // --- Talking (mouth-opening variance over a short window, + hysteresis) ---
    const mar = mouthAspectRatio(mesh);
    if (mar !== null) {
      this._marHistory.push({ t: now, value: mar });
      this._marHistory = this._marHistory.filter((p) => now - p.t <= this.marWindowMs);
    }
    let rawTalking = false;
    if (this._marHistory.length >= 6) {
      const sd = stddev(this._marHistory.map((p) => p.value));
      rawTalking = sd > this.marTalkStddevThreshold;
    }
    const talking = this._talkHyst.update(rawTalking);

    // --- Excessive movement: range AND oscillation count, + hysteresis ---
    const faceScale = Math.max(box[2], box[3]) || 1;
    const center = { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 };
    this._centerHistory.push({ t: now, x: center.x, y: center.y });
    this._centerHistory = this._centerHistory.filter((p) => now - p.t <= this.movementWindowMs);

    let rawMovement = false;
    if (this._centerHistory.length >= 6) {
      const xs = this._centerHistory.map((p) => p.x);
      const ys = this._centerHistory.map((p) => p.y);
      const rangeX = Math.max(...xs) - Math.min(...xs);
      const rangeY = Math.max(...ys) - Math.min(...ys);
      const range = Math.max(rangeX, rangeY);

      // Count direction reversals in x (dominant sway axis for
      // fidgeting/dancing) — a single steady drift across the window
      // has ~0 reversals; genuine restlessness has several.
      let reversals = 0;
      let prevSign = 0;
      for (let i = 1; i < xs.length; i++) {
        const d = xs[i] - xs[i - 1];
        const sign = d > 0.5 ? 1 : d < -0.5 ? -1 : 0;
        if (sign !== 0 && prevSign !== 0 && sign !== prevSign) reversals++;
        if (sign !== 0) prevSign = sign;
      }

      rawMovement = (range / faceScale > this.movementRatioThreshold) && (reversals >= this.minOscillations);
    }
    const excessiveMovement = this._moveHyst.update(rawMovement);

    return { eyesClosed, talking, excessiveMovement, ear, mar };
  }
}
