/**
 * app.js — Focus Buddy main controller.
 *
 * Uses the Human library (https://github.com/vladmandic/human) fully
 * client-side for face + hand landmark detection. All inference runs
 * in this tab via TensorFlow.js (WebGL backend) — the video frame
 * never leaves the browser and is never written to disk or a network
 * request. Only derived booleans + a numeric score are stored locally.
 *
 * Accuracy notes:
 *   - A short calibration pass (runCalibration) measures this user's
 *     own neutral head angle, open-eye EAR, and resting mouth jitter
 *     before each session, so thresholds are personalized rather than
 *     generic. See signals.js for how that's applied.
 *   - "Looking away" uses a hysteresis streak counter (needs several
 *     consecutive off-screen frames to flip, fewer to recover) so a
 *     single glance or blink-adjacent frame doesn't flicker the state.
 */

// ---------- Config ----------
const PHONE_HOLD_FRAMES = 8;       // consecutive frames hand-near-face before flagging
const LOG_INTERVAL_MS = 1000;
const CALIBRATION_MS = 3000;
const LOOK_AWAY_STREAK = 5;        // consecutive bad frames before flagging "away"
const LOOK_BACK_STREAK = 2;        // consecutive good frames before clearing it
const DEFAULT_YAW_THRESHOLD_RAD = 0.42;   // ~24°, used if calibration fails
const DEFAULT_PITCH_THRESHOLD_RAD = 0.33; // ~19°
const CALIBRATED_YAW_THRESHOLD_RAD = 0.30;   // ~17°, tighter once baseline is known
const CALIBRATED_PITCH_THRESHOLD_RAD = 0.26; // ~15°

const humanConfig = {
  modelBasePath: "https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models/",
  backend: "webgl",
  debug: false,
  face: {
    enabled: true,
    detector: { rotation: true, maxDetected: 1, minConfidence: 0.4 },
    mesh: { enabled: true },
    iris: { enabled: false },
    description: { enabled: false },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
  },
  hand: { enabled: true, maxDetected: 2 },
  body: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  filter: { enabled: true, equalization: false },
};

// ---------- State ----------
let human = null;
let scorer = new FocusScorer();
let signalTracker = new SignalTracker();
let currentSessionId = null;
let sessionTimer = null;
let phoneStreak = 0;
let running = false;
let liveChart = null;
let tabAway = false;
const chartLabels = [];
const chartData = [];

// Calibration baseline — null until runCalibration() completes successfully.
let calibration = null; // { yaw, pitch, ear, marNoise }

document.addEventListener("visibilitychange", () => {
  tabAway = document.hidden;
});

// ---------- DOM ----------
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const octx = overlay.getContext("2d");
const modelStatus = document.getElementById("model-status");
const scoreValue = document.getElementById("score-value");
const ringProgress = document.getElementById("ring-progress");
const stateBadge = document.getElementById("state-badge");
const stateText = stateBadge.querySelector(".state-text");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const labelInput = document.getElementById("session-label");
const modeSelect = document.getElementById("mode-select");
const modeHint = document.getElementById("mode-hint");
const durationSelect = document.getElementById("duration-select");
const mAvg = document.getElementById("m-avg");
const mPresent = document.getElementById("m-present");
const mLooking = document.getElementById("m-looking");
const mPhone = document.getElementById("m-phone");
const mEyes = document.getElementById("m-eyes");
const mTalking = document.getElementById("m-talking");
const mTalkingLabel = document.getElementById("m-talking-label");
const mMovement = document.getElementById("m-movement");
const mTabAway = document.getElementById("m-tabaway");
const historyBody = document.getElementById("history-body");
const clockEl = document.getElementById("clock");
const clearDataLink = document.getElementById("clear-data");
const exportCsvLink = document.getElementById("export-csv");
const calibrationOverlay = document.getElementById("calibration-overlay");
const calibProgress = document.getElementById("calib-progress");
const calibCount = document.getElementById("calib-count");

const RING_CIRCUMFERENCE = 2 * Math.PI * 52;   // r=52, matches SVG
const CALIB_CIRCUMFERENCE = 2 * Math.PI * 34;  // r=34, matches SVG
ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
calibProgress.style.strokeDasharray = String(CALIB_CIRCUMFERENCE);

const MODE_HINTS = {
  study: "Camera stream is processed frame-by-frame in this tab only. No frame is ever stored — only a numeric score.",
  meeting: "Meeting mode: speaking is not penalized. Switching to other browser tabs during the session is tracked as the main distraction signal.",
};

function applyModeUI() {
  const mode = modeSelect.value;
  modeHint.textContent = MODE_HINTS[mode];
  mTalkingLabel.textContent = mode === "meeting" ? "Speaking" : "Talking";
  labelInput.placeholder = mode === "meeting"
    ? "meeting/lecture title (e.g. Sprint standup)"
    : "e.g. SDA assignment";
}
modeSelect.addEventListener("change", applyModeUI);

// ---------- Clock ----------
function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" });
}
setInterval(tickClock, 1000);
tickClock();

// ---------- Chart setup ----------
function initChart() {
  const ctx = document.getElementById("live-chart").getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, 130);
  gradient.addColorStop(0, "rgba(99,102,241,0.25)");
  gradient.addColorStop(1, "rgba(99,102,241,0.0)");
  liveChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [{
        data: chartData,
        borderColor: "#6366f1",
        backgroundColor: gradient,
        borderWidth: 2.5,
        pointRadius: 0,
        tension: 0.35,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 100,
          grid: { color: "#e9eaf3" },
          ticks: { color: "#a3a5b8", font: { size: 9 }, stepSize: 50 },
        },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function pushChartPoint(score) {
  chartLabels.push("");
  chartData.push(Math.round(score));
  if (chartLabels.length > 120) {
    chartLabels.shift();
    chartData.shift();
  }
  liveChart.update("none");
}

// ---------- Model init ----------
async function initModels() {
  try {
    human = new Human.Human(humanConfig);
    await human.load();
    await human.warmup();
    modelStatus.textContent = "Models ready";
    modelStatus.className = "pill pill-ready";
    startBtn.disabled = false;
  } catch (err) {
    console.error("Model load failed:", err);
    modelStatus.textContent = "Model load failed";
    modelStatus.className = "pill pill-error";
  }
}

// ---------- Webcam ----------
async function startWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((resolve) => { video.onloadedmetadata = resolve; });
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
}

function stopWebcam() {
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

// ---------- Head pose ----------
function getHeadPose(face) {
  const angle = face?.rotation?.angle;
  if (!angle) return null;
  return { yaw: angle.yaw || 0, pitch: angle.pitch || 0 };
}

function handNearFace(hands, face) {
  if (!hands || !hands.length || !face) return false;
  const box = face.box;
  if (!box) return false;
  const faceCenter = [box[0] + box[2] / 2, box[1] + box[3] / 2];
  const faceScale = Math.max(box[2], box[3]);

  for (const hand of hands) {
    const wrist = hand.keypoints?.[0];
    if (!wrist) continue;
    const dx = wrist[0] - faceCenter[0];
    const dy = wrist[1] - faceCenter[1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < faceScale * 1.3) return true;
  }
  return false;
}

function drawOverlay(result) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!result.face?.length) return;
  const box = result.face[0].box;
  if (box) {
    octx.strokeStyle = "rgba(99, 102, 241, 0.9)";
    octx.lineWidth = 2;
    octx.beginPath();
    octx.roundRect(box[0], box[1], box[2], box[3], 10);
    octx.stroke();
  }
}

// ---------- Calibration ----------
async function runCalibration() {
  calibrationOverlay.classList.remove("hidden");
  const yaws = [], pitches = [], ears = [], mars = [];
  const start = Date.now();

  await new Promise((resolve) => {
    function sampleLoop() {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, CALIBRATION_MS - elapsed);
      const secondsLeft = Math.ceil(remaining / 1000);
      calibCount.textContent = secondsLeft > 0 ? secondsLeft : "";
      const progress = Math.min(1, elapsed / CALIBRATION_MS);
      calibProgress.style.strokeDashoffset = String(CALIB_CIRCUMFERENCE * (1 - progress));

      human.detect(video).then((result) => {
        const face = result.face?.[0] || null;
        if (face) {
          const pose = getHeadPose(face);
          if (pose) { yaws.push(pose.yaw); pitches.push(pose.pitch); }
          const mesh = face.mesh;
          if (mesh) {
            const earL = eyeAspectRatio(mesh, LEFT_EYE);
            const earR = eyeAspectRatio(mesh, RIGHT_EYE);
            if (earL !== null && earR !== null) ears.push((earL + earR) / 2);
            const mar = mouthAspectRatio(mesh);
            if (mar !== null) mars.push(mar);
          }
        }
        if (elapsed >= CALIBRATION_MS) {
          resolve();
        } else {
          requestAnimationFrame(sampleLoop);
        }
      }).catch(() => {
        if (elapsed >= CALIBRATION_MS) resolve();
        else requestAnimationFrame(sampleLoop);
      });
    }
    sampleLoop();
  });

  calibrationOverlay.classList.add("hidden");

  if (yaws.length < 5) {
    calibration = null;
    return;
  }
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  calibration = {
    yaw: avg(yaws),
    pitch: avg(pitches),
    ear: ears.length >= 5 ? avg(ears) : null,
    marNoise: mars.length >= 5 ? stddev(mars) : null,
  };
}

// ---------- Main loop ----------
// Cache of the most recent face-based signals. rAF stalls when the tab is
// hidden, so a separate setInterval (below) keeps logging on that cadence,
// reusing these cached values but overriding with the live tabAway flag —
// this is what lets "switched tabs mid-meeting" actually get captured.
let lastFaceSignals = {
  facePresent: false, lookingAtScreen: false, phoneDetected: false,
  eyesClosed: false, talking: false, excessiveMovement: false,
};
let lookAwayStreak = 0;
let lookBackStreak = 0;
let smoothedLooking = true;

function evaluateLooking(face) {
  const pose = getHeadPose(face);
  if (!pose) return smoothedLooking; // fail-open: keep last known state if pose unavailable

  const baseYaw = calibration ? calibration.yaw : 0;
  const basePitch = calibration ? calibration.pitch : 0;
  const yawThresh = calibration ? CALIBRATED_YAW_THRESHOLD_RAD : DEFAULT_YAW_THRESHOLD_RAD;
  const pitchThresh = calibration ? CALIBRATED_PITCH_THRESHOLD_RAD : DEFAULT_PITCH_THRESHOLD_RAD;

  const dYaw = Math.abs(pose.yaw - baseYaw);
  const dPitch = Math.abs(pose.pitch - basePitch);
  const rawLooking = dYaw < yawThresh && dPitch < pitchThresh;

  // Hysteresis: require a streak before flipping, so single noisy frames
  // don't cause the badge/score to flicker.
  if (rawLooking) {
    lookBackStreak++;
    lookAwayStreak = 0;
    if (lookBackStreak >= LOOK_BACK_STREAK) smoothedLooking = true;
  } else {
    lookAwayStreak++;
    lookBackStreak = 0;
    if (lookAwayStreak >= LOOK_AWAY_STREAK) smoothedLooking = false;
  }
  return smoothedLooking;
}

async function detectLoop() {
  if (!running) return;
  try {
    const result = await human.detect(video);
    const face = result.face?.[0] || null;
    const facePresent = !!face;
    const lookingAtScreen = facePresent ? evaluateLooking(face) : false;

    const rawPhone = handNearFace(result.hand, face);
    phoneStreak = rawPhone ? phoneStreak + 1 : 0;
    const phoneDetected = phoneStreak >= PHONE_HOLD_FRAMES;

    const mesh = face?.mesh || null;
    const box = face?.box || null;
    const behavioral = signalTracker.update(mesh, box);

    lastFaceSignals = {
      facePresent,
      lookingAtScreen,
      phoneDetected,
      eyesClosed: behavioral.eyesClosed,
      talking: behavioral.talking,
      excessiveMovement: behavioral.excessiveMovement,
    };

    applyStateBadge({ ...lastFaceSignals, tabAway });
    drawOverlay(result);
  } catch (err) {
    console.error("Detection frame error:", err);
  }
  requestAnimationFrame(detectLoop);
}

// Single canonical scoring/logging tick — runs on a plain setInterval
// (not rAF) so it keeps firing even while the tab is hidden, which is
// exactly the period we need to capture in meeting mode.
let scoreTickInterval = null;
function scoreTick() {
  if (!running) return;
  const signals = { ...lastFaceSignals, tabAway };
  const score = scorer.update(signals);
  updateScoreDisplay(score);

  if (currentSessionId) {
    FocusDB.logTick(currentSessionId, signals, score).catch((e) => console.error(e));
    pushChartPoint(score);
  }
}

function updateScoreDisplay(score) {
  scoreValue.textContent = Math.round(score);
  const offset = RING_CIRCUMFERENCE * (1 - score / 100);
  ringProgress.style.strokeDashoffset = String(offset);
  let color = "#34d399"; // green
  if (score < 40) color = "#f87171";
  else if (score < 70) color = "#fbbf24";
  ringProgress.style.stroke = color;
}

function applyStateBadge(signals) {
  let label, cls;
  if (signals.tabAway) { label = "Tab switch"; cls = "alert"; }
  else if (signals.phoneDetected) { label = "Phone"; cls = "alert"; }
  else if (!signals.facePresent) { label = "No face"; cls = "alert"; }
  else if (signals.eyesClosed) { label = "Eyes closed"; cls = "alert"; }
  else if (!signals.lookingAtScreen) { label = "Looking away"; cls = "away"; }
  else if (signals.excessiveMovement) { label = "Restless"; cls = "away"; }
  else if (signals.talking && scorer.weights.talkingPenalty > 0) { label = "Talking"; cls = "away"; }
  else if (signals.talking) { label = "Speaking"; cls = "focused"; }
  else { label = "Focused"; cls = "focused"; }
  stateText.textContent = label;
  stateBadge.className = "state-chip " + cls;
}

// ---------- Session control ----------
async function startSession() {
  await startWebcam();
  startBtn.disabled = true;
  await runCalibration();

  const mode = modeSelect.value;
  currentSessionId = await FocusDB.startSession(labelInput.value.trim(), mode);
  scorer = new FocusScorer({ mode });
  signalTracker.reset();
  signalTracker.applyCalibration(calibration ? { ear: calibration.ear, marNoise: calibration.marNoise } : null);
  phoneStreak = 0;
  lookAwayStreak = 0;
  lookBackStreak = 0;
  smoothedLooking = true;
  tabAway = document.hidden;
  chartLabels.length = 0;
  chartData.length = 0;
  liveChart.update("none");

  running = true;
  stopBtn.disabled = false;
  labelInput.disabled = true;
  modeSelect.disabled = true;
  durationSelect.disabled = true;

  const durationMin = parseFloat(durationSelect.value);
  if (durationMin > 0) {
    sessionTimer = setTimeout(stopSession, durationMin * 60000);
  }

  detectLoop();
  scoreTickInterval = setInterval(scoreTick, LOG_INTERVAL_MS);
}

async function stopSession() {
  running = false;
  if (sessionTimer) clearTimeout(sessionTimer);
  if (scoreTickInterval) clearInterval(scoreTickInterval);
  stopWebcam();
  octx.clearRect(0, 0, overlay.width, overlay.height);

  if (currentSessionId) {
    await FocusDB.endSession(currentSessionId);
    await refreshSummaryFor(currentSessionId);
  }
  currentSessionId = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;
  labelInput.disabled = false;
  modeSelect.disabled = false;
  durationSelect.disabled = false;
  scoreValue.textContent = "--";
  ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  stateText.textContent = "Standby";
  stateBadge.className = "state-chip standby";

  await refreshHistory();
}

// ---------- Summary / history ----------
async function refreshSummaryFor(sessionId) {
  const ticks = await FocusDB.getTicks(sessionId);
  const s = FocusDB.summarize(ticks);
  mAvg.textContent = s.n ? Math.round(s.avgScore) : "--";
  mPresent.textContent = s.n ? Math.round(s.pctPresent * 100) + "%" : "--";
  mLooking.textContent = s.n ? Math.round(s.pctLooking * 100) + "%" : "--";
  mPhone.textContent = s.n ? s.phonePickups : "--";
  mEyes.textContent = s.n ? s.eyesClosedSecs + "s" : "--";
  mTalking.textContent = s.n ? s.talkingSecs + "s" : "--";
  mMovement.textContent = s.n ? s.movementSecs + "s" : "--";
  mTabAway.textContent = s.n ? s.tabSwitches : "--";
}

async function refreshHistory() {
  const sessions = await FocusDB.getSessions();
  if (!sessions.length) {
    historyBody.innerHTML = '<div class="empty-row">No sessions logged yet</div>';
    return;
  }
  const rows = await Promise.all(sessions.map(async (s) => {
    const ticks = await FocusDB.getTicks(s.id);
    const sum = FocusDB.summarize(ticks);
    const date = new Date(s.startedAt).toLocaleString("en-GB", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
    const modeCls = s.mode === "meeting" ? "meeting" : "study";
    const modeLabel = s.mode === "meeting" ? "Meet" : "Study";
    const score = sum.n ? Math.round(sum.avgScore) : "--";
    const scoreColor = !sum.n ? "var(--text-faint)" : score >= 70 ? "var(--green)" : score >= 40 ? "var(--amber)" : "var(--red)";
    return `<div class="history-row">
      <span class="history-mode-chip ${modeCls}">${modeLabel}</span>
      <div class="history-main">
        <div class="history-label">${s.label || "Untitled"}</div>
        <div class="history-date">${date}</div>
      </div>
      <span class="history-score" style="color:${scoreColor}">${score}</span>
    </div>`;
  }));
  historyBody.innerHTML = rows.join("");
}

// ---------- Wiring ----------
startBtn.addEventListener("click", () => startSession().catch((err) => {
  console.error(err);
  startBtn.disabled = false;
  calibrationOverlay.classList.add("hidden");
  alert("Could not start webcam/session: " + err.message);
}));
stopBtn.addEventListener("click", () => stopSession());

clearDataLink.addEventListener("click", async () => {
  if (!confirm("This will permanently delete all locally stored session data. Continue?")) return;
  await FocusDB.clearAll();
  await refreshHistory();
  mAvg.textContent = mPresent.textContent = mLooking.textContent = mPhone.textContent = "--";
  mEyes.textContent = mTalking.textContent = mMovement.textContent = mTabAway.textContent = "--";
});

exportCsvLink.addEventListener("click", async () => {
  const csv = await FocusDB.exportCsv();
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `focus-buddy-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ---------- Init ----------
(async function init() {
  initChart();
  applyModeUI();
  startBtn.disabled = true;
  await initModels();
  await refreshHistory();
})();
