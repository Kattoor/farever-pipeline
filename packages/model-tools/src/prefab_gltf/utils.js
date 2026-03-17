const fs = require('fs');
const path = require('path');
const { isHbsonBuffer, readHbson } = require('./hbson');

function norm(p) {
  return String(p || '').replace(/\\/g, '/');
}

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function existsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonOrHbson(file, options = {}) {
  const bytes = fs.readFileSync(file);
  // Heaps converts prefab resources to HBSON without changing the prefab resource identity.
  if (isHbsonBuffer(bytes)) return readHbson(bytes, options);
  return JSON.parse(bytes.toString('utf8'));
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function resolveAsset(assetRoot, fromFile, relPath) {
  if (!relPath) return null;
  const clean = norm(relPath);
  const tries = [];
  if (path.isAbsolute(clean)) tries.push(clean);
  if (fromFile) tries.push(path.resolve(path.dirname(fromFile), clean));
  if (assetRoot) tries.push(path.resolve(assetRoot, clean));
  for (const t of tries) if (existsFile(t)) return t;
  if (
    assetRoot &&
    !path.isAbsolute(clean) &&
    !clean.startsWith('./') &&
    !clean.startsWith('../') &&
    /^[A-Za-z0-9_.-]+\//.test(clean)
  ) {
    return path.resolve(assetRoot, clean);
  }
  return tries[0] || null;
}

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (!base || typeof base !== 'object') return patch;
  if (!patch || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k in out && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeName(s) {
  return String(s || 'unnamed').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

module.exports = {
  norm,
  existsFile,
  existsDir,
  mkdirp,
  readJson,
  readJsonOrHbson,
  writeJson,
  resolveAsset,
  deepMerge,
  sanitizeName,
};
