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
const LOG_INTERVAL_MS = 1000;
const CALIBRATION_MS = 3000;
const LOOK_AWAY_STREAK = 5;        // consecutive bad frames before flagging "away"
const LOOK_BACK_STREAK = 2;        // consecutive good frames before clearing it
const DEFAULT_YAW_THRESHOLD_RAD = 0.42;   // ~24°, used if calibration fails
const DEFAULT_PITCH_THRESHOLD_RAD = 0.33; // ~19°
const CALIBRATED_YAW_THRESHOLD_RAD = 0.30;   // ~17°, tighter once baseline is known
const CALIBRATED_PITCH_THRESHOLD_RAD = 0.26; // ~15°
const FACE_ABSENT_GRACE_MS = 1800;  // brief occlusion/tracking loss tolerance before it counts as "gone"
const STEPPED_AWAY_MS = 12000;      // sustained absence beyond this -> distinct "Stepped away" label

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
const mAway = document.getElementById("m-away");
const historyBody = document.getElementById("history-body");
const clockEl = document.getElementById("clock");
const clearDataLink = document.getElementById("clear-data");
const exportCsvLink = document.getElementById("export-csv");
const calibrationOverlay = document.getElementById("calibration-overlay");
const calibProgress = document.getElementById("calib-progress");
const calibCount = document.getElementById("calib-count");
const themeToggle = document.getElementById("theme-toggle");
const useSavedCalibrationCb = document.getElementById("use-saved-calibration");
const calibSavedDate = document.getElementById("calib-saved-date");
const performanceModeCb = document.getElementById("performance-mode");
const inSessions = document.getElementById("in-sessions");
const inMinutes = document.getElementById("in-minutes");
const inAvg = document.getElementById("in-avg");
const inStreak = document.getElementById("in-streak");
const inHighlight = document.getElementById("in-highlight");
const exportPdfLink = document.getElementById("export-pdf");

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

// ---------- Theme ----------
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("focusbuddy-theme", next);
});

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
async function startWebcam(performanceMode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: performanceMode
      ? { width: 480, height: 360, facingMode: "user" }
      : { width: 640, height: 480, facingMode: "user" },
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
    // Trimmed mean: if the person blinks during calibration, those low
    // EAR samples get dropped instead of dragging the baseline down.
    ear: ears.length >= 5 ? trimmedMeanLow(ears) : null,
    marNoise: mars.length >= 5 ? stddev(mars) : null,
    savedAt: Date.now(),
  };
  try {
    await FocusDB.setSetting("calibration", calibration);
    refreshCalibrationStatus();
  } catch (err) {
    console.error("Could not persist calibration:", err);
  }
}

async function refreshCalibrationStatus() {
  const saved = await FocusDB.getSetting("calibration").catch(() => null);
  if (saved && saved.savedAt) {
    const d = new Date(saved.savedAt);
    calibSavedDate.textContent = `(${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })})`;
    useSavedCalibrationCb.disabled = false;
    useSavedCalibrationCb.checked = true;
  } else {
    calibSavedDate.textContent = "";
    useSavedCalibrationCb.disabled = true;
    useSavedCalibrationCb.checked = false;
  }
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
let lookAwayHyst = new Hysteresis(LOOK_AWAY_STREAK, LOOK_BACK_STREAK);
let faceAbsentSince = null;
let smoothedFacePresent = true;

function evaluateLooking(face) {
  const pose = getHeadPose(face);
  if (!pose) return !lookAwayHyst.state; // fail-open: keep last known state if pose unavailable

  const baseYaw = calibration ? calibration.yaw : 0;
  const basePitch = calibration ? calibration.pitch : 0;
  const yawThresh = calibration ? CALIBRATED_YAW_THRESHOLD_RAD : DEFAULT_YAW_THRESHOLD_RAD;
  const pitchThresh = calibration ? CALIBRATED_PITCH_THRESHOLD_RAD : DEFAULT_PITCH_THRESHOLD_RAD;

  const dYaw = Math.abs(pose.yaw - baseYaw);
  const dPitch = Math.abs(pose.pitch - basePitch);
  const rawLooking = dYaw < yawThresh && dPitch < pitchThresh;

  // Hysteresis: requires a streak before flipping, so single noisy frames
  // don't cause the badge/score to flicker.
  const away = lookAwayHyst.update(!rawLooking);
  return !away;
}

async function detectLoop() {
  if (!running) return;
  try {
    const result = await human.detect(video);
    const face = result.face?.[0] || null;
    const rawFacePresent = !!face;
    const now = Date.now();

    if (rawFacePresent) {
      faceAbsentSince = null;
      smoothedFacePresent = true;
    } else {
      if (faceAbsentSince === null) faceAbsentSince = now;
      if (now - faceAbsentSince >= FACE_ABSENT_GRACE_MS) smoothedFacePresent = false;
      // else: still within the grace window — hold last known presence state
      // so a momentary occlusion (hand passing by, quick tracking loss)
      // doesn't instantly zero the score like actually leaving would.
    }

    let lookingAtScreen, eyesClosed, talking, excessiveMovement, phoneDetected;
    if (rawFacePresent) {
      lookingAtScreen = evaluateLooking(face);
      const behavioral = signalTracker.update(face.mesh || null, face.box || null, result.hand);
      eyesClosed = behavioral.eyesClosed;
      talking = behavioral.talking;
      excessiveMovement = behavioral.excessiveMovement;
      phoneDetected = behavioral.phoneDetected;
    } else if (smoothedFacePresent) {
      // Within grace period: no new landmark data this frame, so hold the
      // last known behavioral signals rather than guessing. Still feed
      // hands through so a phone-check that started just before a brief
      // tracking blip isn't lost.
      ({ lookingAtScreen, eyesClosed, talking } = lastFaceSignals);
      excessiveMovement = lastFaceSignals.excessiveMovement;
      const behavioral = signalTracker.update(null, null, result.hand);
      phoneDetected = behavioral.phoneDetected;
    } else {
      // Genuinely stepped away — these should read as false, not stale.
      lookingAtScreen = false;
      eyesClosed = false;
      talking = false;
      excessiveMovement = false;
      const behavioral = signalTracker.update(null, null, result.hand);
      phoneDetected = behavioral.phoneDetected;
    }

    lastFaceSignals = {
      facePresent: smoothedFacePresent,
      lookingAtScreen,
      phoneDetected,
      eyesClosed,
      talking,
      excessiveMovement,
    };

    const steppedAway = !rawFacePresent && faceAbsentSince !== null && (now - faceAbsentSince >= STEPPED_AWAY_MS);
    applyStateBadge({ ...lastFaceSignals, tabAway, steppedAway });
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
  else if (!signals.facePresent) { label = signals.steppedAway ? "Stepped away" : "No face"; cls = "alert"; }
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
  const performanceMode = performanceModeCb.checked;
  await startWebcam(performanceMode);
  startBtn.disabled = true;

  // Human's config is read live on each detect() call, so toggling this
  // before the session starts is enough — no need to recreate the model.
  human.config.hand.enabled = !performanceMode;

  const useSaved = useSavedCalibrationCb.checked && !useSavedCalibrationCb.disabled;
  if (useSaved) {
    const saved = await FocusDB.getSetting("calibration").catch(() => null);
    calibration = saved || null;
    if (!calibration) await runCalibration(); // saved calibration vanished somehow — fall back
  } else {
    await runCalibration();
  }

  const mode = modeSelect.value;
  currentSessionId = await FocusDB.startSession(labelInput.value.trim(), mode);
  scorer = new FocusScorer({ mode });
  signalTracker.reset();
  signalTracker.applyCalibration(calibration ? { ear: calibration.ear, marNoise: calibration.marNoise } : null);
  lookAwayHyst.reset();
  faceAbsentSince = null;
  smoothedFacePresent = true;
  tabAway = document.hidden;
  chartLabels.length = 0;
  chartData.length = 0;
  liveChart.update("none");

  running = true;
  stopBtn.disabled = false;
  labelInput.disabled = true;
  modeSelect.disabled = true;
  durationSelect.disabled = true;
  useSavedCalibrationCb.disabled = true;
  performanceModeCb.disabled = true;

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
  performanceModeCb.disabled = false;
  await refreshCalibrationStatus(); // re-enables the checkbox if a baseline exists
  scoreValue.textContent = "--";
  ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  stateText.textContent = "Standby";
  stateBadge.className = "state-chip standby";

  await refreshHistory();
  await refreshInsights();
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
  mAway.textContent = s.n ? s.awayEvents : "--";
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

async function getSessionsWithSummaries() {
  const sessions = await FocusDB.getSessions();
  return Promise.all(sessions.map(async (session) => {
    const ticks = await FocusDB.getTicks(session.id);
    return { session, summary: FocusDB.summarize(ticks) };
  }));
}

// ---------- Insights ----------
let trendChart = null;
function initTrendChart() {
  const ctx = document.getElementById("trend-chart").getContext("2d");
  trendChart = new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [{ data: [], borderColor: "#a855f7", borderWidth: 2, pointRadius: 2, pointBackgroundColor: "#a855f7", tension: 0.3, fill: false }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { display: false }, y: { min: 0, max: 100, display: false } },
      plugins: { legend: { display: false } },
    },
  });
}

async function refreshInsights() {
  const withSummaries = await getSessionsWithSummaries();
  const insights = FocusInsights.compute(withSummaries);

  inSessions.textContent = insights.totalSessions || "--";
  inMinutes.textContent = insights.totalSessions ? insights.totalMinutes : "--";
  inAvg.textContent = insights.totalSessions ? insights.allTimeAvg : "--";
  inStreak.textContent = insights.totalSessions ? insights.streak : "--";

  if (insights.totalSessions) {
    const bits = [];
    if (insights.bestLabel) bits.push(`Best focus on <b>${insights.bestLabel.label}</b> (avg ${insights.bestLabel.avg})`);
    if (insights.topDistraction) bits.push(`most common distraction: <b>${insights.topDistraction}</b>`);
    inHighlight.innerHTML = bits.length ? bits.join(" · ") : "Keep logging sessions to see patterns here.";
  } else {
    inHighlight.textContent = "Log a few sessions to see patterns here.";
  }

  trendChart.data.labels = insights.trend.map((_, i) => i);
  trendChart.data.datasets[0].data = insights.trend;
  trendChart.update("none");
}

// ---------- PDF report ----------
async function downloadPdfReport() {
  const withSummaries = await getSessionsWithSummaries();
  const insights = FocusInsights.compute(withSummaries);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Focus Buddy — Session Report", 14, 18);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated ${new Date().toLocaleString()}`, 14, 25);

  doc.setTextColor(20);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text("Summary", 14, 38);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const summaryLines = [
    `Total sessions: ${insights.totalSessions}`,
    `Total minutes tracked: ${insights.totalMinutes}`,
    `All-time average focus: ${insights.allTimeAvg}`,
    `Current day streak: ${insights.streak}`,
    insights.bestLabel ? `Best-performing label: ${insights.bestLabel.label} (avg ${insights.bestLabel.avg})` : null,
    insights.topDistraction ? `Most common distraction: ${insights.topDistraction}` : null,
  ].filter(Boolean);
  summaryLines.forEach((line, i) => doc.text(line, 14, 46 + i * 6));

  if (trendChart) {
    const chartImg = trendChart.toBase64Image();
    doc.addImage(chartImg, "PNG", 14, 46 + summaryLines.length * 6 + 6, 180, 45);
  }

  let y = 46 + summaryLines.length * 6 + 60;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Recent sessions", 14, y);
  y += 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const headers = ["Date", "Mode", "Label", "Avg", "Mins"];
  const colX = [14, 45, 65, 130, 150];
  headers.forEach((h, i) => doc.text(h, colX[i], y));
  y += 5;
  doc.setDrawColor(220);
  doc.line(14, y - 3, 195, y - 3);

  const recent = withSummaries
    .filter((x) => x.session.endedAt)
    .sort((a, b) => b.session.startedAt - a.session.startedAt)
    .slice(0, 25);

  for (const x of recent) {
    if (y > 280) { doc.addPage(); y = 20; }
    const date = new Date(x.session.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    const mins = Math.round((x.session.endedAt - x.session.startedAt) / 60000);
    const row = [date, x.session.mode || "study", (x.session.label || "Untitled").slice(0, 22), String(Math.round(x.summary.avgScore || 0)), String(mins)];
    row.forEach((cell, i) => doc.text(cell, colX[i], y));
    y += 6;
  }

  doc.save(`focus-buddy-report-${new Date().toISOString().slice(0, 10)}.pdf`);
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
  if (!confirm("This will permanently delete all locally stored session data, including any saved calibration. Continue?")) return;
  await FocusDB.clearAll();
  await refreshHistory();
  await refreshInsights();
  await refreshCalibrationStatus();
  mAvg.textContent = mPresent.textContent = mLooking.textContent = mPhone.textContent = "--";
  mEyes.textContent = mTalking.textContent = mMovement.textContent = mTabAway.textContent = "--";
  mAway.textContent = "--";
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

exportPdfLink.addEventListener("click", () => downloadPdfReport().catch((err) => {
  console.error(err);
  alert("Could not generate PDF report: " + err.message);
}));

// ---------- Init ----------
(async function init() {
  initChart();
  initTrendChart();
  applyModeUI();
  startBtn.disabled = true;
  await initModels();
  await refreshHistory();
  await refreshInsights();
  await refreshCalibrationStatus();
})();
