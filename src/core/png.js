'use strict';

// Minimal dependency-free PNG codec. Supports the subset that matters for
// camera captures: 8/16-bit grayscale, grayscale+alpha, RGB, RGBA, palette-free
// non-interlaced images. Anything else is rejected rather than guessed at.

const zlib = require('zlib');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

class PngError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PngError';
  }
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  CRC_TABLE[n] = c >>> 0;
}

function crc32Fast(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('不是有效的 PNG 文件（签名不匹配）');
  }
  let pos = 8;
  const chunks = [];
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new PngError(`PNG 数据在 ${type} 块处被截断`);
    const crcStored = buf.readUInt32BE(dataEnd);
    const crcActual = crc32Fast(buf.subarray(pos + 4, dataEnd));
    if (crcStored !== crcActual) throw new PngError(`PNG ${type} 块 CRC 校验失败`);
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd) });
    pos = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[inPos++];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
      let value;
      switch (filter) {
        case 0: value = cur; break;
        case 1: value = cur + left; break;
        case 2: value = cur + up; break;
        case 3: value = cur + ((left + up) >> 1); break;
        case 4: value = cur + paeth(left, up, upLeft); break;
        default: throw new PngError(`未知的 PNG 行滤波器类型 ${filter}`);
      }
      out[rowStart + x] = value & 0xff;
    }
  }
  return out;
}

function filterNone(data, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (stride + 1)] = 0;
    out.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return out;
}

// Image representation: { width, height, bitDepth: 8|16, channels: 1|2|3|4,
// data: Uint16Array } with samples normalized to the source bit depth.
// 16-bit PNGs are stored big-endian in the file; we keep them in Uint16Array
// and remember the source depth so round-tripping never silently rescales.
function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new PngError('PNG 缺少 IHDR 块');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (![8, 16].includes(bitDepth)) throw new PngError(`不支持的 PNG 位深 ${bitDepth}（仅支持 8/16 位）`);
  if (!(colorType in CHANNELS) || colorType === 3) {
    throw new PngError(`不支持的 PNG 颜色类型 ${colorType}（仅支持灰度/RGB 及其 alpha 变体）`);
  }
  if (interlace !== 0) throw new PngError('不支持隔行扫描 PNG，请改用非隔行扫描输出');
  if (width < 1 || height < 1 || width > 16384 || height > 16384) {
    throw new PngError(`图像尺寸异常：${width}x${height}`);
  }
  const channels = CHANNELS[colorType];
  const bpp = channels * (bitDepth / 8);
  const idatParts = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  if (idatParts.length === 0) throw new PngError('PNG 缺少 IDAT 块');
  const compressed = Buffer.concat(idatParts);
  let raw;
  try {
    raw = zlib.inflateSync(compressed);
  } catch (err) {
    throw new PngError('PNG 像素数据解压失败：' + err.message);
  }
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw new PngError('PNG 像素数据长度不足');
  const bytes = unfilter(raw, width, height, bpp);
  const sampleCount = width * height * channels;
  const data = new Uint16Array(sampleCount);
  if (bitDepth === 8) {
    for (let i = 0; i < sampleCount; i++) data[i] = bytes[i];
  } else {
    for (let i = 0; i < sampleCount; i++) data[i] = (bytes[2 * i] << 8) | bytes[2 * i + 1];
  }
  return { width, height, bitDepth, channels, data };
}

function encodePng(image, level = 6) {
  const { width, height, bitDepth, channels, data } = image;
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  let p = 0;
  // Write samples in file order (big-endian for 16-bit), filter type None.

  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    const row = y * width * channels;
    if (bitDepth === 8) {
      for (let x = 0; x < width * channels; x++) raw[p++] = data[row + x];
    } else {
      for (let x = 0; x < width * channels; x++) {
        const v = data[row + x];
        raw[p++] = (v >> 8) & 0xff;
        raw[p++] = v & 0xff;
      }
    }
  }
  const compressed = zlib.deflateSync(raw, { level });
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts = [SIGNATURE];
  const chunk = (type, dataBuf) => {
    const buf = Buffer.alloc(12 + dataBuf.length);
    buf.writeUInt32BE(dataBuf.length, 0);
    buf.write(type, 4, 'ascii');
    dataBuf.copy(buf, 8);
    buf.writeUInt32BE(crc32Fast(buf.subarray(4, 8 + dataBuf.length)), 8 + dataBuf.length);
    return buf;
  };
  parts.push(chunk('IHDR', ihdr));
  parts.push(chunk('IDAT', compressed));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function grayOf(image, x, y) {
  const idx = (y * image.width + x) * image.channels;
  const c = image.channels;
  if (c === 1 || c === 2) return image.data[idx];
  return Math.round((image.data[idx] + image.data[idx + 1] + image.data[idx + 2]) / 3);
}

module.exports = { decodePng, encodePng, PngError, crc32, grayOf, SIGNATURE };
