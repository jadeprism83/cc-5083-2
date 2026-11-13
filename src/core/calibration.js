'use strict';

// Flat-field calibration kernel.
//
// Pipeline: dark subtraction -> per-pixel robust multi-frame combination ->
// spatial defect rejection -> mask-aware smoothing -> normalization basis ->
// unbounded-but-flagged gain estimate with per-pixel confidence.
//
// A flat reference is uniform by construction, so its spatial structure is the
// combined optical/electronic response (vignetting, dust, local occlusion).
// We estimate that response once. Gain limits and trust thresholds are applied
// later (in apply.js) so a preview can change them without re-estimating.

const {
  medianInPlace,
  percentileSorted,
  clamp,
  smoothstep,
  maskedGaussianBlur,
  highPassNoiseSigma,
} = require('./stats');
const { SETTINGS_SCHEMA } = require('./options');

const FLAGS = {
  NO_VALID_VIEW: 1,   // not enough usable frames at this pixel
  SATURATED: 2,       // clipped in every used reference frame
  BAD_PIXEL: 4,       // spatially incoherent defect
  LOW_SIGNAL: 8,      // valid but close to the sensor noise floor
  FILLED: 64,         // gain borrowed from neighbouring reliable pixels
  DEAD: 128,          // no supported gain estimate at all
};

const FLAG_LABELS = {
  NO_VALID_VIEW: '有效观测不足',
  SATURATED: '参考帧饱和（无有效观测）',
  BAD_PIXEL: '坏点',
  LOW_SIGNAL: '低照度（限制放大）',
  FILLED: '增益由邻近可靠区填充',
  DEAD: '无有效增益估计',
};

const APPLY_FLAGS = {
  TARGET_CLIPPED: 1,
  TARGET_UNDER_DARK: 2,
  GAIN_CAPPED: 4,
  GAIN_FLOORED: 8,
  LOW_CONFIDENCE: 16,
  CONTROL_INVALID: 32,
  TAPERED: 64,
};

const APPLY_FLAG_LABELS = {
  TARGET_CLIPPED: '目标图饱和',
  TARGET_UNDER_DARK: '目标低于暗电平',
  GAIN_CAPPED: '达到最大补偿倍率',
  GAIN_FLOORED: '达到最大衰减倍率',
  LOW_CONFIDENCE: '可信度不足',
  CONTROL_INVALID: '该处无有效增益估计',
  TAPERED: '按可信度部分施加',
};

const bitDepthFullScale = (bitDepth) => (bitDepth === 8 ? 255 : 65535);
const signalChannelsOf = (image) => (image.channels === 4 ? 3 : image.channels === 2 ? 1 : image.channels);

function settingsFromSchema(settings) {
  const out = {};
  for (const field of SETTINGS_SCHEMA) {
    const raw = settings ? settings[field.key] : undefined;
    if (raw === undefined || raw === null || raw === '' || (typeof raw === 'number' && !Number.isFinite(raw))) {
      out[field.key] = null;
    } else {
      out[field.key] = field.type === 'number' ? Number(raw) : String(raw);
    }
  }
  return out;
}

function formatSetting(v) {
  if (v === null) return '未提供';
  return typeof v === 'number' ? String(Number(v.toFixed(6))) : String(v);
}

function compareSettings(recordSettings, targetSettings, options) {
  const expected = settingsFromSchema(recordSettings);
  const actual = settingsFromSchema(targetSettings);
  const mismatches = [];
  for (const field of SETTINGS_SCHEMA) {
    let required = field.mandatory;
    if (!required && (field.key === 'iso' || field.key === 'exposureMs')) {
      required = !!(options && options.requireRadiometryMatch);
    }
    if (!required) continue;
    const av = expected[field.key];
    const bv = actual[field.key];
    const absent = av === null || bv === null;
    let equal = false;
    if (!absent) {
      if (typeof av === 'number') {
        const relTol = (field.key === 'iso' || field.key === 'exposureMs')
          ? Math.max(0, (options && options.radiometryTolerance) || 0)
          : 0;
        equal = Math.abs(av - bv) <= Math.max(relTol * Math.max(Math.abs(av), 1e-9), 1e-9);
      } else {
        equal = String(av).trim() === String(bv).trim();
      }
    }
    if (!equal) {
      mismatches.push({
        key: field.key,
        label: field.label,
        expected: av,
        actual: bv,
        reason: absent
          ? `缺少必填采集设置“${field.label}”`
          : `“${field.label}”不一致：标定记录 ${formatSetting(av)}，目标图 ${formatSetting(bv)}`,
        mandatory: field.mandatory,
        radiometric: !field.mandatory,
      });
    }
  }
  return { ok: mismatches.length === 0, mismatches, expected, actual };
}

function consistentGroup(items, label) {
  const errors = [];
  if (!items.length) return { ok: false, errors: [`${label}为空`], reference: null };
  const first = items[0];
  for (const item of items.slice(1)) {
    if (item.image.width !== first.image.width || item.image.height !== first.image.height) {
      errors.push(`${label}尺寸不一致：${item.name} 为 ${item.image.width}×${item.image.height}，${first.name} 为 ${first.image.width}×${first.image.height}`);
    }
    if (item.image.bitDepth !== first.image.bitDepth) {
      errors.push(`${label}位深不一致：${item.name} 为 ${item.image.bitDepth} 位，${first.name} 为 ${first.image.bitDepth} 位`);
    }
    if (item.image.channels !== first.image.channels) {
      errors.push(`${label}通道数不一致：${item.name} 为 ${item.image.channels}，${first.name} 为 ${first.image.channels}`);
    }
  }
  const reference = settingsFromSchema(first.settings);
  const mandatoryFields = SETTINGS_SCHEMA.filter((f) => f.mandatory);
  for (const field of mandatoryFields) {
    if (reference[field.key] === null) {
      errors.push(`${label}缺少必填采集设置“${field.label}”`);
    }
  }
  for (const item of items.slice(1)) {
    const other = settingsFromSchema(item.settings);
    for (const field of mandatoryFields) {
      if (reference[field.key] === null || other[field.key] === null) continue;
      if (String(reference[field.key]) !== String(other[field.key])) {
        errors.push(`${label}内采集设置不一致：${item.name} 的“${field.label}”为 ${formatSetting(other[field.key])}，组内值为 ${formatSetting(reference[field.key])}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, reference };
}

function frameNoisePerChannel(image, darkLevel, satThreshold) {
  const channels = signalChannelsOf(image);
  const w = image.width;
  const h = image.height;
  const out = [];
  for (let c = 0; c < channels; c++) {
    const plane = new Float32Array(w * h);
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const raw = image.data[p * image.channels + c];
      if (raw < satThreshold && raw - darkLevel > 0) {
        mask[p] = 1;
        plane[p] = raw - darkLevel;
      }
    }
    const sigma = highPassNoiseSigma(plane, w, h, mask);
    out.push(Number.isFinite(sigma) && sigma > 0 ? sigma : 1);
  }
  return out;
}

function frameStats(image, darkLevel, satThreshold, noise) {
  const channels = signalChannelsOf(image);
  const w = image.width;
  const h = image.height;
  const perChannel = [];
  let overallSat = 0;
  for (let c = 0; c < channels; c++) {
    let sum = 0;
    let n = 0;
    let sat = 0;
    for (let p = 0; p < w * h; p++) {
      const raw = image.data[p * image.channels + c];
      if (raw >= satThreshold) sat++;
      else if (raw - darkLevel > 0) { sum += raw - darkLevel; n++; }
    }
    perChannel.push({
      meanSignalDn: n ? sum / n : NaN,
      noiseSigmaDn: noise[c],
      saturatedFraction: sat / (w * h),
      validFraction: n / (w * h),
    });
    overallSat += sat / (w * h) / channels;
  }
  return { perChannel, saturatedFraction: overallSat };
}

// Pixel-wise robust multi-frame combination.
//
// * Saturated samples are never treated as observations.
// * Samples at or below the dark level are invalid observations, not low light.
// * A median plus MAD outlier rejection keeps moving defects from biasing the
//   estimate, and the retained count becomes part of the trust model.
function combineFrames(refs, channel, darkLevel, satThreshold, options) {
  const w = refs[0].image.width;
  const h = refs[0].image.height;
  const nFrames = refs.length;
  const signal = new Float32Array(w * h);
  const frameSigma = new Float32Array(w * h); // single-frame noise at this pixel
  const accepted = new Uint16Array(w * h);
  const saturatedFrames = new Uint16Array(w * h);
  const rejectedSamples = new Uint16Array(w * h);
  const samples = new Float32Array(nFrames);
  const residuals = new Float32Array(nFrames);
  let groupNoise = 0;
  for (let f = 0; f < nFrames; f++) groupNoise += refs[f].noiseSigma[channel] / nFrames;
  if (!(groupNoise > 0)) groupNoise = 0.5;

  for (let p = 0; p < w * h; p++) {
    let m = 0;
    let sat = 0;
    for (let f = 0; f < nFrames; f++) {
      const raw = refs[f].image.data[p * refs[f].image.channels + channel];
      if (raw >= satThreshold) { sat++; continue; }
      const s = raw - darkLevel;
      if (s <= 0) continue;
      samples[m++] = s;
    }
    saturatedFrames[p] = sat;
    if (m === 0) {
      signal[p] = 0;
      frameSigma[p] = groupNoise;
      accepted[p] = 0;
      continue;
    }

    let center;
    let kept = m;
    let localSigma = groupNoise;
    if (m >= 3) {
      center = medianInPlace(samples, m);
      for (let i = 0; i < m; i++) residuals[i] = Math.abs(samples[i] - center);
      const mad = medianInPlace(residuals, m);
      localSigma = Math.max(1.4826 * mad, groupNoise * 0.25, 0.5);
      const limit = options.outlierSigma * localSigma;
      let k = 0;
      for (let i = 0; i < m; i++) {
        if (Math.abs(samples[i] - center) <= limit) samples[k++] = samples[i];
        else rejectedSamples[p]++;
      }
      kept = k;
      if (kept === 0) kept = m; // never discard everything
    } else {
      let sum = 0;
      for (let i = 0; i < m; i++) sum += samples[i];
      center = sum / m;
      localSigma = groupNoise;
      kept = m;
    }

    let mean = 0;
    const nKeep = Math.max(1, kept);
    for (let i = 0; i < nKeep; i++) mean += samples[i];
    mean /= nKeep;
    signal[p] = mean;
    frameSigma[p] = Math.max(localSigma, 0.5);
    accepted[p] = nKeep;
  }
  return { signal, frameSigma, accepted, saturatedFrames, rejectedSamples, groupNoise };
}

// An isolated spatial spike is a defect. The median of the eight neighbours is
// insensitive to an edge step, so a genuine shadow boundary is not rejected.
function findBadPixels(plane, valid, sigma, options, w, h) {
  const bad = new Uint8Array(w * h);
  const neighbours = new Float32Array(8);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (!valid[idx]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const j = (y + dy) * w + (x + dx);
          if (valid[j]) neighbours[n++] = plane[j];
        }
      }
      if (n < 5) continue;
      const med = medianInPlace(neighbours, n);
      const limit = options.badPixelSigma * Math.max(Math.min(sigma[idx], 1e6), 0.5);
      if (Math.abs(plane[idx] - med) > limit) bad[idx] = 1;
    }
  }
  return bad;
}

function collectStatistic(plane, mask, mode, percentile) {
  let count = 0;
  for (let i = 0; i < plane.length; i++) if (mask[i]) count++;
  if (!count) return NaN;
  if (mode === 'mean') {
    let sum = 0;
    for (let i = 0; i < plane.length; i++) if (mask[i]) sum += plane[i];
    return sum / count;
  }
  const values = [];
  const step = Math.max(1, Math.floor(count / 150000));
  let seen = 0;
  for (let i = 0; i < plane.length; i++) {
    if (!mask[i]) continue;
    if (seen++ % step === 0) values.push(plane[i]);
  }
  values.sort((a, b) => a - b);
  return percentileSorted(values, mode === 'median' ? 0.5 : percentile / 100);
}

function calibrate(group, options, context) {
  const errors = [];
  const warnings = [];
  const refs = group.references || [];
  const darks = group.darkFrames || [];

  if (!refs.length) return { ok: false, errors: ['参考组为空，无法估计增益'], warnings };
  if (refs.length < options.minValidFrames) {
    errors.push(`参考组只有 ${refs.length} 帧，少于“最少有效帧数” ${options.minValidFrames}`);
  }
  if (refs.length < 2) {
    warnings.push('仅 1 帧参考无法用多帧中值区分噪声与响应；可信度和噪声统计将不完整');
  }
  const refCheck = consistentGroup(refs, '参考组');
  if (!refCheck.ok) errors.push(...refCheck.errors);
  if (darks.length) {
    const darkCheck = consistentGroup(darks, '暗场组');
    if (!darkCheck.ok) errors.push(...darkCheck.errors);
  }
  if (errors.length) return { ok: false, errors, warnings };

  const first = refs[0].image;
  const width = first.width;
  const height = first.height;
  const bitDepth = first.bitDepth;
  const channels = signalChannelsOf(first);
  const fullScale = bitDepthFullScale(bitDepth);
  const satThreshold = Math.max(1, Math.min(fullScale, Math.round(options.saturationFraction * fullScale)));
  const pixelCount = width * height;

  let darkDn;
  let darkSource;
  if (options.darkMode === 'darkFrames') {
    if (!darks.length) return { ok: false, errors: ['暗电平模式为“使用暗场组”，但未提供暗场图像'], warnings };
    if (darks[0].image.bitDepth !== bitDepth) return { ok: false, errors: ['暗场组位深与参考组不一致'], warnings };
    const perChannel = [];
    for (let c = 0; c < channels; c++) {
      const values = [];
      for (const frame of darks) {
        const n = frame.image.width * frame.image.height;
        for (let p = 0; p < n; p += 5) values.push(frame.image.data[p * frame.image.channels + c]);
      }
      values.sort((a, b) => a - b);
      perChannel.push(percentileSorted(values, 0.5));
    }
    darkDn = percentileSorted(perChannel.slice().sort((a, b) => a - b), 0.5);
    darkSource = { mode: 'darkFrames', frameCount: darks.length, perChannelMedianDn: perChannel };
    const spread = Math.max(...perChannel.map((v) => Math.abs(v - darkDn)));
    if (spread > Math.max(8, darkDn * 0.1)) {
      warnings.push(`暗场各通道中位数差异达 ${spread.toFixed(1)} DN；平场使用统一暗电平 ${darkDn.toFixed(1)} DN`);
    }
  } else if (options.darkMode === 'manual') {
    darkDn = options.darkDn;
    darkSource = { mode: 'manual', valueDn: darkDn };
  } else {
    darkDn = 0;
    darkSource = { mode: 'none', valueDn: 0 };
  }
  if (!(darkDn >= 0) || darkDn >= fullScale * 0.9) {
    const limit = Math.floor(fullScale * 0.9) - 1;
    return {
      ok: false,
      errors: [
        `暗电平 ${darkDn} DN 超出 ${bitDepth} 位图像满量程 ${fullScale} 的有效范围（应 ≤ ${limit} DN）。` +
        '暗电平按图像自身的 DN 单位计，8 位图像请改用较小的数值或暗场组。',
      ],
      warnings,
    };
  }
  darkDn = Math.round(darkDn);

  for (const ref of refs) ref.noiseSigma = frameNoisePerChannel(ref.image, darkDn, satThreshold);
  for (const dark of darks) dark.noiseSigma = frameNoisePerChannel(dark.image, 0, satThreshold);

  const frameReports = [];
  const meanLevels = [];
  for (const ref of refs) {
    const st = frameStats(ref.image, darkDn, satThreshold, ref.noiseSigma);
    meanLevels.push(meanOf(st.perChannel.map((c) => c.meanSignalDn)));
    frameReports.push({ name: ref.name, role: 'reference', ...st });
  }
  for (const dark of darks) {
    const st = frameStats(dark.image, 0, satThreshold, dark.noiseSigma);
    frameReports.push({ name: dark.name, role: 'dark', ...st });
  }
  const groupMeanLevel = meanOf(meanLevels.filter(Number.isFinite));
  if (refs.length > 1 && groupMeanLevel > 0) {
    for (const report of frameReports) {
      if (report.role !== 'reference') continue;
      const level = meanOf(report.perChannel.map((c) => c.meanSignalDn));
      if (Math.abs(level - groupMeanLevel) / groupMeanLevel > 0.1) {
        warnings.push(`参考帧 ${report.name} 的平均信号偏离组内均值超过 10%（光源可能不稳定）`);
      }
    }
  }
  for (const report of frameReports) {
    if (report.saturatedFraction > 0.02) {
      warnings.push(`参考帧 ${report.name} 有 ${(report.saturatedFraction * 100).toFixed(2)}% 像素饱和，这些像素不作为有效观测`);
    }
  }

  const gainRaw = new Float32Array(pixelCount * channels);
  const confidence = new Float32Array(pixelCount);
  const flags = new Uint8Array(pixelCount);
  const noiseDn = new Float32Array(pixelCount * channels);
  const normalizationPerChannel = [];
  const channelSummaries = [];

  for (let c = 0; c < channels; c++) {
    const combined = combineFrames(refs, c, darkDn, satThreshold, options);
    const validObservation = new Uint8Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      validObservation[p] = combined.accepted[p] >= options.minValidFrames && combined.signal[p] > 0 ? 1 : 0;
    }
    const bad = findBadPixels(combined.signal, validObservation, combined.frameSigma, options, width, height);
    const valid = new Uint8Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      valid[p] = validObservation[p] && !bad[p] ? 1 : 0;
      if (validObservation[p]) noiseDn[p * channels + c] = combined.frameSigma[p];
      else noiseDn[p * channels + c] = combined.groupNoise;
      // Ensure the dead zone carries the group floor, not a zero.
      if (!(noiseDn[p * channels + c] > 0)) noiseDn[p * channels + c] = combined.groupNoise;
    }

    const sigma = options.gainSmoothingPx > 0 ? Math.max(0.5, options.gainSmoothingPx / 3) : 0;
    const smoothed = maskedGaussianBlur(combined.signal, valid, width, height, sigma, false);
    const support = smoothed.weight;
    const supported = new Uint8Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      supported[p] = support[p] >= 0.35 && smoothed.values[p] > 0 ? 1 : 0;
    }

    const snr = new Float32Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      snr[p] = combined.signal[p] / Math.max(noiseDn[p * channels + c], 1e-9);
    }
    const reliable = new Uint8Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      reliable[p] = valid[p] && support[p] >= 0.6 && snr[p] >= options.lowSignalFactor ? 1 : 0;
    }
    const reliableFraction = meanMask(reliable);
    if (reliableFraction < 0.01) {
      return {
        ok: false,
        errors: [`通道 ${c + 1} 的可靠观测不足 1%，无法确定归一化基准。请提高参考照度，或降低饱和/遮挡比例。`],
        warnings,
      };
    }
    let basisSignal;
    if (options.normalizationMode === 'fixed') {
      basisSignal = options.normalizationDn - darkDn;
    } else {
      basisSignal = collectStatistic(smoothed.values, reliable, options.normalizationMode, options.normalizationPercentile);
    }
    if (!Number.isFinite(basisSignal) || basisSignal <= 1) {
      return { ok: false, errors: [`通道 ${c + 1} 的归一化基准无效（${basisSignal}）`], warnings };
    }

    let gainSum = 0;
    let gainCount = 0;
    let cappedCandidate = 0;
    let lowSignalCount = 0;
    let deadCount = 0;
    let filledCount = 0;
    let badCount = 0;
    let saturatedDead = 0;

    for (let p = 0; p < pixelCount; p++) {
      const signalValue = smoothed.values[p];
      let pixelFlags = 0;
      let rawGain = 1;
      if (combined.saturatedFrames[p] === refs.length) pixelFlags |= FLAGS.SATURATED;
      if (bad[p]) { pixelFlags |= FLAGS.BAD_PIXEL; badCount++; }
      if (supported[p]) {
        rawGain = basisSignal / signalValue;
        if (rawGain > options.maxGain) { cappedCandidate++; }
      } else {
        pixelFlags |= FLAGS.DEAD;
        rawGain = 1;
        deadCount++;
        if (combined.saturatedFrames[p] === refs.length) saturatedDead++;
      }
      if (!valid[p]) {
        pixelFlags |= FLAGS.NO_VALID_VIEW;
        if (supported[p] && (combined.accepted[p] > 0 || combined.saturatedFrames[p] > 0)) {
          pixelFlags |= FLAGS.FILLED;
          filledCount++;
        }
      }
      if (valid[p] && snr[p] < options.lowSignalFactor) {
        pixelFlags |= FLAGS.LOW_SIGNAL;
        lowSignalCount++;
      }
      gainRaw[p * channels + c] = rawGain;
      if (valid[p] && supported[p]) {
        gainSum += rawGain;
        gainCount++;
      }

      let conf = 0;
      if (supported[p]) {
        const countFactor = clamp(combined.accepted[p] / refs.length, 0.15, 1);
        const snrFactor = smoothstep(options.lowSignalFactor * 0.5, options.lowSignalFactor * 2, snr[p]);
        const supportFactor = smoothstep(0.35, 0.7, support[p]);
        const pixelConf = countFactor * snrFactor * supportFactor;
        conf = valid[p] ? pixelConf : pixelConf * 0.45;
      }
      if (c === 0) {
        confidence[p] = conf;
        flags[p] = pixelFlags;
      } else {
        confidence[p] = Math.min(confidence[p], conf);
        flags[p] |= pixelFlags;
      }
    }

    let gainMin = Infinity;
    let gainMax = 0;
    for (let p = 0; p < pixelCount; p++) {
      const g = gainRaw[p * channels + c];
      if (g < gainMin) gainMin = g;
      if (g > gainMax) gainMax = g;
    }
    channelSummaries.push({
      channel: c,
      reliableFraction,
      observedFraction: meanMask(validObservation),
      badPixelFraction: meanMask(bad),
      supportedFraction: meanMask(supported),
      filledFraction: filledCount / pixelCount,
      deadFraction: deadCount / pixelCount,
      saturatedDeadFraction: saturatedDead / pixelCount,
      lowSignalFraction: lowSignalCount / pixelCount,
      cappedCandidateFraction: cappedCandidate / pixelCount,
      meanFrameNoiseDn: meanOf(refs.map((r) => r.noiseSigma[c])),
      meanGainTrusted: gainCount ? gainSum / gainCount : 1,
      gainRawMin: Number.isFinite(gainMin) ? gainMin : 1,
      gainRawMax: gainMax || 1,
      normalizationDn: basisSignal,
    });
    normalizationPerChannel.push({
      channel: c,
      basisSignalDn: basisSignal,
      basisLevelDn: basisSignal + darkDn,
      reliableFraction,
    });
  }

  let trustedCount = 0;
  let confSum = 0;
  for (let p = 0; p < pixelCount; p++) {
    confSum += confidence[p];
    const excluded = flags[p] & (FLAGS.NO_VALID_VIEW | FLAGS.BAD_PIXEL | FLAGS.DEAD | FLAGS.SATURATED);
    if (!excluded && confidence[p] >= options.confidenceThreshold) trustedCount++;
  }

  const record = {
    schemaVersion: 3,
    id: context && context.id ? context.id : null,
    createdAt: new Date().toISOString(),
    width, height, bitDepth, channels,
    fullScale,
    inputFormat: { channels, bitDepth, signalChannels: channels },
    darkLevelDn: darkDn,
    darkSource,
    saturationThresholdDn: satThreshold,
    normalization: {
      mode: options.normalizationMode,
      percentile: options.normalizationPercentile,
      fixedDn: options.normalizationMode === 'fixed' ? options.normalizationDn : null,
      perChannel: normalizationPerChannel,
    },
    gainPolicy: {
      maxGain: options.maxGain,
      minGain: options.minGain,
      confidenceThreshold: options.confidenceThreshold,
      note: '估计阶段保存未限幅增益；应用阶段按本次导出配置限幅并记录',
    },
    refinement: {
      gainSmoothingPx: options.gainSmoothingPx,
      outlierSigma: options.outlierSigma,
      badPixelSigma: options.badPixelSigma,
      lowSignalFactor: options.lowSignalFactor,
      minValidFrames: options.minValidFrames,
    },
    options: Object.assign({}, options),
    settings: refCheck.reference,
    settingsSchema: SETTINGS_SCHEMA,
    referenceNames: refs.map((r) => r.name),
    darkFrameNames: darks.map((d) => d.name),
    referenceCount: refs.length,
    frameReports,
    channelStatistics: channelSummaries,
    warnings,
    summary: {
      trustedFraction: trustedCount / pixelCount,
      meanConfidence: confSum / pixelCount,
      meanSignalDn: groupMeanLevel,
      gainRawMin: Math.min(...channelSummaries.map((s) => s.gainRawMin)),
      gainRawMax: Math.max(...channelSummaries.map((s) => s.gainRawMax)),
      estimatedAt: new Date().toISOString(),
    },
    flagDefinitions: FLAGS,
    applyFlagDefinitions: APPLY_FLAGS,
  };

  return {
    ok: true,
    errors: [],
    warnings,
    record,
    width, height, channels,
    gain: { width, height, channels, data: gainRaw },
    confidence,
    flags,
    noiseDn,
    flagLabels: FLAG_LABELS,
    applyFlagLabels: APPLY_FLAG_LABELS,
  };
}

function meanMask(mask) {
  let sum = 0;
  for (let i = 0; i < mask.length; i++) sum += mask[i] ? 1 : 0;
  return mask.length ? sum / mask.length : 0;
}

function meanOf(values) {
  let sum = 0;
  let n = 0;
  for (const v of values) if (Number.isFinite(v)) { sum += v; n++; }
  return n ? sum / n : NaN;
}

module.exports = {
  calibrate,
  compareSettings,
  settingsFromSchema,
  signalChannelsOf,
  bitDepthFullScale,
  formatSetting,
  FLAGS,
  FLAG_LABELS,
  APPLY_FLAGS,
  APPLY_FLAG_LABELS,
};
