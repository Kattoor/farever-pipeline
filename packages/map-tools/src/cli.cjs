#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { runTaskList, consola } = require('@farever/cli-utils');

const MAP_TILE_CHUNKS_PER_SIDE = 3;
const DEFAULT_TILE_SIZE = 256;
const MAP_BACKGROUND = { r: 17, g: 17, b: 17, alpha: 0 };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function floorDiv(a, b) { return Math.floor(a / b); }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }

function parseMinimapTileName(file) {
  const m = file.match(/^(-?\d+)_(-?\d+)_(\d+)\.png$/i);
  if (!m) return null;
  return { tileX: parseInt(m[1], 10), tileY: parseInt(m[2], 10), tileRes: parseInt(m[3], 10) };
}

function parseChunkFromPath(p) {
  const parts = p.split(/[\\/]/);
  for (const seg of parts) {
    const m = seg.match(/^L(\d+)_([+-]?\d+)_([+-]?\d+)$/);
    if (m) return { level: parseInt(m[1], 10), I: parseInt(m[2], 10), J: parseInt(m[3], 10), id: seg };
  }
  return null;
}

function findNodes(root, predicate, out = []) {
  if (!root || typeof root !== 'object') return out;
  if (predicate(root)) out.push(root);
  if (Array.isArray(root.children)) for (const c of root.children) findNodes(c, predicate, out);
  return out;
}

function inferWorldPrefabPath(worldRootDir) {
  const parent = path.dirname(worldRootDir);
  const datBase = path.basename(worldRootDir);
  if (datBase.endsWith('.dat')) return path.join(parent, datBase.slice(0, -4) + '.prefab');
  return path.join(parent, 'W1_Siagarta.prefab');
}

function loadWorldParams(worldPrefabPath) {
  const world = readJson(worldPrefabPath);
  const terrainNodes = findNodes(world, (n) => n && typeof n === 'object' && n.type === 'gterrain');
  if (!terrainNodes.length) throw new Error('Could not find gterrain node in world prefab.');
  const worldNodes = findNodes(world, (n) => n && typeof n === 'object' && n.type === 'world' && n.name === 'gameplayData');
  if (!worldNodes.length) throw new Error('Could not find gameplayData world node in world prefab.');
  const terrain = terrainNodes[0];
  const gameplay = worldNodes[0];
  const terrainCellsPerFilePow = terrain.cellsPerFilePow;
  if (typeof terrainCellsPerFilePow !== 'number') throw new Error('terrain.cellsPerFilePow missing in world prefab.');
  const gameplayWorldUnit = typeof gameplay.worldUnit === 'number' ? gameplay.worldUnit : 1;
  const gameplayCellsPerFilePow = 5;
  const gameplayBaseChunkSize = (1 << gameplayCellsPerFilePow) * gameplayWorldUnit;
  const terrainChunkWidth = (1 << terrainCellsPerFilePow) * 3;
  const tileWorld = terrainChunkWidth * MAP_TILE_CHUNKS_PER_SIDE;
  const loadedChunkIds = new Set(Array.isArray(gameplay.chunkData) ? gameplay.chunkData.map((x) => x.id) : []);
  return { terrainCellsPerFilePow, gameplayCellsPerFilePow, gameplayWorldUnit, gameplayBaseChunkSize, terrainChunkWidth, tileWorld, loadedChunkIds };
}

async function listFilesRecursive(rootDir) {
  const out = [];
  async function walk(dir) {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  }
  await walk(rootDir);
  return out;
}

async function stitchMinimapToRaw(minimapDir, tileWorld) {
  const files = await fs.promises.readdir(minimapDir);
  const tiles = [];
  for (const f of files) {
    const info = parseMinimapTileName(f);
    if (!info) continue;
    tiles.push({ ...info, filePath: path.join(minimapDir, f) });
  }
  if (!tiles.length) throw new Error(`No minimap tiles found in ${minimapDir}`);

  const meta0 = await sharp(tiles[0].filePath).metadata();
  const tilePx = meta0.width;
  if (!tilePx || tilePx !== meta0.height) throw new Error('Minimap tiles must be square.');

  let minTX = Infinity, maxTX = -Infinity, minTY = Infinity, maxTY = -Infinity;
  for (const t of tiles) {
    minTX = Math.min(minTX, t.tileX);
    maxTX = Math.max(maxTX, t.tileX);
    minTY = Math.min(minTY, t.tileY);
    maxTY = Math.max(maxTY, t.tileY);
  }

  const outW = (maxTX - minTX + 1) * tilePx;
  const outH = (maxTY - minTY + 1) * tilePx;

  const composites = tiles.map((t) => ({
    input: t.filePath,
    left: (t.tileX - minTX) * tilePx,
    top: (t.tileY - minTY) * tilePx,
  }));

  const rawResult = await sharp({
    create: { width: outW, height: outH, channels: 4, background: MAP_BACKGROUND },
  }).composite(composites).raw().toBuffer({ resolveWithObject: true });

  return {
    tileWorld, tilePx,
    pxPerWorld: tilePx / tileWorld,
    minTX, maxTX, minTY, maxTY, outW, outH,
    raw: rawResult.data,
    channels: rawResult.info.channels,
  };
}

function worldToPixel(worldX, worldY, meta) {
  const { tileWorld, tilePx, pxPerWorld, minTX, minTY } = meta;
  const tileX = floorDiv(worldX, tileWorld);
  const tileY = floorDiv(worldY, tileWorld);
  const localX = worldX - tileX * tileWorld;
  const localY = worldY - tileY * tileWorld;
  const px = (tileX - minTX) * tilePx + localX * pxPerWorld;
  const py = (tileY - minTY) * tilePx + localY * pxPerWorld;
  return { tileX, tileY, px, py };
}

function identityT() { return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }; }
function mulT(p, l) {
  return {
    a: p.a * l.a + p.c * l.b,
    b: p.b * l.a + p.d * l.b,
    c: p.a * l.c + p.c * l.d,
    d: p.b * l.c + p.d * l.d,
    tx: p.a * l.tx + p.c * l.ty + p.tx,
    ty: p.b * l.tx + p.d * l.ty + p.ty,
  };
}
function applyT(t, x, y) { return { x: t.a * x + t.c * y + t.tx, y: t.b * x + t.d * y + t.ty }; }

function nodeLocalT(node) {
  const x = typeof node.x === 'number' ? node.x : 0;
  const y = typeof node.y === 'number' ? node.y : 0;
  const sx = typeof node.scaleX === 'number' ? node.scaleX : typeof node.scale === 'number' ? node.scale : 1;
  const sy = typeof node.scaleY === 'number' ? node.scaleY : typeof node.scale === 'number' ? node.scale : 1;
  let rz = typeof node.rotationZ === 'number' ? node.rotationZ : 0;
  if (Math.abs(rz) > 6.283185307179586) rz = (rz * Math.PI) / 180.0;
  const cos = Math.cos(rz), sin = Math.sin(rz);
  return { a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy, tx: x, ty: y };
}

function traversePrefab(node, parentT, visit) {
  if (!node || typeof node !== 'object') return;
  const absT = mulT(parentT, nodeLocalT(node));
  visit(node, absT);
  if (Array.isArray(node.children)) for (const c of node.children) traversePrefab(c, absT, visit);
}

async function extractAllSpawns(worldRootDir, loadedChunkIds, includeUnreferenced = false) {
  const all = await listFilesRecursive(worldRootDir);
  const gameplayFiles = all.filter((p) => p.endsWith('gameplayData.prefab'));
  const spawns = [];
  const skippedChunkIds = new Map();

  for (const fp of gameplayFiles) {
    const chunk = parseChunkFromPath(fp);
    if (!chunk) continue;
    if (!includeUnreferenced && !loadedChunkIds.has(chunk.id)) {
      skippedChunkIds.set(chunk.id, (skippedChunkIds.get(chunk.id) || 0) + 1);
      continue;
    }
    let json;
    try { json = readJson(fp); } catch { continue; }
    const roots = Array.isArray(json.children) ? json.children : [];
    for (const child of roots) {
      traversePrefab(child, identityT(), (node, absT) => {
        const props = node.props || {};
        if (props.$cdbtype !== 'spawner') return;
        const pos = applyT(absT, 0, 0);
        spawns.push({
          file: fp, chunkId: chunk.id, level: chunk.level, I: chunk.I, J: chunk.J,
          localAbsX: pos.x, localAbsY: pos.y,
          unitId: props.unit ?? null, unitGroup: props.unitGroup ?? null, props,
        });
      });
    }
  }
  return { spawns, skippedChunkIds: [...skippedChunkIds.keys()].sort() };
}

function mapSpawnerToPixel(s, meta, gameplayBaseChunkSize) {
  const chunkSize = gameplayBaseChunkSize * (1 << s.level);
  const worldX = (s.I - 0.5) * chunkSize + s.localAbsX;
  const worldY = (s.J - 0.5) * chunkSize + s.localAbsY;
  const p = worldToPixel(worldX, worldY, meta);
  return { chunkSize, worldX, worldY, minimapTileX: p.tileX, minimapTileY: p.tileY, px: p.px, py: p.py };
}

function makeSvgOverlay(points, width, height, radius) {
  const els = points.map((p) => {
    const cx = p.px.toFixed(2), cy = p.py.toFixed(2), cross = Math.max(3, Math.floor(radius * 0.8));
    return `\n      <circle cx="${cx}" cy="${cy}" r="${radius}" fill="rgba(255,0,0,0.75)" stroke="rgba(255,255,255,0.95)" stroke-width="2" />\n      <line x1="${(p.px - cross).toFixed(2)}" y1="${cy}" x2="${(p.px + cross).toFixed(2)}" y2="${cy}" stroke="rgba(0,0,0,0.55)" stroke-width="2" />\n      <line x1="${cx}" y1="${(p.py - cross).toFixed(2)}" x2="${cx}" y2="${(p.py + cross).toFixed(2)}" stroke="rgba(0,0,0,0.55)" stroke-width="2" />\n    `;
  }).join('\n');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${els}</svg>`);
}

function summarizeUnits(points) {
  const counts = new Map();
  for (const p of points) {
    const key = p.unitId ?? (p.unitGroup != null ? `GROUP:${p.unitGroup}` : '(unknown)');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
}

function computeZoomMetadata(width, height, tileSize = DEFAULT_TILE_SIZE) {
  const maxDim = Math.max(width, height);
  const maxZoom = Math.max(0, Math.ceil(Math.log2(Math.max(1, maxDim / tileSize))));
  return { tileSize, minZoom: 0, maxZoom, width, height, tileFormat: 'webp', tileScheme: 'xyz' };
}

function cropRawTile(src, imgWidth, imgHeight, channels, left, top, tileSize) {
  const extractWidth = Math.max(0, Math.min(tileSize, imgWidth - left));
  const extractHeight = Math.max(0, Math.min(tileSize, imgHeight - top));
  const out = Buffer.alloc(tileSize * tileSize * channels, 0);

  for (let i = 0; i < tileSize * tileSize; i++) {
    const o = i * channels;
    out[o + 0] = MAP_BACKGROUND.r;
    if (channels > 1) out[o + 1] = MAP_BACKGROUND.g;
    if (channels > 2) out[o + 2] = MAP_BACKGROUND.b;
    if (channels > 3) out[o + 3] = Math.round((MAP_BACKGROUND.alpha ?? 1) * 255);
  }

  if (extractWidth <= 0 || extractHeight <= 0) {
    return out;
  }

  for (let row = 0; row < extractHeight; row++) {
    const srcStart = ((top + row) * imgWidth + left) * channels;
    const srcEnd = srcStart + extractWidth * channels;
    const dstStart = (row * tileSize) * channels;
    src.copy(out, dstStart, srcStart, srcEnd);
  }
  return out;
}

async function runTasksBounded(tasks, concurrency) {
  let index = 0;
  async function worker() {
    while (true) {
      const i = index++;
      if (i >= tasks.length) return;
      await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

async function writeTilePyramidFromRaw(rawInfo, outDir, tileMeta) {
  const { tileSize, minZoom, maxZoom, width, height } = tileMeta;
  const baseInput = { raw: { width: rawInfo.width, height: rawInfo.height, channels: rawInfo.channels } };

  for (let z = minZoom; z <= maxZoom; z++) {
    const scale = 2 ** (z - maxZoom);
    const zoomWidth = Math.max(1, Math.ceil(width * scale));
    const zoomHeight = Math.max(1, Math.ceil(height * scale));
    const cols = Math.ceil(zoomWidth / tileSize);
    const rows = Math.ceil(zoomHeight / tileSize);

    let zoomRaw = rawInfo.data;
    let zoomChannels = rawInfo.channels;

    if (zoomWidth !== rawInfo.width || zoomHeight !== rawInfo.height) {
      const resized = await sharp(rawInfo.data, baseInput).resize(zoomWidth, zoomHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).raw().toBuffer({ resolveWithObject: true });
      zoomRaw = resized.data;
      zoomChannels = resized.info.channels;
    }

    const tasks = [];
    for (let x = 0; x < cols; x++) {
      const xDir = path.join(outDir, String(z), String(x));
      await fs.promises.mkdir(xDir, { recursive: true });
      for (let y = 0; y < rows; y++) {
        tasks.push(async () => {
          const left = x * tileSize;
          const top = y * tileSize;
          const tileRaw = cropRawTile(zoomRaw, zoomWidth, zoomHeight, zoomChannels, left, top, tileSize);
          await sharp(tileRaw, { raw: { width: tileSize, height: tileSize, channels: zoomChannels } })
            .webp({ quality: 90 })
            .toFile(path.join(xDir, `${y}.webp`));
        });
      }
    }
    const concurrency = Math.max(1, Math.min(os.cpus().length || 4, 8));
    await runTasksBounded(tasks, concurrency);
  }
}

async function runMapStitch({ minimapDir, worldRootDir, worldPrefabPath, outDir, radius = 8, includeUnreferenced = false }) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const stitchedPath = path.join(outDir, 'stitched_minimap.png');
  const stitchedOutPath = path.join(outDir, 'stitched_with_all_spawns.png');
  const jsonOutPath = path.join(outDir, 'all_spawns_mapped.json');
  const mapJsonPath = path.join(outDir, 'map.json');
  const ctx = {};

  await runTaskList([
    {
      title: 'Read world params',
      task: (_ctx, task) => {
        ctx.params = loadWorldParams(worldPrefabPath);
        task.output = `${ctx.params.loadedChunkIds.size} loaded chunks`;
      },
    },
    {
      title: 'Stitch minimap',
      task: async (_ctx, task) => {
        ctx.meta = await stitchMinimapToRaw(minimapDir, ctx.params.tileWorld);
        await sharp(ctx.meta.raw, { raw: { width: ctx.meta.outW, height: ctx.meta.outH, channels: ctx.meta.channels } })
          .png({ compressionLevel: 6 })
          .toFile(stitchedPath);
        task.output = `${ctx.meta.outW}x${ctx.meta.outH}px stitched`;
      },
    },
    {
      title: 'Load gameplay spawns',
      task: async (_ctx, task) => {
        const extracted = await extractAllSpawns(worldRootDir, ctx.params.loadedChunkIds, includeUnreferenced);
        ctx.spawns = extracted.spawns;
        ctx.skippedChunkIds = extracted.skippedChunkIds;
        ctx.mapped = ctx.spawns.map((spawn) => ({ ...spawn, ...mapSpawnerToPixel(spawn, ctx.meta, ctx.params.gameplayBaseChunkSize) }));
        ctx.inside = ctx.mapped.filter((point) => point.px >= 0 && point.py >= 0 && point.px < ctx.meta.outW && point.py < ctx.meta.outH);
        task.output = `${ctx.inside.length}/${ctx.mapped.length} points inside stitched image`;
      },
    },
    {
      title: 'Write debug overlays',
      task: async () => {
        const unitSummary = summarizeUnits(ctx.mapped);
        await fs.promises.writeFile(
          jsonOutPath,
          JSON.stringify({ params: { ...ctx.params, loadedChunkIds: [...ctx.params.loadedChunkIds].sort() }, skippedChunkIds: ctx.skippedChunkIds, meta: { ...ctx.meta, raw: undefined, channels: undefined }, unitSummary, points: ctx.mapped }, null, 2),
          'utf8'
        );
        const overlay = makeSvgOverlay(ctx.inside, ctx.meta.outW, ctx.meta.outH, radius);
        await sharp(ctx.meta.raw, { raw: { width: ctx.meta.outW, height: ctx.meta.outH, channels: ctx.meta.channels } })
          .composite([{ input: overlay, top: 0, left: 0 }])
          .png({ compressionLevel: 6 })
          .toFile(stitchedOutPath);
      },
    },
    {
      title: 'Build tile pyramid',
      task: async (_ctx, task) => {
        const mapMeta = computeZoomMetadata(ctx.meta.outW, ctx.meta.outH, DEFAULT_TILE_SIZE);
        await writeTilePyramidFromRaw({ data: ctx.meta.raw, width: ctx.meta.outW, height: ctx.meta.outH, channels: ctx.meta.channels }, outDir, mapMeta);
        await fs.promises.writeFile(mapJsonPath, JSON.stringify(mapMeta, null, 2), 'utf8');
        ctx.mapMeta = mapMeta;
        task.output = `${mapMeta.maxZoom + 1} zoom levels`;
      },
    },
  ], { tag: 'map-tools' });

  return {
    stitchedPath,
    stitchedOutPath,
    jsonOutPath,
    mapJsonPath,
    pointCount: ctx.mapped.length,
    visiblePointCount: ctx.inside.length,
    tileWidth: ctx.meta.outW,
    tileHeight: ctx.meta.outH,
  };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  let minimapDir, worldRootDir, worldPrefabPath, outDir;
  if (positional.length >= 4) [minimapDir, worldRootDir, worldPrefabPath, outDir] = positional;
  else if (positional.length >= 3) {
    [minimapDir, worldRootDir, outDir] = positional;
    worldPrefabPath = inferWorldPrefabPath(worldRootDir);
  } else {
    throw new Error('Usage: farever-map-stitch <minimapDir> <worldRootDir> <worldPrefabPath> <outDir> [--radius=10] [--includeUnreferenced]');
  }

  const radius = flags.radius ? parseInt(flags.radius, 10) : 8;
  const includeUnreferenced = !!flags.includeUnreferenced;
  await runMapStitch({ minimapDir, worldRootDir, worldPrefabPath, outDir, radius, includeUnreferenced });
}

module.exports = {
  main,
  runMapStitch,
};

if (require.main === module) {
  main().catch((err) => {
    consola.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
