#!/usr/bin/env node
'use strict';

// Recompute every published number of a saved calibration from the persisted
// intermediate fields (record.json + gain/confidence/flags/noise binaries +
// optional model.json). Nothing here trusts the summary block: each metric is
// derived from the raw saved arrays so a calibration directory is fully
// auditable. With --target it also measures the per-image application cost.

const fs = require('fs');
const path = require('path');
const { loadCalibration } = require('../src/core/store');
const { expandModelData } = require('../src/core/gainmodel');
const { applyFlat, regionStats } = require('../src/core/apply');
const { loadImage } = require('../src/core/image-io');
const { FLAGS } = require('../src/core/calibration');

function percentileSorted(sorted, p) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function usage() {
  return `从保存的中间场重算标定指标

用法:
  node tools/recompute-metrics.js --calibration <标定目录> [--target x.png --settings @settings.json] [--json]

输出（JSON）:
  sizes        模型与稠密场字节数（model.json vs gain.bin）
  trust        由 confidence.bin 重算的可信比例（与 record.summary 对照）
  flags        各标志位像素比例（含 MODEL_UNFIT / GRID_DEGRADED）
  gain         全图与低亮度区（增益≥2）的增益分布：mean/p50/p99/max、封顶比例
  modelCheck   model.json 重新展开与 gain.bin 的最大偏差（存在模型文件时）
  noise        noise.bin 的噪声分布
  application  目标图应用耗时与统计（提供 --target 时）`;
}

function dirSizes(dir) {
  const sizes = {};
  for (const name of ['record.json', 'model.json', 'model.bin', 'gain.bin', 'confidence.bin', 'flags.bin', 'noise.bin']) {
    const file = path.join(dir, name);
    sizes[name] = fs.existsSync(file) ? fs.statSync(file).size : null;
  }
  return sizes;
}

function recompute(dir, targetPath, settings) {
  const calibration = loadCalibration(dir);
  const { record } = calibration;
  const pixelCount = record.width * record.height;
  const channels = calibration.channels;
  const threshold = record.options ? record.options.confidenceThreshold : 0.5;

  let trusted = 0;
  for (let p = 0; p < pixelCount; p++) {
    const excluded = calibration.flags[p] & (FLAGS.NO_VALID_VIEW | FLAGS.BAD_PIXEL | FLAGS.DEAD | FLAGS.SATURATED);
    if (!excluded && calibration.confidence[p] >= threshold) trusted++;
  }

  const flagFractions = {};
  for (const [name, bit] of Object.entries(FLAGS)) {
    let count = 0;
    for (let p = 0; p < pixelCount; p++) if (calibration.flags[p] & bit) count++;
    flagFractions[name] = count / pixelCount;
  }

  const gains = [];
  const lowGains = [];
  let cappedLow = 0;
  const cap = record.gainPolicy.maxGain;
  for (let p = 0; p < pixelCount; p++) {
    let g = 0;
    for (let c = 0; c < channels; c++) g += calibration.gain.data[p * channels + c];
    g /= channels;
    gains.push(g);
    if (g >= 2) {
      lowGains.push(g);
      if (g > cap) cappedLow++;
    }
  }
  gains.sort((a, b) => a - b);
  lowGains.sort((a, b) => a - b);
  const statsOf = (sorted) => ({
    samples: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
    p50: percentileSorted(sorted, 0.5),
    p99: percentileSorted(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : NaN,
  });

  let modelCheck = null;
  if (calibration.gainModelData && calibration.gainModelData.kind !== 'field') {
    const perChannel = calibration.gainModelData.channels || [];
    let maxDiff = 0;
    let maxRel = 0;
    perChannel.forEach((modelData, c) => {
      const dense = expandModelData(modelData, record.width, record.height);
      if (!dense) return;
      for (let p = 0; p < pixelCount; p++) {
        const diff = Math.abs(dense[p] - calibration.gain.data[p * channels + c]);
        if (diff > maxDiff) maxDiff = diff;
        const rel = diff / Math.max(1e-9, Math.abs(calibration.gain.data[p * channels + c]));
        if (rel > maxRel) maxRel = rel;
      }
    });
    modelCheck = {
      kind: calibration.gainModelData.kind,
      channelsChecked: perChannel.length,
      maxAbsDiff: maxDiff,
      maxRelativeDiff: maxRel,
      consistent: maxRel < 1e-4,
    };
  }

  const noiseValues = Array.from(calibration.noiseDn).filter((v) => v > 0).sort((a, b) => a - b);

  const result = {
    calibrationDir: dir,
    id: record.id,
    schemaVersion: record.schemaVersion || 3,
    gainModel: record.gainModel ? record.gainModel.kind : 'field',
    sizes: (() => {
      const s = dirSizes(dir);
      const modelTotal = (s['model.json'] || 0) + (s['model.bin'] || 0);
      return {
        ...s,
        modelTotalBytes: s['model.bin'] != null ? modelTotal : null,
        modelVsDense: s['model.bin'] != null ? modelTotal / s['gain.bin'] : 1,
      };
    })(),
    trust: {
      threshold,
      trustedFraction: trusted / pixelCount,
      recordedTrustedFraction: record.summary ? record.summary.trustedFraction : null,
      meanConfidence: Array.from(calibration.confidence).reduce((a, b) => a + b, 0) / pixelCount,
    },
    flags: flagFractions,
    gain: {
      all: statsOf(gains),
      lowLight: { ...statsOf(lowGains), cappedFraction: lowGains.length ? cappedLow / lowGains.length : 0, cap },
    },
    modelCheck,
    noise: {
      p50: percentileSorted(noiseValues, 0.5),
      p99: percentileSorted(noiseValues, 0.99),
      max: noiseValues.length ? noiseValues[noiseValues.length - 1] : NaN,
    },
  };

  if (targetPath) {
    const image = loadImage(targetPath);
    const runs = [];
    let application = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Number(process.hrtime.bigint()) / 1e6;
      application = applyFlat(record, calibration, image, { targetSettings: settings || record.settings });
      runs.push(Number(process.hrtime.bigint()) / 1e6 - t0);
    }
    runs.sort((a, b) => a - b);
    const rect = { x: 0, y: 0, w: image.width, h: image.height };
    result.application = {
      target: targetPath,
      applyMsPerImage: runs[Math.floor(runs.length / 2)],
      applyMsRuns: runs.map((v) => Math.round(v * 100) / 100),
      trustedFraction: application.trustedFraction,
      meanAppliedGain: application.meanAppliedGain,
      maxAppliedGain: application.maxAppliedGain,
      counts: application.counts,
      fullFrame: {
        before: regionStats(image, rect),
        after: regionStats(application.output, rect),
      },
    };
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.includes('--calibration')) {
    console.log(usage());
    process.exit(args.includes('--help') ? 0 : 2);
  }
  const dir = args[args.indexOf('--calibration') + 1];
  const targetPath = args.includes('--target') ? args[args.indexOf('--target') + 1] : null;
  let settings = null;
  if (args.includes('--settings')) {
    const raw = args[args.indexOf('--settings') + 1];
    settings = JSON.parse(raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw);
  }
  const result = recompute(dir, targetPath, settings);
  console.log(JSON.stringify(result, null, 2));
  if (result.modelCheck && !result.modelCheck.consistent) process.exit(3);
}

main();
