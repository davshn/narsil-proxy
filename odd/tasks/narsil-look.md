# Narsil look and day/night theme

Objective: replace the steel-shard look with the narsilPet / narsil-skin visual identity, and switch light/dark by time of day.
Branch: feat/narsil-agent. Test runner: `npm test`, `npm run typecheck`, `npm run build`.

## Specs

- S1: "ahora quiero que tenga la estetica de narsil-pet, mi mod de claude buscalo en proyectos"
- S2: "que cambie entre version clara/oscura de acuerdo a la hora tal y como hace en claude"
  - Verified by the parent: narsilPet itself only follows `prefers-color-scheme`. The time-based switch the user sees in Claude comes from their narsil-skin mod: `isDay = hour >= 6 && hour < 18` on the local clock, re-checked every 10 s, light theme `narsil-light`, dark theme `narsil`.
- S3: the avatar is Narsil, the chibi sea serpent from narsilPet (`E:\Proyectos\narsilPet\assets\<pose>-<claro|oscuro>.png` stills, 86×150, and `assets\anim\<pose>-<claro|oscuro>.webp` loops). Her pose reflects state:
  - `base` when idle;
  - `trabajando` while emails are being triaged;
  - `necesita` when unread mail waits or a meeting reminder fires;
  - `error` when there is an error;
  - `terminado` briefly after an action succeeds.
  The claro art is used in the light theme and the oscuro art in the dark theme.
- S4: the palette is narsil-skin's.
  - Dark: surfaces `#0f1a2c #142339 #192a44 #1c2f4c`; text `#dce6fa #b4c4e0 #93a6c8`; accent `#5aaeff`; danger `#ff5a6e`; success `#5fd3a0`; warning `#ffc94d`.
  - Light: surfaces `#c9e7f1 #d8eef6 #e8f5fa`; text `#0f2f47 #26475f #3a5b72`; accent `#1f83a8`; danger `#c2334a`; success `#2e8a5a`; warning `#b07a12`.
  - Plus narsilPet's water motif and status colors where they fit.
- S5: UI stays in neutral Spanish; `prefers-reduced-motion` is respected.

## Log

- L1 (2026-11-26): the user's request quoted in S1 and S2. An explorer mapped narsilPet (GPL-3.0, author Davshn), narsil-skin (MIT) and narsil-android. The art and code are the user's own. The animated loops came from Veo/Flow videos.
- L2: Writer finished. Parent recheck: 160/160 tests, typecheck and build pass. Captures of both themes reviewed by the parent. The light-theme accent and warning are darkened for contrast. The error and terminado poses were not captured. Risk: none (renderer visuals, a pure module and the dock size).
