# AGENTS.md

## Mission

This repository contains the Farever asset pipeline and Astro site.

Primary goals:
- extract the four game PAKs into one merged extracted tree
- dump public-safe game data into the site
- export prefab/HMD models into GLB for the model browser
- build world map assets for the site
- keep the public site aligned with the current live game content

Secondary goals:
- use the reverse-engineering reference archives to improve runtime and shader parity
- preserve existing bug fixes and UX decisions unless the task explicitly changes them

## Hard rules

### Preserve working behavior unless the task says otherwise

This repo has a lot of fragile fixes. Avoid regressions.

Known examples:
- layout imports must stay `BaseLayout.astro`, never `BaseLayout.js`
- the four PAKs must merge into one extracted root: `.cache/extracted`
- the model browser stays prefab-level; child-part switching happens inside the viewer
- the prefab-part selector is shown only when there are 2 or more real child parts
- do not set `mesh.onBeforeRender = null`; leave it undefined or delete it
- map tile empty space should rely on the intended site background, not accidental extra backgrounds

### Prefer small, auditable changes

When fixing a bug:
- patch the narrowest layer that actually causes it
- avoid broad rewrites unless requested
- preserve file names and CLI entrypoints where possible

## Repository structure

- `apps/site` - Astro frontend
- `packages/pipeline` - orchestrator CLI used by the root scripts
- `packages/pak-extractor` - PAK extraction and DDS/PNG conversion
- `packages/content-dumper` - JSON, icon, and map data dumps into site public dirs
- `packages/model-tools` - prefab/HMD/GLB exporter
- `packages/map-tools` - minimap stitcher and map tile generation
- `config/farever.config.json` - central pipeline config
- `game-input/pak` - expected input PAKs
- `.cache/extracted` - merged extracted asset tree

## Standard commands

Run from the repo root:

```bash
npm install
npm run sync:game
npm run dev
npm run build
```

Other useful commands:

```bash
npm run extract:paks
npm run dump:site
npm run export:models
npm run stitch:maps
npm run clean
```

## Pipeline expectations

### Extractor

Expected PAKs:
- `res.pak`
- `res.levels.pak`
- `res.light.pak`
- `res.map.pak`

They must extract into one merged output tree:
- `.cache/extracted`

Not into:
- `.cache/extracted/res`
- `.cache/extracted/res.levels`
- `.cache/extracted/res.light`
- `.cache/extracted/res.map`

### Content dumper

The content dumper writes generated site data into:
- `apps/site/public/generated/data`
- `apps/site/public/generated/icons`

Map-related data also flows into generated site public dirs. Keep those paths consistent.

### Model export

The model exporter writes into:
- `apps/site/public/generated/model-library`

Batch export should produce one root `prefab-export-summary.json` in the model-library root, not one per subfolder.

### Map tools

The map step should produce the final Leaflet assets the site expects:
- `apps/site/public/generated/map/<map-id>/map.json`
- `apps/site/public/generated/map/<map-id>/<z>/<x>/<y>.webp`

## Astro and site conventions

### Layout imports

Always keep layout imports as `.astro`:

```astro
import BaseLayout from '../layouts/BaseLayout.astro';
import BaseLayout from '../../layouts/BaseLayout.astro';
```

Never rewrite them to `.js`.

### Model viewer

Important files:
- `apps/site/src/pages/models/index.astro`
- `apps/site/public/model-viewer/viewer-tree-multiprefab.js`

Keep these behaviors:
- browser tree = prefab-level
- child parts = viewer-level selector
- selector hidden for single-part prefabs
- auto-rotate and prefab-part controls live in the viewer overlay

### World map

Important files:
- `apps/site/src/pages/map.astro`
- `apps/site/src/scripts/world-map.ts`
- `apps/site/src/styles/global.css`

When changing map rendering:
- distinguish between page/CSS background issues and tile-generation issues
- avoid double-applying translucent backgrounds to both the canvas and tile layers unless intended
- if inner and outer backgrounds mismatch, determine whether the mismatch is caused by CSS layering or baked tile pixels

## Reverse-engineering references

If these archives are present locally, use them as references:
- decompiled game sources zip (`out-dec...zip`)
- disassembled game sources zip (`out-dis...zip`)
- decoded shader dump zip (`out-hxsm-decoded...zip`)
- Heaps source zip (`heaps-master...zip`)
- HashLink source zip (`hashlink-master...zip`)

Trust order when sources disagree:
1. observed current game behavior
2. disassembly (`out-dis`)
3. decoded shader artifacts (`out-hxsm-decoded`)
4. relevant Heaps / HashLink engine behavior
5. decompiled Haxe (`out-dec`)
6. current repo convenience code

Important files for shader and material work:
- `1328_GradMat.hx`
- `1328_GradMat.hx.disasm`
- `0039_Macros.hx`
- `0039_Macros.hx.disasm`
- decoded `.hxsl.txt` and `.ast.json` files from `out-hxsm-decoded`

Use the references like this:
- use decompiled files to discover names, types, and likely high-level intent
- use disassembly to resolve ambiguities or decompiler mistakes
- use decoded shader files to confirm actual shader structure and runtime semantics
- use Heaps/HashLink sources to understand engine-side conventions, shader APIs, transforms, and serialization/runtime behavior

## Model and prefab guidance

### General

- prefabs may contain multiple child model nodes
- prefabs may also contain constraints and non-model helper objects
- do not assume the first child model is the prefab

### Export behavior

- preserve multi-child prefab structure when the site viewer needs it
- nested `gradmat` under `model -> material -> gradmat` must be detected
- if behavior differs between single-part and multi-part prefabs, preserve both correctly

### Viewer behavior

- Combined = all real child model wrappers visible
- per-part mode = only the selected child wrapper visible
- hide the prefab-part control when there is 1 or 0 real child parts

### Three.js pitfall

Do not assign non-functions to `onBeforeRender`.

Bad:
```js
mesh.onBeforeRender = null;
```

Good:
```js
delete mesh.onBeforeRender;
```

## Map pipeline guidance

### Performance

Prefer:
- stitch once
- keep the stitched image in memory when possible
- resize once per zoom level
- slice tiles from in-memory image data
- use bounded parallelism for tile encoding

Avoid:
- unnecessary PNG round-trips
- re-decoding the stitched map for every tile
- serially encoding every tile when not needed

### Visual correctness

When backgrounds look wrong, ask:
1. Is the mismatch in CSS?
2. Is it in the generated tiles?
3. Are multiple translucent backgrounds stacking?
4. Is the tile padding transparent or baked with a color?

## Content-dumper guidance

The dumper still contains legacy scripts. Treat them as working but fragile.

When modifying them:
- prefer adapting wrappers and CLI paths first
- do not casually rewrite every legacy script unless necessary
- keep output filenames stable unless the frontend is updated in the same change

If changing dump schema:
- also update the site code that reads that schema
- do not leave half-migrated JSON formats

## PAK extractor guidance

The extractor is IO-heavy and fragile.

When optimizing it:
- preserve correctness first
- keep merged extraction behavior
- be careful with DDS queue concurrency and de-duplication
- if batching conversions, make missing duplicate `.dds` entries benign when a `.png` already exists

Do not silently skip asset types without documenting it.

## Validation checklist

After touching any area, run the narrowest relevant checks plus any affected end-to-end flow.

### If you change site code

```bash
npm run build
```

### If you change extractor, dumper, model, or map pipeline

```bash
npm run sync:game
```

### If you change the models viewer

Verify manually in the site:
- single-part prefab: no prefab-part selector
- multi-part prefab: selector appears and works
- golems still render with textures and colors
- no `onBeforeRender is not a function` errors

### If you change map generation

Verify manually in the site:
- the map loads from generated `public/generated/map/<id>`
- `map.json` exists
- zoom levels load
- the max zoomed-out background looks correct
- inner and outer background colors match as intended
- POIs and spawns still align reasonably with the map

## Ambiguous tasks

If asked to make the site match the game more closely:
- inspect current repo behavior
- inspect reverse-engineering references
- prefer the smallest change that improves parity
- explain uncertainty clearly

If asked to expose data or content that may be hidden or unreleased:
- do not default to exposing it
- prefer a safer public-facing interpretation

## Good agent behavior for this repo

Do:
- preserve working paths and CLI entrypoints
- use npm workspace commands from the repo root
- keep public-site behavior stable unless asked otherwise
- consult reverse-engineering references for shader/runtime parity issues
- leave concise comments only where they help future maintainers

Do not:
- rename imports or extensions casually
- flatten multiprefabs into single-child behavior by accident
- assume decompiled Haxe is authoritative when disassembly disagrees
- expose hidden content just because it exists in source data
- replace stable working code with large rewrites unless explicitly requested

## Preferred output style for changes

When making non-trivial changes, also update:
- the relevant README or inline note if behavior changed materially
- config comments or defaults if new behavior depends on configuration

If a fix addresses a previously fragile issue, preserve the rationale in a short comment near the fix.
