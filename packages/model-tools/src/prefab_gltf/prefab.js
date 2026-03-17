const path = require('path');
const { readJsonOrHbson, resolveAsset, deepMerge } = require('./utils');
const { buildGradientMap } = require('./cdb');

function typeName(node) {
  const t = node?.type ?? node?.__type ?? node?.kind ?? '';
  return String(t).toLowerCase();
}

function looksLikeReference(node) {
  const t = typeName(node);
  return t.includes('reference') || (node && node.source && /\.(prefab|prefab\.json|prefab\.hbson)$/i.test(String(node.source)) && !t.includes('model'));
}

function looksLikeModel(node) {
  const t = typeName(node);
  return t.includes('model') || (node && typeof node.source === 'string' && /\.fbx$/i.test(node.source));
}

function looksLikeGradMat(node) {
  const t = typeName(node);
  return t.includes('gradmat');
}

function looksLikeMaterial(node) {
  const t = typeName(node);
  return t.includes('material') && !looksLikeGradMat(node);
}

function looksLikeObject(node) {
  const t = typeName(node);
  return t.includes('object');
}

function looksLikeConstraint(node) {
  const t = typeName(node);
  return t.includes('constraint');
}

function walk(node, parentPath = '$', out = []) {
  out.push({ node, path: parentPath });
  const kids = Array.isArray(node?.children) ? node.children : [];
  kids.forEach((child, i) => walk(child, `${parentPath}.children[${i}]`, out));
  return out;
}

function loadPrefab(prefabPath, assetRoot, seen = new Set()) {
  const abs = path.resolve(prefabPath);
  if (seen.has(abs)) throw new Error(`Reference loop while loading ${abs}`);
  seen.add(abs);
  let data = readJsonOrHbson(abs);
  data = resolveReferences(data, abs, assetRoot, seen);
  return data;
}

function resolveReferences(node, currentFile, assetRoot, seen) {
  if (!node || typeof node !== 'object') return node;
  if (looksLikeReference(node) && node.source) {
    const refPath = resolveAsset(assetRoot, currentFile, node.source);
    if (!refPath) return { ...node, __unresolvedReference: node.source };
    const loaded = loadPrefab(refPath, assetRoot, seen);
    const patched = node.overrides && typeof node.overrides === 'object' ? deepMerge(loaded, node.overrides) : loaded;
    return resolveReferences(patched, refPath, assetRoot, seen);
  }
  const out = { ...node };
  if (Array.isArray(node.children)) out.children = node.children.map((c) => resolveReferences(c, currentFile, assetRoot, seen));
  return out;
}

function findFirstGradMat(node) {
  const kids = Array.isArray(node?.children) ? node.children : [];
  for (const child of kids) {
    if (looksLikeGradMat(child)) return child;
  }
  for (const child of kids) {
    const found = findFirstGradMat(child);
    if (found) return found;
  }
  return null;
}

function buildMaterialOverrideSpec(node, assetRoot, prefabPath, gradMap = null, cdb = null) {
  if (!looksLikeMaterial(node)) return null;
  const gradMatNode = (Array.isArray(node.children) ? node.children : []).find((child) => looksLikeGradMat(child)) || null;
  return {
    name: node.name || node.materialName || 'material',
    materialName: node.materialName || node.name || null,
    gradMat: gradMatNode ? buildGradMatSpec({ raw: gradMatNode, name: gradMatNode.name }, assetRoot, prefabPath, gradMap, cdb) : null,
    raw: node,
  };
}

function collectPrefabInfo(prefab, prefabPath, assetRoot) {
  const entries = walk(prefab);
  const models = [];
  const materials = [];
  const gradMats = [];

  for (const entry of entries) {
    const node = entry.node;
    if (!node || typeof node !== 'object') continue;
    if (looksLikeModel(node)) {
      const gradMatNode = findFirstGradMat(node);
      models.push({
        path: entry.path,
        name: node.name || path.basename(String(node.source || 'model')),
        source: node.source,
        resolvedSource: resolveAsset(assetRoot, prefabPath, node.source),
        gradMatNode,
        raw: node,
      });
      if (gradMatNode) {
        gradMats.push({
          path: `${entry.path}.gradMat`,
          name: gradMatNode.name || 'GradMat',
          raw: gradMatNode,
          ownerModelPath: entry.path,
        });
      }
    } else if (looksLikeGradMat(node)) {
      gradMats.push({ path: entry.path, name: node.name || 'GradMat', raw: node });
    } else if (looksLikeMaterial(node)) {
      materials.push({ path: entry.path, name: node.name || node.materialName || 'MaterialOverride', raw: node });
    }
  }

  return { models, materials, gradMats };
}

function degToRad(v) { return (Number(v) || 0) * Math.PI / 180; }
function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
function quatFromAxisAngle(x, y, z, angle) {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
}
function quatNormalize(q) {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return q.map((v) => v / len);
}
function quatFromEulerDegXYZ(rx, ry, rz) {
  const qx = quatFromAxisAngle(1, 0, 0, degToRad(rx));
  const qy = quatFromAxisAngle(0, 1, 0, degToRad(ry));
  const qz = quatFromAxisAngle(0, 0, 1, degToRad(rz));
  return quatNormalize(quatMul(quatMul(qx, qy), qz));
}

function defaultTransform(node) {
  const translation = Array.isArray(node.position)
    ? [Number(node.position[0]) || 0, Number(node.position[1]) || 0, Number(node.position[2]) || 0]
    : [Number(node.x) || 0, Number(node.y) || 0, Number(node.z) || 0];

  let authoredRotation;
  if (Array.isArray(node.rotation) && node.rotation.length === 4) {
    authoredRotation = node.rotation.map((v) => Number(v) || 0);
  } else if (Array.isArray(node.rot) && node.rot.length === 4) {
    authoredRotation = node.rot.map((v) => Number(v) || 0);
  } else if (Array.isArray(node.rotation) && node.rotation.length === 3) {
    authoredRotation = quatFromEulerDegXYZ(node.rotation[0], node.rotation[1], node.rotation[2]);
  } else {
    authoredRotation = quatFromEulerDegXYZ(node.rotationX || 0, node.rotationY || 0, node.rotationZ || 0);
  }

  const authoredScale = Array.isArray(node.scale)
    ? [Number(node.scale[0]) || 1, Number(node.scale[1]) || 1, Number(node.scale[2]) || 1]
    : [Number(node.scaleX) || Number(node.sx) || 1, Number(node.scaleY) || Number(node.sy) || 1, Number(node.scaleZ) || Number(node.sz) || 1];

  return {
    translation,
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    authoredRotation,
    authoredScale,
  };
}

function buildGradMatSpec(node, assetRoot, prefabPath, gradMap = null, cdb = null) {
  const raw = node.raw || node;
  const readProp = (key, fallback = undefined) => {
    if (raw[key] != null) return raw[key];
    if (raw.props && raw.props[key] != null) return raw.props[key];
    return fallback;
  };
  const slots = Array.isArray(raw.slots) ? raw.slots.slice() : [];
  const slotCount = slots.length;
  const declaredMaxSlotsRaw = readProp('numSlots', null);
  // Heaps keeps GradMat MAX_SLOTS at 8 unless the prefab explicitly overrides it.
  // That grid size is separate from the number of populated slot textures.
  const declaredMaxSlots = Number.isFinite(Number(declaredMaxSlotsRaw)) && Number(declaredMaxSlotsRaw) > 0
    ? Number(declaredMaxSlotsRaw)
    : 8;
  const cdbGradMap = cdb ? buildGradientMap(cdb, assetRoot, prefabPath) : new Map();
  const resolvedSlots = slots.map((slot) => {
    const manual = gradMap && gradMap[slot] ? gradMap[slot] : null;
    const cdbEntry = cdbGradMap.get(slot) || null;
    const texture = manual || cdbEntry?.texture || null;
    const resolvedTexture = manual ? resolveAsset(assetRoot, prefabPath, manual) : (cdbEntry?.resolvedTexture || null);
    return {
      id: slot,
      texture,
      resolvedTexture,
      source: manual ? 'grad-map' : (cdbEntry ? 'data.cdb' : null),
      cdbRef: cdbEntry?.ref || null,
      bodyParts: cdbEntry?.bodyParts ?? null,
      playerCustomization: cdbEntry?.playerCustomization ?? null,
    };
  });
  return {
    name: node.name || raw.name || 'GradMat',
    slots,
    numSlots: slotCount,
    maxSlots: declaredMaxSlots,
    shaderMaxSlots: declaredMaxSlots,
    slotCount,
    resolvedSlots,
    linesTex: 'Character/Common/Texture/UV_Lines.png',
    linesTexResolved: resolveAsset(assetRoot, prefabPath, 'Character/Common/Texture/UV_Lines.png'),
    patternPath: readProp('patternPath', null) || null,
    patternResolved: resolveAsset(assetRoot, prefabPath, readProp('patternPath', null) || null),
    patternAlphaPath: readProp('patternAlphaPath', null) || null,
    patternAlphaResolved: resolveAsset(assetRoot, prefabPath, readProp('patternAlphaPath', null) || null),
    marks: [raw.mark0Path, raw.mark1Path, raw.mark2Path, raw.mark3Path].map((p) => p || null),
    marksResolved: [raw.mark0Path, raw.mark1Path, raw.mark2Path, raw.mark3Path].map((p) => resolveAsset(assetRoot, prefabPath, p || null)),
    outlineSize: readProp('outlineSize', 0) ?? 0,
    outlineIntensity: readProp('outlineIntensity', 1) ?? 1,
    linesBlend: readProp('linesBlend', 1) ?? 1,
    minLightPower: readProp('minLightPower', 0) ?? 0,
    shadowSmooth: readProp('shadowSmooth', 0.1) ?? 0.1,
    lightSmooth: readProp('lightSmooth', 0.1) ?? 0.1,
    terminatorSize: readProp('terminatorSize', 0.5) ?? 0.5,
    shadowBias: readProp('shadowBias', 0) ?? 0,
    specSize: readProp('specSize', 0.8) ?? 0.8,
    specInsideSize: readProp('specInsideSize', 0.5) ?? 0.5,
    specInsideIntensity: readProp('specInsideIntensity', 0) ?? 0,
    specSmooth: readProp('specSmooth', 0.05) ?? 0.05,
    specAlpha: readProp('specAlpha', 1) ?? 1,
    emissivePow: readProp('emissivePow', 0) ?? 0,
    rimLightAngle: readProp('rimLightAngle', 0) ?? 0,
    rimLightWidth: readProp('rimLightWidth', 1) ?? 1,
    rimLightSize: readProp('rimLightSize', 0) ?? 0,
    rimLightSmooth: readProp('rimLightSmooth', 0.05) ?? 0.05,
    rimLightMin: readProp('rimLightMin', 0) ?? 0,
    rimLightSpecMultiplier: readProp('rimLightSpecMultiplier', 0) ?? 0,
    rimLightColor: readProp('rimLightColor', [1, 1, 1]) ?? [1, 1, 1],
    ambientColor: readProp('ambientColor', [1, 1, 1]) ?? [1, 1, 1],
    ambientIntensity: readProp('ambientIntensity', 0) ?? 0,
    useVertexColor: true,
  };
}

function buildPrefabScene(prefab, prefabPath, assetRoot, gradMap = null, cdb = null) {
  const nodes = [];
  const constraints = [];
  let nextId = 0;

  function descend(children, parentId, parentPath) {
    const kids = Array.isArray(children) ? children : [];
    for (const child of kids) {
      if (!child || typeof child !== 'object') continue;
      if (looksLikeConstraint(child)) {
        constraints.push({
          name: child.name || `constraint_${constraints.length}`,
          object: child.object || null,
          target: child.target || null,
          raw: child,
        });
        continue;
      }

      const isNode = looksLikeObject(child) || looksLikeModel(child);
      let effectiveParentId = parentId;
      let effectiveParentPath = parentPath;

      if (isNode) {
        const name = child.name || (looksLikeModel(child)
          ? path.basename(String(child.source || `model_${nextId}`), path.extname(String(child.source || '')))
          : `object_${nextId}`);
        const pathName = effectiveParentPath ? `${effectiveParentPath}.${name}` : name;
        const entry = {
          id: nextId++,
          parentId: effectiveParentId,
          type: looksLikeModel(child) ? 'model' : 'object',
          name,
          pathName,
          transform: defaultTransform(child),
          raw: child,
        };
        if (entry.type === 'model') {
          entry.source = child.source || null;
          entry.resolvedSource = resolveAsset(assetRoot, prefabPath, child.source || null);
          entry.animation = child.animation || null;
          entry.resolvedAnimation = resolveAsset(assetRoot, prefabPath, child.animation || null);
          entry.materialOverrides = (Array.isArray(child.children) ? child.children : [])
            .filter((n) => looksLikeMaterial(n))
            .map((n) => buildMaterialOverrideSpec(n, assetRoot, prefabPath, gradMap, cdb))
            .filter(Boolean);
          const directGradNode = (Array.isArray(child.children) ? child.children : []).find((n) => looksLikeGradMat(n)) || null;
          const materialGradOverrides = entry.materialOverrides.filter((override) => override.gradMat);
          entry.gradMat = directGradNode
            ? buildGradMatSpec({ raw: directGradNode, name: directGradNode.name }, assetRoot, prefabPath, gradMap, cdb)
            : (materialGradOverrides.length === 1 ? materialGradOverrides[0].gradMat : null);
        }
        nodes.push(entry);
        effectiveParentId = entry.id;
        effectiveParentPath = entry.pathName;
      }

      descend(child.children, effectiveParentId, effectiveParentPath);
    }
  }

  descend(prefab.children, null, '');
  return { nodes, constraints };
}

module.exports = {
  loadPrefab,
  collectPrefabInfo,
  buildGradMatSpec,
  buildPrefabScene,
  looksLikeModel,
  looksLikeMaterial,
  looksLikeGradMat,
  looksLikeObject,
  looksLikeConstraint,
  typeName,
};
