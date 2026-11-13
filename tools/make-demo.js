#!/usr/bin/env node
'use strict';

// Generate the demo data set used by the UI and the tests: synthetic
// references with known vignetting, dust and a rectangular occluder, the
// target scene, the acquisition settings, and a small geometry/settings
// mismatch example that must be refused.

const fs = require('fs');
const path = require('path');
const { buildScenario } = require('../src/core/synthetic');
const { encodePng } = require('../src/core/png');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'demo'));
fs.mkdirSync(outDir, { recursive: true });

const scenario = buildScenario();
const settings = {
  device: '合成相机 A',
  lens: '合成镜头 50mm',
  aperture: 'f/8',
  focalLengthMm: 50,
  zoom: 1,
  binning: 1,
  focusDn: 320,
  iso: 100,
  exposureMs: 10,
};

const refsDir = path.join(outDir, 'references');
const targetsDir = path.join(outDir, 'targets');
fs.mkdirSync(refsDir, { recursive: true });
fs.mkdirSync(targetsDir, { recursive: true });
scenario.references.forEach((image, i) => {
  fs.writeFileSync(path.join(refsDir, `ref_${i + 1}.png`), encodePng(image));
});
fs.writeFileSync(path.join(refsDir, 'settings.json'), JSON.stringify(settings, null, 2));
fs.writeFileSync(path.join(targetsDir, 'target_01.png'), encodePng(scenario.target));

// A second target for batch export, same setup, different texture phase.
const scenarioB = buildScenario({ targetSeed: 41, referenceSeed: 11 });
fs.writeFileSync(path.join(targetsDir, 'target_02.png'), encodePng(scenarioB.target));

// Mismatched acquisition settings, written for the refusal path.
fs.writeFileSync(path.join(targetsDir, 'settings_zoom_mismatch.json'), JSON.stringify({ ...settings, zoom: 2 }, null, 2));
fs.writeFileSync(path.join(targetsDir, 'settings_iso_mismatch.json'), JSON.stringify({ ...settings, iso: 400 }, null, 2));

// A wrong-size target (quarter resolution) for the geometric refusal path.
const small = {
  width: scenario.geometry.width / 2,
  height: scenario.geometry.height / 2,
  bitDepth: 16,
  channels: 1,
  data: new Uint16Array((scenario.geometry.width / 2) * (scenario.geometry.height / 2)),
};
for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
    small.data[y * small.width + x] = scenario.target.data[(y * 2) * scenario.geometry.width + x * 2];
  }
}
fs.writeFileSync(path.join(targetsDir, 'target_wrong_size.png'), encodePng(small));
fs.writeFileSync(path.join(targetsDir, 'settings.json'), JSON.stringify(settings, null, 2));

console.log(JSON.stringify({ ok: true, outDir, files: fs.readdirSync(refsDir).length + fs.readdirSync(targetsDir).length }, null, 2));
