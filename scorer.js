/**
 * scorer.js — Rolling 0-100 focus score from raw per-frame signals.
 *
 * Explainable, additive-penalty design — every deduction below is a
 * plain number you can point at, not a trained black box:
 *
 *   base 100, face must be present at all, then deduct for:
 *     - looking away (sideways/tilted head)      -45
 *     - eyes closed (sustained, not a blink)      -40
 *     - talking (rhythmic mouth movement)         -20
 *     - excessive movement (fidgeting/dancing)     -25
 *   averaged over a short rolling window for stability, then a
 *   separate slow-decaying penalty for phone pickups on top, since
 *   that's treated as more severe than the others.
 */

class FocusScorer {
  constructor({
    windowSize = 30,
    phonePenalty = 35,
    penaltyDecay = 2,
    lookAwayPenalty = 45,
    eyesClosedPenalty = 40,
    talkingPenalty = 20,
    movementPenalty = 25,
  } = {}) {
    this.windowSize = windowSize;
    this.window = [];
    this.phonePenalty = phonePenalty;
    this.penaltyDecay = penaltyDecay;
    this.lookAwayPenalty = lookAwayPenalty;
    this.eyesClosedPenalty = eyesClosedPenalty;
    this.talkingPenalty = talkingPenalty;
    this.movementPenalty = movementPenalty;
    this.activePenalty = 0;
    this.score = 100;
  }

  /**
   * @param {object} signals
   *   facePresent, lookingAtScreen, phoneDetected,
   *   eyesClosed, talking, excessiveMovement
   */
  update(signals) {
    const {
      facePresent,
      lookingAtScreen,
      phoneDetected,
      eyesClosed = false,
      talking = false,
      excessiveMovement = false,
    } = signals;

    let frameValue;
    if (!facePresent) {
      frameValue = 0;
    } else {
      frameValue = 100;
      if (!lookingAtScreen) frameValue -= this.lookAwayPenalty;
      if (eyesClosed) frameValue -= this.eyesClosedPenalty;
      if (talking) frameValue -= this.talkingPenalty;
      if (excessiveMovement) frameValue -= this.movementPenalty;
      frameValue = Math.max(0, frameValue);
    }

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
