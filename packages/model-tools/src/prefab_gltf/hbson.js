const GLOBAL_STRING_MAP = new Map();

function isHbsonBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 6 && buffer.subarray(0, 5).toString('ascii') === 'HBSON';
}

class HbsonReader {
  constructor(buffer, globalStrings = false) {
    if (!isHbsonBuffer(buffer)) throw new Error('Input is not HBSON data');
    this.buffer = buffer;
    this.offset = 6;
    this.stringTable = [];
    this.globalStrings = globalStrings;
  }

  ensure(size) {
    if (this.offset + size > this.buffer.length) throw new Error('Unexpected end of HBSON data');
  }

  readByte() {
    this.ensure(1);
    return this.buffer[this.offset++];
  }

  readInt32() {
    this.ensure(4);
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt32() {
    this.ensure(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readDouble() {
    this.ensure(8);
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  readStringBytes(length) {
    this.ensure(length);
    const value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readString() {
    const index = this.readUInt32();
    if ((index & 0xC0000000) !== 0) {
      let value = this.readStringBytes(index & 0x3FFFFFFF);
      if ((index & 0x40000000) !== 0) {
        if (this.globalStrings) {
          const cached = GLOBAL_STRING_MAP.get(value);
          if (cached != null) value = cached;
          else GLOBAL_STRING_MAP.set(value, value);
        }
        this.stringTable.push(value);
      }
      return value;
    }
    const value = this.stringTable[index];
    if (value == null) throw new Error(`Invalid HBSON string table reference: ${index}`);
    return value;
  }

  readValue() {
    const code = this.readByte();
    switch (code) {
      case 0:
        return 0;
      case 1:
        return this.readByte();
      case 2:
        return this.readInt32();
      case 3:
        return this.readDouble();
      case 4:
        return true;
      case 5:
        return false;
      case 6:
        return null;
      case 7:
        return {};
      case 8:
      case 9: {
        const fieldCount = code === 8 ? this.readByte() : this.readInt32();
        const out = {};
        for (let i = 0; i < fieldCount; i++) out[this.readString()] = this.readValue();
        return out;
      }
      case 10:
        return this.readString();
      case 11:
        return [];
      case 12:
      case 13: {
        const length = code === 12 ? this.readByte() : this.readInt32();
        const out = new Array(length);
        for (let i = 0; i < length; i++) out[i] = this.readValue();
        return out;
      }
      default:
        throw new Error(`Unsupported HBSON opcode: ${code}`);
    }
  }
}

function readHbson(buffer, options = {}) {
  return new HbsonReader(buffer, !!options.globalStrings).readValue();
}

module.exports = {
  isHbsonBuffer,
  readHbson,
};
