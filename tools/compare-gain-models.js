#!/usr/bin/env node
'use strict';

// Gain-model comparison and parameter search.
//
// Runs every candidate representation (dense field, interpolation grid at
// several cell sizes, constrained basis at several degrees) through the
// synthetic ground-truth validation chain, on a standard scenario and on a
// stress scenario with a large invalid region. Each candidate is scored on:
//   - gain accuracy vs known truth (trusted pixels)
//   - flatness of a HELD-OUT reference frame never used in estimation
//   - texture preservation on the textured target (high-pass residual ratio)
//   - low-brightness gain stability (truth gain >= 2 regions)
//   - model size in bytes and per-image application cost
//
// Acceptance gates decide selectability; the weighted score picks the
// confirmed configuration. The confirmed selection is written to
// config/gain-model.selection.json ONLY when the selected candidate passes
// every gate - a failing run never overwrites the confirmed parameters and
// exits with code 3.

const fs = require('fs');
const path = require('path');
const { validateOptions } = require('../src/core/options');
const { buildValidation } = require('../src/core/validation');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'exports', 'model-comparison');
const SELECTION_FILE = path.join(ROOT, 'config', 'gain-model.selection.json');

const GATES = {
  gainErrMax: 0.05,          // mean |est/truth - 1| over trusted pixels
  heldOutFlatnessMin: 0.5,   // cvAfter must be < 0.5 x cvBefore on the held-out frame
  textureMin: 0.8,           // high-pass residual ratio vs applied gain
  textureMax: 1.25,
  lowLightP50Max: 0.15,      // mean relative error where truth gain >= 2
  lowLightCappedMax: 0.02,   // fraction of low-light pixels hitting the gain cap
  degradedPixelMax: 0.2,     // grid degradation must stay local
};

const SCORE_WEIGHTS = {
  gainErr: 0.30,
  heldOut: 0.25,
  lowLight: 0.20,
  texture: 0.10,
  modelBytes: 0.15,
};

function candidates() {
  const list = [{ id: 'field', kind: 'field', overrides: { gainModel: 'field' } }];
  for (const cell of [8, 12, 16, 24, 32]) {
    list.push({
      id: `grid@${cell}px`,
      kind: 'grid',
      overrides: { gainModel: 'grid', gridCellPx: cell },
    });
  }
  for (const degree of [2, 3, 4, 5]) {
    list.push({
      id: `basis@${degree}`,
      kind: 'basis',
      overrides: { gainModel: 'basis', basisDegree: degree },
    });
  }
  return list;
}

const SCENARIOS = {
  standard: {},
  // A large saturated blob plus stronger vignette exercises the degradation
  // policy for sparse invalid regions.
  stress: {
    vignette: 0.55,
    saturatedPatch: { x: 300, y: 40, w: 120, h: 110 },
  },
};

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function runCandidate(candidate, repeats) {
  const perScenario = {};
  for (const [name, params] of Object.entries(SCENARIOS)) {
    const runs = [];
    for (let i = 0; i < repeats; i++) {
      const options = validateOptions(candidate.overrides).options;
      const v = buildValidation(options, params);
      if (!v.ok) return { id: candidate.id, ok: false, errors: v.errors };
      runs.push(v);
    }
    const v = runs[0];
    perScenario[name] = {
      gainErr: v.gainAccuracy.meanAbsRelativeError,
      cvBefore: v.uniformity.uniformityCvBefore,
      cvAfter: v.uniformity.uniformityCvAfter,
      heldOutCvBefore: v.heldOut.cvBefore,
      heldOutCvAfter: v.heldOut.cvAfter,
      heldOutDeviation: v.heldOut.meanAbsDeviationFromTruth,
      textureRatio: v.texture.ratio,
      lowLightMean: v.lowLight.meanRelativeError,
      lowLightP99: v.lowLight.p99RelativeError,
      lowLightMaxRawGain: v.lowLight.maxRawGain,
      lowLightCappedFraction: v.lowLight.cappedFraction,
      trustedFraction: v.application.trustedFraction,
      modelBytes: v.calibration.gainModel.modelBytes,
      denseBytes: v.calibration.gainModel.denseBytes,
      unfitFraction: v.calibration.gainModel.unfitFraction || 0,
      degradedPixelFraction: v.calibration.gainModel.degradedPixelFraction || 0,
      deadNodes: (v.calibration.gainModel.channels || []).reduce((a, c) => a + (c.deadNodes || 0), 0),
      calibrateMs: median(runs.map((r) => r.timing.calibrateMs)),
      applyMsPerImage: median(runs.map((r) => r.timing.applyMs)),
      checks: v.checks,
    };
  }
  return { id: candidate.id, kind: candidate.kind, overrides: candidate.overrides, ok: true, scenarios: perScenario };
}

function evaluateGates(result) {
  const s = result.scenarios.standard;
  const stress = result.scenarios.stress;
  const gates = {
    gainAccurate: s.gainErr < GATES.gainErrMax,
    heldOutFlatter: s.heldOutCvAfter < GATES.heldOutFlatnessMin * s.heldOutCvBefore,
    texturePreserved: s.textureRatio >= GATES.textureMin && s.textureRatio <= GATES.textureMax,
    lowLightStable: s.lowLightMean < GATES.lowLightP50Max && s.lowLightCappedFraction < GATES.lowLightCappedMax,
    noiseBounded: s.checks.noiseAmplificationBounded,
    stressHeldOutFlatter: stress.heldOutCvAfter < GATES.heldOutFlatnessMin * stress.heldOutCvBefore,
    degradationLocal: stress.degradedPixelFraction < GATES.degradedPixelMax && stress.deadNodes === 0,
  };
  const pass = Object.values(gates).every(Boolean);
  return { gates, pass };
}

function score(result) {
  const s = result.scenarios.standard;
  const parts = {
    gainErr: s.gainErr / GATES.gainErrMax,
    heldOut: s.heldOutCvAfter / s.heldOutCvBefore,
    lowLight: s.lowLightMean / GATES.lowLightP50Max,
    texture: Math.abs(s.textureRatio - 1) / ((GATES.textureMax - GATES.textureMin) / 2),
    modelBytes: Math.log(Math.max(1, s.modelBytes)) / Math.log(s.denseBytes),
  };
  let total = 0;
  for (const [k, w] of Object.entries(SCORE_WEIGHTS)) total += w * parts[k];
  return { parts, total };
}

function commitSelection(selectionPath, selection, evaluation) {
  // The confirmed compensation parameters are only rewritten when every
  // acceptance gate passes. A failing run leaves the file untouched.
  if (!evaluation.pass) return { written: false, reason: '验收门控未全部通过，保留已确认的选择' };
  fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
  const previous = fs.existsSync(selectionPath)
    ? JSON.parse(fs.readFileSync(selectionPath, 'utf8'))
    : null;
  fs.writeFileSync(selectionPath, JSON.stringify(selection, null, 2) + '\n');
  return { written: true, previous: previous ? previous.selected : null };
}

function toCsv(results) {
  const header = [
    'candidate', 'gain_err', 'cv_before', 'cv_after', 'heldout_cv_before', 'heldout_cv_after',
    'texture_ratio', 'lowlight_mean_err', 'lowlight_p99_err', 'lowlight_max_raw_gain',
    'model_bytes', 'dense_bytes', 'apply_ms_per_image', 'calibrate_ms',
    'unfit_fraction', 'degraded_fraction', 'stress_heldout_cv_after', 'stress_degraded_fraction',
    'gates_pass', 'score',
  ].join(',');
  const rows = results.map((r) => {
    const s = r.scenarios.standard;
    const t = r.scenarios.stress;
    return [
      r.id, s.gainErr.toFixed(5), s.cvBefore.toFixed(4), s.cvAfter.toFixed(4),
      s.heldOutCvBefore.toFixed(4), s.heldOutCvAfter.toFixed(4),
      s.textureRatio.toFixed(4), s.lowLightMean.toFixed(4), s.lowLightP99.toFixed(4),
      s.lowLightMaxRawGain.toFixed(3), s.modelBytes, s.denseBytes,
      s.applyMsPerImage.toFixed(2), s.calibrateMs.toFixed(1),
      s.unfitFraction.toFixed(5), s.degradedPixelFraction.toFixed(5),
      t.heldOutCvAfter.toFixed(4), t.degradedPixelFraction.toFixed(5),
      r.evaluation.pass ? 1 : 0, r.score.total.toFixed(4),
    ].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : DEFAULT_OUT;
  const repeats = args.includes('--repeats') ? Number(args[args.indexOf('--repeats') + 1]) : 3;
  const noWrite = args.includes('--no-write');

  const results = [];
  for (const candidate of candidates()) {
    const result = runCandidate(candidate, repeats);
    if (!result.ok) {
      results.push({ id: candidate.id, ok: false, errors: result.errors, evaluation: { pass: false }, score: { total: Infinity } });
      continue;
    }
    result.evaluation = evaluateGates(result);
    result.score = score(result);
    results.push(result);
  }

  const selectable = results.filter((r) => r.ok && r.evaluation.pass);
  selectable.sort((a, b) => a.score.total - b.score.total);
  const winner = selectable[0] || null;

  const selection = winner && {
    confirmedAt: new Date().toISOString(),
    selected: { id: winner.id, kind: winner.kind, overrides: winner.overrides },
    gates: GATES,
    scoreWeights: SCORE_WEIGHTS,
    metrics: {
      standard: winner.scenarios.standard,
      stress: winner.scenarios.stress,
    },
    score: winner.score,
    note: '由 tools/compare-gain-models.js 生成；仅当全部验收门控通过时写入。运行参数搜索不会改动此文件以外的任何已确认参数。',
  };

  let commit = { written: false, reason: '无候选通过验收门控' };
  if (winner && !noWrite) {
    commit = commitSelection(SELECTION_FILE, selection, winner.evaluation);
  } else if (winner && noWrite) {
    commit = { written: false, reason: '--no-write 指定，仅报告' };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    gates: GATES,
    scoreWeights: SCORE_WEIGHTS,
    scenarios: Object.keys(SCENARIOS),
    repeats,
    results,
    selected: winner ? winner.id : null,
    selectionFile: path.relative(ROOT, SELECTION_FILE),
    selectionWritten: commit.written,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.csv'), toCsv(results.filter((r) => r.ok)));

  const table = results.map((r) => {
    if (!r.ok) return `${r.id}\tFAILED`;
    const s = r.scenarios.standard;
    return [
      r.id.padEnd(12),
      `err ${(s.gainErr * 100).toFixed(2)}%`,
      `heldOut ${s.heldOutCvAfter.toFixed(3)}`,
      `low ${(s.lowLightMean * 100).toFixed(1)}%`,
      `tex ${s.textureRatio.toFixed(2)}`,
      `${s.modelBytes}B`,
      `apply ${s.applyMsPerImage.toFixed(1)}ms`,
      r.evaluation.pass ? 'PASS' : 'fail',
      `score ${r.score.total.toFixed(3)}`,
    ].join('  ');
  });
  console.log(table.join('\n'));
  console.log(`\n选定: ${winner ? winner.id : '无（无候选通过门控）'}`);
  console.log(`选择文件: ${path.relative(ROOT, SELECTION_FILE)} ${commit.written ? '已更新' : `未改动（${commit.reason}）`}`);
  console.log(`报告: ${path.relative(ROOT, outDir)}/report.json, summary.csv`);

  if (!winner) process.exit(3);
  if (!commit.written && !noWrite) process.exit(3);
}

if (require.main === module) main();

module.exports = { commitSelection, GATES, SCORE_WEIGHTS };
