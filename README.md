# Glass Beads — Spatial Study 01

A hand-tracked spatial interaction study for the browser. Your webcam becomes the room. A pile of glass stones rests in a shallow bowl in front of you, and a frosted glass board floats to the side for sorting them. Reach in with your bare hands: push the stones, pick them up, stretch them, throw them, and pin them to the board by category.

**Live demo:** https://jin-dalrae.github.io/xr-portfolio/

Best on a desktop or laptop with a webcam, in Chrome, Safari, Arc or Edge. Everything runs on-device; no video leaves the browser. Without a camera, the mouse works too.

## What you can do

| Gesture | What happens |
| --- | --- |
| **Open hand** | Your fingertips, knuckles and palm are physical. Push, swat and roll the stones at your hand's depth. Press slowly and the glass dents like slime. |
| **Pinch** (thumb + index) | Pick up the stone under your fingers. |
| **Fist** | Grab with your whole hand. Squeeze tighter to squish it. |
| **Both hands on one stone** | Pull apart to grow it (up to 3.2×), push together to shrink it. |
| **Move a held stone toward or away from you** | It travels twice as far as your hand does, so you can bring it right up to the screen or send it to the back of the room. |
| **Let go mid-swing** | Throw. Stones bounce off the edges of the room and land back in the bowl or on the table below it. |
| **Carry a stone over the board** | It's drawn onto the glass, with a ring showing where it will land. Let go and it sticks in that row, sliding over so it doesn't overlap its neighbors. A fast flick still throws it. |
| **Pinch or grab a stone on the board** | Pulls it back off. |

**The board** has three category rows, **Warm**, **Cool** and **Clear** by default. Click a label to rename it. Pinned stones are solid: loose stones bounce off them, and hands brushing past don't knock them off. The arrangement and labels are saved in the browser, so your board is still there next time.

**Toolbar** (at the top, so the lower half stays clear for your hands): **Pile** (gravity) · **Float** (zero-g) · **Reset** (clears the board and pours every stone back into the bowl, keeping your row names). Keys: `R` reset, `G` toggle gravity, `D` camera & depth panel.

**Mouse:** drag to grab and throw, scroll while holding to change depth, shift + scroll to resize.

## Design notes

Some decisions that shaped the interaction:

- **Physical, not generated.** Stones never pop in, respawn or vanish. They're poured into the bowl and the physics settles them before the first frame, so the page opens on a pile gravity made. A thrown stone stays in the room until you put it back.
- **Your hand is the cursor.** No dots, skeletons or rings on your hand, and no on-screen instructions. Stones glow softly when they're within reach, and real fingers pass in front of the glass that's behind them.
- **Open hand touches, closed hand grabs.** Early on, fingertips shoved away the very stone you were reaching to pinch. Making the open hand physical and the pinching or fisted hand a grabber resolved it.
- **Throws that survive motion blur.** A fast flick blurs the hand and the camera loses it at exactly the moment you let go. Throw velocity is taken from the last moments the hand was tracked, and a loosening grip at speed releases right away.
- **Depth you can read on a flat screen.** Depth of field follows your hand, so the stones you can reach are the sharp ones. A held stone keeps its own size and depth when picked up, and moves only when your hand really moves toward or away from you.
- **Glass that belongs in your room, still looking like glass.** The camera feed stays ungraded, and the glass takes its tint and reflections from your room, but it keeps crisp studio lighting and full resolution. Matching the webcam's softness made it look like a sticker.
- **Calm insides.** A glass ball shows a flipped, moving picture of the room, which read as chaotic. Each stone instead bends what's behind it gently, with a static texture inside.

## How it works

- **Glass:** [three.js](https://threejs.org) with hand-written GLSL. Each stone transmits the camera feed, bent gently (magnified, never flipped) and slightly softened. Color is absorbed Beer–Lambert style (deeper in thick centers, nearly clear at thin rims), with a faint rainbow sheen on the rim, a caustic glow, and per-stone depth of field and haze. Over a bright room the glass gets a little extra depth and a darker inner edge.
- **Textures:** surfaces are smooth; each stone has a static look inside, fixed in its own space: clear, frosted (sea glass, rose quartz, moonstone), seeded (tiny air bubbles at two depths) or ribbon (a cat's-eye band of color).
- **Stones:** 12 hero stones (round beads, pebbles, eggs, rings) and 30 small chips borrowing their tones.
- **Slime:** a squash-and-stretch spring and a fingertip dent in the vertex shader, with normals, so the dimple catches the light. Impacts, carrying, squeezing and stretching drive the springs.
- **Hand tracking:** [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker), 21 joints per hand, up to two hands, on the GPU. Pinch and fist are measured on MediaPipe's metric 3D hand, so they hold up as the hand rotates.
- **Depth from a plain webcam**, three ways (switch live in the `D` panel):
  - **Mirror** (default): the hand's 3D skeleton is fitted to its image (least squares over all 21 joints) for its real distance, and [Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) measures your face's distance from the iris (about 11.7 mm across in nearly everyone) and eye spacing. Their ratio places your hand in the room: level with your face is the back, reaching toward the screen is the front. The unknown camera lens cancels out.
  - **Metric:** the fitted hand distance, mapped onto a self-calibrating range of your reach. Used automatically when your face isn't visible.
  - **Palm:** apparent palm size, kept for comparison.

  Every joint gets its own depth, so a finger pointing at the screen reaches deeper than the palm behind it. Over the bowl, screen height adds a second cue: like a table in perspective, lower on screen is nearer. It's blended in, and frozen while you hold a stone so lifting it doesn't push it deeper.
- **Matching the room:** the feed is decoded to linear light with automatic black-level and exposure correction (bright rooms make webcams run hot and hazy). A 64×36 probe of each frame finds the room's average color and brightest light for the glass's tint and reflections. A soft depth mask drawn from the hand skeleton lets real hands cover the glass behind them, and stones cast shadows onto the hand beneath them.
- **Physics:** a small custom solver tuned for heavy but lively glass: strong gravity with real bounce, clink and wobble; friction in the bowl so stones roll a little, then settle; sphere–sphere impulses with resting contacts; screen-edge walls, a ceiling and an invisible table so nothing leaves the room. Hands are kinematic colliders with swept tests so fast swipes don't tunnel, and held stones trail the hand slightly for weight.

## Run locally

No build step. Serve the folder over `localhost` (camera access needs a secure context):

```sh
python3 -m http.server 4317
# open http://localhost:4317
```

## Tuning

Press `D` (or open the page with `#debug`) for the camera & depth panel: exposure bias, depth method, camera field of view, and live face and hand distances with each method's estimate.

Constants at the top of [`src/main.js`](src/main.js):

| Constants | Controls |
| --- | --- |
| `GRAVITY`, `RESTITUTION`, `TRAY_GRIP`, `SPIN`, `JELLY_K` / `JELLY_C` | How heavy and how lively the stones feel |
| `HOLD_DEPTH_GAIN`, `HAND_Z_FRONT` / `HAND_Z_BACK`, `Z_MAX` | How far your reach carries in depth |
| `MIRROR_NEAR` / `MIRROR_FAR` | Hand-to-face distance ratio at the front and back of the room |
| `TRAY_DEPTH`, `PILE_LIFT` | How much screen height drives depth over the bowl |
| `THROW_BOOST`, `FLICK_SPEED`, `HOLD_FOLLOW` | How throws and carrying feel |
| `TOUCH_STRENGTH`, `SQUISH_SPEED`, `MAX_DENT` | How hands push and dent the glass |
| `PINCH_ON` / `PINCH_OFF`, `FIST_ON` / `FIST_OFF` | Gesture thresholds (with hysteresis) |
| `WALL_THROW` | Released over the board slower than this, a stone sticks |

The bowl's height, curvature, position and tilt are `FLOOR_Y`, `BOWL_X`, `BOWL_Z`, `BOWL_ZC` and `TILT` in [`src/floor.js`](src/floor.js). The board's rows, default labels and placement are `WALL_ROWS`, `DEFAULT_LABELS`, `WALL_Z` and `WALL_YAW` in [`src/wall.js`](src/wall.js).

## Files

```
index.html     UI shell + import map (three.js and MediaPipe from jsDelivr)
style.css      visionOS-style glass panels and labels
src/main.js    scene, physics, gestures, interaction
src/glass.js   stone palette, geometry, glass shader
src/floor.js   the bowl: shape, collisions, ray hits, contact shadows, caustics
src/wall.js    the glass board: category rows, sticking, labels, saved layout
src/room.js    room light probe, hand occlusion mask
src/hands.js   MediaPipe setup, gestures, hand pose and face distance solvers
```
