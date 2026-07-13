/**
 * app.js — Focus Buddy main controller.
 *
 * Uses the Human library (https://github.com/vladmandic/human) fully
 * client-side for face + hand landmark detection. All inference runs
 * in this tab via TensorFlow.js (WebGL backend) — the video frame
 * never leaves the browser and is never written to disk or a network
 * request. Only derived booleans + a numeric score are stored locally.
 */

// ---------- Config ----------
const YAW_THRESHOLD_RAD = 0.45;   // ~26 degrees
const PITCH_THRESHOLD_RAD = 0.35; // ~20 degrees
const PHONE_HOLD_FRAMES = 8;      // consecutive frames hand-near-face before flagging
const LOG_INTERVAL_MS = 1000;

const humanConfig = {
  modelBasePath: "https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models/",
  backend: "webgl",
  debug: false,
  face: {
    enabled: true,
    detector: { rotation: true, maxDetected: 1 },
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
let sessionEndAt = null;
let phoneStreak = 0;
let running = false;
let liveChart = null;
let tabAway = false;
const chartLabels = [];
const chartData = [];

document.addEventListener("visibilitychange", () => {
  tabAway = document.hidden;
});

// ---------- DOM ----------
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const octx = overlay.getContext("2d");
const modelStatus = document.getElementById("model-status");
const scoreValue = document.getElementById("score-value");
const stateBadge = document.getElementById("state-badge");
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

const MODE_HINTS = {
  study: "Camera stream is processed frame-by-frame in this tab only. No frame is ever stored — only a numeric score.",
  meeting: "Meeting mode: speaking is not penalized. Switching to other browser tabs during the session is tracked as the main distraction signal.",
};

function applyModeUI() {
  const mode = modeSelect.value;
  modeHint.textContent = MODE_HINTS[mode];
  mTalkingLabel.textContent = mode === "meeting" ? "SPEAKING" : "TALKING";
  labelInput.placeholder = mode === "meeting"
    ? "meeting/lecture title (e.g. Sprint standup)"
    : "session label (e.g. SDA assignment)";
}
modeSelect.addEventListener("change", applyModeUI);

// ---------- Clock ----------
function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

// ---------- Chart setup ----------
function initChart() {
  const ctx = document.getElementById("live-chart").getContext("2d");
  liveChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [{
        data: chartData,
        borderColor: "#baff29",
        backgroundColor: "rgba(186,255,41,0.08)",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
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
          grid: { color: "#2a2f27" },
          ticks: { color: "#565b53", font: { size: 9 } },
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
    modelStatus.textContent = "MODELS READY";
    modelStatus.className = "status-pill ready";
    startBtn.disabled = false;
  } catch (err) {
    console.error("Model load failed:", err);
    modelStatus.textContent = "MODEL LOAD FAILED";
    modelStatus.className = "status-pill error";
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

// ---------- Detection heuristics ----------
function estimateLooking(face) {
  const angle = face?.rotation?.angle;
  if (!angle) return true; // fail-open: don't punish if angle unavailable
  const yaw = Math.abs(angle.yaw || 0);
  const pitch = Math.abs(angle.pitch || 0);
  return yaw < YAW_THRESHOLD_RAD && pitch < PITCH_THRESHOLD_RAD;
}

function handNearFace(hands, face) {
  if (!hands || !hands.length || !face) return false;
  const box = face.box; // [x, y, width, height]
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
    octx.strokeStyle = "#baff29";
    octx.lineWidth = 2;
    octx.strokeRect(box[0], box[1], box[2], box[3]);
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

async function detectLoop() {
  if (!running) return;
  try {
    const result = await human.detect(video);
    const face = result.face?.[0] || null;
    const facePresent = !!face;
    const lookingAtScreen = facePresent ? estimateLooking(face) : false;

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
  updateScoreDisplay(score, signals);

  if (currentSessionId) {
    FocusDB.logTick(currentSessionId, signals, score).catch((e) => console.error(e));
    pushChartPoint(score);
  }
}

function updateScoreDisplay(score, signals) {
  scoreValue.textContent = Math.round(score);
  applyStateBadge(signals);
}

function applyStateBadge(signals) {
  let label, cls;
  if (signals.tabAway) { label = "TAB SWITCH"; cls = "phone"; }
  else if (signals.phoneDetected) { label = "PHONE"; cls = "phone"; }
  else if (!signals.facePresent) { label = "NO FACE"; cls = "noface"; }
  else if (signals.eyesClosed) { label = "EYES CLOSED"; cls = "phone"; }
  else if (!signals.lookingAtScreen) { label = "LOOKING AWAY"; cls = "away"; }
  else if (signals.excessiveMovement) { label = "RESTLESS"; cls = "away"; }
  else if (signals.talking && scorer.weights.talkingPenalty > 0) { label = "TALKING"; cls = "away"; }
  else if (signals.talking) { label = "SPEAKING"; cls = "focused"; }
  else { label = "FOCUSED"; cls = "focused"; }
  stateBadge.textContent = label;
  stateBadge.className = "state-badge " + cls;
}

// ---------- Session control ----------
async function startSession() {
  await startWebcam();
  const mode = modeSelect.value;
  currentSessionId = await FocusDB.startSession(labelInput.value.trim(), mode);
  scorer = new FocusScorer({ mode });
  signalTracker.reset();
  phoneStreak = 0;
  tabAway = document.hidden;
  chartLabels.length = 0;
  chartData.length = 0;
  liveChart.update("none");

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  labelInput.disabled = true;
  modeSelect.disabled = true;
  durationSelect.disabled = true;

  const durationMin = parseFloat(durationSelect.value);
  if (durationMin > 0) {
    sessionEndAt = Date.now() + durationMin * 60000;
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
  stateBadge.textContent = "STANDBY";
  stateBadge.className = "state-badge";

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
    historyBody.innerHTML = '<tr><td colspan="10" class="empty-row">no sessions logged yet</td></tr>';
    return;
  }
  const rows = await Promise.all(sessions.map(async (s) => {
    const ticks = await FocusDB.getTicks(s.id);
    const sum = FocusDB.summarize(ticks);
    const mins = s.endedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : "--";
    const date = new Date(s.startedAt).toLocaleString("en-GB", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
    const modeLabel = s.mode === "meeting" ? "MEET" : "STUDY";
    return `<tr>
      <td>${date}</td>
      <td>${modeLabel}</td>
      <td>${s.label || "untitled"}</td>
      <td>${sum.n ? Math.round(sum.avgScore) : "--"}</td>
      <td>${mins}</td>
      <td>${sum.phonePickups}</td>
      <td>${sum.eyesClosedSecs}s</td>
      <td>${sum.talkingSecs}s</td>
      <td>${sum.movementSecs}s</td>
      <td>${sum.tabSwitches}</td>
    </tr>`;
  }));
  historyBody.innerHTML = rows.join("");
}

// ---------- Wiring ----------
startBtn.addEventListener("click", () => startSession().catch((err) => {
  console.error(err);
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
