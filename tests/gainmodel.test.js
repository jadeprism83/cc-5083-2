'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { validateOptions } = require('../src/core/options');
const { buildScenario } = require('../src/core/synthetic');
const { calibrate, FLAGS } = require('../src/core/calibration');
const { writeCalibration, loadCalibration, listCalibrations } = require('../src/core/store');
const { fitGainModel, expandModelData } = require('../src/core/gainmodel');
const { buildValidation } = require('../src/core/validation');
const { commitSelection } = require('../tools/compare-gain-models');

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

function makeGroup(scenario) {
  return scenario.references.map((image, i) => ({ name: `ref_${i}.png`, image, settings: SETTINGS }));
}

function calibrateScenario(scenario, overrides = {}) {
  const options = validateOptions(overrides).options;
  const result = calibrate({ references: makeGroup(scenario) }, options);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result;
}

test('gain-model options are validated', () => {
  assert.equal(validateOptions({ gainModel: 'nonsense' }).ok, false);
  assert.equal(validateOptions({ gainModel: 'grid', gridCellPx: 4 }).ok, false);
  assert.equal(validateOptions({ gainModel: 'grid', gridCellPx: 1024 }).ok, false);
  assert.equal(validateOptions({ gainModel: 'basis', basisDegree: 0 }).ok, false);
  assert.equal(validateOptions({ gainModel: 'basis', basisDegree: 7 }).ok, false);
  assert.equal(validateOptions({ gainModel: 'basis', basisDegree: 2.5 }).ok, false);
  assert.equal(validateOptions({ basisResidualSigma: 1 }).ok, false);
  assert.equal(validateOptions({ basisResidualSigma: 25 }).ok, false);
  assert.equal(validateOptions({ gainModel: 'grid', gridCellPx: 8 }).ok, true);
  assert.equal(validateOptions({ gainModel: 'basis', basisDegree: 4, basisResidualSigma: 4 }).ok, true);
  assert.equal(validateOptions({ gainModel: 'field' }).ok, true);
});

test('grid model passes the accuracy gates on held-out data, texture and low light', () => {
  const options = validateOptions({ gainModel: 'grid', gridCellPx: 8 }).options;
  const report = buildValidation(options);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const gainErr = report.gainAccuracy.meanAbsRelativeError;
  assert.ok(gainErr < 0.02, `grid@8 mean gain error ${(gainErr * 100).toFixed(2)}% exceeds 2%`);
  // Flatness must improve on a reference frame the estimator never saw.
  assert.ok(report.heldOut.cvAfter < report.heldOut.cvBefore * 0.5,
    `held-out flatness ${report.heldOut.cvBefore} -> ${report.heldOut.cvAfter}`);
  // Real texture must survive compensation.
  assert.ok(report.texture.ratio >= 0.8 && report.texture.ratio <= 1.25,
    `texture preservation ratio ${report.texture.ratio}`);
  // Low-brightness gain must stay stable where the truth gain is >= 2.
  assert.ok(report.lowLight.meanRelativeError < 0.15,
    `low-light mean error ${(report.lowLight.meanRelativeError * 100).toFixed(1)}%`);
  assert.ok(report.lowLight.cappedFraction < 0.02,
    `low-light capped fraction ${report.lowLight.cappedFraction}`);
});

test('grid model hop-fills the saturated patch and keeps confidence positive', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario, { gainModel: 'grid', gridCellPx: 8 });
  const stats = result.record.gainModel.channels[0];
  assert.equal(stats.deadNodes, 0, 'saturated patch must be filled, not dead');
  assert.ok(stats.filledNodes > 0, 'saturated patch should produce hop-filled nodes');

  let degraded = 0;
  let invalidControl = 0;
  for (let p = 0; p < result.flags.length; p++) {
    if (result.flags[p] & FLAGS.GRID_DEGRADED) {
      degraded++;
      assert.ok(result.confidence[p] > 0, `degraded pixel ${p} lost all confidence`);
    }
    // The invalidControl invariant: a non-dead pixel with gain != 1 must
    // carry non-zero confidence (regression: saturated patch edge had
    // confidence exactly 0 while the model supplied gain ~1.65).
    if (!(result.flags[p] & FLAGS.DEAD) && Math.abs(result.gain.data[p] - 1) > 1e-9) {
      if (result.confidence[p] <= 0) invalidControl++;
    }
  }
  assert.ok(degraded > 0, 'saturated patch should mark GRID_DEGRADED pixels');
  assert.equal(invalidControl, 0);
});

test('grid model declares dead nodes beyond MAX_HOPS and degrades near ones', () => {
  const width = 100;
  const height = 20;
  const n = width * height;
  const obsGain = new Float32Array(n).fill(2);
  const weight = new Float32Array(n).fill(1);
  const mask = new Uint8Array(n);
  const supported = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (x >= 70) { mask[p] = 1; supported[p] = 1; }
    }
  }
  const model = fitGainModel('grid', { obsGain, weight, mask, supported, basisSignal: 1 }, width, height, { gridCellPx: 5 });
  assert.ok(model.stats.deadNodes > 0, 'isolated region beyond hop limit must be dead');
  assert.ok(model.stats.filledNodes > 0, 'nodes near the valid region must be hop-filled');

  let degradedPixels = 0;
  let deadPixels = 0;
  for (let p = 0; p < n; p++) {
    if (model.modelFlags[p] & 2) deadPixels++;
    else if (model.modelFlags[p] & 1) {
      degradedPixels++;
      assert.ok(model.modelConfidence[p] > 0 && model.modelConfidence[p] < 1,
        `degraded pixel confidence ${model.modelConfidence[p]} must be a strict fill fraction`);
    }
  }
  assert.ok(deadPixels > 0, 'far-left pixels must be dead');
  assert.ok(degradedPixels > 0, 'hop-filled neighbourhoods must be marked degraded');
  for (let y = 0; y < height; y++) {
    // Far-left pixels are surrounded only by dead nodes: unit gain, no confidence.
    assert.equal(model.gain[y * width + 0], 1);
    assert.equal(model.modelConfidence[y * width + 0], 0);
    assert.ok(model.modelFlags[y * width + 0] & 2, 'far-left pixel flag');
    const direct = model.gain[y * width + 99];
    assert.ok(Math.abs(direct - 2) < 0.05, `direct region gain ${direct} should be 2`);
  }
});

test('basis model flags inexpressible occlusions as MODEL_UNFIT instead of forcing correction', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario, { gainModel: 'basis', basisDegree: 4 });
  const stats = result.record.gainModel.channels[0];
  assert.ok(stats.unfitFraction > 0, 'dust/flap occlusions should be marked unfit');
  assert.ok(stats.unfitFraction < 0.3, `unfit fraction ${stats.unfitFraction} should stay local`);
  let checked = 0;
  for (let p = 0; p < result.flags.length; p++) {
    if (!(result.flags[p] & FLAGS.MODEL_UNFIT)) continue;
    checked++;
    assert.ok(result.confidence[p] <= 0.25 + 1e-6, `unfit pixel confidence ${result.confidence[p]} must be cut`);
    assert.ok(result.confidence[p] > 0, 'unfit pixels keep a tapered, non-zero confidence');
  }
  assert.ok(checked > 0);
});

test('basis gain stays positive and finite everywhere', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario, { gainModel: 'basis', basisDegree: 3 });
  for (let p = 0; p < result.gain.data.length; p++) {
    const g = result.gain.data[p];
    assert.ok(Number.isFinite(g) && g > 0, `basis gain must be positive, got ${g} at ${p}`);
  }
});

test('compact grid model round-trips through the store and re-expands to the dense field', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario, { gainModel: 'grid', gridCellPx: 8 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-grid-'));
  try {
    writeCalibration(dir, result, { label: 't', id: 't' });
    assert.ok(fs.existsSync(path.join(dir, 'model.json')));
    assert.ok(fs.existsSync(path.join(dir, 'model.bin')));
    const modelBytes = fs.statSync(path.join(dir, 'model.bin')).size + fs.statSync(path.join(dir, 'model.json')).size;
    const denseBytes = fs.statSync(path.join(dir, 'gain.bin')).size;
    assert.ok(modelBytes < denseBytes * 0.05, `model ${modelBytes}B should be far below dense ${denseBytes}B`);

    const loaded = loadCalibration(dir);
    assert.equal(loaded.gainModelData.kind, 'grid');
    const dense = expandModelData(loaded.gainModelData.channels[0], loaded.width, loaded.height);
    let maxRel = 0;
    for (let p = 0; p < dense.length; p++) {
      const rel = Math.abs(dense[p] - loaded.gain.data[p]) / Math.max(1e-9, Math.abs(loaded.gain.data[p]));
      if (rel > maxRel) maxRel = rel;
    }
    assert.ok(maxRel < 1e-4, `re-expanded model deviates ${maxRel} from saved gain`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compact basis model round-trips through the store', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario, { gainModel: 'basis', basisDegree: 4 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-basis-'));
  try {
    writeCalibration(dir, result, { label: 't', id: 't' });
    const loaded = loadCalibration(dir);
    assert.equal(loaded.gainModelData.kind, 'basis');
    const dense = expandModelData(loaded.gainModelData.channels[0], loaded.width, loaded.height);
    let maxRel = 0;
    for (let p = 0; p < dense.length; p++) {
      const rel = Math.abs(dense[p] - loaded.gain.data[p]) / Math.max(1e-9, Math.abs(loaded.gain.data[p]));
      if (rel > maxRel) maxRel = rel;
    }
    assert.ok(maxRel < 1e-4, `re-expanded basis model deviates ${maxRel}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schemaVersion 3 calibration directories stay loadable as the field model', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario, { gainModel: 'grid', gridCellPx: 8 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-v3-'));
  try {
    writeCalibration(dir, result, { label: 't', id: 't' });
    // Downgrade to a v3 directory: no model files, schemaVersion 3 record.
    fs.rmSync(path.join(dir, 'model.json'));
    fs.rmSync(path.join(dir, 'model.bin'));
    const recordPath = path.join(dir, 'record.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    delete record.gainModel;
    record.schemaVersion = 3;
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

    const loaded = loadCalibration(dir);
    assert.equal(loaded.gainModelData, null);
    assert.equal(loaded.record.schemaVersion, 3);
    const listed = listCalibrations(path.dirname(dir));
    const entry = listed.find((e) => e.id === path.basename(dir));
    assert.equal(entry.gainModel, 'field');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('field model writes no compact model files', () => {
  const scenario = buildScenario();
  const result = calibrateScenario(scenario, { gainModel: 'field' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-field-'));
  try {
    writeCalibration(dir, result, { label: 't', id: 't' });
    assert.equal(fs.existsSync(path.join(dir, 'model.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'model.bin')), false);
    const loaded = loadCalibration(dir);
    assert.equal(loaded.gainModelData, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmed selection is never overwritten by a failing evaluation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-'));
  const file = path.join(dir, 'gain-model.selection.json');
  const confirmed = JSON.stringify({ selected: 'grid@8px', confirmed: true }, null, 2);
  fs.writeFileSync(file, confirmed);
  try {
    const failed = commitSelection(file, { selected: 'basis@4' }, { pass: false });
    assert.equal(failed.written, false);
    assert.equal(fs.readFileSync(file, 'utf8'), confirmed, 'failing run must not touch the confirmed file');

    const passed = commitSelection(file, { selected: 'grid@12px' }, { pass: true });
    assert.equal(passed.written, true);
    assert.deepEqual(passed.previous, 'grid@8px');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).selected, 'grid@12px');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
