# Glass Beads — Spatial Study 01

A hand-tracked spatial interaction study for the browser. Your webcam becomes the room, and a pile of glass stones sits in front of you: push them with an open hand, pick them up with a pinch or a fist, pull one apart with both hands to make it bigger, and let go mid-swing to throw it.

**Live demo:** https://jin-dalrae.github.io/xr-portfolio/

Best on a desktop or laptop with a webcam, in Chrome, Safari, Arc or Edge. Everything runs on-device; no video leaves the browser.

## Interactions

| Gesture | What happens |
| --- | --- |
| **Open hand** | Your fingertips, knuckles and palm are physical. Stones at your hand's depth can be pushed, swatted and rolled. Press slowly and the glass dents like slime. |
| **Pinch** (thumb + index) | Pick up the stone under your fingers. |
| **Fist** | Grab with your whole hand. Squeeze tighter to squish it. |
| **Both hands on one stone** | Pull apart to grow it (up to 3.2×), push together to shrink it. |
| **Release mid-swing** | Throw. Soft throws bounce off the edges of the room; hard throws fly out, and the stone comes back. |
| **Move hand toward / away from camera** | Changes depth. The depth of field follows your hand, so the stones you can reach are the sharp ones. |

Toolbar: **Pile** (gravity, stones rest in a glass tray) · **Float** (zero-g) · **Reset**. Keys: `R` reset, `G` toggle gravity.

**Mouse fallback:** drag to grab and throw, scroll while holding to change depth, shift + scroll to resize.

## How it works

- **Rendering:** [three.js](https://threejs.org) with hand-written GLSL. The camera feed is drawn as a full-screen background, and each stone samples the same feed through a screen-space ball-lens refraction. That's why your face appears flipped and magnified inside the glass, with chromatic dispersion at the edges. On top of that: absorption tint, thin-film iridescence on the rim, a studio softbox reflection, a caustic glow, frosting for sea glass and moonstone, and per-stone depth-of-field and haze.
- **Slime:** a squash-and-stretch spring and a fingertip dent are applied in the vertex shader (normals included, so the dimple catches the light). Impacts, carrying, squeezing and two-hand stretching drive the springs.
- **Hand tracking:** [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) (21 landmarks per hand, up to 2 hands, GPU). Hand depth is estimated from apparent palm size, and per-finger depth comes from MediaPipe's relative z.
- **Physics:** a small custom solver: sphere–sphere impulses with resting-contact handling, a bowl-shaped tray with rolling friction, kinematic hand colliders with swept tests so fast swipes don't tunnel, and throw velocity taken from the peak of recent tracked hand motion, so a throw still lands even if the camera loses your hand to motion blur.

## Run locally

No build step. Serve the folder over `localhost` (camera access requires a secure context):

```sh
python3 -m http.server 4317
# open http://localhost:4317
```

## Tuning

Constants at the top of [`src/main.js`](src/main.js):

- `HAND_NEAR` / `HAND_FAR`: palm size at your closest and farthest reach. Open the page with `#debug` to see live values next to your hand, and set these to match your setup.
- `PINCH_ON` / `PINCH_OFF`, `FIST_ON` / `FIST_OFF`: gesture thresholds (with hysteresis).
- `ESCAPE_SPEED`, `THROW_BOOST`, `FLICK_SPEED`: how throws feel.
- `SQUISH_SPEED`, `MAX_DENT`, `JELLY_K` / `JELLY_C`: how soft the slime is.

## Files

```
index.html     UI shell + import map (three.js and MediaPipe from jsDelivr)
style.css      visionOS-style glass panels
src/main.js    scene, physics, gestures, interaction
src/glass.js   stone palette, geometry, glass shader
src/floor.js   tray, contact shadows, caustics
src/hands.js   MediaPipe setup, pinch / fist / palm-size measures
```
