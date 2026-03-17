#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runTaskList, consola } = require('@farever/cli-utils');
const { dumpMapPois } = require('./map/dump-pois.cjs');
const { dumpMapMobs } = require('./map/dump-mobs.cjs');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function loadConfig(root) {
  return readJson(path.join(root, 'config', 'farever.config.json'));
}

function resolveGeneratedDir(root, cfg) {
  const sitePublicDir = cfg.sitePublicDir || './apps/site/public';
  const generatedDir = cfg.siteGeneratedDir || path.join(sitePublicDir, 'generated');
  return path.resolve(root, generatedDir);
}

function resolveCdbJson(extractDir) {
  const tries = [
    path.join(extractDir, 'res', 'data.cdb.json'),
    path.join(extractDir, 'res', 'data.cdb'),
    path.join(extractDir, 'data.cdb.json'),
    path.join(extractDir, 'data.cdb')
  ];
  for (const p of tries) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Could not find JSON-readable data.cdb(.json) under ${extractDir}`);
}

function loadCdb(cdbPath) {
  return readJson(cdbPath);
}

function sheetLines(cdb, name) {
  return cdb.sheets.find((s) => s.name === name)?.lines || [];
}

function copyIconIfPresent(extractedRoot, iconPath, publicIconsDir) {
  if (!iconPath) return;
  const tries = [
    path.join(extractedRoot, 'res', iconPath),
    path.join(extractedRoot, iconPath)
  ];
  const src = tries.find((p) => fs.existsSync(p));
  if (!src) return;
  const dst = path.join(publicIconsDir, iconPath);
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function dumpSimpleCdbContent({ cdb, extractedRoot, generatedDir }) {
  const generatedDataDir = path.join(generatedDir, 'data');
  const generatedIconsDir = path.join(generatedDir, 'icons');
  ensureDir(generatedDataDir);
  ensureDir(generatedIconsDir);

  const dumps = [
    ['attributes.json', sheetLines(cdb, 'attribute'), (row) => row.gfx?.file],
    ['craft.json', sheetLines(cdb, 'craft'), null],
    ['gatherable.json', sheetLines(cdb, 'gatherable'), null],
    ['items.json', sheetLines(cdb, 'item'), (row) => row.gfx?.file],
    ['jobs.json', sheetLines(cdb, 'job'), (row) => row.gfx?.file],
    ['loot-tables.json', sheetLines(cdb, 'lootTable').map(({ id, loot }) => ({ id, loot })), null],
    ['skills.json', sheetLines(cdb, 'skill'), (row) => row.gfx?.file],
    ['units.json', sheetLines(cdb, 'unit'), (row) => row.gfx?.file]
  ];

  let iconCount = 0;
  for (const [fileName, rows, iconGetter] of dumps) {
    fs.writeFileSync(path.join(generatedDataDir, fileName), JSON.stringify(rows, null, 2));
    if (iconGetter) {
      for (const row of rows) {
        copyIconIfPresent(extractedRoot, iconGetter(row), generatedIconsDir);
        iconCount += 1;
      }
    }
  }

  return {
    fileCount: dumps.length,
    rowCount: dumps.reduce((total, [, rows]) => total + rows.length, 0),
    iconCount,
  };
}

function getMapJobs({ cfg, cdbPath, extractedRoot, generatedDir }) {
  const maps = Array.isArray(cfg.maps) ? cfg.maps : [];
  return maps.map((mapCfg) => {
    const worldRootDir = path.join(extractedRoot, mapCfg.worldRootDir);
    const minimapDir = path.join(extractedRoot, mapCfg.minimapDir);
    const worldPrefabPath = path.join(extractedRoot, mapCfg.worldPrefabPath);
    const outDir = path.join(generatedDir, mapCfg.publicDataDir);
    return {
      id: mapCfg.id,
      worldRootDir,
      minimapDir,
      worldPrefabPath,
      outDir,
      cdbPath,
    };
  });
}

async function main() {
  const root = process.cwd();
  const cfg = loadConfig(root);
  const extractDir = path.resolve(root, cfg.extractDir);
  const generatedDir = resolveGeneratedDir(root, cfg);
  const cdbPath = resolveCdbJson(extractDir);
  const cdb = loadCdb(cdbPath);
  const mapJobs = getMapJobs({ cfg, cdbPath, extractedRoot: extractDir, generatedDir });
  const ctx = { cfg, extractDir, generatedDir, cdbPath, cdb };

  const tasks = [
    {
      title: 'Load content sources',
      task: (_taskCtx, task) => {
        task.output = `CDB: ${path.basename(ctx.cdbPath)}`;
      },
    },
    {
      title: 'Dump CDB site data',
      task: (_taskCtx, task) => {
        const summary = dumpSimpleCdbContent({ cdb: ctx.cdb, extractedRoot: ctx.extractDir, generatedDir: ctx.generatedDir });
        task.output = `${summary.fileCount} files, ${summary.rowCount} rows`;
      },
    },
  ];

  if (!mapJobs.length) {
    tasks.push({
      title: 'Dump map data',
      task: (_taskCtx, task) => {
        task.skip('No maps configured');
      },
    });
  } else {
    for (const job of mapJobs) {
      tasks.push({
        title: `Dump map data: ${job.id}`,
        task: async (_taskCtx, task) => {
          ensureDir(job.outDir);
          if (!fs.existsSync(job.worldRootDir) || !fs.existsSync(job.minimapDir) || !fs.existsSync(job.worldPrefabPath)) {
            task.skip('Missing world or minimap inputs');
            return;
          }
          const poiSummary = dumpMapPois(job);
          const mobSummary = dumpMapMobs({ ...job, outPath: path.join(job.outDir, 'mobs.json') });
          task.output = `${Object.values(poiSummary.counts).reduce((total, count) => total + count, 0)} POIs, ${mobSummary.rowCount} mobs`;
        },
      });
    }
  }

  await runTaskList(tasks, { tag: 'content-dumper' });
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
