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
const BREAK_INTERVAL_MS = 25 * 60000;   // time-based reminder cadence
const LOW_FOCUS_THRESHOLD = 45;         // rolling avg score below this triggers a reminder
const LOW_FOCUS_WINDOW_SEC = 180;       // sustained for this many seconds (at 1 sample/sec) before it fires

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
const sessionProject = document.getElementById("session-project");
const sessionNotes = document.getElementById("session-notes");
const attendancePanel = document.getElementById("attendance-panel");
const attendanceTimerEl = document.getElementById("attendance-timer");
const redactedModeCb = document.getElementById("redacted-mode");
const insightsProjectFilter = document.getElementById("insights-project-filter");
const exportTimesheetLink = document.getElementById("export-timesheet");
const templateSelect = document.getElementById("template-select");
const saveTemplateBtn = document.getElementById("save-template-btn");
const deleteTemplateBtn = document.getElementById("delete-template-btn");
const breakReminder = document.getElementById("break-reminder");
const breakReminderText = document.getElementById("break-reminder-text");
const breakReminderDismiss = document.getElementById("break-reminder-dismiss");
const breakRemindersToggle = document.getElementById("break-reminders-toggle");
const backupDataLink = document.getElementById("backup-data");
const restoreDataLink = document.getElementById("restore-data");
const restoreFileInput = document.getElementById("restore-file-input");

const RING_CIRCUMFERENCE = 2 * Math.PI * 52;   // r=52, matches SVG
const CALIB_CIRCUMFERENCE = 2 * Math.PI * 34;  // r=34, matches SVG
ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
calibProgress.style.strokeDasharray = String(CALIB_CIRCUMFERENCE);

const MODE_HINTS = {
  study: "Camera stream is processed frame-by-frame in this tab only. No frame is ever stored — only a numeric score.",
  meeting: "Meeting mode: speaking is not penalized. Switching to other browser tabs during the session is tracked as the main distraction signal.",
  attendance: "Attendance-only mode: no camera is used at all — just a timestamped duration log for timesheets or attendance records.",
};

function applyModeUI() {
  const mode = modeSelect.value;
  modeHint.textContent = MODE_HINTS[mode];
  mTalkingLabel.textContent = mode === "meeting" ? "Speaking" : "Talking";
  labelInput.placeholder = mode === "meeting"
    ? "meeting/lecture title (e.g. Sprint standup)"
    : mode === "attendance"
      ? "e.g. All-hands meeting"
      : "e.g. SDA assignment";

  const isAttendance = mode === "attendance";
  attendancePanel.classList.toggle("hidden", !isAttendance);
  useSavedCalibrationCb.closest(".option-toggle").classList.toggle("hidden", isAttendance);
  performanceModeCb.closest(".option-toggle").classList.toggle("hidden", isAttendance);
}
modeSelect.addEventListener("change", applyModeUI);

// ---------- Notes autosave ----------
let notesSaveTimer = null;
sessionNotes.addEventListener("input", () => {
  if (!currentSessionId) return;
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(() => {
    FocusDB.updateSession(currentSessionId, { notes: sessionNotes.value }).catch((e) => console.error(e));
  }, 800);
});

// ---------- Theme ----------
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("focusbuddy-theme", next);
});

// ---------- Session templates ----------
async function refreshTemplateOptions() {
  const templates = await FocusDB.getTemplates();
  const current = templateSelect.value;
  templateSelect.innerHTML = '<option value="">Load template…</option>' +
    templates.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join("");
  if (templates.some((t) => t.name === current)) templateSelect.value = current;
  deleteTemplateBtn.disabled = !templateSelect.value;
}

templateSelect.addEventListener("change", async () => {
  deleteTemplateBtn.disabled = !templateSelect.value;
  if (!templateSelect.value) return;
  const templates = await FocusDB.getTemplates();
  const t = templates.find((x) => x.name === templateSelect.value);
  if (!t) return;
  labelInput.value = t.label || "";
  sessionProject.value = t.project || "";
  modeSelect.value = t.mode || "study";
  durationSelect.value = String(t.duration ?? 25);
  applyModeUI();
});

saveTemplateBtn.addEventListener("click", async () => {
  const defaultName = labelInput.value.trim() || "Untitled template";
  const name = prompt("Template name:", defaultName);
  if (!name) return;
  await FocusDB.saveTemplate({
    name: name.trim(),
    label: labelInput.value.trim(),
    project: sessionProject.value.trim(),
    mode: modeSelect.value,
    duration: durationSelect.value,
  });
  await refreshTemplateOptions();
  templateSelect.value = name.trim();
  deleteTemplateBtn.disabled = false;
});

deleteTemplateBtn.addEventListener("click", async () => {
  if (!templateSelect.value) return;
  if (!confirm(`Delete template "${templateSelect.value}"?`)) return;
  await FocusDB.deleteTemplate(templateSelect.value);
  await refreshTemplateOptions();
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
  if (liveChart) liveChart.update("none");
}

// ---------- Model init ----------
let modelsReady = false;

function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms));
}

async function initModels() {
  try {
    human = new Human.Human(humanConfig);
    await Promise.race([human.load(), timeout(20000, "Model load")]);
    await Promise.race([human.warmup(), timeout(20000, "Model warmup")]);
    modelStatus.textContent = "Models ready";
    modelStatus.className = "pill pill-ready";
    startBtn.disabled = false;
    modelsReady = true;
  } catch (err) {
    console.error("Model load failed:", err);
    modelStatus.textContent = "Detection unavailable (Attendance-only still works)";
    modelStatus.className = "pill pill-error";
    startBtn.disabled = false; // still allow attendance-only mode, checked at click time below
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
// ---------- Break reminders ----------
let breakIntervalTimer = null;
let recentScores = [];
let lowFocusReminderShown = false;

async function ensureNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch (err) { /* ignore — banner still works without it */ }
  }
}

function showBreakReminder(text) {
  breakReminderText.textContent = text;
  breakReminder.classList.remove("hidden");
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("Focus Buddy", { body: text }); } catch (err) { /* ignore */ }
  }
}

breakReminderDismiss.addEventListener("click", () => breakReminder.classList.add("hidden"));

function checkLowFocusReminder(score) {
  if (!breakRemindersToggle.checked || lowFocusReminderShown) return;
  recentScores.push(score);
  if (recentScores.length > LOW_FOCUS_WINDOW_SEC) recentScores.shift();
  if (recentScores.length >= LOW_FOCUS_WINDOW_SEC) {
    const avg = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
    if (avg < LOW_FOCUS_THRESHOLD) {
      lowFocusReminderShown = true;
      showBreakReminder("Focus has been low for a few minutes — might be a good time for a short break.");
    }
  }
}

function startBreakReminders() {
  recentScores = [];
  lowFocusReminderShown = false;
  breakReminder.classList.add("hidden");
  if (!breakRemindersToggle.checked) return;
  ensureNotificationPermission();
  breakIntervalTimer = setInterval(() => {
    showBreakReminder("You've been at this a while — consider a short break.");
  }, BREAK_INTERVAL_MS);
}

function stopBreakReminders() {
  if (breakIntervalTimer) { clearInterval(breakIntervalTimer); breakIntervalTimer = null; }
  breakReminder.classList.add("hidden");
}

let scoreTickInterval = null;
let activeMode = null;
let attendanceTimerInterval = null;
let attendanceStartTime = null;
function scoreTick() {
  if (!running) return;
  const signals = { ...lastFaceSignals, tabAway };
  const score = scorer.update(signals);
  updateScoreDisplay(score);
  checkLowFocusReminder(score);

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
  const mode = modeSelect.value;

  if (mode !== "attendance" && !modelsReady) {
    alert("Detection models haven't loaded (likely a network issue). Attendance-only mode still works without them — switch modes to use it, or reload the page to retry.");
    return;
  }

  activeMode = mode;
  const project = sessionProject.value.trim();

  if (mode === "attendance") {
    startBtn.disabled = true;
    currentSessionId = await FocusDB.startSession(labelInput.value.trim(), mode, project);
    sessionNotes.value = "";
    sessionNotes.disabled = false;

    running = true;
    stopBtn.disabled = false;
    labelInput.disabled = true;
    modeSelect.disabled = true;
    durationSelect.disabled = true;
    sessionProject.disabled = true;

    attendanceStartTime = Date.now();
    updateAttendanceTimer();
    attendanceTimerInterval = setInterval(updateAttendanceTimer, 1000);
    startBreakReminders();

    const durationMin = parseFloat(durationSelect.value);
    if (durationMin > 0) sessionTimer = setTimeout(stopSession, durationMin * 60000);
    return;
  }

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

  currentSessionId = await FocusDB.startSession(labelInput.value.trim(), mode, project);
  sessionNotes.value = "";
  sessionNotes.disabled = false;
  scorer = new FocusScorer({ mode });
  signalTracker.reset();
  signalTracker.applyCalibration(calibration ? { ear: calibration.ear, marNoise: calibration.marNoise } : null);
  lookAwayHyst.reset();
  faceAbsentSince = null;
  smoothedFacePresent = true;
  tabAway = document.hidden;
  chartLabels.length = 0;
  chartData.length = 0;
  if (liveChart) liveChart.update("none");

  running = true;
  stopBtn.disabled = false;
  labelInput.disabled = true;
  modeSelect.disabled = true;
  durationSelect.disabled = true;
  sessionProject.disabled = true;
  useSavedCalibrationCb.disabled = true;
  performanceModeCb.disabled = true;

  const durationMin = parseFloat(durationSelect.value);
  if (durationMin > 0) {
    sessionTimer = setTimeout(stopSession, durationMin * 60000);
  }

  detectLoop();
  scoreTickInterval = setInterval(scoreTick, LOG_INTERVAL_MS);
  startBreakReminders();
}

function updateAttendanceTimer() {
  const elapsed = Math.floor((Date.now() - attendanceStartTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  attendanceTimerEl.textContent = `${mm}:${ss}`;
}

async function stopSession() {
  running = false;
  if (sessionTimer) clearTimeout(sessionTimer);
  if (scoreTickInterval) clearInterval(scoreTickInterval);
  if (attendanceTimerInterval) { clearInterval(attendanceTimerInterval); attendanceTimerInterval = null; }
  stopBreakReminders();

  if (activeMode !== "attendance") {
    stopWebcam();
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }

  if (currentSessionId) {
    await FocusDB.endSession(currentSessionId);
    await refreshSummaryFor(currentSessionId);
  }
  currentSessionId = null;
  sessionNotes.disabled = true;

  startBtn.disabled = false;
  stopBtn.disabled = true;
  labelInput.disabled = false;
  modeSelect.disabled = false;
  durationSelect.disabled = false;
  sessionProject.disabled = false;
  performanceModeCb.disabled = false;
  await refreshCalibrationStatus(); // re-enables the checkbox if a baseline exists
  scoreValue.textContent = "--";
  ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  stateText.textContent = "Standby";
  stateBadge.className = "state-chip standby";
  attendanceTimerEl.textContent = "00:00";
  activeMode = null;

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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const MODE_DISPLAY = {
  study: ["study", "Study"],
  meeting: ["meeting", "Meet"],
  attendance: ["attendance", "Attend"],
};

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
    const [modeCls, modeLabel] = MODE_DISPLAY[s.mode] || MODE_DISPLAY.study;
    const mins = s.endedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : null;

    let scoreDisplay, scoreColor;
    if (s.mode === "attendance") {
      scoreDisplay = mins !== null ? `${mins}m` : "--";
      scoreColor = "var(--teal)";
    } else {
      const score = sum.n ? Math.round(sum.avgScore) : "--";
      scoreDisplay = score;
      scoreColor = !sum.n ? "var(--text-faint)" : score >= 70 ? "var(--green)" : score >= 40 ? "var(--amber)" : "var(--red)";
    }

    const projectChip = s.project ? `<span class="history-project">${escapeHtml(s.project)}</span>` : "";
    const notesIcon = s.notes
      ? `<svg class="history-notes-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" title="${escapeHtml(s.notes)}"><path d="M4 4h16v12H8l-4 4V4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`
      : "";

    return `<div class="history-row">
      <span class="history-mode-chip ${modeCls}">${modeLabel}</span>
      ${projectChip}
      <div class="history-main">
        <div class="history-label">${escapeHtml(s.label || "Untitled")}${notesIcon}</div>
        <div class="history-date">${date}</div>
      </div>
      <div class="history-actions">
        <button class="history-copy-btn" data-session-id="${s.id}" title="Copy share-safe summary">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15V5a2 2 0 012-2h10" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <span class="history-score" style="color:${scoreColor}">${scoreDisplay}</span>
      </div>
    </div>`;
  }));
  historyBody.innerHTML = rows.join("");
}

historyBody.addEventListener("click", async (e) => {
  const btn = e.target.closest(".history-copy-btn");
  if (!btn) return;
  const sessionId = Number(btn.dataset.sessionId);
  const sessions = await FocusDB.getSessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const ticks = await FocusDB.getTicks(sessionId);
  const summary = FocusDB.summarize(ticks);
  const text = FocusInsights.formatRedactedSummary(session, summary);
  try {
    await navigator.clipboard.writeText(text);
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    setTimeout(refreshHistory, 1400);
  } catch (err) {
    console.error("Clipboard write failed:", err);
    alert("Couldn't access the clipboard. Here's the summary to copy manually:\n\n" + text);
  }
});

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

  // Repopulate the project filter without losing the current selection.
  const currentSelection = insightsProjectFilter.value;
  const projects = FocusInsights.listProjects(withSummaries);
  insightsProjectFilter.innerHTML = '<option value="">All projects</option>' +
    projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  if (projects.includes(currentSelection)) insightsProjectFilter.value = currentSelection;

  const insights = FocusInsights.compute(withSummaries, insightsProjectFilter.value || null);

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

  if (trendChart) {
    trendChart.data.labels = insights.trend.map((_, i) => i);
    trendChart.data.datasets[0].data = insights.trend;
    trendChart.update("none");
  }
}
insightsProjectFilter.addEventListener("change", () => refreshInsights());

// ---------- PDF report ----------
async function downloadPdfReport() {
  const withSummaries = await getSessionsWithSummaries();
  const insights = FocusInsights.compute(withSummaries);
  const redacted = redactedModeCb.checked;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(redacted ? "Meeting Engagement Summary" : "Focus Buddy — Session Report", 14, 18);
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
    // Redacted mode drops the distraction-pattern line — appropriate for
    // a summary you'd hand to someone else, since it reveals behavioral
    // detail rather than just outcomes.
    (!redacted && insights.topDistraction) ? `Most common distraction: ${insights.topDistraction}` : null,
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
  const headers = ["Date", "Project", "Label", "Avg", "Mins"];
  const colX = [14, 45, 85, 155, 175];
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
    const row = [
      date,
      (x.session.project || "—").slice(0, 16),
      (x.session.label || "Untitled").slice(0, 22),
      String(Math.round(x.summary.avgScore || 0)),
      String(mins),
    ];
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
  if (!confirm("This will permanently delete all locally stored session data, including any saved calibration and templates. Continue?")) return;
  await FocusDB.clearAll();
  await refreshHistory();
  await refreshInsights();
  await refreshCalibrationStatus();
  await refreshTemplateOptions();
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

exportTimesheetLink.addEventListener("click", async () => {
  const csv = await FocusDB.exportTimesheetCsv();
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `focus-buddy-timesheet-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ---------- Backup / restore ----------
backupDataLink.addEventListener("click", async () => {
  try {
    const backup = await FocusDB.exportBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `focus-buddy-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert("Could not create backup: " + err.message);
  }
});

restoreDataLink.addEventListener("click", () => restoreFileInput.click());

restoreFileInput.addEventListener("change", async () => {
  const file = restoreFileInput.files[0];
  restoreFileInput.value = ""; // allow re-selecting the same file later
  if (!file) return;
  if (!confirm("This will REPLACE all current local data with the contents of this backup file. Continue?")) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await FocusDB.restoreBackup(data);
    await refreshHistory();
    await refreshInsights();
    await refreshCalibrationStatus();
    await refreshTemplateOptions();
    alert("Backup restored successfully.");
  } catch (err) {
    console.error(err);
    alert("Could not restore backup: " + err.message);
  }
});

// ---------- Keyboard shortcut ----------
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  e.preventDefault();
  if (running) {
    if (!stopBtn.disabled) stopBtn.click();
  } else if (!startBtn.disabled) {
    startBtn.click();
  }
});

// ---------- Init ----------
(async function init() {
  // Pure DOM setup — no external dependencies, always safe.
  applyModeUI();

  // Charts are a nice-to-have, not load-bearing — if Chart.js fails to
  // load (blocked CDN, offline, ad-blocker), hide the chart areas and
  // keep going. Every other feature (history, insights numbers, session
  // tracking itself) works completely fine without them.
  try {
    initChart();
    initTrendChart();
  } catch (err) {
    console.error("Chart.js unavailable, continuing without charts:", err);
    document.querySelector(".chart-wrap")?.classList.add("hidden");
    document.querySelector(".sparkline-wrap")?.classList.add("hidden");
  }

  // Each of these touches its own DOM region and has no dependency on
  // the others — isolate them so one failure doesn't blank the rest.
  await initModels().catch((err) => console.error("initModels:", err));
  await refreshHistory().catch((err) => console.error("refreshHistory:", err));
  await refreshInsights().catch((err) => console.error("refreshInsights:", err));
  await refreshCalibrationStatus().catch((err) => console.error("refreshCalibrationStatus:", err));
  await refreshTemplateOptions().catch((err) => console.error("refreshTemplateOptions:", err));
})();
