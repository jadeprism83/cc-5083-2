'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { validateOptions, describe } = require('../src/core/options');
const { encodePng, decodePng } = require('../src/core/png');
const { buildScenario } = require('../src/core/synthetic');
const { calibrate, compareSettings } = require('../src/core/calibration');
const { applyFlat, RefusalError, regionStats } = require('../src/core/apply');
const { writeCalibration, loadCalibration } = require('../src/core/store');
const { buildValidation } = require('../src/core/validation');

const SETTINGS = {
  device: 'test-camera',
  lens: 'test-lens',
  aperture: 'f/8',
  focalLengthMm: 50,
  zoom: 1,
  binning: 1,
  iso: 100,
  exposureMs: 10,
};

function makeGroup(scenario, settings = SETTINGS) {
  return scenario.references.map((image, i) => ({ name: `ref_${i}.png`, image, settings }));
}

function calibrateScenario(scenario, overrides = {}, settings = SETTINGS) {
  const options = validateOptions(overrides).options;
  const result = calibrate({ references: makeGroup(scenario, settings) }, options);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result;
}

function regionMean(image, rect) {
  return regionStats(image, rect).meanDn;
}

test('PNG round-trips 8-bit and 16-bit grey data without rescaling', () => {
  for (const bitDepth of [8, 16]) {
    const full = bitDepth === 8 ? 255 : 65535;
    const image = {
      width: 7, height: 5, bitDepth, channels: 1,
      data: Uint16Array.from({ length: 35 }, (_, i) => (i * 997) % (full + 1)),
    };
    const decoded = decodePng(encodePng(image));
    assert.equal(decoded.width, 7);
    assert.equal(decoded.height, 5);
    assert.equal(decoded.bitDepth, bitDepth);
    assert.deepEqual(Array.from(decoded.data), Array.from(image.data));
  }
});

test('PNG decoder rejects corrupted CRC', () => {
  const image = { width: 4, height: 4, bitDepth: 8, channels: 1, data: new Uint16Array(16).fill(9) };
  const buffer = Buffer.from(encodePng(image));
  // Flip a byte inside the IDAT payload, leaving the stored CRC stale.
  buffer[buffer.length - 20] ^= 0xff;
  assert.throws(() => decodePng(buffer), /CRC/);
});

test('option validation rejects out-of-range values', () => {
  assert.equal(validateOptions({ maxGain: 0.5 }).ok, false);
  assert.equal(validateOptions({ saturationFraction: 2 }).ok, false);
  assert.equal(validateOptions({ normalizationMode: 'nonsense' }).ok, false);
  assert.equal(validateOptions({ maxGain: 6 }).ok, true);
  assert.ok(describe().fields.some((f) => f.key === 'maxGain'));
});

test('calibration refuses a single reference frame', () => {
  const scenario = buildScenario();
  const options = validateOptions({ minValidFrames: 2 }).options;
  const result = calibrate({ references: makeGroup(scenario).slice(0, 1) }, options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /少于/);
});

test('calibration refuses inconsistent reference sizes', () => {
  const scenario = buildScenario();
  const refs = makeGroup(scenario).slice(0, 3);
  refs[2] = {
    name: 'odd.png',
    image: { width: 256, height: 192, bitDepth: 16, channels: 1, data: new Uint16Array(256 * 192) },
    settings: SETTINGS,
  };
  const result = calibrate({ references: refs }, validateOptions({}).options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /尺寸不一致/);
});

test('calibration refuses mismatched mandatory acquisition settings inside a group', () => {
  const scenario = buildScenario();
  const refs = makeGroup(scenario);
  refs[1] = { ...refs[1], settings: { ...SETTINGS, zoom: 2 } };
  const result = calibrate({ references: refs }, validateOptions({}).options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /采集设置不一致/);
});

test('calibration requires the mandatory acquisition fields', () => {
  const scenario = buildScenario();
  const refs = makeGroup(scenario).map((r) => ({ ...r, settings: { device: 'x' } }));
  const result = calibrate({ references: refs }, validateOptions({}).options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /缺少必填采集设置/);
});

test('dark level is subtracted and recorded', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario, { darkMode: 'manual', darkDn: 700 });
  assert.equal(result.record.darkLevelDn, 700);
  assert.equal(result.record.darkSource.mode, 'manual');
  assert.equal(result.record.gainPolicy.maxGain, 8);
});

test('calibration produces a flat reference and bounded gains', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario);
  assert.ok(result.record.summary.trustedFraction > 0.9);
  assert.ok(result.record.summary.gainRawMin > 0);
  // Raw gains are unclamped and flagged; saturation still leaves a bounded
  // estimate because the normalisation basis is a high percentile.
  assert.ok(result.record.summary.gainRawMax < 8);
  const threshold = result.record.options.confidenceThreshold;
  let trusted = 0;
  for (let p = 0; p < result.confidence.length; p++) {
    if (result.confidence[p] >= threshold && !(result.flags[p] & (1 | 4 | 128))) trusted++;
  }
  assert.ok(trusted / result.confidence.length > 0.9);
});

test('saturated regions are excluded from the estimate', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario);
  const patch = scenario.saturatedPatch;
  const p = Math.floor(patch.y + patch.h / 2) * scenario.geometry.width + Math.floor(patch.x + patch.w / 2);
  assert.ok(result.flags[p] & 2, 'centre of the saturated patch is flagged saturated');
});

test('gain field is applied with bounded amplification and preserves texture', () => {
  const scenario = buildScenario();
  const calibration = calibrateScenario(scenario);
  const application = applyFlat(calibration.record, calibration, scenario.target, { targetSettings: SETTINGS });
  assert.ok(application.maxAppliedGain <= 8 + 1e-6);
  assert.ok(application.counts.gainCapped >= 0);

  const rect = { x: 420, y: 300, w: 60, h: 60 };
  const before = regionStats(scenario.target, rect);
  const after = regionStats(application.output, rect);
  assert.ok(after.meanDn > before.meanDn * 1.3, 'corner is brightened');

  // Total CV in this tile falls because the correction removes the *smooth*
  // vignette ramp across it, which is the intended effect. Texture must be
  // judged on the high-pass residual: it has to be scaled up by the gain, not
  // smoothed away.
  let gainSum = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) gainSum += application.appliedGain[y * scenario.geometry.width + x];
  }
  const meanGain = gainSum / (rect.w * rect.h);
  assert.ok(meanGain > 1.5, `region gain ${meanGain}`);
  assert.ok(
    after.highPassNoiseDn > before.highPassNoiseDn * meanGain * 0.7,
    `texture detail ${before.highPassNoiseDn} -> ${after.highPassNoiseDn} at gain ${meanGain}`,
  );
  assert.ok(after.highPassNoiseDn > before.highPassNoiseDn, 'detail is not flattened');
});

test('application refuses a dimension mismatch', () => {
  const scenario = buildScenario();
  const calibration = calibrateScenario(scenario);
  const small = {
    width: 128, height: 96, bitDepth: 16, channels: 1, data: new Uint16Array(128 * 96).fill(1000),
  };
  assert.throws(
    () => applyFlat(calibration.record, calibration, small, { targetSettings: SETTINGS }),
    (err) => err instanceof RefusalError && /尺寸不匹配/.test(err.details.join(' ')),
  );
});

test('application refuses a mandatory acquisition setting mismatch', () => {
  const scenario = buildScenario();
  const calibration = calibrateScenario(scenario);
  assert.throws(
    () => applyFlat(calibration.record, calibration, scenario.target, { targetSettings: { ...SETTINGS, zoom: 2 } }),
    (err) => err instanceof RefusalError && /变焦位置/.test(err.details.join(' ')),
  );
  // Radiometric fields are only enforced when requested.
  assert.doesNotThrow(() => applyFlat(calibration.record, calibration, scenario.target, { targetSettings: { ...SETTINGS, iso: 400 } }), 'ISO is advisory by default');
});

test('ISO mismatch is enforced when requireRadiometryMatch is on', () => {
  const scenario = buildScenario();
  const calibration = calibrateScenario(scenario, { requireRadiometryMatch: true });
  assert.throws(
    () => applyFlat(calibration.record, calibration, scenario.target, { targetSettings: { ...SETTINGS, iso: 400 } }),
    (err) => err instanceof RefusalError && /ISO/.test(err.details.join(' ')),
  );
});

test('a target below the dark level is copied through, not amplified', () => {
  const scenario = buildScenario();
  const calibration = calibrateScenario(scenario);
  const flat = {
    width: scenario.geometry.width, height: scenario.geometry.height, bitDepth: 16, channels: 1,
    data: new Uint16Array(scenario.geometry.width * scenario.geometry.height).fill(700),
  };
  const application = applyFlat(calibration.record, calibration, flat, { targetSettings: SETTINGS });
  assert.equal(application.counts.underDark, flat.width * flat.height);
  for (let i = 0; i < application.output.data.length; i++) assert.equal(application.output.data[i], 700);
});

test('calibration store round-trips binary fields', () => {
  const scenario = buildScenario();
  const calibration = calibrateScenario(scenario);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-cal-'));
  try {
    writeCalibration(dir, calibration, { label: 'test' });
    const loaded = loadCalibration(dir);
    assert.equal(loaded.record.width, scenario.geometry.width);
    assert.equal(loaded.gain.data.length, calibration.gain.data.length);
    assert.equal(loaded.confidence.length, calibration.confidence.length);
    assert.equal(loaded.gain.data[100], calibration.gain.data[100]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('8-bit estimation keeps the same gain shape as 16-bit', () => {
  const rich = buildScenario({ bitDepth: 16 });
  const plain = buildScenario({ bitDepth: 8, noise: 1.4, lightLevel: 150, darkLevel: 4 });
  const a = calibrateScenario(rich);
  // Dark level is expressed in the image's own DN, so an 8-bit frame needs a
  // correspondingly small value rather than the 16-bit default.
  const b = calibrateScenario(plain, { darkDn: 4 });
  const xs = [0.2, 0.5, 0.8];
  for (const fx of xs) {
    for (const fy of xs) {
      const p = Math.floor(fy * rich.geometry.height) * rich.geometry.width + Math.floor(fx * rich.geometry.width);
      const ratio = b.gain.data[p] / a.gain.data[p];
      assert.ok(ratio > 0.9 && ratio < 1.1, `gain ratio at ${fx},${fy} was ${ratio}`);
    }
  }
});

test('synthetic validation reports restoration and noise', () => {
  const result = buildValidation(validateOptions({}).options);
  assert.equal(result.ok, true);
  assert.ok(result.uniformity.uniformityCvAfter < result.uniformity.uniformityCvBefore);
  assert.ok(result.checks.gainMapAccurate);
  assert.ok(result.checks.noiseAmplificationBounded);
  const corner = result.regions.find((r) => r.label.includes('角落'));
  assert.ok(corner.afterMeanDn > corner.beforeMeanDn * 1.3);
  assert.ok(corner.noiseGainRatio > 1);
  assert.ok(result.profiles.length >= 1);
  assert.ok(result.profiles[0].points.length > 20);
});

test('lower max gain clips amplification and is recorded in the report', () => {
  const scenario = buildScenario();
  const calibration = calibrateScenario(scenario, { maxGain: 2 });
  const application = applyFlat(calibration.record, calibration, scenario.target, {
    targetSettings: SETTINGS, confidenceThreshold: 0.5,
  });
  assert.ok(application.maxAppliedGain <= 2.000001);
  assert.ok(application.counts.gainCapped > 0);
  assert.ok(application.counts.gainCapped < scenario.geometry.width * scenario.geometry.height);
});

test('apply-time gain limits override the recorded policy without re-estimating', () => {
  const scenario = buildScenario();
  const calibration = calibrateScenario(scenario);
  const strict = applyFlat(calibration.record, calibration, scenario.target, {
    targetSettings: SETTINGS, maxGain: 1.5, minGain: 0.6,
  });
  assert.ok(strict.maxAppliedGain <= 1.500001);
  assert.ok(strict.counts.gainCapped > 0);
  // Gains below the floor are raised to it, so the applied gain never drops
  // under the requested minimum.
  for (let p = 0; p < strict.appliedGain.length; p++) {
    assert.ok(strict.appliedGain[p] >= 0.6 - 1e-6);
  }
  const unchanged = applyFlat(calibration.record, calibration, scenario.target, {
    targetSettings: SETTINGS, maxGain: 8,
  });
  assert.ok(unchanged.maxAppliedGain > 1.5, 'the recorded cap still allows larger gains');
  assert.equal(unchanged.counts.gainCapped, 0);
});

test('artifact-free estimate: the corrected reference is more uniform', () => {
  const scenario = buildScenario();
  const calibration = calibrateScenario(scenario);
  const uniform = scenario.trueReference;
  const rect = { x: 0, y: 0, w: uniform.width, h: uniform.height };
  const before = regionStats(uniform, rect);
  const application = applyFlat(calibration.record, calibration, uniform, { targetSettings: SETTINGS });
  const after = regionStats(application.output, rect);
  assert.ok(after.stdDn < before.stdDn * 0.35, `std ${before.stdDn} -> ${after.stdDn}`);
});
