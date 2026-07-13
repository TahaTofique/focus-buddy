# Focus Buddy — Web App

Browser-based, local-only attention tracker for **solo study sessions
and online meetings/lectures**. No install, no server, no upload —
everything (webcam capture, face/hand detection, scoring, storage)
runs inside this single browser tab.

## Two modes

**Study Session** — for working alone. Talking is treated as a
distraction (on a call, chatting) like any other signal.

**Meeting / Lecture** — for Zoom/Teams/Meet calls or online classes.
Talking is *expected participation* and is not penalized — instead,
speaking time is tracked as a positive stat. The main distraction
signal becomes **switching to other browser tabs** mid-meeting (email,
other sites), which is tracked via the Page Visibility API and
penalized more heavily than in study mode.

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
  `face.rotation.angle`.
- **Eyes closed**: Eye Aspect Ratio (EAR) computed from 6 eye-mesh
  landmarks per eye. Must stay below threshold for 600ms straight to
  count — a normal blink (~100-400ms) won't trigger it.
- **Talking / Speaking**: Mouth Aspect Ratio (MAR) tracked over a
  rolling 1.2s window; if it's *varying* a lot (mouth opening/closing
  rhythmically) rather than static, that's flagged. In study mode this
  is a penalty; in meeting mode it's just a tracked stat (not
  penalized), and the badge shows "SPEAKING" instead of "TALKING".
- **Excessive movement (dancing/fidgeting/restless)**: tracks how
  much the face's bounding-box center bounces around over a ~0.9s
  window, relative to face size.
- **Tab switching**: `document.visibilitychange` — if you switch to
  another browser tab, that's logged immediately, even while the tab
  is hidden (a plain `setInterval` keeps ticking in the background for
  this specifically, since `requestAnimationFrame` — used for the
  live camera detection — pauses when a tab isn't visible).
- **Phone heuristic**: if a hand landmark stays near your face for
  several consecutive frames (typical phone-check posture), it's
  flagged. Still a geometric heuristic, not true object detection.
- **Scoring**: `scorer.js` — explainable additive penalties per
  signal, with separate weight sets for each mode (see comments in
  the file for exact numbers), fully auditable, no black box.
- **Storage**: `db.js` — IndexedDB, scoped to this browser only.
  Nothing is ever sent over the network except the one-time model
  download from the CDN. A CSV export button lets you pull your own
  session history out as a file (e.g. for a personal engagement log),
  entirely client-side — no server involved there either.

## Files

```
index.html   — layout
style.css    — terminal/HUD styling (matches your portfolio palette)
app.js       — webcam + detection loop + UI wiring + tab tracking
scorer.js    — focus score logic (mode-aware multi-signal weighting)
signals.js   — eye closure / talking / movement heuristics
db.js        — IndexedDB storage + CSV export
```

## Tuning

Top of `app.js`:
- `YAW_THRESHOLD_RAD` / `PITCH_THRESHOLD_RAD` — how far you can turn
  your head before it counts as "away" (defaults ~26°/20°)
- `PHONE_HOLD_FRAMES` — consecutive frames before a phone-check is
  flagged

`SignalTracker` constructor in `signals.js`:
- `earThreshold` (default 0.21) — lower = eyes have to be more
  closed before it counts
- `eyesClosedMs` (default 600) — how long eyes must stay closed
  before it's not just a blink
- `marTalkStddevThreshold` (default 0.018) — lower = more sensitive
  to small mouth movements
- `movementRatioThreshold` (default 0.32) — lower = more sensitive
  to head/face wobble

`MODE_WEIGHTS` in `scorer.js` — separate penalty numbers for `study`
vs `meeting` mode (look-away, eyes-closed, talking, movement, tab-away,
phone). Change these directly to retune either mode.

## Known limitations (worth noting in a report/viva)

- Phone detection is a hand-near-face heuristic, not real object
  detection — a proper v2 would run a lightweight on-device object
  detector for an actual phone shape.
- "Talking/Speaking" detects mouth-movement rhythm, not audio — it
  can't tell talking-to-a-person apart from singing along to music or
  chewing gum vigorously. It's a proxy, not a transcript, and it
  can't distinguish *who* is speaking if multiple people are in frame.
- "Excessive movement" is relative motion of the face box, not full
  body pose — energetic movement that keeps the face still may not
  trigger it, while head-shaking will.
- Tab-switch tracking only sees *this browser*. Switching to a
  different application entirely (e.g. alt-tabbing to a native app,
  or a second monitor) isn't caught by the Page Visibility API — it
  only fires when the tab itself loses visibility.
- All thresholds are generic defaults, not calibrated per user, per
  lighting condition, or per camera. Expect to tune them slightly for
  your own setup — the tuning section above tells you exactly which
  constants to touch.
- Model field names come from Human's documented API; if a library
  version bump changes the result shape, check the browser console —
  `console.error` logs will point at the exact mismatch. First run,
  it's worth doing `console.log(result)` inside `detectLoop` once to
  confirm the shape matches your installed version.
- Requires camera permission and a browser with WebGL support.
- This is a **self-monitoring** tool — it's designed to run on your
  own device for your own awareness, not to covertly surveil someone
  else's meeting attendance without their knowledge.

## Possible extensions

- Break reminders after sustained low focus/engagement
- Per-mode break/reminder thresholds
- PWA manifest + service worker for offline model caching
- Swap the phone heuristic for a real object-detection model
- Full-screen / picture-in-picture mode so it's easier to keep an eye
  on the score readout while the actual meeting window has focus
