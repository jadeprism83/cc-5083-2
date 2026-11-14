'use strict';

// Flat-field application kernel.
//
// The calibration produces a dimensionless gain field plus per-pixel
// confidence. Application is one bounded multiply per signal channel, tapered
// by confidence. No histogram operation happens here, so relative detail
// inside the target image is retained; only the known spatial response is
// removed.

const {
  compareSettings,
  signalChannelsOf,
  bitDepthFullScale,
  APPLY_FLAGS,
  APPLY_FLAG_LABELS,
} = require('./calibration');
const { clamp, smoothstep, percentileSorted } = require('./stats');

const MAX_PIXELS = 24_000_000;

class RefusalError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RefusalError';
    this.details = Array.isArray(details) ? details : [];
  }
}

// Strict gate: identical sensor geometry and acquisition configuration. A gain
// estimated under one optical/electronic setup must not be reused under
// another, so missing or conflicting mandatory settings produce a refusal.
function validateCompatibility(record, calibration, targetImage, targetSettings) {
  const details = [];
  const warnings = [];
  if (!record) throw new RefusalError('缺少标定记录', ['请先完成参考组标定']);
  if (!calibration) throw new RefusalError('缺少增益数据', ['标定文件不完整']);
  if (record.width !== targetImage.width || record.height !== targetImage.height) {
    details.push(`图像尺寸不匹配：标定为 ${record.width}×${record.height}，目标图为 ${targetImage.width}×${targetImage.height}`);
  }
  const recordSignalChannels = record.inputFormat
    ? record.inputFormat.signalChannels
    : signalChannelsOf(calibration);
  const targetSignalChannels = signalChannelsOf(targetImage);
  if (recordSignalChannels !== targetSignalChannels) {
    details.push(`信号通道不匹配：标定为 ${recordSignalChannels} 通道，目标图为 ${targetSignalChannels} 通道`);
  }
  if (targetImage.width * targetImage.height > MAX_PIXELS) {
    details.push(`目标图 ${targetImage.width}×${targetImage.height} 超过单张处理上限 ${MAX_PIXELS} 像素`);
  }
  if (calibration.gain.width !== record.width || calibration.gain.height !== record.height) {
    details.push('增益场尺寸与标定记录不一致，标定文件可能已损坏');
  }
  if (targetImage.bitDepth !== record.bitDepth) {
    warnings.push(`位深不同：标定 ${record.bitDepth} 位、目标 ${targetImage.bitDepth} 位；暗电平与饱和阈值按满量程比例换算`);
  }
  const settingsCheck = compareSettings(record.settings, targetSettings, record.options || {});
  if (!settingsCheck.ok) details.push(...settingsCheck.mismatches.map((m) => m.reason));
  return {
    ok: details.length === 0 && settingsCheck.ok,
    details,
    warnings,
    settings: settingsCheck,
  };
}

function applyFlat(record, calibration, targetImage, options = {}) {
  const compatibility = validateCompatibility(record, calibration, targetImage, options.targetSettings || null);
  if (!compatibility.ok) {
    throw new RefusalError('目标图与标定不匹配，拒绝套用平场补偿', compatibility.details);
  }
  const width = targetImage.width;
  const height = targetImage.height;
  const channels = targetImage.channels;
  const signalChannels = signalChannelsOf(targetImage);
  const pixelCount = width * height;
  const fullScale = bitDepthFullScale(targetImage.bitDepth);
  const scale = fullScale / bitDepthFullScale(record.bitDepth);
  const dark = record.darkLevelDn * scale;
  const gain = calibration.gain;
  const gainChannels = gain.channels;
  const gainMax = Number.isFinite(options.maxGain) ? options.maxGain : record.gainPolicy.maxGain;
  const gainMin = Number.isFinite(options.minGain) ? options.minGain : record.gainPolicy.minGain;
  const threshold = options.confidenceThreshold !== undefined
    ? options.confidenceThreshold
    : (record.options ? record.options.confidenceThreshold : 0.5);

  const out = new Uint16Array(pixelCount * channels);
  const flags = new Uint8Array(pixelCount * signalChannels);
  const appliedGain = new Float32Array(pixelCount * signalChannels);
  const trust = new Uint8Array(pixelCount);
  const counts = {
    untrusted: 0, underDark: 0, clipped: 0, gainCapped: 0, gainFloored: 0, gainTapered: 0, invalidControl: 0,
  };
  let gainSum = 0;
  let gainSamples = 0;
  let trustedGainSum = 0;
  let trustedGainSamples = 0;
  let maxAppliedGain = 0;
  let trustedPixels = 0;

  for (let p = 0; p < pixelCount; p++) {
    const conf = calibration.confidence ? calibration.confidence[p] : 1;
    const taper = smoothstep(threshold * 0.5, threshold, conf);
    const trusted = conf >= threshold;
    trust[p] = trusted ? 1 : 0;
    if (!trusted) counts.untrusted++;
    else trustedPixels++;

    for (let c = 0; c < signalChannels; c++) {
      const idx = p * channels + c;
      const sample = targetImage.data[idx];
      let pixelFlags = 0;
      if (!trusted) pixelFlags |= APPLY_FLAGS.LOW_CONFIDENCE;
      if (sample >= Math.round(record.saturationThresholdDn * scale)) {
        pixelFlags |= APPLY_FLAGS.TARGET_CLIPPED;
        counts.clipped++;
      }
      const signal = sample - dark;
      if (signal <= 0) {
        // At or below the dark level there is no recoverable signal. Copy it
        // through instead of amplifying noise into a fake gradient.
        pixelFlags |= APPLY_FLAGS.TARGET_UNDER_DARK;
        counts.underDark++;
        out[idx] = Math.round(clamp(sample, 0, fullScale));
        appliedGain[p * signalChannels + c] = 1;
        flags[p * signalChannels + c] = pixelFlags;
        continue;
      }
      const rawGain = c < gainChannels ? gain.data[p * gainChannels + c] : 1;
      const g = clamp(rawGain, gainMin, gainMax);
      // Clamping is applied here, not during estimation, so the limits can be
      // changed in the preview without re-running the calibration.
      if (rawGain > gainMax + 1e-9) { pixelFlags |= APPLY_FLAGS.GAIN_CAPPED; counts.gainCapped++; }
      if (rawGain < gainMin - 1e-9) { pixelFlags |= APPLY_FLAGS.GAIN_FLOORED; counts.gainFloored++; }
      if (conf <= 0 && Math.abs(g - 1) > 1e-9) { pixelFlags |= APPLY_FLAGS.CONTROL_INVALID; counts.invalidControl++; }
      if (taper < 0.999 && conf > 0 && Math.abs(g - 1) > 1e-9) {
        pixelFlags |= APPLY_FLAGS.LOW_SIGNAL_LIMITED;
        counts.gainTapered++;
      }
      const effectiveGain = 1 + (g - 1) * taper;
      const corrected = signal * effectiveGain + dark;
      out[idx] = Math.round(clamp(corrected, 0, fullScale));
      appliedGain[p * signalChannels + c] = effectiveGain;
      flags[p * signalChannels + c] = pixelFlags;
      gainSum += effectiveGain;
      gainSamples++;
      if (effectiveGain > maxAppliedGain) maxAppliedGain = effectiveGain;
      if (trusted) {
        trustedGainSum += effectiveGain;
        trustedGainSamples++;
      }
    }
    if (channels === 4) out[p * channels + 3] = targetImage.data[p * channels + 3];
    if (channels === 2) out[p * channels + 1] = targetImage.data[p * channels + 1];
  }

  return {
    ok: true,
    output: { width, height, bitDepth: targetImage.bitDepth, channels, data: out },
    flags,
    flagsPerChannel: signalChannels,
    appliedGain,
    appliedGainChannels: signalChannels,
    trusted: trust,
    compatibility,
    counts,
    threshold,
    trustedFraction: trustedPixels / pixelCount,
    meanAppliedGain: gainSamples ? gainSum / gainSamples : 1,
    meanAppliedGainTrusted: trustedGainSamples ? trustedGainSum / trustedGainSamples : 1,
    maxAppliedGain,
  };
}

// Region descriptors over identical coordinates in both images. Used by the
// preview, export report and synthetic validation so the numbers always refer
// to the same physical area.
function regionStats(image, rect, channel) {
  const x0 = clamp(Math.floor(rect.x), 0, image.width);
  const y0 = clamp(Math.floor(rect.y), 0, image.height);
  const x1 = clamp(Math.floor(rect.x + rect.w), 0, image.width);
  const y1 = clamp(Math.floor(rect.y + rect.h), 0, image.height);
  if (x1 <= x0 || y1 <= y0) return { error: '区域超出图像范围' };
  const sc = signalChannelsOf(image);
  const chan = channel === undefined || channel === null ? -1 : channel;
  const values = [];
  const residuals = [];
  const rowData = [];
  for (let y = y0; y < y1; y++) {
    const row = [];
    for (let x = x0; x < x1; x++) {
      const base = (y * image.width + x) * image.channels;
      let v;
      if (chan >= 0) v = image.data[base + chan];
      else if (sc === 1) v = image.data[base];
      else {
        let s = 0;
        for (let c = 0; c < sc; c++) s += image.data[base + c];
        v = s / sc;
      }
      values.push(v);
      row.push(v);
    }
    rowData.push(row);
  }
  for (let y = 1; y < rowData.length - 1; y++) {
    for (let x = 1; x < rowData[y].length - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) sum += rowData[y + dy][x + dx];
      }
      residuals.push(rowData[y][x] - sum / 9);
    }
  }
  values.sort((a, b) => a - b);
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let hpSigma = NaN;
  if (residuals.length >= 16) {
    const abs = residuals.map(Math.abs).sort((a, b) => a - b);
    hpSigma = (1.4826 * abs[Math.floor(abs.length / 2)]) / 0.943;
  }
  return {
    rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    samples: values.length,
    meanDn: mean,
    medianDn: percentileSorted(values, 0.5),
    p01Dn: percentileSorted(values, 0.01),
    p99Dn: percentileSorted(values, 0.99),
    minDn: values[0],
    maxDn: values[values.length - 1],
    stdDn: Math.sqrt(values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length),
    highPassNoiseDn: hpSigma,
  };
}

function regionTrust(calibration, rect, threshold) {
  const thresholdValue = threshold === undefined
    ? ((calibration.record && calibration.record.options) ? calibration.record.options.confidenceThreshold : 0.5)
    : threshold;
  const trustMap = calibration.trust || calibration.trusted;
  const x0 = clamp(Math.floor(rect.x), 0, calibration.width);
  const y0 = clamp(Math.floor(rect.y), 0, calibration.height);
  const x1 = clamp(Math.floor(rect.x + rect.w), 0, calibration.width);
  const y1 = clamp(Math.floor(rect.y + rect.h), 0, calibration.height);
  let trusted = 0;
  let total = 0;
  let confSum = 0;
  let modelUnfit = 0;
  let gridDegraded = 0;
  let gainSum = 0;
  let gainSamples = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = y * calibration.width + x;
      const conf = calibration.confidence ? calibration.confidence[p] : 1;
      if (conf >= thresholdValue && !(trustMap && trustMap[p] === 0)) trusted++;
      if (calibration.flags) {
        if (calibration.flags[p] & 16) modelUnfit++;
        if (calibration.flags[p] & 32) gridDegraded++;
      }
      confSum += conf;
      for (let c = 0; c < calibration.gain.channels; c++) {
        gainSum += calibration.gain.data[p * calibration.gain.channels + c];
        gainSamples++;
      }
      total++;
    }
  }
  return {
    trustedFraction: total ? trusted / total : 0,
    meanConfidence: total ? confSum / total : 0,
    modelUnfitFraction: total ? modelUnfit / total : 0,
    gridDegradedFraction: total ? gridDegraded / total : 0,
    meanGain: gainSamples ? gainSum / gainSamples : 1,
  };
}

// Horizontal numeric profile at one row: same row and x-range in both images.
function numericProfile(before, after, rect, channel) {
  const y = clamp(Math.floor(rect.y), 0, before.height - 1);
  const x0 = clamp(Math.floor(rect.x), 0, before.width);
  const x1 = clamp(Math.floor(rect.x + rect.w), 0, before.width);
  const scBefore = signalChannelsOf(before);
  const scAfter = signalChannelsOf(after);
  const chan = channel === undefined || channel === null ? -1 : channel;
  const sampleAt = (image, sc, x) => {
    const base = (y * image.width + x) * image.channels;
    if (chan >= 0) return image.data[base + chan];
    if (sc === 1) return image.data[base];
    let s = 0;
    for (let c = 0; c < sc; c++) s += image.data[base + c];
    return s / sc;
  };
  const points = [];
  const stride = Math.max(1, Math.round((x1 - x0) / 200));
  for (let x = x0; x < x1; x += stride) {
    points.push({ x, beforeDn: sampleAt(before, scBefore, x), afterDn: sampleAt(after, scAfter, x) });
  }
  return { y, x0, x1, stride, points };
}

function describeApplication(before, after, record, calibration, application, regions, profileSpec) {
  const regionReports = (regions || []).map((region) => {
    const beforeStats = regionStats(before, region, region.channel);
    const afterStats = regionStats(after, region, region.channel);
    const trust = regionTrust(calibration, region);
    return {
      label: region.label || `区域 ${region.x},${region.y}`,
      channel: region.channel === undefined ? null : region.channel,
      before: beforeStats,
      after: afterStats,
      ...trust,
    };
  });
  const report = {
    image: { width: before.width, height: before.height, bitDepth: before.bitDepth, channels: before.channels },
    calibration: {
      id: record.id,
      createdAt: record.createdAt,
      referenceCount: record.referenceCount,
      dark: record.darkSource,
      darkLevelDn: record.darkLevelDn,
      saturationThresholdDn: record.saturationThresholdDn,
      normalization: record.normalization,
      gainPolicy: record.gainPolicy,
      refinement: record.refinement,
      options: record.options,
      settings: record.settings,
      warnings: record.warnings,
    },
    application: {
      confidenceThreshold: application.threshold,
      untrustedFraction: 1 - application.trustedFraction,
      meanAppliedGain: application.meanAppliedGain,
      counts: application.counts,
      warnings: application.compatibility.warnings,
    },
    regions: regionReports,
  };
    if (profileSpec) report.profile = numericProfile(before, after, profileSpec, profileSpec.channel);
  return report;
}

module.exports = {
  applyFlat,
  validateCompatibility,
  describeApplication,
  regionStats,
  regionTrust,
  numericProfile,
  RefusalError,
  MAX_PIXELS,
  APPLY_FLAGS,
  APPLY_FLAG_LABELS,
};

