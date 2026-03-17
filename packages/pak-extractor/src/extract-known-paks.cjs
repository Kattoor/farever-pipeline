#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runTaskList, formatCount, formatBytes, consola } = require('@farever/cli-utils');
const { extractPak } = require('./extract-pak.cjs');

const DEFAULT_PAKS = ['res.pak', 'res.levels.pak', 'res.light.pak', 'res.map.pak'];

function loadConfig(cwd) {
  const p = path.join(cwd, 'config', 'farever.config.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function run(options = {}) {
  const root = options.root || process.cwd();
  const cfg = options.cfg || loadConfig(root);
  const pakDir = path.resolve(root, cfg.pakDir);
  const extractDir = path.resolve(root, cfg.extractDir);
  const pakFiles = Array.isArray(cfg.pakFiles) ? cfg.pakFiles : DEFAULT_PAKS;
  const results = { extracted: [], skipped: [] };

  const tasks = [
    {
      title: 'Prepare merged extract tree',
      task: (_ctx, task) => {
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.mkdirSync(extractDir, { recursive: true });
        task.output = extractDir;
      },
    },
  ];

  for (const pakFile of pakFiles) {
    tasks.push({
      title: `Extract ${pakFile}`,
      task: async (_ctx, task) => {
        const pakPath = path.join(pakDir, pakFile);
        if (!fs.existsSync(pakPath)) {
          results.skipped.push({ pak: pakFile, pakPath });
          task.skip('Missing input PAK');
          return;
        }
        const result = await extractPak({
          pakPath,
          outDir: extractDir,
          onProgress: (progress) => {
            if (progress.stage === 'read') {
              task.output = `v${progress.version}, ${formatBytes(progress.dataSize)}, ${formatCount(0, progress.totalFiles, 'files')}`;
              return;
            }
            if (progress.stage === 'extract') {
              task.output = `${formatCount(progress.files, progress.totalFiles, 'files')}, ${formatBytes(progress.bytes)}, ${progress.ddsQueued} DDS queued`;
              return;
            }
            if (progress.stage === 'convert') {
              task.output = `${formatCount(progress.current, progress.total, 'textures')} converted`;
            }
          },
        });
        results.extracted.push(result);
        task.output = `${formatCount(result.files, result.totalFiles, 'files')}, ${result.ddsConverted}/${result.ddsQueued} DDS->PNG`;
      },
    });
  }

  await runTaskList(tasks, { tag: 'pak-extractor' });

  return {
    pakDir,
    extractDir,
    total: pakFiles.length,
    extracted: results.extracted,
    skipped: results.skipped,
  };
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    consola.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
