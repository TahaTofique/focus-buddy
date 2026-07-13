/**
 * scorer.js — Rolling 0-100 focus/engagement score from raw per-frame signals.
 *
 * Explainable, additive-penalty design — every deduction below is a
 * plain number you can point at, not a trained black box. Weights
 * differ by mode:
 *
 *   STUDY mode (solo work): talking is a distraction (on a call,
 *   chatting) and gets penalized like any other signal.
 *
 *   MEETING mode (calls/lectures): talking is expected participation
 *   — it is NOT penalized. Instead, checking other browser tabs
 *   mid-meeting is penalized, since that's the realistic distraction
 *   in a meeting context that a webcam alone can't otherwise see.
 */

const MODE_WEIGHTS = {
  study: {
    lookAwayPenalty: 45,
    eyesClosedPenalty: 40,
    talkingPenalty: 20,
    movementPenalty: 25,
    tabAwayPenalty: 30,
    phonePenalty: 35,
  },
  meeting: {
    lookAwayPenalty: 35,
    eyesClosedPenalty: 40,
    talkingPenalty: 0,       // speaking is expected, not a distraction
    movementPenalty: 15,     // a little more lenient — gestures while talking are normal
    tabAwayPenalty: 45,      // the realistic "not paying attention" signal in a meeting
    phonePenalty: 35,
  },
};

class FocusScorer {
  constructor({ mode = "study", windowSize = 30, penaltyDecay = 2 } = {}) {
    this.mode = MODE_WEIGHTS[mode] ? mode : "study";
    this.weights = MODE_WEIGHTS[this.mode];
    this.windowSize = windowSize;
    this.window = [];
    this.penaltyDecay = penaltyDecay;
    this.activePenalty = 0;
    this.score = 100;
  }

  /**
   * @param {object} signals
   *   facePresent, lookingAtScreen, phoneDetected,
   *   eyesClosed, talking, excessiveMovement, tabAway
   */
  update(signals) {
    const {
      facePresent,
      lookingAtScreen,
      phoneDetected,
      eyesClosed = false,
      talking = false,
      excessiveMovement = false,
      tabAway = false,
    } = signals;
    const w = this.weights;

    let frameValue;
    if (!facePresent) {
      frameValue = 0;
    } else {
      frameValue = 100;
      if (!lookingAtScreen) frameValue -= w.lookAwayPenalty;
      if (eyesClosed) frameValue -= w.eyesClosedPenalty;
      if (talking) frameValue -= w.talkingPenalty;
      if (excessiveMovement) frameValue -= w.movementPenalty;
      frameValue = Math.max(0, frameValue);
    }

    // tabAway overrides face-based signals entirely — if you've switched
    // tabs, nothing your face is doing matters, you're not on the meeting.
    if (tabAway) frameValue = Math.min(frameValue, 100 - w.tabAwayPenalty);

    if (phoneDetected) {
      this.activePenalty = w.phonePenalty;
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
