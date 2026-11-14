'use strict';

// Validation harness for the flat-field chain using synthetic ground truth.
//
// Two independent checks are reported:
//   1. Spatial gain accuracy. The estimated gain is multiplied by the known
//      response; a correct estimate leaves only one global scale factor.
//      Errors are measured after removing that factor, so a deliberate choice
//      of normalization basis cannot masquerade as accuracy.
//   2. Brightness and noise on identical regions. Region means before/after
//      are compared with the expected level and with each other; noise is
//      measured from the high-pass residual in both images.

const { buildScenario } = require('./synthetic');
const { calibrate } = require('./calibration');
const { applyFlat, regionStats, numericProfile, regionTrust } = require('./apply');
const { encodePng } = require('./png');

const DEFAULT_REGIONS = [
  { label: '画面中心', x: 220, y: 150, w: 64, h: 64 },
  { label: '右下角落', x: 440, y: 316, w: 56, h: 48 },
  { label: '尘点遮挡', x: 136, y: 96, w: 44, h: 44 },
  { label: '遮光板（强衰减）', x: 380, y: 248, w: 60, h: 56 },
  { label: '低照度暗区', x: 84, y: 276, w: 36, h: 32 },
];

function regionMeanTruth(scenario, rect) {
  const w = scenario.geometry.width;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(rect.y); y < Math.floor(rect.y + rect.h); y++) {
    for (let x = Math.floor(rect.x); x < Math.floor(rect.x + rect.w); x++) {
      sum += scenario.targetScene[y * w + x];
      n++;
    }
  }
  return n ? sum / n : NaN;
}

// Global factor left by a correct gain estimate: response × estimated gain.
function globalScale(scenario, application, calibration) {
  const w = scenario.geometry.width;
  let sum = 0;
  let n = 0;
  for (let p = 0; p < w * scenario.geometry.height; p++) {
    if (!application.trusted[p]) continue;
    let g = 0;
    for (let c = 0; c < calibration.gain.channels; c++) g += calibration.gain.data[p * calibration.gain.channels + c];
    g /= calibration.gain.channels;
    const x = p % w;
    const y = Math.floor(p / w);
    sum += g * scenario.responseAt(x, y).gain;
    n++;
  }
  return n ? sum / n : 1;
}

function gainMapError(scenario, application, calibration, scale) {
  const w = scenario.geometry.width;
  const h = scenario.geometry.height;
  let absErr = 0;
  let maxErr = 0;
  let n = 0;
  let worstPixel = null;
  for (let p = 0; p < w * h; p++) {
    if (!application.trusted[p]) continue;
    const x = p % w;
    const y = Math.floor(p / w);
    let g = 0;
    for (let c = 0; c < calibration.gain.channels; c++) g += calibration.gain.data[p * calibration.gain.channels + c];
    g /= calibration.gain.channels;
    const expected = 1 / scenario.responseAt(x, y).gain;
    const normalized = g / scale;
    const err = Math.abs(normalized / expected - 1);
    absErr += err;
    if (err > maxErr) { maxErr = err; worstPixel = { x, y, gain: g, expected, error: err }; }
    n++;
  }
  return { meanAbsRelativeError: n ? absErr / n : NaN, maxRelativeError: maxErr, worstPixel, samples: n };
}

// Uniformity of a corrected uniform reference. A perfect gain field makes the
// reference flat; the residual coefficient of variation is the flatness error.
function flatness(scenario, application, calibration, scale) {
  const w = scenario.geometry.width;
  const h = scenario.geometry.height;
  let beforeSum = 0;
  let beforeSq = 0;
  let afterSum = 0;
  let afterSq = 0;
  let n = 0;
  for (let p = 0; p < w * h; p++) {
    if (!application.trusted[p]) continue;
    const x = p % w;
    const y = Math.floor(p / w);
    const uniform = scenario.lightLevel * scenario.responseAt(x, y).gain;
    let g = 0;
    for (let c = 0; c < calibration.gain.channels; c++) g += calibration.gain.data[p * calibration.gain.channels + c];
    g /= calibration.gain.channels;
    beforeSum += uniform;
    beforeSq += uniform * uniform;
    const after = uniform * g / scale;
    afterSum += after;
    afterSq += after * after;
    n++;
  }
  const beforeMean = beforeSum / n;
  const afterMean = afterSum / n;
  const beforeCv = Math.sqrt(Math.max(0, beforeSq / n - beforeMean ** 2)) / beforeMean;
  const afterCv = Math.sqrt(Math.max(0, afterSq / n - afterMean ** 2)) / afterMean;
  return {
    uniformityCvBefore: beforeCv,
    uniformityCvAfter: afterCv,
    reductionFactor: beforeCv > 0 ? afterCv / beforeCv : NaN,
  };
}

function noiseRatio(regionBefore, regionAfter) {
  if (!Number.isFinite(regionBefore.highPassNoiseDn) || !Number.isFinite(regionAfter.highPassNoiseDn)) {
    return { ratio: NaN, beforeDn: NaN, afterDn: NaN };
  }
  return {
    beforeDn: regionBefore.highPassNoiseDn,
    afterDn: regionAfter.highPassNoiseDn,
    ratio: regionAfter.highPassNoiseDn / regionBefore.highPassNoiseDn,
  };
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

// Flatness of the held-out reference frame (never used in the estimation).
// Before/after are measured against the known uniform truth level, so the
// numbers say how flat an unseen image becomes, not just the training flats.
function heldOutFlatness(scenario, calibration, heldOutImage, settings, scale) {
  const application = applyFlat(calibration.record, calibration, heldOutImage, { targetSettings: settings });
  const w = scenario.geometry.width;
  const h = scenario.geometry.height;
  const expected = scenario.lightLevel * scale;
  let n = 0;
  let beforeSum = 0;
  let beforeSq = 0;
  let afterSum = 0;
  let afterSq = 0;
  let afterDev = 0;
  for (let p = 0; p < w * h; p++) {
    if (!application.trusted[p]) continue;
    const before = heldOutImage.data[p] - scenario.darkLevel;
    const after = application.output.data[p] - scenario.darkLevel;
    beforeSum += before;
    beforeSq += before * before;
    afterSum += after;
    afterSq += after * after;
    afterDev += Math.abs(after - expected) / expected;
    n++;
  }
  const cvOf = (sum, sq, count) => {
    const mean = sum / count;
    return Math.sqrt(Math.max(0, sq / count - mean * mean)) / mean;
  };
  return {
    framesUsedForEstimation: scenario.references.length - 1,
    cvBefore: cvOf(beforeSum, beforeSq, n),
    cvAfter: cvOf(afterSum, afterSq, n),
    meanAbsDeviationFromTruth: n ? afterDev / n : NaN,
    trustedFraction: application.trustedFraction,
    samples: n,
  };
}

// Texture damage check on the resolution-chart region: the high-pass residual
// of a corrected textured image must scale with the applied gain. A ratio
// below 1 means the correction flattened real texture; far above 1 means
// noise is being over-amplified relative to the gain actually applied.
function texturePreservation(scenario, application) {
  const w = scenario.geometry.width;
  const h = scenario.geometry.height;
  const rect = {
    x: Math.round(w * 0.62), y: Math.round(h * 0.2),
    w: Math.round(w * 0.2), h: Math.round(h * 0.25),
  };
  const before = regionStats(scenario.target, rect);
  const after = regionStats(application.output, rect);
  const gainMean = meanAppliedGain(application, rect);
  const ratio = before.highPassNoiseDn > 0 && gainMean > 0
    ? after.highPassNoiseDn / (before.highPassNoiseDn * gainMean)
    : NaN;
  return {
    rect,
    beforeHighPassDn: before.highPassNoiseDn,
    afterHighPassDn: after.highPassNoiseDn,
    meanAppliedGain: gainMean,
    ratio,
  };
}

// Gain stability where the reference is dim (truth gain >= 2): the estimate
// must stay close to the truth and must not run into the gain cap.
function lowLightStability(scenario, calibration, scale) {
  const w = scenario.geometry.width;
  const h = scenario.geometry.height;
  const errors = [];
  let maxRawGain = 0;
  let capped = 0;
  const cap = calibration.record.gainPolicy.maxGain;
  for (let p = 0; p < w * h; p++) {
    const truth = scenario.gainTruth[p];
    if (truth < 2) continue;
    let g = 0;
    for (let c = 0; c < calibration.gain.channels; c++) g += calibration.gain.data[p * calibration.gain.channels + c];
    g /= calibration.gain.channels;
    if (g > maxRawGain) maxRawGain = g;
    if (g > cap) capped++;
    errors.push(Math.abs((g / scale) / truth - 1));
  }
  errors.sort((a, b) => a - b);
  const mean = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : NaN;
  const p99 = errors.length ? errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.99))] : NaN;
  return {
    samples: errors.length,
    meanRelativeError: mean,
    p99RelativeError: p99,
    maxRawGain,
    cappedFraction: errors.length ? capped / errors.length : 0,
    cap,
  };
}

function buildValidation(options, scenarioParams = {}) {
  const t0 = nowMs();
  const scenario = buildScenario(scenarioParams);
  const settings = {
    device: 'synthetic-camera',
    lens: 'synthetic-lens',
    aperture: 'f/8',
    focalLengthMm: 50,
    zoom: 1,
    binning: 1,
    iso: 100,
    exposureMs: 10,
  };
  // The last reference frame is held out of the estimation so flatness can be
  // verified on an image the model has never seen.
  const useHoldout = scenarioParams.holdout !== false && scenario.references.length >= 3;
  const estimationRefs = useHoldout ? scenario.references.slice(0, -1) : scenario.references;
  const heldOutImage = useHoldout ? scenario.references[scenario.references.length - 1] : null;
  const references = estimationRefs.map((image, i) => ({ name: `参考_${i + 1}.png`, image, settings }));
  const tCal0 = nowMs();
  const calibration = calibrate({ references }, options);
  const calibrateMs = nowMs() - tCal0;
  if (!calibration.ok) {
    return { ok: false, stage: 'calibrate', errors: calibration.errors, warnings: calibration.warnings, scenario: summarizeScenario(scenario) };
  }
  const tApply0 = nowMs();
  let application;
  try {
    application = applyFlat(calibration.record, calibration, scenario.target, { targetSettings: settings });
  } catch (err) {
    return { ok: false, stage: 'apply', errors: [err.message, ...(err.details || [])], warnings: calibration.warnings, scenario: summarizeScenario(scenario) };
  }
  const applyMs = nowMs() - tApply0;

  const scale = globalScale(scenario, application, calibration);
  const gainError = gainMapError(scenario, application, calibration, scale);
  const uniformity = flatness(scenario, application, calibration, scale);
  const heldOut = heldOutImage ? heldOutFlatness(scenario, calibration, heldOutImage, settings, scale) : null;
  const texture = texturePreservation(scenario, application);
  const lowLight = lowLightStability(scenario, calibration, scale);
  const regions = DEFAULT_REGIONS.map((rect) => {
    const before = regionStats(scenario.target, rect);
    const after = regionStats(application.output, rect);
    const truth = regionMeanTruth(scenario, rect);
    const trust = regionTrust(calibration, rect);
    const expectedAfter = truth * scale;
    const noise = noiseRatio(before, after);
    const gainMean = meanAppliedGain(application, rect);
    return {
      label: rect.label,
      rect,
      channel: null,
      alreadyUntrusted: trust.trustedFraction < 1,
      trustedFraction: trust.trustedFraction,
      meanConfidence: trust.meanConfidence,
      beforeMeanDn: before.meanDn,
      afterMeanDn: after.meanDn,
      truthMeanDn: truth,
      expectedAfterDn: expectedAfter,
      brightnessResidualPercent: expectedAfter > 0 ? ((after.meanDn - expectedAfter) / expectedAfter) * 100 : NaN,
      beforeNoiseDn: noise.beforeDn,
      afterNoiseDn: noise.afterDn,
      noiseGainRatio: noise.ratio,
      meanAppliedGain: gainMean,
      gainMaxInRegion: maxAppliedGain(application, rect),
      beforeStdDn: before.stdDn,
      afterStdDn: after.stdDn,
    };
  });

  const profiles = [
    makeProfile(scenario.target, application.output, { y: Math.round(scenario.geometry.height * 0.45), x: 0, w: scenario.geometry.width }, '主剖面（穿过渐晕与尘点）', scenario, scale),
    makeProfile(scenario.target, application.output, { y: Math.round(scenario.geometry.height * 0.73), x: 0, w: scenario.geometry.width }, '遮光板剖面', scenario, scale),
  ];

  const maxNoiseRatio = Math.max(...regions.map((r) => (Number.isFinite(r.noiseGainRatio) ? r.noiseGainRatio : 0)));
  const caps = options.maxGain;

  return {
    ok: true,
    scenario: summarizeScenario(scenario),
    calibration: {
      id: calibration.record.id,
      darkLevelDn: calibration.record.darkLevelDn,
      darkSource: calibration.record.darkSource,
      normalization: calibration.record.normalization,
      gainModel: calibration.record.gainModel,
      warnings: calibration.warnings,
      summary: calibration.record.summary,
      channelStatistics: calibration.record.channelStatistics,
    },
    application: {
      counts: application.counts,
      trustedFraction: application.trustedFraction,
      globalScale: scale,
      warnings: application.compatibility.warnings,
    },
    gainAccuracy: gainError,
    uniformity,
    heldOut,
    texture,
    lowLight,
    timing: {
      calibrateMs: Math.round(calibrateMs * 10) / 10,
      applyMs: Math.round(applyMs * 10) / 10,
      totalMs: Math.round((nowMs() - t0) * 10) / 10,
    },
    regions,
    profiles,
    checks: {
      flatnessImproved: uniformity.uniformityCvAfter < uniformity.uniformityCvBefore,
      flatnessReducedByAtLeastHalf: uniformity.reductionFactor < 0.5,
      gainMapAccurate: gainError.meanAbsRelativeError < 0.05,
      noiseAmplificationBounded: maxNoiseRatio <= caps * 1.02,
      heldOutFlatnessImproved: heldOut ? heldOut.cvAfter < heldOut.cvBefore : null,
      texturePreserved: Number.isFinite(texture.ratio) ? texture.ratio >= 0.8 && texture.ratio <= 1.25 : null,
      lowLightStable: Number.isFinite(lowLight.p99RelativeError) ? lowLight.p99RelativeError < 0.25 : null,
      maxNoiseRatio,
      maxAllowedGain: caps,
    },
    images: {
      reference: calibrationImage(scenario.references[0]),
      target: calibrationImage(scenario.target),
      corrected: calibrationImage(application.output),
      trustMask: trustMaskImage(calibration),
    },
  };
}

function meanAppliedGain(application, rect) {
  const w = application.output.width;
  const h = application.output.height;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(rect.y); y < Math.min(h, Math.floor(rect.y + rect.h)); y++) {
    for (let x = Math.floor(rect.x); x < Math.min(w, Math.floor(rect.x + rect.w)); x++) {
      for (let c = 0; c < application.appliedGainChannels; c++) {
        sum += application.appliedGain[(y * w + x) * application.appliedGainChannels + c];
        n++;
      }
    }
  }
  return n ? sum / n : NaN;
}

function maxAppliedGain(application, rect) {
  const w = application.output.width;
  const h = application.output.height;
  let max = 0;
  for (let y = Math.floor(rect.y); y < Math.min(h, Math.floor(rect.y + rect.h)); y++) {
    for (let x = Math.floor(rect.x); x < Math.min(w, Math.floor(rect.x + rect.w)); x++) {
      for (let c = 0; c < application.appliedGainChannels; c++) {
        const v = application.appliedGain[(y * w + x) * application.appliedGainChannels + c];
        if (v > max) max = v;
      }
    }
  }
  return max;
}

function makeProfile(before, after, rect, label, scenario, scale) {
  const pair = numericProfile(before, after, rect, null);
  const w = scenario.geometry.width;
  const y = pair.y;
  let sceneSum = 0;
  for (let x = pair.x0; x < pair.x1; x++) sceneSum += scenario.targetScene[y * w + x];
  const sceneMean = sceneSum / Math.max(1, pair.x1 - pair.x0);
  return {
    label,
    y,
    points: pair.points.map((pt) => {
      const expected = scenario.targetScene[y * w + pt.x] * scale;
      return {
        x: pt.x,
        beforeDn: around(pt.beforeDn),
        afterDn: around(pt.afterDn),
        expectedDn: around(expected),
      };
    }),
    sceneMeanDn: around(sceneMean),
    beforeMeanDn: around(mean(pair.points.map((p) => p.beforeDn))),
    afterMeanDn: around(mean(pair.points.map((p) => p.afterDn))),
    expectedMeanDn: around(mean(pair.points.map((p) => scenario.targetScene[y * w + p.x] * scale))),
  };
}

function mean(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return values.length ? sum / values.length : NaN;
}

function around(v) {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
}

function summarizeScenario(scenario) {
  return {
    width: scenario.geometry.width,
    height: scenario.geometry.height,
    bitDepth: scenario.bitDepth,
    frames: scenario.references.length,
    lightLevelDn: scenario.lightLevel,
    noiseSigmaDn: scenario.noise,
    vignetteStrength: scenario.response.vignette,
    note: '参考图包含已知径向渐晕、尘埃遮挡与矩形遮光板；目标图带自身纹理与硬边',
  };
}

function calibrationImage(image) {
  return { width: image.width, height: image.height, bitDepth: image.bitDepth, channels: image.channels, png: encodePng(image) };
}

function trustMaskImage(calibration) {
  const w = calibration.width;
  const h = calibration.height;
  const out = new ImageDataLike(w, h);
  for (let p = 0; p < w * h; p++) {
    const trusted = calibration.confidence[p] >= (calibration.record.options ? calibration.record.options.confidenceThreshold : 0.5)
      && !(calibration.flags[p] & 128);
    out.data[p] = trusted ? 255 : 24;
  }
  return calibrationImage({ width: w, height: h, bitDepth: 8, channels: 1, data: out.data });
}

class ImageDataLike {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.bitDepth = 8;
    this.channels = 1;
    this.data = new Uint16Array(w * h);
  }
}

function profileCsv(profile) {
  const lines = ['# ' + profile.label, `# row y=${profile.y}`, 'x,before_dn,after_dn,expected_dn'];
  for (const pt of profile.points) {
    lines.push(`${pt.x},${pt.beforeDn},${pt.afterDn},${pt.expectedDn}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { buildValidation, DEFAULT_REGIONS, profileCsv, regionMeanTruth };
