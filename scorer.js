/**
 * scorer.js — Rolling 0-100 focus score from raw per-frame signals.
 *
 * Same explainable weighting as the Python version (no black box):
 *   - face present is the baseline requirement
 *   - looking_at_screen sustains the score
 *   - phone_detected sharply penalizes, decaying slowly so a single
 *     pickup doesn't get erased by the next good frame
 */

class FocusScorer {
  constructor({ windowSize = 30, phonePenalty = 35, penaltyDecay = 2 } = {}) {
    this.windowSize = windowSize;
    this.window = [];
    this.phonePenalty = phonePenalty;
    this.penaltyDecay = penaltyDecay;
    this.activePenalty = 0;
    this.score = 100;
  }

  update(facePresent, lookingAtScreen, phoneDetected) {
    let frameValue;
    if (!facePresent) frameValue = 0;
    else if (lookingAtScreen) frameValue = 100;
    else frameValue = 40; // present but looking away

    if (phoneDetected) {
      this.activePenalty = this.phonePenalty;
    } else {
      this.activePenalty = Math.max(0, this.activePenalty - this.penaltyDecay);
    }

    this.window.push(frameValue);
    if (this.window.length > this.windowSize) this.window.shift();

    const base = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    this.score = Math.max(0, Math.min(100, base - this.activePenalty));
    return this.score;
  }
}
