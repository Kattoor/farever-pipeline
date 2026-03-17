const fs = require('fs');

class Reader {
  constructor(buf) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.off = 0;
  }
  seek(n) { this.off = n; }
  tell() { return this.off; }
  u8() { const v = this.buf.readUInt8(this.off); this.off += 1; return v; }
  i8() { const v = this.buf.readInt8(this.off); this.off += 1; return v; }
  u16() { const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  i32() { const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
  f32() { const v = this.buf.readFloatLE(this.off); this.off += 4; return v; }
  bytes(n) { const v = this.buf.subarray(this.off, this.off + n); this.off += n; return v; }
  str(n) { const s = this.buf.subarray(this.off, this.off + n).toString('utf8'); this.off += n; return s; }
}

const PRECISION = { 0: 'F32', 1: 'F16', 2: 'U8', 3: 'S8' };
const FORMAT = { 1: { name: 'DFloat', comps: 1 }, 2: { name: 'DVec2', comps: 2 }, 3: { name: 'DVec3', comps: 3 }, 4: { name: 'DVec4', comps: 4 }, 9: { name: 'DBytes4', comps: 4 }, 16: { name: 'DMat4', comps: 16 } };
const PROPERTY_KIND = {
  0: 'CameraFOVY',
  1: 'Unused_HasMaterialFlags',
  2: 'HasExtraTextures',
  3: 'FourBonesByVertex',
  4: 'HasLod',
  5: 'HasCollider',
  6: 'HasColliders',
  7: 'HasCustomCollider',
};
const COLLIDER_TYPE = {
  0: 'ConvexHulls',
  1: 'Mesh',
  2: 'Group',
  3: 'Sphere',
  4: 'Box',
  5: 'Capsule',
  6: 'Cylinder',
  255: 'Empty',
};
const ANIMATION_FLAG = {
  HasPosition: 1 << 0,
  HasRotation: 1 << 1,
  HasScale: 1 << 2,
  HasUV: 1 << 3,
  HasAlpha: 1 << 4,
  SingleFrame: 1 << 5,
  HasProps: 1 << 6,
  Reserved: 1 << 7,
};

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7C00) >> 10;
  const f = h & 0x03FF;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / Math.pow(2, 10));
  if (e === 0x1F) return f ? NaN : ((s ? -1 : 1) * Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / Math.pow(2, 10));
}

function readName(r) {
  const b = r.u8();
  if (b === 0xFF) return null;
  return r.str(b);
}

function readProps(r, version) {
  if (version === 1) return null;
  const n = r.u8();
  if (n === 0) return null;
  const props = [];
  for (let i = 0; i < n; i++) {
    const kind = r.u8();
    if (kind === 0) props.push({ kind: 'CameraFOVY', value: r.f32() });
    else props.push({ kind: PROPERTY_KIND[kind] || `Property_${kind}` });
  }
  return props;
}

function hasProp(props, name) {
  return Array.isArray(props) && props.some((prop) => prop?.kind === name);
}

function readPosition(r, hasScale = true) {
  const p = {
    x: r.f32(), y: r.f32(), z: r.f32(),
    qx: r.f32(), qy: r.f32(), qz: r.f32(),
    sx: 1, sy: 1, sz: 1,
  };
  if (hasScale) {
    p.sx = r.f32(); p.sy = r.f32(); p.sz = r.f32();
  }
  const qw2 = 1 - (p.qx * p.qx + p.qy * p.qy + p.qz * p.qz);
  p.qw = qw2 < 0 ? -Math.sqrt(-qw2) : Math.sqrt(qw2);
  return p;
}

function readBounds(r) {
  return { xMin: r.f32(), yMin: r.f32(), zMin: r.f32(), xMax: r.f32(), yMax: r.f32(), zMax: r.f32() };
}

function readVector(r) {
  return { x: r.f32(), y: r.f32(), z: r.f32() };
}

function readFormat(r) {
  const stride = r.u8();
  const count = r.u8();
  const inputs = [];
  let strideBytes = 0;
  for (let i = 0; i < count; i++) {
    const name = readName(r);
    const typeRaw = r.u8();
    const type = typeRaw & 15;
    const precision = typeRaw >> 4;
    const fmt = FORMAT[type];
    if (!fmt) throw new Error(`Unsupported HMD input format ${type}`);
    const bytes = fmt.name === 'DBytes4' ? 4 : fmt.comps * ({ F32: 4, F16: 2, U8: 1, S8: 1 }[PRECISION[precision]]);
    inputs.push({ name, type, typeName: fmt.name, comps: fmt.comps, precision, precisionName: PRECISION[precision], bytes, offset: strideBytes });
    strideBytes += bytes;
    if (strideBytes & 3) strideBytes += 4 - (strideBytes & 3);
  }
  return { stride, strideBytes, inputs };
}

function readSkin(r, version) {
  const name = readName(r);
  if (name == null) return null;
  const props = readProps(r, version);
  const joints = [];
  const count = r.u16();
  for (let i = 0; i < count; i++) {
    const jProps = readProps(r, version);
    const jName = readName(r);
    let pid = r.u16();
    const hasScale = (pid & 0x8000) !== 0;
    if (hasScale) pid &= 0x7FFF;
    const parent = pid - 1;
    const position = readPosition(r, hasScale);
    const bind = r.u16() - 1;
    let transpos = null;
    if (bind >= 0) transpos = readPosition(r, hasScale);
    joints.push({ props: jProps, name: jName, parent, position, bind, transpos });
  }
  const splitCount = r.u8();
  const split = [];
  for (let i = 0; i < splitCount; i++) {
    const materialIndex = r.u8();
    const n = r.u8();
    const js = [];
    for (let j = 0; j < n; j++) js.push(r.u16());
    split.push({ materialIndex, joints: js });
  }
  return { name, props, joints, split: splitCount ? split : null };
}

function readAnimation(r, version) {
  const props = readProps(r, version);
  const name = readName(r);
  const frames = r.i32();
  const sampling = r.f32();
  const speed = r.f32();
  const flags = r.u8();
  const dataPosition = r.i32();
  const objectCount = r.i32();
  const objects = [];
  for (let i = 0; i < objectCount; i++) {
    const objectName = readName(r);
    const objectFlags = r.u8();
    const object = {
      name: objectName,
      flags: {
        raw: objectFlags,
        hasPosition: (objectFlags & ANIMATION_FLAG.HasPosition) !== 0,
        hasRotation: (objectFlags & ANIMATION_FLAG.HasRotation) !== 0,
        hasScale: (objectFlags & ANIMATION_FLAG.HasScale) !== 0,
        hasUV: (objectFlags & ANIMATION_FLAG.HasUV) !== 0,
        hasAlpha: (objectFlags & ANIMATION_FLAG.HasAlpha) !== 0,
        singleFrame: (objectFlags & ANIMATION_FLAG.SingleFrame) !== 0,
        hasProps: (objectFlags & ANIMATION_FLAG.HasProps) !== 0,
      },
      props: [],
    };
    if (object.flags.hasProps) {
      const propCount = r.u8();
      for (let j = 0; j < propCount; j++) object.props.push(readName(r));
    }
    objects.push(object);
  }
  let events = null;
  if ((flags & 2) !== 0) {
    const eventCount = r.i32();
    events = [];
    for (let i = 0; i < eventCount; i++) {
      events.push({ frame: r.i32(), data: readName(r) });
    }
  }
  return {
    props,
    name,
    frames,
    sampling,
    speed,
    loop: (flags & 1) !== 0,
    hasEvents: (flags & 2) !== 0,
    dataPosition,
    objects,
    events,
  };
}

function readBlendShape(r) {
  return {
    name: readName(r),
    geom: r.i32() - 1,
    vertexCount: r.i32(),
    vertexFormat: readFormat(r),
    vertexPosition: r.i32(),
    indexCount: r.i32(),
    remapPosition: r.i32(),
  };
}

function readCollider(r, hasType) {
  const typeValue = hasType ? r.u8() : 0;
  const type = COLLIDER_TYPE[typeValue] || `Collider_${typeValue}`;
  switch (type) {
    case 'ConvexHulls': {
      const hullCount = r.i32();
      const vertexCounts = [];
      for (let i = 0; i < hullCount; i++) vertexCounts.push(r.i32());
      const vertexPosition = r.i32();
      const indexCounts = [];
      for (let i = 0; i < hullCount; i++) indexCounts.push(r.i32());
      const indexPosition = r.i32();
      return { type, vertexCounts, vertexPosition, indexCounts, indexPosition };
    }
    case 'Mesh':
      return {
        type,
        vertexCount: r.i32(),
        vertexPosition: r.i32(),
        indexCount: r.i32(),
        indexPosition: r.i32(),
      };
    case 'Group': {
      const count = r.i32();
      const colliders = [];
      for (let i = 0; i < count; i++) colliders.push(readCollider(r, hasType));
      return { type, colliders };
    }
    case 'Sphere':
      return { type, position: readVector(r), radius: r.f32() };
    case 'Box':
      return { type, position: readVector(r), halfExtent: readVector(r), rotation: readVector(r) };
    case 'Capsule':
    case 'Cylinder':
      return { type, position: readVector(r), halfExtent: readVector(r), radius: r.f32() };
    case 'Empty':
      return { type };
    default:
      throw new Error(`Unsupported collider type ${typeValue}`);
  }
}

function parseHMD(file) {
  const buf = fs.readFileSync(file);
  const r = new Reader(buf);
  const magic = r.str(3);
  if (magic !== 'HMD') throw new Error(`Not an HMD file: ${file}`);
  const version = r.u8();
  const dataPosition = r.i32();
  const dataLength = buf.readInt32LE(dataPosition - 4);
  const headerBytes = buf.subarray(8, dataPosition - 4);
  const h = new Reader(headerBytes);
  const data = buf.subarray(dataPosition, dataPosition + dataLength);

  const out = { version, dataPosition, dataLength, geometries: [], materials: [], models: [], animations: [], shapes: [], colliders: [], data };
  out.props = readProps(h, version);
  const geomCount = h.i32();
  for (let i = 0; i < geomCount; i++) {
    const props = readProps(h, version);
    const vertexCount = h.i32();
    const vertexFormat = readFormat(h);
    const vertexPosition = h.i32();
    let subCount = h.u8(); if (subCount === 0xFF) subCount = h.i32();
    const indexCounts = Array.from({ length: subCount }, () => h.i32());
    const indexPosition = h.i32();
    const bounds = readBounds(h);
    out.geometries.push({ props, vertexCount, vertexFormat, vertexPosition, indexCounts, indexPosition, bounds, indexCount: indexCounts.reduce((a, b) => a + b, 0) });
  }
  const matCount = h.i32();
  for (let i = 0; i < matCount; i++) {
    const props = readProps(h, version);
    const name = readName(h);
    const diffuseTexture = readName(h);
    const blendMode = h.u8();
    h.u8();
    h.f32();
    let specularTexture = null, normalMap = null;
    if (hasProp(props, 'HasExtraTextures')) {
      specularTexture = readName(h);
      normalMap = readName(h);
    }
    out.materials.push({ props, name, diffuseTexture, blendMode, specularTexture, normalMap });
  }
  const modelCount = h.i32();
  let hasColliders = false;
  for (let i = 0; i < modelCount; i++) {
    const props = readProps(h, version);
    const name = readName(h);
    const parent = h.i32() - 1;
    const follow = readName(h);
    const position = readPosition(h, true);
    const geometry = h.i32() - 1;
    const model = { props, name, parent, follow, position, geometry, materials: [], skin: null, lods: null, collider: null, colliders: null };
    if (geometry >= 0) {
      let mcount = h.u8(); if (mcount === 0xFF) mcount = h.i32();
      for (let m = 0; m < mcount; m++) model.materials.push(h.i32());
      model.skin = readSkin(h, version);
      if (hasProp(props, 'HasLod')) {
        const lodCount = h.i32();
        model.lods = [];
        for (let j = 0; j < lodCount; j++) model.lods.push(h.i32());
      }
      if (hasProp(props, 'HasCollider')) {
        model.collider = h.i32();
        hasColliders = true;
      }
      if (hasProp(props, 'HasColliders')) {
        const colliderCount = h.i32();
        model.colliders = [];
        for (let j = 0; j < colliderCount; j++) model.colliders.push(h.i32());
        hasColliders = true;
      }
    }
    out.models.push(model);
  }
  const animationCount = h.i32();
  for (let i = 0; i < animationCount; i++) out.animations.push(readAnimation(h, version));
  if (version >= 4) {
    const shapeCount = h.i32();
    for (let i = 0; i < shapeCount; i++) out.shapes.push(readBlendShape(h));
  }
  if (hasColliders) {
    const hasTypedColliders = hasProp(out.props, 'HasCustomCollider');
    const colliderCount = h.i32();
    for (let i = 0; i < colliderCount; i++) out.colliders.push(readCollider(h, hasTypedColliders));
  }
  return out;
}

function componentTypeForIndices(maxIndex) {
  return maxIndex > 65535 ? 5125 : 5123;
}

function readValue(data, offset, input) {
  if (input.typeName === 'DBytes4') {
    return [data.readUInt8(offset + input.offset + 0), data.readUInt8(offset + input.offset + 1), data.readUInt8(offset + input.offset + 2), data.readUInt8(offset + input.offset + 3)];
  }
  const r = [];
  let p = offset + input.offset;
  for (let c = 0; c < input.comps; c++) {
    switch (input.precisionName) {
      case 'F32':
        r.push(data.readFloatLE(p)); p += 4; break;
      case 'F16':
        r.push(halfToFloat(data.readUInt16LE(p))); p += 2; break;
      case 'U8':
        r.push(data.readUInt8(p)); p += 1; break;
      case 'S8':
        r.push(data.readInt8(p)); p += 1; break;
      default:
        throw new Error(`Unsupported precision ${input.precisionName}`);
    }
  }
  return r;
}

function decodeGeometry(hmd, geometryIndex) {
  const g = hmd.geometries[geometryIndex];
  const attrs = {};
  for (const input of g.vertexFormat.inputs) attrs[input.name] = [];
  for (let i = 0; i < g.vertexCount; i++) {
    const base = g.vertexPosition + i * g.vertexFormat.strideBytes;
    for (const input of g.vertexFormat.inputs) {
      const v = readValue(hmd.data, base, input);
      attrs[input.name].push(...v);
    }
  }
  const index32 = g.vertexCount > 65535;
  const indices = [];
  let ip = g.indexPosition;
  for (let i = 0; i < g.indexCount; i++) {
    indices.push(index32 ? hmd.data.readUInt32LE(ip + i * 4) : hmd.data.readUInt16LE(ip + i * 2));
  }
  return { ...g, attributes: attrs, indices };
}

function animationObjectStride(object) {
  let stride = 0;
  if (object.flags.hasPosition) stride += 3;
  if (object.flags.hasRotation) stride += 3;
  if (object.flags.hasScale) stride += 3;
  if (object.flags.hasUV) stride += 2;
  if (object.flags.hasAlpha) stride += 1;
  if (object.flags.hasProps) stride += object.props.length;
  return stride;
}

function decodeAnimation(hmd, animationIndex) {
  const animation = hmd.animations[animationIndex];
  if (!animation) throw new Error(`Animation ${animationIndex} not found`);
  if (hmd.version <= 2) throw new Error(`Legacy HMD animation decoding is not implemented for version ${hmd.version}`);

  const singleStride = animation.objects.reduce((sum, object) => sum + (object.flags.singleFrame ? animationObjectStride(object) : 0), 0);
  const frameStride = animation.objects.reduce((sum, object) => sum + (object.flags.singleFrame ? 0 : animationObjectStride(object)), 0);

  let singleOffset = 0;
  let dynamicOffset = 0;
  const objects = animation.objects.map((object) => {
    const stride = animationObjectStride(object);
    const dataOffset = object.flags.singleFrame ? singleOffset : dynamicOffset;
    if (object.flags.singleFrame) singleOffset += stride;
    else dynamicOffset += stride;
    return {
      ...object,
      stride,
      dataOffset,
      channels: {
        translation: object.flags.hasPosition ? [] : null,
        rotation: object.flags.hasRotation ? [] : null,
        scale: object.flags.hasScale ? [] : null,
        uv: object.flags.hasUV ? [] : null,
        alpha: object.flags.hasAlpha ? [] : null,
        props: object.flags.hasProps ? Object.fromEntries(object.props.map((name) => [name, []])) : {},
      },
    };
  });

  for (const object of objects) {
    const frameCount = object.flags.singleFrame ? 1 : animation.frames;
    for (let frame = 0; frame < frameCount; frame++) {
      const baseOffset = object.flags.singleFrame
        ? animation.dataPosition + object.dataOffset * 4
        : animation.dataPosition + (singleStride + frame * frameStride + object.dataOffset) * 4;
      const r = new Reader(hmd.data.subarray(baseOffset));

      if (object.flags.hasPosition) object.channels.translation.push([r.f32(), r.f32(), r.f32()]);
      if (object.flags.hasRotation) {
        const qx = r.f32();
        const qy = r.f32();
        const qz = r.f32();
        const qw = Math.sqrt(Math.abs(1 - (qx * qx + qy * qy + qz * qz)));
        object.channels.rotation.push([qx, qy, qz, qw]);
      }
      if (object.flags.hasScale) object.channels.scale.push([r.f32(), r.f32(), r.f32()]);
      if (object.flags.hasUV) object.channels.uv.push([r.f32(), r.f32()]);
      if (object.flags.hasAlpha) object.channels.alpha.push(r.f32());
      if (object.flags.hasProps) {
        for (const propName of object.props) object.channels.props[propName].push(r.f32());
      }
    }
  }

  return {
    ...animation,
    duration: animation.sampling > 0 ? animation.frames / animation.sampling : 0,
    frameStride,
    singleStride,
    objects,
  };
}

function decodeBlendShape(hmd, shapeIndex) {
  const shape = hmd.shapes[shapeIndex];
  if (!shape) throw new Error(`Blend shape ${shapeIndex} not found`);
  const attributes = {};
  for (const input of shape.vertexFormat.inputs) attributes[input.name] = [];
  for (let i = 0; i < shape.vertexCount; i++) {
    const base = shape.vertexPosition + i * shape.vertexFormat.strideBytes;
    for (const input of shape.vertexFormat.inputs) {
      const value = readValue(hmd.data, base, input);
      attributes[input.name].push(...value);
    }
  }

  const remap = [];
  let remapOffset = shape.remapPosition;
  for (let i = 0; i < shape.indexCount; i++) {
    const targets = [];
    while (true) {
      let affected = hmd.data.readInt32LE(remapOffset);
      remapOffset += 4;
      const reachEnd = (affected & 0x80000000) !== 0;
      if (reachEnd) affected &= 0x7fffffff;
      targets.push(affected);
      if (reachEnd) break;
    }
    remap.push(targets);
  }

  return { ...shape, attributes, remap };
}

module.exports = {
  parseHMD,
  decodeGeometry,
  decodeAnimation,
  decodeBlendShape,
  componentTypeForIndices,
  hasProp,
};
