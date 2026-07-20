# Focus Buddy — Web App

Browser-based, local-only attention tracker for **solo study sessions
and online meetings/lectures**. No install, no server, no upload —
everything (webcam capture, face/hand detection, scoring, storage)
runs inside this single browser tab. Clean, modern interface with a
live focus ring, glass-style cards, and a per-user calibration step
for real accuracy instead of generic guesses.

## Calibration & precision (accuracy)

Every session starts with a ~3 second calibration: sit naturally and
look at the screen while it measures *your* neutral head angle,
open-eye ratio, and natural mouth-landmark jitter. Everything after
that is judged relative to your own baseline instead of one generic
threshold for everyone. The eye-closure baseline specifically uses a
**trimmed mean** — if you blink during calibration, that low sample
gets dropped instead of dragging your whole "eyes open" baseline down.

Beyond calibration, every behavioral signal now has **hysteresis**:
it takes a short streak of consecutive qualifying frames to turn a
signal on, and a streak of clean frames to turn it back off. This is
what stops a single noisy frame — a hand passing near your face, one
odd landmark reading — from flipping the badge for an instant. Applies
to: looking-away, eyes-closed, talking, movement, and phone detection.

**Movement** specifically no longer just measures "how much did the
face move" — it now also counts **direction reversals** within the
tracking window. A single calm shift in seating position has ~0
reversals and won't trigger "Restless"; genuine fidgeting or dancing
reverses direction repeatedly and does.

**Leaving the desk** now has a grace period: momentary tracking loss
(a hand passing by, a quick head turn, brief occlusion) is tolerated
for ~1.8s before it counts as "gone" — so it doesn't zero your score
for a blip. Beyond ~12 seconds of continuous absence, the badge
switches from "No face" to "Stepped away" to distinguish a longer
break from a momentary glitch. Each transition into sustained absence
is also counted as an "Away event" in your session metrics/history.

## Phone detection (accuracy)

Reworked from the ground up — the original version just checked "is any
hand within a wide circle around the face center", which fired just as
easily for resting your chin on your hand or scratching your face as it
did for actually holding a phone. The new `PhoneDetector` (in
`signals.js`):

- Checks proximity to the **ear region specifically** (via face-oval
  landmarks near each ear), not the face center
- Checks two points per hand (wrist + palm base), so an awkward wrist
  angle doesn't get missed
- Uses a **rolling-window ratio** ("near the ear for 60%+ of the last
  1.5s, and that window has to actually span most of its 1.5s target")
  instead of a bare consecutive-frame counter, so it can't be triggered
  by a couple of lucky samples right after a half-second touch
- Hysteresis on top of that ratio for the final on/off call

Verified with synthetic tests: a hand resting at face-center no longer
triggers it, a brief ~450ms touch doesn't either, and sustained contact
near the ear does.

## Persisted calibration, dark mode, and performance mode

**Persisted calibration** — after a successful calibration, the
baseline is saved to IndexedDB. Next time you start a session, "Use
saved calibration" is checked by default and the live 3-second
calibration is skipped entirely — useful if you're running several
short sessions back to back. Uncheck it (or hit "Clear all data") to
force a fresh calibration.

**Dark mode** — toggle in the top-right. Preference is remembered
across visits via `localStorage` (this is a real deployed site you
control, not a sandboxed environment, so that's a reasonable place
for a UI preference — session data itself still lives only in
IndexedDB).

**Performance mode** — a checkbox in session options that captures at
480×360 instead of 640×480 and disables hand tracking (via Human's
live-mutable `config` object) for that session, trading phone
detection for lower CPU/GPU load. Worth enabling on slower machines.

## Insights & PDF report

The Insights card (computed entirely from your local session history,
`insights.js`) shows: total sessions, minutes tracked, all-time average
focus, current day streak, your best-performing label, your most
common distraction type, and a trend sparkline across your last 20
sessions.

"Most common distraction type" compares different units (seconds of
eyes-closed vs. count of phone pickups vs. count of tab switches, etc.)
so it's directional, not a precise ranking — flagged here and in the
UI copy rather than presented as more rigorous than it is.

**PDF report** — via the "PDF report" link next to Export CSV,
generates a downloadable summary (jsPDF, entirely client-side): the
same insight stats, the trend chart as an embedded image, and a table
of your 25 most recent sessions. Useful for attaching to a portfolio
writeup or handing in as engagement evidence for a course.

## Backup, restore, and session templates

- **Backup / Restore** (footer links) — a full local backup as a
  downloadable JSON file: every session, every per-second tick, and
  every setting (including saved calibration). "Restore" loads a
  backup file back in — this **replaces** current local data, so
  it asks for confirmation first. This is the actual answer to "what
  if I clear my browser data by accident" — otherwise everything
  lives only in this one IndexedDB, in this one browser.
- **Session templates** — save the current label/project/mode/duration
  as a named preset ("Save as template"), then reload it with one
  click from the dropdown next time — useful for a recurring meeting
  you track every day rather than retyping the same fields.

## Break reminders & notifications

Two triggers, both toggleable via "Break reminders" in session
options (on by default):

- **Time-based** — a reminder every 25 minutes of continuous session,
  regardless of score.
- **Low-focus-based** — if your rolling average score stays below 45
  for a sustained ~3 minutes, a reminder fires once (not repeatedly)
  suggesting a break. A brief dip doesn't trigger it — it has to be
  sustained across the whole window.

Reminders show as a dismissible in-app banner, and — if you grant
permission when asked — also as a native browser notification, so
you'll see it even if you've switched away from the tab. Notification
permission is requested only when you start a session with reminders
enabled, never on page load.

**Keyboard shortcut**: press `Space` to start or stop a session,
whenever focus isn't inside a text field.

## Sharing with someone else (redacted reports, copy-as-email)

Anything shareable here is something **you** choose to generate and
send — never automatic, never live-viewable by someone else. That
distinction matters: this stays a self-monitoring tool, not a
surveillance one.

- **Copy summary** — the small copy icon next to any session in
  History copies a short plain-text summary to your clipboard: title,
  project, date, duration, and one overall engagement number. No
  phone/eyes/talking/movement breakdown, no tab-switch counts —
  appropriate to paste into an email or chat message.
- **Redacted exports (share-safe)** — a checkbox in session options.
  When checked, the PDF report drops the "most common distraction"
  line and is titled "Meeting Engagement Summary" instead of "Focus
  Buddy — Session Report" — a version built to hand to someone else,
  not to keep for your own detailed review.
- The full (non-redacted) PDF, CSV, and Insights view are always
  available for your own use regardless of this toggle — it only
  affects what a report built *for sharing* includes.

## Meeting notes & project tagging

- A **Notes** field is available during any session — action items,
  what was discussed, whatever's useful. Autosaves ~800ms after you
  stop typing (no save button needed), stored with the session.
  Notes show as a small icon (hover for the full text) in History,
  and are included in the detailed CSV export and redacted summaries.
- A **Project/client** tag lets you organize sessions beyond the
  per-meeting label — e.g. label "Sprint standup", project "Internal";
  label "Kickoff call", project "Client A". The Insights card has a
  project filter dropdown so you can see stats scoped to one project
  ("how did my Client A calls go this month?").

## Attendance-only mode

For meetings where you don't want engagement scrutiny at all — just
proof you were there and for how long. Selecting "Attendance only" as
the mode:

- Never requests camera access, never runs calibration or detection
- Just starts a timer and logs start/end timestamps
- Shows in History with duration instead of a focus score
- Feeds into the **Timesheet CSV** export (Date, Project, Task,
  Duration in decimal hours, Notes) — shaped for tools like Toggl or
  Harvest, deliberately omitting engagement data entirely since this
  mode is for time accounting, not attention data.

## Three modes

**Study Session** — for working alone. Talking is treated as a
distraction (on a call, chatting) like any other signal.

**Meeting / Lecture** — for Zoom/Teams/Meet calls or online classes.
Talking is *expected participation* and is not penalized — instead,
speaking time is tracked as a positive stat. The main distraction
signal becomes **switching to other browser tabs** mid-meeting (email,
other sites), tracked via the Page Visibility API and penalized more
heavily than in study mode.

**Attendance only** — no camera, no scoring, just a duration log. See
the "Attendance-only mode" section above.

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
- **Phone heuristic**: proximity to ear-region landmarks (not face
  center), rolling-window ratio, and hysteresis — see the "Phone
  detection" section above for the full rationale. Still a geometric
  heuristic, not true object detection, but far less prone to firing
  on chin-resting or face-scratching than the original version.
- **Scoring**: `scorer.js` — explainable additive penalties per
  signal, with separate weight sets for each mode, fully auditable,
  no black box.
- **Storage**: `db.js` — IndexedDB, scoped to this browser only. A
  CSV export button lets you pull your own session history out as a
  file, entirely client-side.

## Files

```
index.html   — layout (modern card-based UI, calibration overlay, score ring, insights)
style.css    — design system: soft gradients, glass cards, Inter/Lexend, dark theme
app.js       — webcam + calibration + detection loop + UI wiring + reports
scorer.js    — focus score logic (mode-aware multi-signal weighting)
signals.js   — eye/talking/movement/phone heuristics, calibration, hysteresis
insights.js  — cross-session aggregate stats + redacted summary formatting
db.js        — IndexedDB storage (sessions incl. project/notes, ticks, settings)
              + CSV/timesheet export + full JSON backup/restore + templates
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
- Hysteresis and the face-absence grace period trade a small amount of
  responsiveness for a large reduction in false positives — expect the
  badge to lag reality by roughly half a second to a couple of seconds
  by design, not as a bug.
- Model field names come from Human's documented API; if a library
  version bump changes the result shape, check the browser console.
- Requires camera permission and a browser with WebGL support.
- This is a **self-monitoring** tool — designed to run on your own
  device for your own awareness, not to covertly surveil someone
  else's meeting attendance without their knowledge.

## Possible extensions

- PWA manifest + service worker for offline model caching
- Swap the phone heuristic for a real object-detection model
- Picture-in-picture mode so the score stays visible while the actual
  meeting window has focus
