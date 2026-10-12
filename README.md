# Glass Beads — Spatial Study 01

A hand-tracked spatial interaction study for the browser. Your webcam becomes the room, and a glass bowl of stones is held out in front of you. Push the stones with an open hand, pick one up with a pinch or a fist, pull one apart with both hands to make it bigger, and let go mid-swing to throw it.

The stones are meant to feel physical rather than generated: they're poured in and settle under gravity, they stack, they keep their size and depth when you pick them up, and nothing ever pops in or vanishes. A thrown stone stays in the room, bouncing off its edges and landing on the table, until you put it back.

**Live demo:** https://jin-dalrae.github.io/xr-portfolio/

Best on a desktop or laptop with a webcam, in Chrome, Safari, Arc or Edge. Everything runs on-device; no video leaves the browser.

## Interactions

| Gesture | What happens |
| --- | --- |
| **Open hand** | Your fingertips, knuckles and palm are physical. Stones at your hand's depth can be pushed, swatted and rolled. Press slowly and the glass dents like slime. |
| **Pinch** (thumb + index) | Pick up the stone under your fingers. |
| **Fist** | Grab with your whole hand. Squeeze tighter to squish it. |
| **Both hands on one stone** | Pull apart to grow it (up to 3.2×), push together to shrink it. |
| **Release mid-swing** | Throw. Stones bounce off the edges of the room and land in the bowl or on the table. |
| **Move hand toward / away from camera** | Changes depth. The depth of field follows your hand, so the stones you can reach are the sharp ones. A held stone keeps its own depth and moves only as much as your hand does. |
| **Move hand up / down over the bowl** | Like a table seen in perspective, lower on screen is nearer and higher is farther back in the bowl. |

Toolbar (top, so the lower half stays clear for your hands): **Pile** (gravity, stones in the bowl) · **Float** (zero-g) · **Reset** (pours everything back into the bowl). Keys: `R` reset, `G` toggle gravity, `D` camera & depth panel. There are no on-screen instructions; the interaction is meant to be discovered by reaching in.

**Mouse fallback:** drag to grab and throw, scroll while holding to change depth, shift + scroll to resize.

## How it works

- **Glass:** [three.js](https://threejs.org) with hand-written GLSL. The camera feed is the background, and each stone transmits the same feed: bent gently (magnified, never flipped) and slightly softened, so the inside reads as calm light rather than a moving picture. Color is absorbed Beer–Lambert style (thick centers deeper, thin rims nearly clear), with a faint rainbow sheen on the rim, a caustic glow, and per-stone depth of field and haze.
- **Textures:** each stone has a static texture carved in its own space, so it only moves when the stone turns: clear, frosted (sea glass, rose quartz, moonstone), fluted ribs, seeded (tiny air bubbles at two depths inside), ribbon (a cat's-eye band of color) and hammered dimples.
- **Bowl:** a round glass bowl tipped about 26° toward the viewer, with a glass rim that refracts the room like the stones do. Stones are poured in on load and the physics settles them before the first frame, so the page opens on a pile gravity made.
- **Slime:** a squash-and-stretch spring and a fingertip dent are applied in the vertex shader (normals included, so the dimple catches the light). Impacts, carrying, squeezing and two-hand stretching drive the springs.
- **Hand tracking:** [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) (21 landmarks per hand, up to 2 hands, GPU). Pinch and fist are measured on MediaPipe's metric 3D hand, so they hold up as the hand rotates.
- **Depth sensing:** a webcam has no depth sensor, so depth is reconstructed three ways (switch live with `D`):
  - **Mirror** (default): the screen is treated as a mirror. The hand's 3D pose is fitted to its image (least-squares, all 21 joints) to get its distance, and [Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) measures your face's distance from the iris (~11.7 mm in nearly everyone) and eye-corner spacing. Their *ratio* places your hand in the room: level with your face is the back, reaching toward the screen is the front. The unknown camera lens cancels out of the ratio.
  - **Metric:** the fitted hand distance in meters, mapped onto a self-calibrating range of your reach. Used automatically when your face isn't visible.
  - **Palm:** apparent palm size only, the original heuristic, kept for comparison.

  Every joint gets its own metric depth, so a finger pointing at the screen reaches deeper than the palm behind it.
- **Screen height as depth:** over the bowl, a ray from the camera through your palm lands somewhere in the bowl, and that depth is blended with the measured one (up to 65%, strongest low on the screen). It's steadier than distance-from-camera alone. While you hold a stone the blend is frozen, so lifting it doesn't push it deeper.
- **Matching the real room:** the camera feed stays ungraded (decoded to linear light, with automatic black-level and exposure correction for bright rooms that make webcams run hot and hazy). A 64×36 probe of each frame finds the room's average color and its brightest light; the glass takes its highlight direction and color from that light and its reflections from a blurred copy of the room. Stones render at about the camera's resolution, so they're no sharper than the video around them. Real hands occlude the glass via a soft depth mask drawn from the hand skeleton, and stones cast shadows onto the hand beneath them.
- **Physics:** a small custom solver tuned for heavy glass: strong gravity, low bounce, Coulomb friction in the bowl so stones settle and stay where they settle, sphere–sphere impulses with resting-contact handling, and screen-edge walls plus an invisible table so nothing leaves the room. Hands are kinematic colliders with swept tests so fast swipes don't tunnel; held stones trail the hand slightly for weight; throw velocity comes from the peak of recent tracked hand motion, so a throw still lands even if the camera loses your hand to motion blur.

## Run locally

No build step. Serve the folder over `localhost` (camera access requires a secure context):

```sh
python3 -m http.server 4317
# open http://localhost:4317
```

## Tuning

Constants at the top of [`src/main.js`](src/main.js):

- Press `D` (or open the page with `#debug`) for the camera & depth panel: exposure bias, depth method, camera FOV, live face/hand distances and each method's estimate.
- `MIRROR_NEAR` / `MIRROR_FAR`: hand-to-face distance ratio at the front and back of the room.
- `HAND_NEAR` / `HAND_FAR`: palm method only.
- `PINCH_ON` / `PINCH_OFF`, `FIST_ON` / `FIST_OFF`: gesture thresholds (with hysteresis).
- `THROW_BOOST`, `FLICK_SPEED`, `HOLD_FOLLOW`: how throws and carrying feel.
- `GRAVITY`, `TRAY_GRIP`, `RESTITUTION`: how heavy the stones feel.
- `TRAY_DEPTH`, `PILE_LIFT`: how much screen height drives depth over the bowl.
- In [`src/floor.js`](src/floor.js): `TRAY_TILT`, `TRAY_RADIUS`, `BOWL_K` for the bowl's angle, size and depth.
- `SQUISH_SPEED`, `MAX_DENT`, `JELLY_K` / `JELLY_C`: how soft the slime is.

## Files

```
index.html     UI shell + import map (three.js and MediaPipe from jsDelivr)
style.css      visionOS-style glass panels
src/main.js    scene, physics, gestures, interaction
src/glass.js   stone palette, geometry, glass shader
src/floor.js   the bowl: shape, collisions, ray hits, contact shadows, caustics
src/room.js    room light probe, hand occlusion mask
src/hands.js   MediaPipe setup, gestures, hand pose + face distance solvers
```
