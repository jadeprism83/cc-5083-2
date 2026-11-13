'use strict';

// Calibration persistence. One directory per calibration holds:
//   record.json     - manifest, settings, options, statistics, warnings
//   gain.bin        - Float32 gain field, little-endian (width*height*channels)
//   confidence.bin  - Float32 confidence, one value per pixel (shared channels)
//   flags.bin       - Uint8 per-pixel reference flags
//   noise.bin       - Float32 per-pixel, per-signal-channel noise (DN)
//
// Raw float fields avoid quantising the gain or losing the confidence model.
// A JSON-only manifest cannot be applied accidentally without its binaries
// because load refuses incomplete directories.

const fs = require('fs');
const path = require('path');

class CalibrationStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CalibrationStoreError';
  }
}

const REQUIRED_BINARIES = ['gain', 'confidence', 'flags', 'noise'];

function assertFinite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CalibrationStoreError(`标定字段 ${field} 不是有限数值（${value}）`);
  }
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new CalibrationStoreError('标定记录缺失');
  for (const field of ['width', 'height', 'channels', 'bitDepth', 'fullScale', 'darkLevelDn', 'saturationThresholdDn']) {
    assertFinite(record[field], field);
    if (record[field] < 0) throw new CalibrationStoreError(`标定字段 ${field} 不能为负`);
  }
  if (!record.gainPolicy || !Number.isFinite(record.gainPolicy.maxGain)) {
    throw new CalibrationStoreError('标定记录缺少 gainPolicy.maxGain');
  }
  if (!record.options) throw new CalibrationStoreError('标定记录缺少 options');
  return record;
}

function writeCalibration(dir, result, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const record = validateRecord({ ...result.record, ...extra });
  const pixelCount = result.width * result.height;
  const channels = result.channels;
  const gain = result.gain.data;
  if (gain.length !== pixelCount * channels) throw new CalibrationStoreError('增益场长度与尺寸不符');
  if (result.confidence.length !== pixelCount) throw new CalibrationStoreError('可信度图长度与尺寸不符');
  if (result.flags.length !== pixelCount) throw new CalibrationStoreError('标志位长度与尺寸不符');
  if (result.noiseDn.length !== pixelCount * channels) throw new CalibrationStoreError('噪声图长度与尺寸不符');
  fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(dir, 'gain.bin'), Buffer.from(Float32Array.from(gain).buffer));
  fs.writeFileSync(path.join(dir, 'confidence.bin'), Buffer.from(Float32Array.from(result.confidence).buffer));
  fs.writeFileSync(path.join(dir, 'flags.bin'), Buffer.from(Uint8Array.from(result.flags).buffer));
  fs.writeFileSync(path.join(dir, 'noise.bin'), Buffer.from(Float32Array.from(result.noiseDn).buffer));
  return {
    record,
    paths: {
      record: path.join(dir, 'record.json'),
      gain: path.join(dir, 'gain.bin'),
      confidence: path.join(dir, 'confidence.bin'),
      flags: path.join(dir, 'flags.bin'),
      noise: path.join(dir, 'noise.bin'),
    },
  };
}

function readFloat32(file, expectedLength, label) {
  const buffer = fs.readFileSync(file);
  if (buffer.length !== expectedLength * 4) {
    throw new CalibrationStoreError(`${label} 长度不符：${buffer.length} 字节，期望 ${expectedLength * 4}`);
  }
  return new Float32Array(buffer.buffer, buffer.byteOffset, expectedLength).slice();
}

function readUint8(file, expectedLength, label) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < expectedLength) {
    throw new CalibrationStoreError(`${label} 长度不足：${buffer.length} 字节，期望 ${expectedLength}`);
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, expectedLength).slice();
}

function loadCalibration(dir) {
  const recordPath = path.join(dir, 'record.json');
  if (!fs.existsSync(recordPath)) throw new CalibrationStoreError(`标定目录 ${dir} 缺少 record.json`);
  const record = validateRecord(JSON.parse(fs.readFileSync(recordPath, 'utf8')));
  for (const name of REQUIRED_BINARIES) {
    if (!fs.existsSync(path.join(dir, `${name}.bin`))) {
      throw new CalibrationStoreError(`标定目录 ${dir} 缺少 ${name}.bin`);
    }
  }
  const pixelCount = record.width * record.height;
  const channels = record.inputFormat && record.inputFormat.signalChannels ? record.inputFormat.signalChannels : record.channels;
  const gain = readFloat32(path.join(dir, 'gain.bin'), pixelCount * channels, 'gain.bin');
  const confidence = readFloat32(path.join(dir, 'confidence.bin'), pixelCount, 'confidence.bin');
  const flags = readUint8(path.join(dir, 'flags.bin'), pixelCount, 'flags.bin');
  const noiseDn = readFloat32(path.join(dir, 'noise.bin'), pixelCount * channels, 'noise.bin');
  return {
    record,
    width: record.width,
    height: record.height,
    channels,
    gain: { width: record.width, height: record.height, channels, data: gain },
    confidence,
    flags,
    noiseDn,
  };
}

function listCalibrations(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const recordPath = path.join(dir, entry.name, 'record.json');
      if (!fs.existsSync(recordPath)) return null;
      try {
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        return {
          id: entry.name,
          label: record.label || record.id || entry.name,
          createdAt: record.createdAt,
          width: record.width,
          height: record.height,
          bitDepth: record.bitDepth,
          referenceCount: record.referenceCount,
          darkLevelDn: record.darkLevelDn,
          normalization: record.normalization ? record.normalization.mode : null,
          maxGain: record.gainPolicy ? record.gainPolicy.maxGain : null,
          trustedFraction: record.summary ? record.summary.trustedFraction : null,
          settings: record.settings,
          warnings: record.warnings || [],
          hasBinaries: REQUIRED_BINARIES.every((n) => fs.existsSync(path.join(dir, entry.name, `${n}.bin`))),
        };
      } catch (err) {
        return { id: entry.name, error: err.message };
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function deleteCalibration(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { writeCalibration, loadCalibration, listCalibrations, deleteCalibration, CalibrationStoreError };
