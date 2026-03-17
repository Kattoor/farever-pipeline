const path = require('path');
const { readJson, resolveAsset, existsFile, norm } = require('./utils');

function findCdb(assetRoot, explicitPath = null) {
  const tries = [];
  if (explicitPath) tries.push(path.resolve(explicitPath));
  if (assetRoot) {
    tries.push(path.resolve(assetRoot, 'data.cdb'));
    tries.push(path.resolve(assetRoot, 'out', 'data.cdb'));
    tries.push(path.resolve(assetRoot, '..', 'data.cdb'));
    tries.push(path.resolve(assetRoot, '..', 'out', 'data.cdb'));
  }
  for (const p of tries) if (existsFile(p)) return p;
  return null;
}

function loadCdb(cdbPath) {
  if (!cdbPath) return null;
  const data = readJson(cdbPath);
  const sheets = Array.isArray(data.sheets) ? data.sheets : [];
  const byName = new Map(sheets.map((s) => [String(s.name || ''), s]));
  return { path: cdbPath, data, sheets, byName };
}

function getSheet(cdb, name) {
  return cdb?.byName?.get(name) || null;
}

function buildGradientMap(cdb, assetRoot = null, prefabPath = null) {
  const sheet = getSheet(cdb, 'gradient');
  const map = new Map();
  if (!sheet || !Array.isArray(sheet.lines)) return map;
  for (const line of sheet.lines) {
    const id = line && typeof line.id === 'string' ? line.id : null;
    const file = line && line.ref && typeof line.ref.file === 'string' ? line.ref.file : null;
    if (!id || !file) continue;
    map.set(id, {
      id,
      texture: norm(file),
      resolvedTexture: assetRoot ? resolveAsset(assetRoot, prefabPath, file) : null,
      ref: line.ref,
      bodyParts: line.bodyParts,
      playerCustomization: !!line.playerCustomization,
    });
  }
  return map;
}

module.exports = {
  findCdb,
  loadCdb,
  getSheet,
  buildGradientMap,
};
