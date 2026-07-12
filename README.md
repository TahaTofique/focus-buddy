# Focus Buddy — Web App

Browser-based, local-only study focus tracker. No install, no server,
no upload — everything (webcam capture, face/hand detection, scoring,
storage) runs inside this single browser tab.

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
- **Talking**: Mouth Aspect Ratio (MAR) tracked over a rolling
  1.2s window; if it's *varying* a lot (mouth opening/closing
  rhythmically) rather than static, that's flagged as talking. A
  single yawn or resting mouth won't trigger this — it's the
  variance, not the raw opening, that matters.
- **Excessive movement (dancing/fidgeting/restless)**: tracks how
  much the face's bounding-box center bounces around over a ~0.9s
  window, relative to face size. Sustained bouncing beyond a
  threshold gets flagged.
- **Phone heuristic**: if a hand landmark stays near your face for
  several consecutive frames (typical phone-check posture), it's
  flagged. Still a geometric heuristic, not true object detection.
- **Scoring**: `scorer.js` — explainable additive penalties per
  signal (see comments in the file for exact numbers), fully
  auditable, no black box.
- **Storage**: `db.js` — IndexedDB, scoped to this browser only.
  Nothing is ever sent over the network except the one-time model
  download from the CDN.

## Files

```
index.html   — layout
style.css    — terminal/HUD styling (matches your portfolio palette)
app.js       — webcam + detection loop + UI wiring
scorer.js    — focus score logic (multi-signal weighting)
signals.js   — eye closure / talking / movement heuristics
db.js        — IndexedDB storage
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

`FocusScorer` constructor in `scorer.js` — per-signal penalty weights
(`lookAwayPenalty`, `eyesClosedPenalty`, `talkingPenalty`,
`movementPenalty`, `phonePenalty`), plus `windowSize`/`penaltyDecay`
for smoothing.

## Known limitations (worth noting in a report/viva)

- Phone detection is a hand-near-face heuristic, not real object
  detection — a proper v2 would run a lightweight on-device object
  detector for an actual phone shape.
- "Talking" detects mouth-movement rhythm, not audio — it can't tell
  the difference between talking to a person, singing along to music,
  or chewing gum vigorously. It's a proxy, not a transcript.
- "Excessive movement" is relative motion of the face box, not full
  body pose — energetic dancing that keeps the face still (e.g.
  swaying from the shoulders down) may not trigger it, while a lot of
  head-shaking to music will.
- All thresholds (EAR, MAR variance, movement ratio) are generic
  defaults, not calibrated per user, per lighting condition, or per
  camera. Expect to tune them slightly for your own setup — the
  tuning section above tells you exactly which constants to touch.
- Head-pose thresholds are generic, not calibrated per user.
- Model field names come from Human's documented API; if a library
  version bump changes the result shape, check the browser console —
  `console.error` logs will point at the exact mismatch. First run,
  it's worth doing `console.log(result)` inside `detectLoop` once to
  confirm the shape matches your installed version.
- Requires camera permission and a browser with WebGL support.

## Possible extensions

- Break reminders after sustained low focus
- Export session history as CSV
- PWA manifest + service worker for offline model caching
- Swap the phone heuristic for a real object-detection model
