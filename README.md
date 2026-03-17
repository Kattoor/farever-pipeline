# Farever Pipeline

This repository extracts Farever game assets, converts the public-safe data into site-ready files, exports prefab/HMD models to GLB, and serves an Astro site for browsing the results.

## What it does

- extracts the four game PAK files into one merged asset tree
- dumps data and icons into the site's generated public output
- exports prefab and HMD models into the model library used by `/models`
- builds generated world map assets for the site

## Repository layout

- `apps/site` - Astro frontend
- `packages/pipeline` - top-level CLI that runs the asset pipeline
- `packages/pak-extractor` - PAK extraction and texture conversion
- `packages/content-dumper` - data and icon dumps for the site
- `packages/model-tools` - prefab/HMD/GLB export tools
- `packages/map-tools` - world map stitching and tile generation
- `config/farever.config.json` - central pipeline configuration
- `game-input/pak` - input folder for the game's `.pak` files

## Getting started

1. Install dependencies:

```bash
npm install
```

2. Put these game files into `game-input/pak/`:

- `res.pak`
- `res.levels.pak`
- `res.light.pak`
- `res.map.pak`

The folder is kept in git with a `.gitkeep` file so you can drag the `.pak` files straight into it after cloning.

3. Run the full pipeline:

```bash
npm run sync:game
```

4. Start the site:

```bash
npm run dev
```

## Useful commands

```bash
npm run extract:paks
npm run dump:site
npm run export:models
npm run stitch:maps
npm run build
npm run clean
```

## Generated output

- extracted assets: `.cache/extracted`
- site data, icons, maps, and model library: `apps/site/public/generated`
- exported models: `apps/site/public/generated/model-library`
- map output: `apps/site/public/generated/map`

## Notes

- The reverse-engineering reference archives used during development are local-only and are ignored by git under `info/`.
- The model browser reads from the generated model library, so rerun the pipeline after changing extraction or export code.
