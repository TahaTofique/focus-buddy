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
  TensorFlow.js library, runs face-mesh + hand landmark detection
  entirely client-side (WebGL backend). Model weights load once from
  a CDN on first run; after that everything is local inference.
- **Attention signal**: head yaw/pitch from `face.rotation.angle` —
  if you're turned/tilted away from the screen beyond a threshold,
  you're marked "away."
- **Phone heuristic**: if a hand landmark stays near your face for
  several consecutive frames (typical phone-check posture), it's
  flagged. This is a heuristic, not true object detection — see
  limitations below.
- **Scoring**: `scorer.js` — same explainable rolling-average logic
  as the original design, fully auditable, no black box.
- **Storage**: `db.js` — IndexedDB, scoped to this browser only.
  Nothing is ever sent over the network except the one-time model
  download from the CDN.

## Files

```
index.html   — layout
style.css    — terminal/HUD styling (matches your portfolio palette)
app.js       — webcam + detection loop + UI wiring
scorer.js    — focus score logic
db.js        — IndexedDB storage
```

## Tuning

Top of `app.js`:
- `YAW_THRESHOLD_RAD` / `PITCH_THRESHOLD_RAD` — how far you can turn
  your head before it counts as "away" (defaults ~26°/20°)
- `PHONE_HOLD_FRAMES` — consecutive frames before a phone-check is
  flagged (reduces false positives from scratching your face etc.)

`FocusScorer` constructor in `scorer.js` — `windowSize`, `phonePenalty`,
`penaltyDecay`.

## Known limitations (worth noting in a report/viva)

- Phone detection is a hand-near-face heuristic, not real object
  detection — a proper v2 would run a lightweight on-device object
  detector for an actual phone shape.
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
