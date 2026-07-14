# Focus Buddy — Web App

Browser-based, local-only attention tracker for **solo study sessions
and online meetings/lectures**. No install, no server, no upload —
everything (webcam capture, face/hand detection, scoring, storage)
runs inside this single browser tab. Clean, modern interface with a
live focus ring, glass-style cards, and a per-user calibration step
for real accuracy instead of generic guesses.

## Calibration (accuracy)

Every session starts with a ~3 second calibration: sit naturally and
look at the screen while it measures *your* neutral head angle,
open-eye ratio, and natural mouth-landmark jitter. Everything after
that is judged relative to your own baseline instead of one generic
threshold for everyone — this is the single biggest accuracy lever
in the app (see `runCalibration()` in `app.js`).

"Looking away" also uses hysteresis: it takes 5 consecutive off-screen
frames to flag you as away, but only 2 good frames to clear it — so a
quick glance or a blink-adjacent frame doesn't cause flicker.

## Two modes

**Study Session** — for working alone. Talking is treated as a
distraction (on a call, chatting) like any other signal.

**Meeting / Lecture** — for Zoom/Teams/Meet calls or online classes.
Talking is *expected participation* and is not penalized — instead,
speaking time is tracked as a positive stat. The main distraction
signal becomes **switching to other browser tabs** mid-meeting (email,
other sites), tracked via the Page Visibility API and penalized more
heavily than in study mode.

Pick the mode from the dropdown before starting a session — it
changes the scoring weights, badge labels, and the metric names.

## Run it

Just open `index.html` in a browser — or for best results (camera
permissions behave more reliably over http/https than `file://`),
serve it locally:

```bash
cd focus-buddy-web
python3 -m http.server 8000
# then open http://localhost:8000
```

You can also deploy it as a static site — GitHub Pages works great,
same as your portfolio (`docs/` or root, no build step needed since
it's plain HTML/CSS/JS).

## Running alongside an actual meeting

Most browsers allow more than one tab to access the same webcam at
once, so you can typically keep Focus Buddy open in one tab while
Zoom/Meet/Teams runs in another (or in its own app) — both get a
camera feed. If your camera driver only allows exclusive access
(common on some Windows setups with certain webcams), you may need to
free up the camera from the meeting app first, or run Focus Buddy on
a secondary device/webcam. This is a hardware/driver limitation, not
something the app itself controls.

## How it works

- **Detection**: [Human](https://github.com/vladmandic/human), a
  TensorFlow.js library, runs face-mesh (468-point) + hand landmark
  detection entirely client-side (WebGL backend). Model weights load
  once from a CDN on first run; after that everything is local
  inference.
- **Looking away (sideways/tilted head)**: head yaw/pitch from
  `face.rotation.angle`, measured relative to your calibrated neutral
  position, with hysteresis to prevent flicker.
- **Eyes closed**: Eye Aspect Ratio (EAR) computed from 6 eye-mesh
  landmarks per eye, EMA-smoothed to reduce jitter, thresholded
  relative to your own calibrated open-eye baseline. Must stay below
  threshold for 500ms straight — a normal blink won't trigger it.
- **Talking / Speaking**: Mouth Aspect Ratio (MAR) tracked over a
  rolling 1.2s window; flagged when it's *varying* a lot rather than
  static, with the variance threshold calibrated against your own
  natural landmark-jitter noise floor. In study mode this is a
  penalty; in meeting mode it's just a tracked stat, and the badge
  shows "Speaking" instead of "Talking".
- **Excessive movement (dancing/fidgeting/restless)**: tracks how
  much the face's bounding-box center bounces around over a ~0.9s
  window, relative to face size.
- **Tab switching**: `document.visibilitychange` — captured even
  while the tab is hidden, since a plain `setInterval` keeps ticking
  in the background for this specifically (unlike the camera loop,
  which uses `requestAnimationFrame` and pauses when hidden).
- **Phone heuristic**: if a hand landmark stays near your face for
  several consecutive frames (typical phone-check posture), it's
  flagged. Still a geometric heuristic, not true object detection.
- **Scoring**: `scorer.js` — explainable additive penalties per
  signal, with separate weight sets for each mode, fully auditable,
  no black box.
- **Storage**: `db.js` — IndexedDB, scoped to this browser only. A
  CSV export button lets you pull your own session history out as a
  file, entirely client-side.

## Files

```
index.html   — layout (modern card-based UI, calibration overlay, score ring)
style.css    — design system: soft gradients, glass cards, Inter/Lexend
app.js       — webcam + calibration + detection loop + UI wiring
scorer.js    — focus score logic (mode-aware multi-signal weighting)
signals.js   — eye closure / talking / movement heuristics + calibration
db.js        — IndexedDB storage + CSV export
```

## Tuning

Top of `app.js`:
- `DEFAULT_YAW_THRESHOLD_RAD` / `DEFAULT_PITCH_THRESHOLD_RAD` — fallback
  thresholds used only if calibration fails (no face detected during
  the calibration window)
- `CALIBRATED_YAW_THRESHOLD_RAD` / `CALIBRATED_PITCH_THRESHOLD_RAD` —
  tighter thresholds used once your baseline is known
- `LOOK_AWAY_STREAK` / `LOOK_BACK_STREAK` — hysteresis frame counts
- `PHONE_HOLD_FRAMES`, `CALIBRATION_MS`

`SignalTracker.applyCalibration()` in `signals.js` — adjusts EAR and
talking thresholds relative to a measured baseline; see the method
comments for the exact multipliers.

`MODE_WEIGHTS` in `scorer.js` — separate penalty numbers for `study`
vs `meeting` mode. Change these directly to retune either mode.

## Known limitations (worth noting in a report/viva)

- Phone detection is a hand-near-face heuristic, not real object
  detection.
- "Talking/Speaking" detects mouth-movement rhythm, not audio — it
  can't tell talking-to-a-person apart from singing along to music,
  and can't identify *who* is speaking if multiple people are in frame.
- "Excessive movement" is relative motion of the face box, not full
  body pose.
- Tab-switch tracking only sees this browser tab — a different
  application entirely (alt-tab to a native app, second monitor)
  isn't caught by the Page Visibility API.
- Calibration is per-session, not persisted — if lighting or your
  seating position changes drastically mid-session, thresholds won't
  re-adjust until the next session.
- Model field names come from Human's documented API; if a library
  version bump changes the result shape, check the browser console.
- Requires camera permission and a browser with WebGL support.
- This is a **self-monitoring** tool — designed to run on your own
  device for your own awareness, not to covertly surveil someone
  else's meeting attendance without their knowledge.

## Possible extensions

- Persist calibration across sessions (with a "recalibrate" option)
- Break reminders after sustained low focus/engagement
- PWA manifest + service worker for offline model caching
- Swap the phone heuristic for a real object-detection model
- Picture-in-picture mode so the score stays visible while the actual
  meeting window has focus
