const path = require('path');
const { existsFile, readJsonOrHbson, resolveAsset, deepMerge } = require('./utils');
const { loadPrefab } = require('./prefab');

function walkMaterials(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (String(node.type || '').toLowerCase().includes('material')) out.push(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkMaterials(child, out);
  }
  return out;
}

function lowerEq(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function resolveColorMult(node) {
  const children = Array.isArray(node?.children) ? node.children : [];
  for (const child of children) {
    if (!lowerEq(child?.type, 'shader') || !lowerEq(child?.name, 'ColorMult')) continue;
    const color = Array.isArray(child?.props?.color) ? child.props.color : null;
    if (!color || color.length < 3) continue;
    const amount = Number.isFinite(Number(child?.props?.amount)) ? Number(child.props.amount) : 1;
    return [
      1 + (Number(color[0]) - 1) * amount,
      1 + (Number(color[1]) - 1) * amount,
      1 + (Number(color[2]) - 1) * amount,
      1,
    ];
  }
  return null;
}

function withinRoot(dir, root) {
  const resolvedDir = path.resolve(dir).toLowerCase();
  const resolvedRoot = path.resolve(root).toLowerCase();
  return resolvedDir === resolvedRoot || resolvedDir.startsWith(`${resolvedRoot}${path.sep}`.toLowerCase());
}

function loadMergedMaterialProps(sourcePath, assetRoot, cache) {
  const key = path.resolve(sourcePath);
  if (cache.propsBySource.has(key)) return cache.propsBySource.get(key);
  let merged = {};
  const dirs = [];
  let current = path.dirname(key);
  const root = assetRoot ? path.resolve(assetRoot) : null;
  while (true) {
    dirs.push(current);
    if (!root || !withinRoot(current, root) || lowerEq(current, root)) break;
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  dirs.reverse();
  for (const dir of dirs) {
    const propsPath = path.join(dir, 'materials.props');
    if (!existsFile(propsPath)) continue;
    try {
      const parsed = readJsonOrHbson(propsPath);
      const materials = parsed?.materials && typeof parsed.materials === 'object' ? parsed.materials : parsed;
      if (materials && typeof materials === 'object') merged = deepMerge(merged, materials);
    } catch {}
  }
  cache.propsBySource.set(key, merged);
  return merged;
}

function findCaseInsensitiveKey(obj, wanted) {
  if (!obj || typeof obj !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(obj, wanted)) return wanted;
  const wantedLower = String(wanted || '').toLowerCase();
  return Object.keys(obj).find((key) => String(key).toLowerCase() === wantedLower) || null;
}

function findMaterialPropEntry(materialProps, sourcePath, materialName) {
  const sourceFile = path.basename(sourcePath);
  const candidates = [`${materialName}/${sourceFile}`, materialName];
  for (const [mode, entries] of Object.entries(materialProps || {})) {
    if (!entries || typeof entries !== 'object') continue;
    for (const candidate of candidates) {
      const matchedKey = findCaseInsensitiveKey(entries, candidate);
      if (!matchedKey) continue;
      const entry = entries[matchedKey];
      if (!entry || typeof entry !== 'object') continue;
      return { mode, key: matchedKey, entry };
    }
  }
  return null;
}

function loadMaterialLibrary(prefabPath, assetRoot, cache) {
  const key = path.resolve(prefabPath);
  if (cache.libraryByPath.has(key)) return cache.libraryByPath.get(key);
  const prefab = loadPrefab(key, assetRoot);
  const exact = new Map();
  const lower = new Map();
  for (const node of walkMaterials(prefab)) {
    if (!node?.name) continue;
    exact.set(node.name, node);
    lower.set(String(node.name).toLowerCase(), node);
  }
  const record = { exact, lower };
  cache.libraryByPath.set(key, record);
  return record;
}

function findLibraryMaterial(library, name) {
  if (!library || !name) return null;
  return library.exact.get(name) || library.lower.get(String(name).toLowerCase()) || null;
}

function resolveMaterialBinding(hmdMaterial, sourcePath, assetRoot, cache) {
  const materialProps = loadMergedMaterialProps(sourcePath, assetRoot, cache);
  const propEntry = findMaterialPropEntry(materialProps, sourcePath, hmdMaterial.name || '');
  let libraryPath = null;
  let libraryMaterial = null;
  let libraryName = propEntry?.entry?.name || hmdMaterial.name || null;
  if (propEntry?.entry?.__ref) {
    libraryPath = resolveAsset(assetRoot, sourcePath, propEntry.entry.__ref);
    if (libraryPath && existsFile(libraryPath)) {
      const library = loadMaterialLibrary(libraryPath, assetRoot, cache);
      libraryMaterial = findLibraryMaterial(library, libraryName);
    }
  }

  const resolved = {
    index: -1,
    name: hmdMaterial.name || 'mat',
    source: libraryMaterial ? 'materialLibrary' : 'hmd',
    libraryRef: propEntry?.entry?.__ref || null,
    libraryRefResolved: libraryPath,
    libraryMaterialName: libraryMaterial?.name || libraryName || null,
    materialPropsMode: propEntry?.mode || null,
    materialPropsKey: propEntry?.key || null,
    materialProps: propEntry?.entry || null,
    diffuseTexture: libraryMaterial?.diffuseMap || hmdMaterial.diffuseTexture || null,
    normalMap: libraryMaterial?.normalMap || hmdMaterial.normalMap || null,
    specularTexture: libraryMaterial?.specularMap || hmdMaterial.specularTexture || null,
    baseColorFactor: resolveColorMult(libraryMaterial) || [1, 1, 1, 1],
    pbrProps: libraryMaterial?.props?.PBR || null,
  };
  const resolveFrom = libraryPath || sourcePath;
  resolved.diffuseResolved = resolveAsset(assetRoot, resolveFrom, resolved.diffuseTexture);
  resolved.normalResolved = resolveAsset(assetRoot, resolveFrom, resolved.normalMap);
  resolved.specularResolved = resolveAsset(assetRoot, resolveFrom, resolved.specularTexture);
  return resolved;
}

function resolveMaterialBindingsForModel(hmdMaterials, sourcePath, assetRoot, cache) {
  return (hmdMaterials || []).map((material, index) => {
    const resolved = resolveMaterialBinding(material, sourcePath, assetRoot, cache);
    resolved.index = index;
    return resolved;
  });
}

module.exports = {
  resolveMaterialBindingsForModel,
};
