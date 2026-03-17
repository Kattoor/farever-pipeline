#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { runTaskList, consola } = require('@farever/cli-utils');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function loadConfig(root) {
  return readJson(path.join(root, 'config', 'farever.config.json'));
}

function resolveGeneratedDir(root, cfg) {
  const sitePublicDir = cfg.sitePublicDir || './apps/site/public';
  const generatedDir = cfg.siteGeneratedDir || path.join(sitePublicDir, 'generated');
  return path.resolve(root, generatedDir);
}

function runNode(script, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [script, ...args], { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${code || 1}): ${path.basename(script)}`));
    });
  });
}

async function extractPaks(root, cfg) {
  ensureDir(path.resolve(root, cfg.extractDir));
  await runNode(path.join(root, 'packages', 'pak-extractor', 'src', 'cli.cjs'), ['extract-known-paks']);
}

async function dumpSite(root, cfg) {
  await runNode(path.join(root, 'packages', 'content-dumper', 'src', 'cli.cjs'));
}

async function exportModels(root, cfg) {
  const tool = path.join(root, 'packages', 'model-tools', 'src', 'cli.cjs');
  const assetRoot = path.join(root, cfg.extractDir);
  const outDir = path.resolve(root, cfg.siteModelLibraryDir || path.join(resolveGeneratedDir(root, cfg), 'model-library'));
  ensureDir(outDir);
  await runNode(tool, ['--batch', '--asset-root', assetRoot, '--out-dir', outDir]);
}

async function stitchMaps(root, cfg) {
  const maps = Array.isArray(cfg.maps) ? cfg.maps : [];
  const results = { stitched: [], skipped: [] };
  for (const mapCfg of maps) {
    const extractDir = path.resolve(root, cfg.extractDir);
    const minimapDir = path.join(extractDir, mapCfg.minimapDir);
    const worldRootDir = path.join(extractDir, mapCfg.worldRootDir);
    const worldPrefabPath = path.join(extractDir, mapCfg.worldPrefabPath);
    const outDir = path.join(resolveGeneratedDir(root, cfg), 'map', mapCfg.id);
    if (!fs.existsSync(minimapDir) || !fs.existsSync(worldRootDir) || !fs.existsSync(worldPrefabPath)) {
      results.skipped.push(mapCfg.id);
      continue;
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    ensureDir(outDir);
    await runNode(path.join(root, 'packages', 'map-tools', 'src', 'cli.cjs'), [minimapDir, worldRootDir, worldPrefabPath, outDir]);
    results.stitched.push(mapCfg.id);
  }
  return results;
}

function clean(root, cfg) {
  fs.rmSync(path.resolve(root, cfg.extractDir), { recursive: true, force: true });
  return { removed: path.resolve(root, cfg.extractDir) };
}

async function main() {
  const root = process.cwd();
  const cfg = loadConfig(root);
  const cmd = process.argv[2] || 'sync-game';

  if (cmd === 'extract-paks') {
    return await runTaskList([
      { title: 'Extract PAKs', task: async (_ctx, task) => { await extractPaks(root, cfg); task.output = path.resolve(root, cfg.extractDir); } },
    ], { tag: 'pipeline' });
  }
  if (cmd === 'dump-site') {
    return await runTaskList([
      { title: 'Dump site data', task: async (_ctx, task) => { await dumpSite(root, cfg); task.output = resolveGeneratedDir(root, cfg); } },
    ], { tag: 'pipeline' });
  }
  if (cmd === 'export-models') {
    return await runTaskList([
      {
        title: 'Export models',
        task: async (_ctx, task) => {
          await exportModels(root, cfg);
          task.output = path.resolve(root, cfg.siteModelLibraryDir || path.join(resolveGeneratedDir(root, cfg), 'model-library'));
        },
      },
    ], { tag: 'pipeline' });
  }
  if (cmd === 'stitch-maps') {
    return await runTaskList([
      {
        title: 'Stitch world maps',
        task: async (_ctx, task) => {
          const result = await stitchMaps(root, cfg);
          task.output = `${result.stitched.length} stitched, ${result.skipped.length} skipped`;
        },
      },
    ], { tag: 'pipeline' });
  }
  if (cmd === 'clean') {
    return await runTaskList([
      { title: 'Clean extracted cache', task: (_ctx, task) => { const result = clean(root, cfg); task.output = result.removed; } },
    ], { tag: 'pipeline' });
  }
  if (cmd === 'sync-game') {
    return await runTaskList([
      { title: 'Extract PAKs', task: async () => { await extractPaks(root, cfg); } },
      { title: 'Dump site data', task: async () => { await dumpSite(root, cfg); } },
      { title: 'Export models', task: async () => { await exportModels(root, cfg); } },
      {
        title: 'Stitch world maps',
        task: async (_ctx, task) => {
          const result = await stitchMaps(root, cfg);
          task.output = `${result.stitched.length} stitched, ${result.skipped.length} skipped`;
        },
      },
    ], { tag: 'pipeline' });
  }
  throw new Error(`Unknown command: ${cmd}`);
}

module.exports = {
  main,
};

if (require.main === module) {
  Promise.resolve(main()).catch((err) => {
    consola.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
