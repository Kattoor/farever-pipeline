const fs = require('fs');
const path = require('path');
const { decodeBlendShape, hasProp } = require('./hmd');
const { mkdirp, sanitizeName } = require('./utils');

function quatFromHmd(p) {
  // Heaps' quaternion storage maps directly to glTF TRS values; the row/column
  // convention difference is already handled by how matrices are flattened.
  return [p.qx, p.qy, p.qz, p.qw];
}

function alignChunks(chunks, align, padByte = 0) {
  let size = chunks.reduce((a, b) => a + b.length, 0);
  const pad = (align - (size % align)) % align;
  if (pad) {
    chunks.push(Buffer.alloc(pad, padByte));
    size += pad;
  }
  return size;
}

function pushBufferAndView(binChunks, bufferViews, bytes, target = null, byteStride = undefined) {
  const offset = alignChunks(binChunks, 4);
  binChunks.push(Buffer.from(bytes));
  const view = { buffer: 0, byteOffset: offset, byteLength: bytes.length };
  if (target != null) view.target = target;
  if (byteStride != null) view.byteStride = byteStride;
  const index = bufferViews.length;
  bufferViews.push(view);
  return index;
}

function minMax(arr, comps) {
  const min = Array(comps).fill(Infinity);
  const max = Array(comps).fill(-Infinity);
  for (let i = 0; i < arr.length; i += comps) {
    for (let c = 0; c < comps; c++) {
      const v = arr[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

function accessorTypeForComps(comps) {
  switch (comps) {
    case 1: return 'SCALAR';
    case 2: return 'VEC2';
    case 3: return 'VEC3';
    case 4: return 'VEC4';
    case 16: return 'MAT4';
    default: throw new Error(`Unsupported accessor component count ${comps}`);
  }
}

function floatAccessor(binChunks, bufferViews, accessors, data, type = null, comps = 1, options = {}) {
  const { target = 34962, includeMinMax = true } = options;
  const bytes = Buffer.alloc(data.length * 4);
  for (let i = 0; i < data.length; i++) bytes.writeFloatLE(data[i], i * 4);
  const view = pushBufferAndView(binChunks, bufferViews, bytes, target);
  const idx = accessors.length;
  const accessor = { bufferView: view, componentType: 5126, count: data.length / comps, type: type || accessorTypeForComps(comps) };
  if (includeMinMax) {
    const { min, max } = minMax(data, comps);
    accessor.min = min;
    accessor.max = max;
  }
  accessors.push(accessor);
  return idx;
}

function indexAccessor(binChunks, bufferViews, accessors, indices) {
  const maxIndex = indices.reduce((a, b) => Math.max(a, b), 0);
  const use32 = maxIndex > 65535;
  const bytes = Buffer.alloc(indices.length * (use32 ? 4 : 2));
  for (let i = 0; i < indices.length; i++) {
    if (use32) bytes.writeUInt32LE(indices[i], i * 4);
    else bytes.writeUInt16LE(indices[i], i * 2);
  }
  const view = pushBufferAndView(binChunks, bufferViews, bytes, 34963);
  const idx = accessors.length;
  accessors.push({ bufferView: view, componentType: use32 ? 5125 : 5123, count: indices.length, type: 'SCALAR', min: [0], max: [maxIndex] });
  return idx;
}

function unsignedAccessor(binChunks, bufferViews, accessors, data, comps, componentType, options = {}) {
  const { target = 34962 } = options;
  const componentSize = componentType === 5121 ? 1 : componentType === 5123 ? 2 : 4;
  const bytes = Buffer.alloc(data.length * componentSize);
  for (let i = 0; i < data.length; i++) {
    if (componentType === 5121) bytes.writeUInt8(data[i], i);
    else if (componentType === 5123) bytes.writeUInt16LE(data[i], i * 2);
    else bytes.writeUInt32LE(data[i], i * 4);
  }
  const view = pushBufferAndView(binChunks, bufferViews, bytes, target);
  const { min, max } = minMax(data, comps);
  const idx = accessors.length;
  accessors.push({ bufferView: view, componentType, count: data.length / comps, type: accessorTypeForComps(comps), min, max });
  return idx;
}

function normalizeMaybe(values) {
  return values.map((v) => Math.abs(v) > 1.001 && Number.isInteger(v) ? (v / 255) : v);
}

function positionToMatrixElements(position, postScale = false) {
  const qx = position.qx;
  const qy = position.qy;
  const qz = position.qz;
  const qw = position.qw;
  const sx = position.sx;
  const sy = position.sy;
  const sz = position.sz;

  const xx = qx * qx;
  const xy = qx * qy;
  const xz = qx * qz;
  const xw = qx * qw;
  const yy = qy * qy;
  const yz = qy * qz;
  const yw = qy * qw;
  const zz = qz * qz;
  const zw = qz * qw;

  let m11 = 1 - 2 * (yy + zz);
  let m12 = 2 * (xy + zw);
  let m13 = 2 * (xz - yw);
  let m21 = 2 * (xy - zw);
  let m22 = 1 - 2 * (xx + zz);
  let m23 = 2 * (yz + xw);
  let m31 = 2 * (xz + yw);
  let m32 = 2 * (yz - xw);
  let m33 = 1 - 2 * (xx + yy);
  let m41 = position.x;
  let m42 = position.y;
  let m43 = position.z;
  const m44 = 1;

  if (postScale) {
    // Mirrors Heaps Position.toMatrix(true): translate first, then scale.
    m11 *= sx; m21 *= sx; m31 *= sx; m41 *= sx;
    m12 *= sy; m22 *= sy; m32 *= sy; m42 *= sy;
    m13 *= sz; m23 *= sz; m33 *= sz; m43 *= sz;
  } else {
    // Mirrors Heaps Position.toMatrix(): scale rows, then translate.
    m11 *= sx; m12 *= sx; m13 *= sx;
    m21 *= sy; m22 *= sy; m23 *= sy;
    m31 *= sz; m32 *= sz; m33 *= sz;
  }

  // Heaps stores row-vector matrices; glTF expects column-major arrays for the
  // equivalent column-vector transform. Flattening the Heaps matrix row-wise
  // yields the correct glTF matrix elements.
  return [
    m11, m12, m13, 0,
    m21, m22, m23, 0,
    m31, m32, m33, 0,
    m41, m42, m43, m44,
  ];
}

function matrixAccessor(binChunks, bufferViews, accessors, matrices) {
  return floatAccessor(binChunks, bufferViews, accessors, matrices.flat(), 'MAT4', 16, { target: null, includeMinMax: false });
}

function buildMorphTargets(binChunks, bufferViews, accessors, geom, blendShapes) {
  if (!Array.isArray(blendShapes) || blendShapes.length === 0) return { targets: [], extras: [] };
  const targets = [];
  const extras = [];
  for (const shape of blendShapes) {
    const targetAttributes = {};
    if (shape.positionDeltas) targetAttributes.POSITION = floatAccessor(binChunks, bufferViews, accessors, shape.positionDeltas, 'VEC3', 3);
    if (shape.normalDeltas) targetAttributes.NORMAL = floatAccessor(binChunks, bufferViews, accessors, shape.normalDeltas, 'VEC3', 3, { includeMinMax: false });
    if (Object.keys(targetAttributes).length === 0) continue;
    targets.push(targetAttributes);
    extras.push({ name: shape.name, vertexCount: shape.vertexCount, indexCount: shape.indexCount });
  }
  return { targets, extras };
}

function buildDenseBlendShape(shape, baseVertexCount) {
  const positionDeltas = shape.attributes.position ? new Array(baseVertexCount * 3).fill(0) : null;
  const normalDeltas = shape.attributes.normal ? new Array(baseVertexCount * 3).fill(0) : null;

  for (let i = 0; i < shape.indexCount; i++) {
    const targets = shape.remap[i] || [];
    for (const targetVertex of targets) {
      if (positionDeltas) {
        positionDeltas[targetVertex * 3 + 0] = shape.attributes.position[i * 3 + 0] || 0;
        positionDeltas[targetVertex * 3 + 1] = shape.attributes.position[i * 3 + 1] || 0;
        positionDeltas[targetVertex * 3 + 2] = shape.attributes.position[i * 3 + 2] || 0;
      }
      if (normalDeltas) {
        normalDeltas[targetVertex * 3 + 0] = shape.attributes.normal[i * 3 + 0] || 0;
        normalDeltas[targetVertex * 3 + 1] = shape.attributes.normal[i * 3 + 1] || 0;
        normalDeltas[targetVertex * 3 + 2] = shape.attributes.normal[i * 3 + 2] || 0;
      }
    }
  }

  return { ...shape, positionDeltas, normalDeltas };
}

function remapSkinJointIndices(jointIndices, jointRemap = null) {
  if (!jointRemap) return jointIndices.slice();
  const remapped = jointIndices.slice();
  for (let i = 0; i < remapped.length; i += 4) {
    remapped[i + 0] = jointRemap[remapped[i + 0]] ?? remapped[i + 0];
    remapped[i + 1] = jointRemap[remapped[i + 1]] ?? remapped[i + 1];
    remapped[i + 2] = jointRemap[remapped[i + 2]] ?? remapped[i + 2];
    remapped[i + 3] = jointRemap[remapped[i + 3]] ?? remapped[i + 3];
  }
  return remapped;
}

function addPrimitiveFromGeometry(binChunks, bufferViews, accessors, geom, materialIndex, options = {}) {
  const { jointRemap = null, useFourBones = false, blendShapes = [] } = options;
  const attrMap = {};
  const pick = (keys) => keys.find((k) => geom.attributes[k]);
  const pos = pick(['position', 'pos']);
  const normal = pick(['normal']);
  const logicNormal = pick(['logicNormal']);
  const uv = pick(['uv']);
  const uv2 = pick(['uv2', 'uv1']);
  const color = pick(['color']);
  const weights = pick(['weights']);
  const indexes = pick(['indexes']);
  if (!pos) throw new Error('HMD geometry has no position attribute');
  attrMap.POSITION = floatAccessor(binChunks, bufferViews, accessors, geom.attributes[pos], 'VEC3', 3);
  if (normal) attrMap.NORMAL = floatAccessor(binChunks, bufferViews, accessors, normalizeMaybe(geom.attributes[normal]), 'VEC3', 3);
  if (logicNormal) {
    // GradMat in the game can shade against a custom logicNormal stream instead of raw mesh normals.
    attrMap._LOGICNORMAL = floatAccessor(binChunks, bufferViews, accessors, normalizeMaybe(geom.attributes[logicNormal]), 'VEC3', 3);
  }
  if (uv) attrMap.TEXCOORD_0 = floatAccessor(binChunks, bufferViews, accessors, normalizeMaybe(geom.attributes[uv]), 'VEC2', 2);
  if (uv2) attrMap.TEXCOORD_1 = floatAccessor(binChunks, bufferViews, accessors, normalizeMaybe(geom.attributes[uv2]), 'VEC2', 2);
  if (color) attrMap.COLOR_0 = floatAccessor(binChunks, bufferViews, accessors, normalizeMaybe(geom.attributes[color]), accessorTypeForComps(geom.attributes[color].length / (geom.vertexCount || 1) || 3), geom.attributes[color].length / (geom.vertexCount || 1) || 3);
  if (weights && indexes) {
    const sourceWeights = geom.attributes[weights];
    const jointWeights = [];
    for (let i = 0; i < sourceWeights.length; i += 3) {
      const w1 = sourceWeights[i + 0] || 0;
      const w2 = sourceWeights[i + 1] || 0;
      const w3 = sourceWeights[i + 2] || 0;
      const w4 = useFourBones ? Math.max(0, 1 - w1 - w2 - w3) : 0;
      jointWeights.push(w1, w2, w3, w4);
    }
    const jointIndices = remapSkinJointIndices(geom.attributes[indexes], jointRemap);
    attrMap.WEIGHTS_0 = floatAccessor(binChunks, bufferViews, accessors, jointWeights, 'VEC4', 4, { includeMinMax: false });
    attrMap.JOINTS_0 = unsignedAccessor(binChunks, bufferViews, accessors, jointIndices, 4, 5121);
  }
  const { targets, extras } = buildMorphTargets(binChunks, bufferViews, accessors, geom, blendShapes);
  const indexAccessorIndex = indexAccessor(binChunks, bufferViews, accessors, geom.indices);
  const primitive = { attributes: attrMap, indices: indexAccessorIndex, material: materialIndex, mode: 4 };
  if (targets.length) primitive.targets = targets;
  if (extras.length) primitive.extras = { blendShapes: extras };
  return primitive;
}

function detectTextureType(bytes, sourcePath = '') {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return { type: 'png', mimeType: 'image/png' };
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { type: 'jpeg', mimeType: 'image/jpeg' };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { type: 'webp', mimeType: 'image/webp' };
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'DDS ') return { type: 'dds', mimeType: 'image/vnd-ms.dds' };
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.png') return { type: 'png', mimeType: 'image/png' };
  if (ext === '.jpg' || ext === '.jpeg') return { type: 'jpeg', mimeType: 'image/jpeg' };
  if (ext === '.webp') return { type: 'webp', mimeType: 'image/webp' };
  if (ext === '.dds') return { type: 'dds', mimeType: 'image/vnd-ms.dds' };
  return { type: 'binary', mimeType: 'application/octet-stream' };
}

function buildEmbeddedTextureBundle(binChunks, bufferViews, embeddedTextures) {
  const meta = [];
  const images = [];
  const textures = [];
  const textureIndexByPath = new Map();
  for (const tex of embeddedTextures) {
    const view = pushBufferAndView(binChunks, bufferViews, tex.bytes);
    const detected = detectTextureType(tex.bytes, tex.sourcePath || tex.path || tex.name || '');
    const base = {
      path: tex.path,
      name: tex.name || path.basename(tex.path || tex.sourcePath || 'texture'),
      sourcePath: tex.sourcePath || null,
      bufferView: view,
      contentType: detected.type,
      mimeType: detected.mimeType,
      byteLength: tex.bytes.length,
    };
    if (detected.mimeType === 'image/png' || detected.mimeType === 'image/jpeg') {
      const imageIndex = images.length;
      images.push({
        name: base.name,
        bufferView: view,
        mimeType: detected.mimeType,
      });
      const textureIndex = textures.length;
      textures.push({ source: imageIndex, name: base.name });
      if (base.path) textureIndexByPath.set(base.path, textureIndex);
      if (base.sourcePath) textureIndexByPath.set(base.sourcePath, textureIndex);
      base.image = imageIndex;
      base.texture = textureIndex;
    }
    meta.push(base);
  }
  return { meta, images, textures, textureIndexByPath };
}

function buildGltfMaterial(materialInfo, textureIndexByPath) {
  const info = materialInfo || {};
  const pbrProps = info.pbrProps && typeof info.pbrProps === 'object' ? info.pbrProps : null;
  const baseColorFactor = Array.isArray(info.baseColorFactor) && info.baseColorFactor.length >= 4
    ? info.baseColorFactor.slice(0, 4)
    : [1, 1, 1, 1];
  const material = {
    name: info.name || 'mat',
    pbrMetallicRoughness: {
      baseColorFactor,
      metallicFactor: 0,
      roughnessFactor: 1,
    },
    doubleSided: pbrProps ? String(pbrProps.culling || '').toLowerCase() !== 'back' : true,
    extras: {
      diffuseTexture: info.diffuseTexture || null,
      specularTexture: info.specularTexture || null,
      normalMap: info.normalMap || null,
      libraryRef: info.libraryRef || null,
      libraryMaterialName: info.libraryMaterialName || null,
      materialSource: info.source || 'hmd',
    },
  };
  const diffuseIndex = info.diffuseOut ? textureIndexByPath.get(info.diffuseOut) : null;
  const normalIndex = info.normalOut ? textureIndexByPath.get(info.normalOut) : null;
  if (diffuseIndex != null) material.pbrMetallicRoughness.baseColorTexture = { index: diffuseIndex };
  if (normalIndex != null) material.normalTexture = { index: normalIndex };
  const blend = String(pbrProps?.blend || '').toLowerCase();
  if (pbrProps?.alphaKill === true) {
    material.alphaMode = 'MASK';
    material.alphaCutoff = 0.5;
  } else if (blend === 'alpha' || blend === 'add') {
    material.alphaMode = 'BLEND';
  }
  return material;
}

function buildGlb(gltf, bin) {
  const jsonBuffer = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
  const jsonChunk = jsonPadding ? Buffer.concat([jsonBuffer, Buffer.alloc(jsonPadding, 0x20)]) : jsonBuffer;
  const binPadding = (4 - (bin.length % 4)) % 4;
  const binChunk = binPadding ? Buffer.concat([bin, Buffer.alloc(binPadding, 0x00)]) : bin;
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4E4F534A, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004E4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

function exportGlb({ outDir, sceneName, hmd, decodedGeometries, manifest, embeddedTextures = [] }) {
  mkdirp(outDir);
  const binChunks = [];
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const materials = [];
  const { meta: embeddedTextureMeta, images, textures, textureIndexByPath } = buildEmbeddedTextureBundle(binChunks, bufferViews, embeddedTextures);
  const nodes = [];
  const rootSceneNodes = [];

  const materialInfos = Array.isArray(manifest?.hmdMaterials) && manifest.hmdMaterials.length
    ? manifest.hmdMaterials
    : hmd.materials;
  for (const m of materialInfos) {
    materials.push(buildGltfMaterial(m, textureIndexByPath));
  }
  if (materials.length === 0) materials.push({ name: 'default', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true });

  for (let modelIndex = 0; modelIndex < hmd.models.length; modelIndex++) {
    const model = hmd.models[modelIndex];
    const node = {
      name: sanitizeName(model.name || `model_${modelIndex}`),
      translation: [model.position.x, model.position.y, model.position.z],
      rotation: quatFromHmd(model.position),
      scale: [model.position.sx, model.position.sy, model.position.sz],
    };
    if (model.geometry >= 0) {
      const geom = decodedGeometries[model.geometry];
      const prims = [];
      let cursor = 0;
      for (let i = 0; i < geom.indexCounts.length; i++) {
        const count = geom.indexCounts[i];
        const subGeom = { ...geom, indices: geom.indices.slice(cursor, cursor + count) };
        cursor += count;
        const matIndex = model.materials?.[i] ?? 0;
        prims.push(addPrimitiveFromGeometry(binChunks, bufferViews, accessors, subGeom, matIndex));
      }
      node.mesh = meshes.length;
      meshes.push({ name: node.name, primitives: prims });
    }
    nodes.push(node);
  }

  nodes.forEach((n, idx) => {
    const parent = hmd.models[idx].parent;
    if (parent >= 0) {
      if (!nodes[parent].children) nodes[parent].children = [];
      nodes[parent].children.push(idx);
    } else {
      rootSceneNodes.push(idx);
    }
  });

  const bin = Buffer.concat(binChunks);
  const gltf = {
    asset: { version: '2.0', generator: 'prefab-to-gltf-glb' },
    scene: 0,
    scenes: [{ name: sceneName, nodes: rootSceneNodes }],
    nodes,
    meshes,
    materials,
    images,
    textures,
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
    extras: { prefabToGltf: { manifest, embeddedTextures: embeddedTextureMeta } },
  };

  const glb = buildGlb(gltf, bin);
  fs.writeFileSync(path.join(outDir, `${sceneName}.glb`), glb);
}

function exportPrefabSceneGlb({ outDir, sceneName, sceneSpec, manifest, embeddedTextures = [] }) {
  mkdirp(outDir);
  const binChunks = [];
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const materials = [];
  const { meta: embeddedTextureMeta, images, textures, textureIndexByPath } = buildEmbeddedTextureBundle(binChunks, bufferViews, embeddedTextures);
  const nodes = [];
  const skins = [];
  const animations = [];
  const rootSceneNodes = [];
  const assetCache = new Map();
  const pathToNodeIndex = new Map();
  const sceneNodeIdToGltfNode = new Map();
  const defaultAnimationFragments = [];

  function addChild(parentIndex, childIndex) {
    if (!nodes[parentIndex].children) nodes[parentIndex].children = [];
    nodes[parentIndex].children.push(childIndex);
  }

  function ensureAsset(asset) {
    if (assetCache.has(asset.sourcePath)) return assetCache.get(asset.sourcePath);
    const materialIndexByHmd = [];
    const materialInfos = Array.isArray(asset.materialInfos) && asset.materialInfos.length ? asset.materialInfos : asset.hmd.materials;
    for (const m of materialInfos) {
      materialIndexByHmd.push(materials.length);
      materials.push(buildGltfMaterial(m, textureIndexByPath));
    }
    if (materialIndexByHmd.length === 0) {
      materialIndexByHmd.push(materials.length);
      materials.push({ name: 'default', pbrMetallicRoughness: { baseColorFactor: [1,1,1,1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true });
    }
    const meshIndexByModel = new Map();
    const blendShapesByGeometry = new Map();
    asset.hmd.shapes.forEach((shape, index) => {
      if (!blendShapesByGeometry.has(shape.geom)) blendShapesByGeometry.set(shape.geom, []);
      const denseShape = buildDenseBlendShape(decodeBlendShape(asset.hmd, index), asset.decodedGeometries[shape.geom]?.vertexCount || 0);
      blendShapesByGeometry.get(shape.geom).push(denseShape);
    });
    for (let modelIndex = 0; modelIndex < asset.hmd.models.length; modelIndex++) {
      const model = asset.hmd.models[modelIndex];
      if (model.geometry < 0) continue;
      const geom = asset.decodedGeometries[model.geometry];
      const useFourBones = hasProp(geom.props, 'FourBonesByVertex');
      const morphTargets = blendShapesByGeometry.get(model.geometry) || [];
      const prims = [];
      let cursor = 0;
      for (let i = 0; i < geom.indexCounts.length; i++) {
        const count = geom.indexCounts[i];
        const subGeom = { ...geom, indices: geom.indices.slice(cursor, cursor + count) };
        cursor += count;
        const matIndex = materialIndexByHmd[model.materials?.[i] ?? 0] ?? materialIndexByHmd[0];
        let jointRemap = null;
        if (model.skin?.split) {
          const split = model.skin.split.find((entry) => entry.materialIndex === i) || null;
          if (split) {
            jointRemap = [];
            split.joints.forEach((jointIndex, splitIndex) => {
              jointRemap[splitIndex] = model.skin.joints[jointIndex]?.bind ?? 0;
            });
          }
        }
        prims.push(addPrimitiveFromGeometry(binChunks, bufferViews, accessors, subGeom, matIndex, { jointRemap, useFourBones, blendShapes: morphTargets }));
      }
      const meshIndex = meshes.length;
      const mesh = { name: sanitizeName(model.name || `model_${modelIndex}`), primitives: prims };
      if (morphTargets.length) {
        mesh.weights = new Array(morphTargets.length).fill(0);
        mesh.extras = { blendShapes: morphTargets.map((shape) => ({ name: shape.name, vertexCount: shape.vertexCount, indexCount: shape.indexCount })) };
      }
      meshes.push(mesh);
      meshIndexByModel.set(modelIndex, meshIndex);
    }
    const cached = { materialIndexByHmd, meshIndexByModel };
    assetCache.set(asset.sourcePath, cached);
    return cached;
  }

  function makeNode(base) {
    const idx = nodes.length;
    nodes.push(base);
    return idx;
  }

  function buildAnimationChannels(decodedAnimation, targetByName) {
    const channels = [];
    let mappedObjectCount = 0;
    const unsupported = { uv: 0, alpha: 0, props: 0 };
    for (const object of decodedAnimation.objects) {
      const targetInfo = targetByName.get(object.name);
      if (targetInfo == null) {
        if (object.channels.uv?.length) unsupported.uv += 1;
        if (object.channels.alpha?.length) unsupported.alpha += 1;
        if (object.channels.props && Object.keys(object.channels.props).length) unsupported.props += 1;
        continue;
      }
      const nodeIndex = targetInfo.nodeIndex;
      mappedObjectCount += 1;
      const translationFrames = Array.isArray(object.channels.translation) ? object.channels.translation : null;
      const rotationFrames = Array.isArray(object.channels.rotation) ? object.channels.rotation : null;
      const scaleFrames = Array.isArray(object.channels.scale) ? object.channels.scale : null;
      const hasTransformChannels = !!(translationFrames?.length || rotationFrames?.length || scaleFrames?.length);
      const defaultTranslation = targetInfo.defaultTranslation || [0, 0, 0];
      if (translationFrames?.length) {
        channels.push({
          nodeIndex,
          path: 'translation',
          times: Array.from({ length: translationFrames.length }, (_, i) => (decodedAnimation.sampling > 0 ? i / decodedAnimation.sampling : i)),
          values: translationFrames.flat(),
          comps: 3,
          accessorType: 'VEC3',
        });
      } else if (hasTransformChannels) {
        channels.push({
          nodeIndex,
          path: 'translation',
          times: [0],
          values: defaultTranslation.slice(0, 3),
          comps: 3,
          accessorType: 'VEC3',
        });
      }
      if (rotationFrames?.length) {
        channels.push({
          nodeIndex,
          path: 'rotation',
          times: Array.from({ length: rotationFrames.length }, (_, i) => (decodedAnimation.sampling > 0 ? i / decodedAnimation.sampling : i)),
          values: rotationFrames.flat(),
          comps: 4,
          accessorType: 'VEC4',
        });
      } else if (hasTransformChannels) {
        channels.push({
          nodeIndex,
          path: 'rotation',
          times: [0],
          values: [0, 0, 0, 1],
          comps: 4,
          accessorType: 'VEC4',
        });
      }
      if (scaleFrames?.length) {
        channels.push({
          nodeIndex,
          path: 'scale',
          times: Array.from({ length: scaleFrames.length }, (_, i) => (decodedAnimation.sampling > 0 ? i / decodedAnimation.sampling : i)),
          values: scaleFrames.flat(),
          comps: 3,
          accessorType: 'VEC3',
        });
      } else if (hasTransformChannels) {
        channels.push({
          nodeIndex,
          path: 'scale',
          times: [0],
          values: [1, 1, 1],
          comps: 3,
          accessorType: 'VEC3',
        });
      }
      if (object.channels.uv?.length) unsupported.uv += 1;
      if (object.channels.alpha?.length) unsupported.alpha += 1;
      if (object.channels.props && Object.keys(object.channels.props).length) unsupported.props += 1;
    }
    return { channels, mappedObjectCount, unsupported };
  }

  function addAnimationClip(name, channelSpecs, extras = null) {
    if (!Array.isArray(channelSpecs) || channelSpecs.length === 0) return null;
    const samplers = [];
    const channels = [];
    for (const spec of channelSpecs) {
      const input = floatAccessor(binChunks, bufferViews, accessors, spec.times, 'SCALAR', 1, { target: null });
      const output = floatAccessor(binChunks, bufferViews, accessors, spec.values, spec.accessorType, spec.comps, { target: null, includeMinMax: false });
      samplers.push({ input, output, interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: spec.nodeIndex, path: spec.path } });
    }
    const animation = { name, samplers, channels };
    if (extras) animation.extras = extras;
    animations.push(animation);
    return animation.name;
  }

  function buildSkinForModel(sceneNode, model, modelPath, internalNodeIndex, targetByName) {
    if (!model.skin) return null;
    const jointNodeIndexByJoint = new Map();
    const jointPathByJoint = new Map();

    for (let jointIndex = 0; jointIndex < model.skin.joints.length; jointIndex++) {
      const joint = model.skin.joints[jointIndex];
      const fullPath = joint.parent >= 0
        ? `${jointPathByJoint.get(joint.parent)}.${joint.name}`
        : `${modelPath}.${joint.name}`;
      jointPathByJoint.set(jointIndex, fullPath);
      const jointNodeIndex = makeNode({
        name: sanitizeName(joint.name || `joint_${jointIndex}`),
        translation: [joint.position.x, joint.position.y, joint.position.z],
        rotation: quatFromHmd(joint.position),
        scale: [joint.position.sx, joint.position.sy, joint.position.sz],
        extras: {
          prefabPath: fullPath,
          prefabType: 'joint',
          hmdJointIndex: jointIndex,
          prefabWrapperPath: sceneNode.pathName,
        },
      });
      jointNodeIndexByJoint.set(jointIndex, jointNodeIndex);
      pathToNodeIndex.set(fullPath, jointNodeIndex);
      if (!targetByName.has(joint.name)) {
        targetByName.set(joint.name, {
          nodeIndex: jointNodeIndex,
          defaultTranslation: [joint.position.x, joint.position.y, joint.position.z],
        });
      }
    }

    for (let jointIndex = 0; jointIndex < model.skin.joints.length; jointIndex++) {
      const joint = model.skin.joints[jointIndex];
      const jointNodeIndex = jointNodeIndexByJoint.get(jointIndex);
      if (joint.parent >= 0) addChild(jointNodeIndexByJoint.get(joint.parent), jointNodeIndex);
      else addChild(internalNodeIndex, jointNodeIndex);
    }

    const boundJoints = model.skin.joints
      .map((joint, index) => ({ joint, index }))
      .filter(({ joint }) => joint.bind >= 0)
      .sort((a, b) => a.joint.bind - b.joint.bind);
    if (!boundJoints.length) return null;

    // HMD skin.transpos already stores the inverse bind pose in Heaps space.
    // `positionToMatrixElements` performs the needed row->column conversion for glTF.
    const inverseBindMatrices = boundJoints.map(({ joint }) =>
      positionToMatrixElements(joint.transpos || { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 }, true)
    );
    const inverseBindAccessor = matrixAccessor(binChunks, bufferViews, accessors, inverseBindMatrices);
    const skinIndex = skins.length;
    skins.push({
      name: sanitizeName(model.skin.name || `${model.name || 'skin'}_skin`),
      inverseBindMatrices: inverseBindAccessor,
      joints: boundJoints.map(({ index }) => jointNodeIndexByJoint.get(index)),
      skeleton: jointNodeIndexByJoint.get(0) ?? boundJoints[0]?.index ?? null,
    });
    return skinIndex;
  }

  for (const sceneNode of sceneSpec.nodes) {
    const gltfNode = {
      name: sanitizeName(sceneNode.name || sceneNode.pathName || `node_${sceneNode.id}`),
      translation: sceneNode.transform.translation,
      rotation: sceneNode.transform.rotation,
      scale: sceneNode.transform.scale,
      extras: { prefabPath: sceneNode.pathName, prefabType: sceneNode.type, prefabName: sceneNode.name },
    };
    const nodeIndex = makeNode(gltfNode);
    sceneNodeIdToGltfNode.set(sceneNode.id, nodeIndex);
    pathToNodeIndex.set(sceneNode.pathName, nodeIndex);
  }

  for (const sceneNode of sceneSpec.nodes) {
    const nodeIndex = sceneNodeIdToGltfNode.get(sceneNode.id);
    if (sceneNode.parentId != null) {
      const parentIndex = sceneNodeIdToGltfNode.get(sceneNode.parentId);
      addChild(parentIndex, nodeIndex);
    } else {
      rootSceneNodes.push(nodeIndex);
    }
  }

  for (const sceneNode of sceneSpec.nodes) {
    if (sceneNode.type !== 'model' || !sceneNode.asset || !sceneNode.resolvedSource) continue;
    const wrapperNodeIndex = sceneNodeIdToGltfNode.get(sceneNode.id);
    const asset = sceneNode.asset;
    const cached = ensureAsset(asset);
    const internalNodeIndexByModel = new Map();
    const internalPathByModel = new Map();
    const animationTargetByName = new Map();

    for (let i = 0; i < asset.hmd.models.length; i++) {
      const model = asset.hmd.models[i];
      const fullPath = model.parent >= 0
        ? `${internalPathByModel.get(model.parent)}.${model.name}`
        : `${sceneNode.pathName}.${model.name}`;
      internalPathByModel.set(i, fullPath);
      const gltfNode = {
        name: sanitizeName(model.name || `hmd_${i}`),
        translation: [model.position.x, model.position.y, model.position.z],
        rotation: quatFromHmd(model.position),
        scale: [model.position.sx, model.position.sy, model.position.sz],
        extras: { prefabPath: fullPath, hmdModelIndex: i, prefabWrapperPath: sceneNode.pathName },
      };
      if (cached.meshIndexByModel.has(i)) gltfNode.mesh = cached.meshIndexByModel.get(i);
      const internalIndex = makeNode(gltfNode);
      internalNodeIndexByModel.set(i, internalIndex);
      pathToNodeIndex.set(fullPath, internalIndex);
      if (!animationTargetByName.has(model.name)) {
        animationTargetByName.set(model.name, {
          nodeIndex: internalIndex,
          defaultTranslation: [0, 0, 0],
        });
      }
    }

    for (let i = 0; i < asset.hmd.models.length; i++) {
      const model = asset.hmd.models[i];
      const internalIndex = internalNodeIndexByModel.get(i);
      if (model.parent >= 0) {
        const parentIndex = internalNodeIndexByModel.get(model.parent);
        addChild(parentIndex, internalIndex);
      } else {
        addChild(wrapperNodeIndex, internalIndex);
      }
      if (model.skin) {
        const skinIndex = buildSkinForModel(sceneNode, model, internalPathByModel.get(i), internalIndex, animationTargetByName);
        if (skinIndex != null) nodes[internalIndex].skin = skinIndex;
      }
    }

    const animationAssets = Array.isArray(sceneNode.animationAssets)
      ? sceneNode.animationAssets
      : (sceneNode.animationAsset ? [sceneNode.animationAsset] : []);
    if (animationAssets.length) {
      let defaultAssetClipAdded = false;
      for (const animationAsset of animationAssets) {
        for (let animationIndex = 0; animationIndex < animationAsset.decodedAnimations.length; animationIndex++) {
          const decodedAnimation = animationAsset.decodedAnimations[animationIndex];
        const { channels, mappedObjectCount, unsupported } = buildAnimationChannels(decodedAnimation, animationTargetByName);
        const clipName = `${sceneNode.name || sceneNode.pathName} / ${decodedAnimation.name || `animation_${animationIndex}`}`;
        addAnimationClip(clipName, channels, {
          prefabPath: sceneNode.pathName,
          sourcePath: animationAsset.sourcePath,
          defaultForPrefabModel: !defaultAssetClipAdded && animationIndex === 0,
          loop: decodedAnimation.loop,
          objectCount: decodedAnimation.objects.length,
          mappedObjectCount,
          unsupportedTracks: unsupported,
          events: decodedAnimation.events || [],
        });
        if (!defaultAssetClipAdded && animationIndex === 0 && channels.length) {
          defaultAnimationFragments.push({
            channels,
            prefabPath: sceneNode.pathName,
            sourcePath: animationAsset.sourcePath,
            eventCount: decodedAnimation.events?.length || 0,
          });
          defaultAssetClipAdded = true;
        }
        }
      }
    }
  }

  function detachNode(childIndex) {
    const r = rootSceneNodes.indexOf(childIndex);
    if (r >= 0) { rootSceneNodes.splice(r, 1); return; }
    for (const node of nodes) {
      if (!Array.isArray(node.children)) continue;
      const i = node.children.indexOf(childIndex);
      if (i >= 0) { node.children.splice(i, 1); return; }
    }
  }

  for (const constraint of sceneSpec.constraints || []) {
    const objectIndex = pathToNodeIndex.get(constraint.object);
    const targetIndex = pathToNodeIndex.get(constraint.target);
    if (objectIndex == null || targetIndex == null || objectIndex === targetIndex) continue;
    detachNode(objectIndex);
    addChild(targetIndex, objectIndex);
  }

  let defaultAnimationName = null;
  if (defaultAnimationFragments.length) {
    defaultAnimationName = addAnimationClip('Scene Default', defaultAnimationFragments.flatMap((fragment) => fragment.channels), {
      sceneDefault: true,
      loop: true,
      sourcePaths: defaultAnimationFragments.map((fragment) => fragment.sourcePath),
      prefabPaths: defaultAnimationFragments.map((fragment) => fragment.prefabPath),
    });
    manifest.defaultAnimationName = defaultAnimationName;
  }

  const bin = Buffer.concat(binChunks);
  const gltf = {
    asset: { version: '2.0', generator: 'prefab-to-gltf-glb-scene' },
    scene: 0,
    scenes: [{ name: sceneName, nodes: rootSceneNodes }],
    nodes,
    meshes,
    materials,
    images,
    textures,
    skins,
    animations,
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
    extras: { prefabToGltf: { manifest, embeddedTextures: embeddedTextureMeta } },
  };
  const glb = buildGlb(gltf, bin);
  fs.writeFileSync(path.join(outDir, `${sceneName}.glb`), glb);
}

module.exports = { exportGlb, exportPrefabSceneGlb };
