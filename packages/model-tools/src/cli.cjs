#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runTaskList, formatCount, consola } = require('@farever/cli-utils');
const { loadPrefab, buildPrefabScene } = require('./prefab_gltf/prefab');
const { parseHMD, decodeGeometry, decodeAnimation, hasProp } = require('./prefab_gltf/hmd');
const { exportPrefabSceneGlb } = require('./prefab_gltf/gltf');
const { mkdirp, resolveAsset, sanitizeName, existsFile } = require('./prefab_gltf/utils');
const { findCdb, loadCdb } = require('./prefab_gltf/cdb');
const { resolveMaterialBindingsForModel } = require('./prefab_gltf/materials');

const DEFAULT_BATCH_FOLDERS = ['Character', 'Environment', 'Fx', 'Gameplay', 'Items', 'Level', 'UI'];
//const DEFAULT_BATCH_FOLDERS = ['assets', 'content', 'prefabs'];
const DEFAULT_ASSET_ROOT = path.resolve('..', 'out');
const DEFAULT_OUT_ROOT = path.resolve('.', 'out-dir-testing');

function parseArgs(argv) {
  const args = { input: null, assetRoot: null, outDir: null, gradMap: null, cdb: null, batch: false };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asset-root') args.assetRoot = argv[++i];
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--grad-map') args.gradMap = argv[++i];
    else if (a === '--cdb') args.cdb = argv[++i];
    else if (a === '--batch') args.batch = true;
    else rest.push(a);
  }
  args.input = rest[0] || null;
  if (!args.input) {
    args.batch = true;
    args.assetRoot = path.resolve(args.assetRoot || DEFAULT_ASSET_ROOT);
    args.outDir = path.resolve(args.outDir || DEFAULT_OUT_ROOT);
  } else {
    if (!args.assetRoot) args.assetRoot = path.dirname(path.resolve(args.input));
    if (!args.outDir) args.outDir = 'out-gltf';
    args.assetRoot = path.resolve(args.assetRoot);
    args.outDir = path.resolve(args.outDir);
  }
  return args;
}

function isPrefabFile(filePath) {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.prefab') || lower.endsWith('.prefab.json') || lower.endsWith('.prefab.hbson');
}

function collectPrefabPaths(inputPath) {
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    if (!isPrefabFile(inputPath)) throw new Error(`Input file is not a prefab: ${inputPath}`);
    return [path.resolve(inputPath)];
  }
  if (!stat.isDirectory()) throw new Error(`Input path is neither a file nor a directory: ${inputPath}`);
  const results = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isPrefabFile(full)) results.push(path.resolve(full));
    }
  }
  walk(path.resolve(inputPath));
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

function safeRelative(fromDir, targetPath) {
  const rel = path.relative(fromDir, targetPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

function buildTextureVirtualRel(src, assetRoot) {
  const relToAssetRoot = safeRelative(path.resolve(assetRoot), path.resolve(src));
  if (relToAssetRoot) return path.join('textures', relToAssetRoot).replace(/\\/g, '/');
  return path.join('textures', path.basename(src)).replace(/\\/g, '/');
}

function embedTextureIfFound(src, embeddedBySrc, assetRoot) {
  if (!src || !existsFile(src)) return null;
  if (!embeddedBySrc.has(src)) {
    embeddedBySrc.set(src, {
      path: buildTextureVirtualRel(src, assetRoot),
      sourcePath: src,
      name: path.basename(src),
      bytes: fs.readFileSync(src),
    });
  }
  return embeddedBySrc.get(src).path;
}

function embedGradMatOutputs(gradMat, embeddedBySrc, assetRoot, warnings) {
  if (!gradMat) return null;
  const embedded = { ...gradMat };
  embedded.linesOut = embedTextureIfFound(embedded.linesTexResolved, embeddedBySrc, assetRoot);
  embedded.patternOut = embedTextureIfFound(embedded.patternResolved, embeddedBySrc, assetRoot);
  embedded.patternAlphaOut = embedTextureIfFound(embedded.patternAlphaResolved, embeddedBySrc, assetRoot);
  embedded.marksOut = (embedded.marksResolved || []).map((p) => embedTextureIfFound(p, embeddedBySrc, assetRoot));
  embedded.resolvedSlots = (embedded.resolvedSlots || []).map((slot) => ({
    ...slot,
    out: embedTextureIfFound(slot.resolvedTexture, embeddedBySrc, assetRoot),
  }));
  if (embedded.resolvedSlots.some((slot) => !slot.resolvedTexture)) {
    warnings?.push('One or more GradMat slot IDs could not be resolved to textures from data.cdb or --grad-map.');
  }
  return embedded;
}

function choosePrimaryModel(manifestModels) {
  if (!manifestModels.length) return null;
  return [...manifestModels].sort((a, b) => (b.vertexScore || 0) - (a.vertexScore || 0))[0];
}

function processPrefab(prefabPath, args, gradMap, cdb, searchRoot) {
  const prefab = loadPrefab(prefabPath, path.resolve(args.assetRoot));
  const sceneSpec = buildPrefabScene(prefab, prefabPath, path.resolve(args.assetRoot), gradMap, cdb);
  const modelNodes = sceneSpec.nodes.filter((n) => n.type === 'model');
  if (!modelNodes.length) throw new Error('No model node found in prefab');

  const hmdCache = new Map();
  const animationCache = new Map();
  const animationPathIndex = new Map();
  const allAnimationPaths = [];
  const allAnimationRecords = [];
  const propsAnimPathCache = new Map();
  const animationMappingCache = new Map();
  const animationClipKeyCache = new Map();
  const materialResolverCache = { propsBySource: new Map(), libraryByPath: new Map() };
  const assetRootResolved = path.resolve(args.assetRoot);
  function getAssetForSource(sourcePath) {
    if (!sourcePath) return null;
    if (hmdCache.has(sourcePath)) return hmdCache.get(sourcePath);
    const hmd = parseHMD(sourcePath);
    const decodedGeometries = hmd.geometries.map((_, i) => decodeGeometry(hmd, i));
    const asset = { sourcePath, hmd, decodedGeometries };
    hmdCache.set(sourcePath, asset);
    return asset;
  }
  function getAnimationAssetForSource(sourcePath) {
    if (!sourcePath) return null;
    if (animationCache.has(sourcePath)) return animationCache.get(sourcePath);
    const hmd = parseHMD(sourcePath);
    const decodedAnimations = hmd.animations.map((_, i) => decodeAnimation(hmd, i));
    const asset = { sourcePath, hmd, decodedAnimations };
    animationCache.set(sourcePath, asset);
    return asset;
  }
  function indexAnimationFiles() {
    if (animationPathIndex.size > 0) return;
    const animRoot = path.join(assetRootResolved, 'Anim');
    if (!fs.existsSync(animRoot) || !fs.statSync(animRoot).isDirectory()) return;
    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && /\.fbx$/i.test(entry.name)) {
          const key = entry.name.toLowerCase();
          if (!animationPathIndex.has(key)) animationPathIndex.set(key, []);
          animationPathIndex.get(key).push(full);
          allAnimationPaths.push(full);
          allAnimationRecords.push({
            full,
            rel: path.relative(assetRootResolved, full).replace(/\\/g, '/'),
            lower: path.relative(assetRootResolved, full).replace(/\\/g, '/').toLowerCase(),
            stem: path.basename(full, path.extname(full)).toLowerCase(),
          });
        }
      }
    }
    walk(animRoot);
  }
  function normalizeAssetRel(filePath) {
    return path.relative(assetRootResolved, path.resolve(filePath)).replace(/\\/g, '/').toLowerCase();
  }
  function normalizeAnimationKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  function buildAnimationTargetInfo(asset) {
    const names = new Set();
    let jointCount = 0;
    for (const model of asset.hmd.models || []) {
      if (model.name) names.add(model.name);
      if (model.skin?.name) names.add(model.skin.name);
      if (Array.isArray(model.skin?.joints)) {
        jointCount = Math.max(jointCount, model.skin.joints.length);
        for (const joint of model.skin.joints) if (joint?.name) names.add(joint.name);
      }
    }
    return {
      names,
      jointCount,
      cacheKey: [...names].sort().join('|'),
    };
  }
  function hasTransformChannels(animationObject) {
    return !!(
      animationObject?.channels?.translation?.length ||
      animationObject?.channels?.rotation?.length ||
      animationObject?.channels?.scale?.length
    );
  }
  function getAnimationMappingStats(sourcePath, targetInfo) {
    if (!targetInfo?.names?.size) return { mappedObjectCount: 0, animatedObjectCount: 0 };
    const cacheKey = `${sourcePath}::${targetInfo.cacheKey}`;
    if (animationMappingCache.has(cacheKey)) return animationMappingCache.get(cacheKey);
    const animationAsset = getAnimationAssetForSource(sourcePath);
    let mappedObjectCount = 0;
    let animatedObjectCount = 0;
    for (const decodedAnimation of animationAsset.decodedAnimations || []) {
      for (const object of decodedAnimation.objects || []) {
        if (!hasTransformChannels(object)) continue;
        animatedObjectCount += 1;
        if (targetInfo.names.has(object.name)) mappedObjectCount += 1;
      }
    }
    const stats = { mappedObjectCount, animatedObjectCount };
    animationMappingCache.set(cacheKey, stats);
    return stats;
  }
  function readAnimPathHintsForSource(sourcePath) {
    if (!sourcePath) return [];
    if (propsAnimPathCache.has(sourcePath)) return propsAnimPathCache.get(sourcePath);
    const hints = [];
    const seen = new Set();
    let currentDir = path.dirname(path.resolve(sourcePath));
    while (currentDir.toLowerCase().startsWith(assetRootResolved.toLowerCase())) {
      const propsPath = path.join(currentDir, 'props.json');
      if (existsFile(propsPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
          const animPaths = Array.isArray(parsed?.['hmd.animPaths']) ? parsed['hmd.animPaths'] : [];
          for (const hint of animPaths) {
            const normalized = String(hint || '').trim();
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            hints.push(normalized);
          }
        } catch {}
      }
      if (currentDir.toLowerCase() === assetRootResolved.toLowerCase()) break;
      const nextDir = path.dirname(currentDir);
      if (nextDir === currentDir) break;
      currentDir = nextDir;
    }
    propsAnimPathCache.set(sourcePath, hints);
    return hints;
  }
  function animationPatternToRegex(pattern) {
    const normalized = String(pattern || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (!normalized) return null;
    const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}(?:/.*)?$`, 'i');
  }
  function tokenizeForAnimationMatch(...values) {
    const noisy = new Set(['anim', 'common', 'character', 'source', 'sources', 'body', 'boss', 'mob', 'hero', 'model', 'prefab']);
    const tokens = new Set();
    for (const value of values) {
      for (const token of String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        if (token.length < 3 || noisy.has(token)) continue;
        tokens.add(token);
      }
    }
    return [...tokens];
  }
  function scoreAnimationRecord(record, tokens) {
    let score = 0;
    if (/idle/i.test(record.rel)) score += 200;
    if (/loop/i.test(record.rel)) score += 30;
    if (/common/i.test(record.rel)) score += 10;
    for (const token of tokens) {
      if (record.lower.includes(token)) score += 20;
      if (record.stem.includes(token)) score += 25;
    }
    return score;
  }
  function getAnimationClipKeys(sourcePath) {
    if (animationClipKeyCache.has(sourcePath)) return animationClipKeyCache.get(sourcePath);
    const animationAsset = getAnimationAssetForSource(sourcePath);
    const keys = [];
    const seen = new Set();
    for (const decodedAnimation of animationAsset.decodedAnimations || []) {
      const key = normalizeAnimationKey(decodedAnimation?.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    if (!keys.length) {
      const fallbackKey = normalizeAnimationKey(path.basename(sourcePath, path.extname(sourcePath)));
      if (fallbackKey) keys.push(fallbackKey);
    }
    animationClipKeyCache.set(sourcePath, keys);
    return keys;
  }
  function scoreAnimationRecordForClip(record, clipKey, tokens) {
    let score = scoreAnimationRecord(record, tokens);
    const normalizedStem = normalizeAnimationKey(record.stem);
    if (clipKey) {
      if (normalizedStem === clipKey || normalizedStem.endsWith(clipKey)) score += 120;
      else if (normalizedStem.includes(clipKey)) score += 60;
    }
    return score;
  }
  function recordForAnimationSource(sourcePath) {
    const rel = path.relative(assetRootResolved, sourcePath).replace(/\\/g, '/');
    return {
      full: sourcePath,
      rel,
      lower: rel.toLowerCase(),
      stem: path.basename(sourcePath, path.extname(sourcePath)).toLowerCase(),
    };
  }
  function isBetterAnimationRecordForClip(candidate, current, clipKey, tokens, targetInfo = null, preferredSourcePath = null) {
    if (!current) return true;
    if (preferredSourcePath) {
      const candidatePreferred = path.resolve(candidate.full) === path.resolve(preferredSourcePath);
      const currentPreferred = path.resolve(current.full) === path.resolve(preferredSourcePath);
      if (candidatePreferred !== currentPreferred) return candidatePreferred;
    }
    if (targetInfo?.names?.size) {
      const candidateMapped = getAnimationMappingStats(candidate.full, targetInfo).mappedObjectCount;
      const currentMapped = getAnimationMappingStats(current.full, targetInfo).mappedObjectCount;
      if (candidateMapped !== currentMapped) return candidateMapped > currentMapped;
    }
    const candidateScore = scoreAnimationRecordForClip(candidate, clipKey, tokens);
    const currentScore = scoreAnimationRecordForClip(current, clipKey, tokens);
    if (candidateScore !== currentScore) return candidateScore > currentScore;
    return candidate.rel.localeCompare(current.rel) < 0;
  }
  function dedupeAnimationMatchesByClip(matches, tokens, targetInfo = null) {
    if (matches.length <= 1) return matches;
    const bestByClip = new Map();
    for (const record of matches) {
      const clipKeys = getAnimationClipKeys(record.full);
      for (const clipKey of clipKeys) {
        const current = bestByClip.get(clipKey) || null;
        if (isBetterAnimationRecordForClip(record, current, clipKey, tokens, targetInfo)) {
          bestByClip.set(clipKey, record);
        }
      }
    }
    if (!bestByClip.size) return matches;
    const selectedPaths = new Set([...bestByClip.values()].map((record) => record.full));
    return matches.filter((record) => selectedPaths.has(record.full));
  }
  function dedupeAnimationSourcePaths(sourcePaths, tokens, targetInfo = null, preferredSourcePath = null) {
    if (sourcePaths.length <= 1) return sourcePaths;
    const sourceRecords = sourcePaths.map(recordForAnimationSource);
    const bestByClip = new Map();
    for (const record of sourceRecords) {
      const clipKeys = getAnimationClipKeys(record.full);
      for (const clipKey of clipKeys) {
        const current = bestByClip.get(clipKey) || null;
        if (isBetterAnimationRecordForClip(record, current, clipKey, tokens, targetInfo, preferredSourcePath)) {
          bestByClip.set(clipKey, record);
        }
      }
    }
    if (!bestByClip.size) return sourcePaths;
    const selectedPaths = new Set([...bestByClip.values()].map((record) => record.full));
    return sourcePaths.filter((sourcePath) => selectedPaths.has(sourcePath));
  }
  function isCommonAnimationRecord(record) {
    return record.lower.includes('/common/') || record.stem.includes('_common_');
  }
  function getCommonAnimationDepth(record) {
    const commonDirIndex = record.lower.indexOf('/common/');
    if (commonDirIndex >= 0) {
      const tail = record.lower.slice(commonDirIndex + '/common/'.length);
      return Math.max(0, tail.split('/').filter(Boolean).length - 1);
    }
    const segments = record.lower.split('/').filter(Boolean);
    return Math.max(0, segments.length - 3);
  }
  function resolveAnimationsFromHints(sourcePath, nodeName, prefabPath, options = {}) {
    const { explicitAnimationSource = null, targetInfo = null } = options;
    indexAnimationFiles();
    const hints = readAnimPathHintsForSource(sourcePath);
    if (!hints.length) return [];
    const tokens = tokenizeForAnimationMatch(
      path.basename(sourcePath, path.extname(sourcePath)),
      nodeName,
      path.basename(prefabPath, path.extname(prefabPath)),
      path.dirname(path.relative(assetRootResolved, sourcePath))
    );
    let matches = [];
    const seen = new Set();
    for (const hint of hints) {
      const regex = animationPatternToRegex(hint);
      if (!regex) continue;
      for (const record of allAnimationRecords) {
        if (!regex.test(record.lower)) continue;
        if (seen.has(record.full)) continue;
        seen.add(record.full);
        matches.push(record);
      }
    }
    const explicitScope = explicitAnimationSource ? normalizeAssetRel(path.dirname(explicitAnimationSource)) : null;
    if (explicitScope) {
      const scopedMatches = matches.filter((record) => record.lower.startsWith(`${explicitScope}/`));
      if (scopedMatches.length) matches.splice(0, matches.length, ...scopedMatches);
    } else {
      const commonMatches = matches.filter(isCommonAnimationRecord);
      if (commonMatches.length) {
        const shallowestCommonDepth = Math.min(...commonMatches.map(getCommonAnimationDepth));
        matches = commonMatches.filter((record) => getCommonAnimationDepth(record) === shallowestCommonDepth);
      }
    }
    if (targetInfo?.names?.size) {
      const mappedMatches = matches.filter((record) => getAnimationMappingStats(record.full, targetInfo).mappedObjectCount > 0);
      if (mappedMatches.length) matches = mappedMatches;
    }
    matches.sort((a, b) => {
      if (targetInfo?.names?.size) {
        const mappedDiff = getAnimationMappingStats(b.full, targetInfo).mappedObjectCount - getAnimationMappingStats(a.full, targetInfo).mappedObjectCount;
        if (mappedDiff !== 0) return mappedDiff;
      }
      const scoreDiff = scoreAnimationRecord(b, tokens) - scoreAnimationRecord(a, tokens);
      if (scoreDiff !== 0) return scoreDiff;
      return a.rel.localeCompare(b.rel);
    });
    matches = dedupeAnimationMatchesByClip(matches, tokens, targetInfo);
    return matches.map((record) => record.full);
  }
  function resolveAnimationSource(prefabPath, animationSource) {
    if (!animationSource) return null;
    const direct = resolveAsset(args.assetRoot, prefabPath, animationSource);
    if (existsFile(direct)) return direct;

    indexAnimationFiles();
    const basename = path.basename(animationSource).toLowerCase();
    const candidates = animationPathIndex.get(basename) || [];
    if (!candidates.length) return direct;
    if (candidates.length === 1) return candidates[0];

    const desiredParts = animationSource.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
    let best = candidates[0];
    let bestScore = -1;
    for (const candidate of candidates) {
      const parts = candidate.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
      let score = 0;
      for (const part of desiredParts) if (parts.includes(part)) score += 1;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }
  function resolveAnimationSourceFuzzy(animationSource) {
    indexAnimationFiles();
    const requestedStem = path.basename(animationSource, path.extname(animationSource)).toLowerCase();
    const requestedParts = requestedStem.split(/[^a-z0-9]+/).filter(Boolean);
    let best = null;
    let bestScore = -1;
    for (const candidate of allAnimationPaths) {
      const candidateStem = path.basename(candidate, path.extname(candidate)).toLowerCase();
      let score = 0;
      if (candidateStem === requestedStem) score += 100;
      for (const part of requestedParts) {
        if (candidateStem.includes(part)) score += 2;
      }
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : null;
  }
  function resolveAnimationPath(prefabPath, animationSource) {
    const resolved = resolveAnimationSource(prefabPath, animationSource);
    if (existsFile(resolved)) return resolved;
    return resolveAnimationSourceFuzzy(animationSource) || resolved;
  }

  const sceneName = sanitizeName(path.basename(prefabPath, path.extname(prefabPath)));
  let prefabOutDir = path.resolve(args.outDir);
  if (searchRoot) {
    const relPrefab = path.relative(searchRoot, prefabPath);
    prefabOutDir = path.join(prefabOutDir, path.dirname(relPrefab));
  }
  mkdirp(prefabOutDir);

  const embeddedBySrc = new Map();
  const manifestModels = [];
  const warnings = [];

  for (const node of modelNodes) {
    if (!node.resolvedSource) {
      manifestModels.push({
        path: node.pathName,
        name: node.name,
        source: node.source,
        resolvedSource: null,
        nodeName: sanitizeName(node.name),
        hmdMaterials: [],
        gradMat: node.gradMat || null,
        materialOverrides: node.materialOverrides || [],
        warnings: [`Could not resolve model source ${node.source}`],
        vertexScore: 0,
      });
      continue;
    }

    const asset = getAssetForSource(node.resolvedSource);
    const animationTargetInfo = buildAnimationTargetInfo(asset);
    const animationTokens = tokenizeForAnimationMatch(
      path.basename(node.resolvedSource, path.extname(node.resolvedSource)),
      node.name,
      path.basename(prefabPath, path.extname(prefabPath)),
      path.dirname(path.relative(assetRootResolved, node.resolvedSource))
    );
    node.asset = asset;
    const animationAssets = [];
    const animationSources = [];
    const seenAnimationSources = new Set();
    if (node.animation) {
      node.resolvedAnimation = resolveAnimationPath(prefabPath, node.animation);
    }
    if (node.resolvedAnimation && existsFile(node.resolvedAnimation)) {
      animationSources.push(node.resolvedAnimation);
      seenAnimationSources.add(node.resolvedAnimation);
    } else if (node.animation) {
      node.animationAsset = null;
      warnings.push(`${node.pathName}: Could not resolve animation source ${node.animation}`);
    }
    for (const hintedAnimation of resolveAnimationsFromHints(node.resolvedSource, node.name, prefabPath, {
      explicitAnimationSource: node.resolvedAnimation,
      targetInfo: animationTargetInfo,
    })) {
      if (seenAnimationSources.has(hintedAnimation)) continue;
      seenAnimationSources.add(hintedAnimation);
      animationSources.push(hintedAnimation);
    }
    const dedupedAnimationSources = dedupeAnimationSourcePaths(
      animationSources,
      animationTokens,
      animationTargetInfo,
      node.resolvedAnimation || null
    );
    for (const animationSource of dedupedAnimationSources) {
      try {
        animationAssets.push(getAnimationAssetForSource(animationSource));
      } catch (err) {
        warnings.push(`${node.pathName}: Failed to parse animation source ${animationSource}: ${err.message || err}`);
      }
    }
    node.animationAssets = animationAssets;
    node.animationAsset = animationAssets[0] || null;
    const vertexScore = asset.hmd.geometries.reduce((sum, g) => sum + (g.vertexCount || 0), 0);
    const skinnedModel = asset.hmd.models.find((model) => model.skin) || null;
    const boundJointCount = skinnedModel?.skin?.joints?.filter((joint) => joint.bind >= 0).length || 0;
    const bonesPerVertex = hasProp(asset.hmd.geometries[0]?.props, 'FourBonesByVertex') ? 4 : 3;
    const blendShapes = (asset.hmd.shapes || []).map((shape) => ({
      name: shape.name,
      geom: shape.geom,
      vertexCount: shape.vertexCount,
      indexCount: shape.indexCount,
      attributes: shape.vertexFormat.inputs.map((input) => input.name),
    }));
    const colliderTypes = (asset.hmd.colliders || []).map((collider) => collider.type);

    const hmdMaterials = resolveMaterialBindingsForModel(asset.hmd.materials, node.resolvedSource, args.assetRoot, materialResolverCache);
    asset.materialInfos = hmdMaterials;

    for (const m of hmdMaterials) {
      m.diffuseOut = embedTextureIfFound(m.diffuseResolved, embeddedBySrc, args.assetRoot);
      m.specularOut = embedTextureIfFound(m.specularResolved, embeddedBySrc, args.assetRoot);
      m.normalOut = embedTextureIfFound(m.normalResolved, embeddedBySrc, args.assetRoot);
    }

    let gradMat = node.gradMat ? { ...node.gradMat } : null;
    const localWarnings = [];
    gradMat = embedGradMatOutputs(gradMat, embeddedBySrc, args.assetRoot, localWarnings);

    const materialOverrides = (node.materialOverrides || []).map((m) => ({
      name: m.name,
      materialName: m.materialName || null,
      gradMat: embedGradMatOutputs(m.gradMat || null, embeddedBySrc, args.assetRoot, localWarnings),
      raw: m.raw,
    }));

    manifestModels.push({
      path: node.pathName,
      name: node.name,
      source: node.source,
      resolvedSource: node.resolvedSource,
      nodeName: sanitizeName(node.name),
      hmdMaterials,
      defaultAnimationSource: node.animation || animationAssets[0]?.sourcePath || null,
      defaultAnimationResolved: node.resolvedAnimation || animationAssets[0]?.sourcePath || null,
      animations: animationAssets.flatMap((animationAsset) => (animationAsset?.decodedAnimations || []).map((animation) => ({
        name: animation.name,
        sourcePath: animationAsset.sourcePath,
        frames: animation.frames,
        sampling: animation.sampling,
        speed: animation.speed,
        duration: animation.duration,
        loop: animation.loop,
        objectCount: animation.objects.length,
        eventCount: animation.events?.length || 0,
      }))),
      hmdMeta: {
        modelCount: asset.hmd.models.length,
        skinnedModelCount: asset.hmd.models.filter((model) => model.skin).length,
        jointCount: skinnedModel?.skin?.joints?.length || 0,
        boundJointCount,
        bonesPerVertex,
        splitSkinCount: skinnedModel?.skin?.split?.length || 0,
        colliderTypes,
        blendShapes,
      },
      gradMat,
      materialOverrides,
      warnings: localWarnings,
      vertexScore,
    });
    warnings.push(...localWarnings.map((w) => `${node.pathName}: ${w}`));
  }

  const primary = choosePrimaryModel(manifestModels);
  const manifest = {
    prefab: prefabPath,
    assetRoot: path.resolve(args.assetRoot),
    cdb: cdb ? cdb.path : null,
    models: manifestModels,
    primaryModelPath: primary?.path || null,
    hmdMaterials: primary?.hmdMaterials || [],
    gradMat: primary?.gradMat || null,
    warnings,
  };

  exportPrefabSceneGlb({ outDir: prefabOutDir, sceneName, sceneSpec, manifest, embeddedTextures: Array.from(embeddedBySrc.values()) });

  return {
    prefab: prefabPath,
    outDir: prefabOutDir,
    glb: path.join(prefabOutDir, `${sceneName}.glb`),
    modelCount: manifestModels.length,
    primaryModelPath: manifest.primaryModelPath,
    warnings,
  };
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function processOneInput(inputPath, args, gradMap, cdb, options = {}) {
  const inputStat = fs.statSync(inputPath);
  const isDirectoryInput = inputStat.isDirectory();
  const searchRoot = isDirectoryInput ? path.resolve(inputPath) : null;
  const prefabPaths = collectPrefabPaths(inputPath);
  if (!prefabPaths.length) throw new Error(`No prefab files found under ${inputPath}`);
  mkdirp(args.outDir);
  const successes = [];
  const failures = [];
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const total = prefabPaths.length;
  const progressEvery = Math.max(
    1,
    Number.isFinite(options.progressEvery)
      ? Number(options.progressEvery)
      : total >= 500
        ? 50
        : total >= 150
          ? 25
          : 10
  );
  onProgress?.({ prefab: null, current: 0, total, exported: 0, failed: 0 });
  for (const prefabPath of prefabPaths) {
    try {
      successes.push(processPrefab(prefabPath, args, gradMap, cdb, searchRoot));
    } catch (err) {
      failures.push({
        prefab: prefabPath,
        error: err?.message || String(err),
        stack: err?.stack || String(err),
      });
    }
    const current = successes.length + failures.length;
    const failed = failures.length;
    if (onProgress && current < total && current % progressEvery === 0) {
      onProgress({ prefab: prefabPath, current, total, exported: successes.length, failed });
    }
  }
  return {
    input: inputPath,
    assetRoot: path.resolve(args.assetRoot),
    cdb: cdb ? cdb.path : null,
    outDir: path.resolve(args.outDir),
    searchedRecursively: isDirectoryInput,
    prefabCount: prefabPaths.length,
    exportedCount: successes.length,
    failedCount: failures.length,
    exports: successes,
    failures,
  };
}

function getBatchInputs(args) {
  return DEFAULT_BATCH_FOLDERS
    .map((folder) => {
      const input = path.join(args.assetRoot, folder);
      if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) return null;
      return {
        folder,
        input: path.resolve(input),
        outDir: path.join(args.outDir, folder),
      };
    })
    .filter(Boolean);
}

function aggregateBatchSummaries(args, summaries) {
  return {
    mode: 'default-batch',
    assetRoot: path.resolve(args.assetRoot),
    outDir: path.resolve(args.outDir),
    folderCount: summaries.length,
    folders: summaries,
    exports: summaries.flatMap((s) => s.exports || []),
    failures: summaries.flatMap((s) => s.failures || []),
    prefabCount: summaries.reduce((n, s) => n + (s.prefabCount || 0), 0),
    exportedCount: summaries.reduce((n, s) => n + (s.exportedCount || 0), 0),
    failedCount: summaries.reduce((n, s) => n + (s.failedCount || 0), 0),
  };
}

function buildFailureReport(summary) {
  return {
    generatedAt: new Date().toISOString(),
    mode: summary.mode || 'single-input',
    input: summary.input || null,
    assetRoot: summary.assetRoot,
    outDir: summary.outDir,
    prefabCount: summary.prefabCount,
    exportedCount: summary.exportedCount,
    failedCount: summary.failedCount,
    failures: Array.isArray(summary.failures) ? summary.failures : [],
  };
}

function buildPublicSummary(summary, failureReport) {
  return {
    ...summary,
    folders: Array.isArray(summary.folders)
      ? summary.folders.map((folderSummary) => buildPublicSummary(folderSummary, null))
      : summary.folders,
    failures: (summary.failures || []).map(({ prefab, error }) => ({ prefab, error })),
    failureReport,
  };
}

function writeFailureReport(summary) {
  const failureReportPath = path.join(path.resolve(summary.outDir), 'prefab-export-failures.json');
  if (!summary.failedCount) {
    try { fs.rmSync(failureReportPath, { force: true }); } catch {}
    return null;
  }
  writeJson(failureReportPath, buildFailureReport(summary));
  return path.basename(failureReportPath);
}

function finalizeSummary(summary, options = {}) {
  const failureReport = writeFailureReport(summary);
  const publicSummary = buildPublicSummary(summary, failureReport);
  if (options.summaryPath) writeJson(options.summaryPath, publicSummary);
  return publicSummary;
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = {};
  const batchInputs = args.batch ? getBatchInputs(args) : [];
  const folderSummaries = [];
  const tasks = [
    {
      title: 'Load model export inputs',
      task: (_taskCtx, task) => {
        ctx.args = args;
        ctx.gradMap = args.gradMap ? JSON.parse(fs.readFileSync(args.gradMap, 'utf8')) : null;
        ctx.cdbPath = findCdb(path.resolve(args.assetRoot), args.cdb);
        ctx.cdb = loadCdb(ctx.cdbPath);
        const cdbLabel = ctx.cdbPath ? path.basename(ctx.cdbPath) : 'no data.cdb';
        task.output = args.batch
          ? `${batchInputs.length} folders, ${cdbLabel}`
          : `${path.basename(args.input)}, ${cdbLabel}`;
      },
    },
  ];

  if (args.batch) {
    if (!batchInputs.length) {
      tasks.push({
        title: 'Export prefab folders',
        task: (_taskCtx, task) => {
          ctx.detailedSummary = aggregateBatchSummaries(args, []);
          task.skip('No default batch folders found');
        },
      });
    } else {
      for (const folderInput of batchInputs) {
        tasks.push({
          title: `Export folder: ${folderInput.folder}`,
          task: (_taskCtx, task) => {
            const subArgs = { ...args, input: folderInput.input, outDir: folderInput.outDir };
            const summary = processOneInput(folderInput.input, subArgs, ctx.gradMap, ctx.cdb, {
              onProgress: (progress) => {
                task.output = formatCount(progress.current, progress.total, 'prefabs', { failed: progress.failed });
              },
            });
            folderSummaries.push(summary);
            task.output = formatCount(summary.exportedCount, summary.prefabCount, 'prefabs', { failed: summary.failedCount });
          },
        });
      }
    }
  } else {
    tasks.push({
      title: 'Export prefabs',
      task: (_taskCtx, task) => {
        const inputPath = path.resolve(args.input);
        ctx.detailedSummary = processOneInput(inputPath, args, ctx.gradMap, ctx.cdb, {
          onProgress: (progress) => {
            task.output = formatCount(progress.current, progress.total, 'prefabs', { failed: progress.failed });
          },
        });
        task.output = formatCount(ctx.detailedSummary.exportedCount, ctx.detailedSummary.prefabCount, 'prefabs', {
          failed: ctx.detailedSummary.failedCount,
        });
      },
    });
  }

  tasks.push({
    title: 'Write export reports',
    task: (_taskCtx, task) => {
      if (args.batch) {
        ctx.detailedSummary = ctx.detailedSummary || aggregateBatchSummaries(args, folderSummaries);
      }
      const summaryPath = args.batch || fs.statSync(path.resolve(args.input)).isDirectory()
        ? path.join(path.resolve(args.outDir), 'prefab-export-summary.json')
        : null;
      ctx.result = finalizeSummary(ctx.detailedSummary, { summaryPath });
      const reportParts = [formatCount(ctx.result.exportedCount, ctx.result.prefabCount, 'prefabs', { failed: ctx.result.failedCount })];
      if (summaryPath) reportParts.push(path.basename(summaryPath));
      if (ctx.result.failureReport) reportParts.push(ctx.result.failureReport);
      task.output = reportParts.join(', ');
    },
  });

  await runTaskList(tasks, { tag: 'model-tools' });

  return ctx.result;
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
