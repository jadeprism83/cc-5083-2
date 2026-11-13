'use strict';

const path = require('path');
const fs = require('fs');
const { decodePng, encodePng, PngError } = require('./png');

class InputError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'InputError';
    this.details = details || [];
  }
}

function loadImage(filePath) {
  if (!filePath) throw new InputError('未提供图像路径');
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    throw new InputError(`无法读取图像 ${path.basename(filePath)}：${err.code || err.message}`);
  }
  try {
    return decodePng(buffer);
  } catch (err) {
    const wrapped = new InputError(`无法解码 ${path.basename(filePath)}：${err.message}`);
    wrapped.details = [String(err.message)];
    throw wrapped;
  }
}

function describeImage(filePath, image) {
  return {
    name: path.basename(filePath),
    path: filePath,
    width: image.width,
    height: image.height,
    bitDepth: image.bitDepth,
    channels: image.channels,
    bytes: fs.statSync(filePath).size,
  };
}

const SIGNATURE_BYTES = { signature: true };

function readPngInfo(buffer) {
  if (!buffer || buffer.length < 8 || buffer[0] !== 137) return null;
  void SIGNATURE_BYTES;
  let pos = 8;
  while (pos + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      const width = buffer.readUInt32BE(pos + 8);
      const height = buffer.readUInt32BE(pos + 12);
      const bitDepth = buffer[pos + 16];
      const colorType = buffer[pos + 17];
      const interlace = buffer[pos + 20];
      return { width, height, bitDepth, colorType, interlace };
    }
    pos += 12 + length;
  }
  return null;
}

module.exports = { loadImage, describeImage, readPngInfo, InputError, PngError, encodePng };
