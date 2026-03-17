#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { runTaskList, formatCount, formatBytes, consola } = require("@farever/cli-utils");

let sea = null;
try {
  sea = require("node:sea");
} catch {}

class Reader {
  constructor(buffer, offset = 0) {
    this.buf = buffer;
    this.pos = offset;
  }
  readByte() {
    if (this.pos >= this.buf.length) throw new Error("Unexpected EOF (byte)");
    return this.buf[this.pos++];
  }
  readString(len) {
    if (this.pos + len > this.buf.length) throw new Error("Unexpected EOF (string)");
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  readInt32() {
    if (this.pos + 4 > this.buf.length) throw new Error("Unexpected EOF (int32)");
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  readDouble() {
    if (this.pos + 8 > this.buf.length) throw new Error("Unexpected EOF (double)");
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
}

function readExactly(fd, length, position) {
  const buf = Buffer.allocUnsafe(length);
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, position + off);
    if (n <= 0) throw new Error(`Unexpected EOF while reading ${length} bytes at ${position}`);
    off += n;
  }
  return buf;
}

function readFileEntry(r) {
  const nameLen = r.readByte();
  const name = r.readString(nameLen);
  const flags = r.readByte();

  if ((flags & 1) !== 0) {
    const count = r.readInt32();
    const content = [];
    for (let i = 0; i < count; i++) content.push(readFileEntry(r));
    return { name, isDirectory: true, content };
  }

  const dataPosition = (flags & 2) !== 0 ? r.readDouble() : r.readInt32();
  const dataSize = r.readInt32();
  const checksum = r.readInt32();
  return { name, isDirectory: false, dataPosition, dataSize, checksum };
}

function readPakHeaderFromFile(pakPath) {
  const fd = fs.openSync(pakPath, "r");
  try {
    const first12 = readExactly(fd, 12, 0);
    const r0 = new Reader(first12);

    const magic = r0.readString(3);
    if (magic !== "PAK") throw new Error("Invalid PAK file (missing 'PAK')");

    const version = r0.readByte();
    const headerSize = r0.readInt32();
    const dataSize = r0.readInt32();

    if (headerSize < 16) throw new Error(`Invalid headerSize: ${headerSize}`);

    const headerPayloadLen = headerSize - 16;
    const headerPayload = readExactly(fd, headerPayloadLen, 12);
    const hr = new Reader(headerPayload);
    const root = readFileEntry(hr);

    const dataMarker = readExactly(fd, 4, 12 + headerPayloadLen).toString("utf8");
    if (dataMarker !== "DATA") throw new Error("Corrupted PAK header (missing 'DATA')");

    return { version, headerSize, dataSize, root };
  } finally {
    fs.closeSync(fd);
  }
}

function countPakFiles(node) {
  if (!node) return 0;
  if (!node.isDirectory) return 1;
  return (node.content || []).reduce((total, child) => total + countPakFiles(child), 0);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function extractFileChunked(srcFd, destPath, srcPos, size, chunkSize = 16 * 1024 * 1024) {
  ensureDir(path.dirname(destPath));
  const outFd = fs.openSync(destPath, "w");
  try {
    let remaining = size;
    let readPos = srcPos;
    const buf = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(1, size)));
    while (remaining > 0) {
      const toRead = Math.min(buf.length, remaining);
      const bytesRead = fs.readSync(srcFd, buf, 0, toRead, readPos);
      if (bytesRead <= 0) throw new Error(`Unexpected EOF while extracting to ${destPath}`);
      let written = 0;
      while (written < bytesRead) {
        const n = fs.writeSync(outFd, buf, written, bytesRead - written);
        if (n <= 0) throw new Error(`Failed writing ${destPath}`);
        written += n;
      }
      remaining -= bytesRead;
      readPos += bytesRead;
    }
  } finally {
    fs.closeSync(outFd);
  }
}

function peekMagic4(srcFd, srcPos) {
  const b = Buffer.allocUnsafe(4);
  const n = fs.readSync(srcFd, b, 0, 4, srcPos);
  if (n < 4) return null;
  return b;
}
function isDDSMagic(buf4) {
  return !!buf4 && buf4.length >= 4 &&
    buf4[0] === 0x44 && buf4[1] === 0x44 && buf4[2] === 0x53 && buf4[3] === 0x20;
}
function isPNGMagic(buf4) {
  return !!buf4 && buf4.length >= 4 &&
    buf4[0] === 0x89 && buf4[1] === 0x50 && buf4[2] === 0x4E && buf4[3] === 0x47;
}
function sanitizeName(name) {
  if (name === "." || name === "..") throw new Error(`Unsafe entry name: ${name}`);
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error(`Invalid entry name segment: ${name}`);
  return name;
}
function getBundledTexconvPath() {
  if (!sea || !sea.isSea()) return null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "farever-"));
  const texconvPath = path.join(tempDir, "texconv.exe");
  const raw = sea.getRawAsset("texconv.exe");
  fs.writeFileSync(texconvPath, new Uint8Array(raw));
  return { texconvPath, tempDir };
}
function findTexconv() {
  const bundled = getBundledTexconvPath();
  if (bundled) return bundled;
  const nextToExe = path.join(path.dirname(process.execPath), "texconv.exe");
  if (fs.existsSync(nextToExe)) return { texconvPath: nextToExe, tempDir: null };
  return { texconvPath: "texconv", tempDir: null };
}
function replaceExt(filePath, newExt) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, parsed.name + newExt);
}
async function runTexconvAsync(ddsPath, outDir) {
  const { texconvPath, tempDir } = findTexconv();
  try {
    const args = ["-ft", "PNG", "-y", "-o", outDir, ddsPath];
    await new Promise((resolve, reject) => {
      const child = cp.spawn(texconvPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
      child.on("error", (err) => reject(new Error(`Failed to launch texconv: ${err.message}`)));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(
            `texconv failed (${code})\n` +
            `Command: ${texconvPath} ${args.map(a => JSON.stringify(a)).join(" ")}\n` +
            `stdout:\n${stdout}\n` +
            `stderr:\n${stderr}`
          ));
        } else {
          resolve();
        }
      });
    });
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}
async function convertDdsList(ddsPaths, onProgress = null) {
  const uniquePaths = [...new Set(ddsPaths)];
  if (!uniquePaths.length) return;
  const concurrency = Math.max(1, Math.min(os.cpus().length || 4, 4));
  const progressEvery = uniquePaths.length >= 2000 ? 100 : uniquePaths.length >= 500 ? 50 : 25;
  let index = 0;
  let done = 0;
  onProgress?.({ current: 0, total: uniquePaths.length, concurrency });

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= uniquePaths.length) return;
      const ddsPath = uniquePaths[i];
      const pngPath = replaceExt(ddsPath, ".png");

      if (!fs.existsSync(ddsPath)) {
        if (fs.existsSync(pngPath)) {
          done += 1;
          if (done % progressEvery === 0 || done === uniquePaths.length) {
            onProgress?.({ current: done, total: uniquePaths.length, concurrency });
          }
          continue;
        }
        throw new Error(`Queued DDS file disappeared before conversion: ${ddsPath}`);
      }

      await runTexconvAsync(ddsPath, path.dirname(ddsPath));
      try { fs.unlinkSync(ddsPath); } catch {}
      done += 1;
      if (done % progressEvery === 0 || done === uniquePaths.length) {
        onProgress?.({ current: done, total: uniquePaths.length, concurrency });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function extractRec(node, outDir, pakFd, headerSize, rel, state, onProgress = null) {
  if (node.isDirectory) {
    const dirRel = node.name === "" ? rel : (rel ? path.join(rel, sanitizeName(node.name)) : sanitizeName(node.name));
    ensureDir(path.join(outDir, dirRel));
    for (const child of node.content) extractRec(child, outDir, pakFd, headerSize, dirRel, state, onProgress);
    return;
  }

  const safeName = sanitizeName(node.name);
  const fileRel = rel ? path.join(rel, safeName) : safeName;
  const absPath = path.join(outDir, fileRel);
  const srcPos = headerSize + node.dataPosition;
  const magic = peekMagic4(pakFd, srcPos);

  state.files += 1;
  state.bytes += node.dataSize;
  if (state.files % 1000 === 0) onProgress?.({ files: state.files, bytes: state.bytes, ddsQueued: state.dds.length });

  if (isDDSMagic(magic)) {
    const ddsTempPath = replaceExt(absPath, ".dds");
    extractFileChunked(pakFd, ddsTempPath, srcPos, node.dataSize);
    state.dds.push(ddsTempPath);
    return;
  }

  extractFileChunked(pakFd, absPath, srcPos, node.dataSize);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let pakPath = null;
  let outDir = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "-o") {
      if (i + 1 >= args.length) throw new Error("Missing value for --out");
      outDir = args[++i];
      continue;
    }
    if (!a.startsWith("-") && pakPath == null) {
      pakPath = a;
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  if (!pakPath) throw new Error('Usage: farever-pak-extractor <file.pak> [--out "folder"]');
  if (!outDir) {
    const ext = path.extname(pakPath).toLowerCase();
    outDir = ext === ".pak" ? pakPath.slice(0, -4) : pakPath + "_extracted";
  }
  return { pakPath, outDir };
}

async function extractPak({ pakPath, outDir, onProgress = null }) {
  const pak = readPakHeaderFromFile(pakPath);
  const totalFiles = countPakFiles(pak.root);
  onProgress?.({ stage: "read", version: pak.version, headerSize: pak.headerSize, dataSize: pak.dataSize, totalFiles });

  ensureDir(outDir);
  const pakFd = fs.openSync(pakPath, "r");
  const state = { files: 0, bytes: 0, dds: [] };
  try {
    extractRec(pak.root, outDir, pakFd, pak.headerSize, "", state, ({ files, bytes, ddsQueued }) => {
      onProgress?.({ stage: "extract", files, totalFiles, bytes, ddsQueued });
    });
  } finally {
    fs.closeSync(pakFd);
  }

  onProgress?.({ stage: "extract", files: state.files, totalFiles, bytes: state.bytes, ddsQueued: state.dds.length });
  await convertDdsList(state.dds, ({ current, total }) => {
    onProgress?.({ stage: "convert", current, total });
  });
  return {
    pakPath,
    outDir,
    version: pak.version,
    headerSize: pak.headerSize,
    dataSize: pak.dataSize,
    totalFiles,
    files: state.files,
    bytes: state.bytes,
    ddsQueued: state.dds.length,
    ddsConverted: state.dds.length,
  };
}

async function main(argv = process.argv) {
  const { pakPath, outDir } = parseArgs(argv);
  let result = null;
  await runTaskList([
    {
      title: `Extract ${path.basename(pakPath)}`,
      task: async (_ctx, task) => {
        result = await extractPak({
          pakPath,
          outDir,
          onProgress: (progress) => {
            if (progress.stage === "read") {
              task.output = `v${progress.version}, ${formatBytes(progress.dataSize)}, ${formatCount(0, progress.totalFiles, "files")}`;
              return;
            }
            if (progress.stage === "extract") {
              task.output = `${formatCount(progress.files, progress.totalFiles, "files")}, ${formatBytes(progress.bytes)}, ${progress.ddsQueued} DDS queued`;
              return;
            }
            if (progress.stage === "convert") {
              task.output = `${formatCount(progress.current, progress.total, "textures")} converted`;
            }
          },
        });
        task.output = `${formatCount(result.files, result.totalFiles, "files")}, ${result.ddsConverted}/${result.ddsQueued} DDS->PNG`;
      },
    },
  ], { tag: "pak-extractor" });
  return result;
}

module.exports = {
  extractPak,
  main,
};

if (require.main === module) {
  Promise.resolve(main()).catch((err) => {
    consola.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
