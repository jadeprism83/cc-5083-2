#!/usr/bin/env node
'use strict';

// Command-line driver for the flat-field kernel. The web UI drives the same
// modules through server.js; this file exists so the chain can be scripted,
// reproduced and validated headlessly.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { validateOptions, describe, describe: describeOptions } = require('./core/options');
const { loadImage, describeImage, encodePng } = require('./core/image-io');
const { calibrate } = require('./core/calibration');
const { applyFlat, regionStats, numericProfile, RefusalError } = require('./core/apply');
const { writeCalibration, loadCalibration, CalibrationStoreError } = require('./core/store');
const { buildValidation, profileCsv } = require('./core/validation');


function usage() {
  return `平场补偿命令行（内核与界面共用同一实现）

用法:
  node src/cli.js calibrate --settings <json|@file> [选项] --ref a.png [--ref b.png ...] [位置参数 ...] --out <目录>
  node src/cli.js apply --calibration <目录> --image <input.png> --settings <json|@file> --out <output.png>
  node src/cli.js apply --calibration <目录> --batch <glob目录> --settings <json|@file> --out <目录>
  node src/cli.js validate [选项] --out <目录>
  node src/cli.js inspect --calibration <目录>

选项（标定）:
  --dark-mode none|manual|darkFrames   --dark-dn <DN>
  --norm-mode mean|median|percentile|fixed  --norm-percentile <p>  --norm-dn <DN>
  --max-gain <x>  --min-gain <x>  --smooth-px <px>
  --outlier-sigma <s>  --min-frames <n>  --bad-pixel-sigma <s>
  --low-signal-factor <s>  --confidence <0..1>
  --options <json|@file>   （整体覆盖以上选项）
  --dark-frames <路径...>  --label <名称>

选项（应用）:
  --confidence <0..1>  覆盖可信区阈值
  --max-gain <x>  --min-gain <x>  覆盖本次导出的限幅
  --regions <json|@file>  剖面/区域定义
  --report <file.json>  写出数值与配置报告
  --csv                额外把剖面写成 CSV

选项（验证）:
  --out <目录>  写出 report.json、剖面 CSV 与恢复图
  --json        只打印汇总 JSON

退出码: 0 成功；2 输入/配置错误；3 拒绝套用（几何或采集设置不匹配）。`;
}

const EXIT_INPUT = 2;
const EXIT_REFUSED = 3;

function fail(message, code = EXIT_INPUT, extra) {
  const payload = { ok: false, error: message };
  if (extra) Object.assign(payload, extra);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(code);
}

function parseFlags(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ref: { type: 'string', multiple: true },
      'dark-frames': { type: 'string', multiple: true },
      out: { type: 'string' },
      image: { type: 'string' },
      batch: { type: 'string' },
      calibration: { type: 'string' },
      settings: { type: 'string' },
      options: { type: 'string' },
      regions: { type: 'string' },
      report: { type: 'string' },
      label: { type: 'string' },
      'dark-mode': { type: 'string' },
      'dark-dn': { type: 'string' },
      'norm-mode': { type: 'string' },
      'norm-percentile': { type: 'string' },
      'norm-dn': { type: 'string' },
      'max-gain': { type: 'string' },
      'min-gain': { type: 'string' },
      'smooth-px': { type: 'string' },
      'outlier-sigma': { type: 'string' },
      'min-frames': { type: 'string' },
      'bad-pixel-sigma': { type: 'string' },
      'low-signal-factor': { type: 'string' },
      confidence: { type: 'string' },
      'require-radiometry': { type: 'boolean' },
      csv: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  return { values, positionals };
}

function loadJsonArg(arg, what) {
  if (!arg) return null;
  let text = arg;
  if (arg.startsWith('@')) {
    try {
      text = fs.readFileSync(arg.slice(1), 'utf8');
    } catch (err) {
      fail(`无法读取 ${what} 文件 ${arg.slice(1)}：${err.message}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${what} 不是合法 JSON：${err.message}`);
  }
  return null;
}

function optionsFromFlags(values) {
  const base = loadJsonArg(values.options, '选项') || {};
  const numeric = [
    ['darkDn', values['dark-dn']],
    ['normalizationPercentile', values['norm-percentile']],
    ['normalizationDn', values['norm-dn']],
    ['maxGain', values['max-gain']],
    ['minGain', values['min-gain']],
    ['gainSmoothingPx', values['smooth-px']],
    ['outlierSigma', values['outlier-sigma']],
    ['minValidFrames', values['min-frames']],
    ['badPixelSigma', values['bad-pixel-sigma']],
    ['lowSignalFactor', values['low-signal-factor']],
    ['confidenceThreshold', values.confidence],
  ];
  for (const [key, value] of numeric) {
    if (value !== undefined) {
      const n = Number(value);
      if (!Number.isFinite(n)) fail(`--${key} 需要数值，收到 ${value}`);
      base[key] = n;
    }
  }
  const modeMap = { 'dark-mode': 'darkMode', 'norm-mode': 'normalizationMode' };
  for (const [flag, key] of Object.entries(modeMap)) {
    if (values[flag] !== undefined) base[key] = values[flag];
  }
  if (values['require-radiometry']) base.requireRadiometryMatch = true;
  const check = validateOptions(base);
  if (!check.ok) fail('选项无效', EXIT_INPUT, { details: check.errors });
  return check.options;
}

function settingsOrFail(values) {
  const settings = loadJsonArg(values.settings, '采集设置');
  if (!settings) fail('缺少 --settings（采集设置 JSON 或 @文件）');
  for (const field of describeOptions().settingsSchema.filter((f) => f.mandatory)) {
    if (settings[field.key] === undefined || settings[field.key] === null || settings[field.key] === '') {
      fail(`采集设置缺少必填字段“${field.label}”（${field.key}）`);
    }
  }
  return settings;
}

function readGroup(paths, settings) {
  return paths.map((p) => {
    const image = loadImage(p);
    return { name: path.basename(p), path: p, image, settings, ...describeImage(p, image) };
  });
}

function newCalibrationId(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const safe = (label || 'cal').replace(/[^\w一-龥-]+/g, '_').slice(0, 40);
  return `${stamp}_${safe}`;
}

function commandCalibrate(values, positionals) {
  const refPaths = [...(values.ref || []), ...(positionals || [])];
  if (refPaths.length === 0) fail('缺少参考图（--ref 或位置参数）');
  if (!values.out) fail('缺少 --out 标定输出目录');
  const settings = settingsOrFail(values);
  const options = optionsFromFlags(values);
  const refs = readGroup(refPaths, settings);
  const darks = values['dark-frames'] ? readGroup(values['dark-frames'], settings) : [];
  const label = values.label || path.basename(values.out);
  const result = calibrate({ references: refs, darkFrames: darks }, options, { id: label });
  if (!result.ok) {
    fail('标定失败', EXIT_INPUT, { errors: result.errors, warnings: result.warnings });
  }
  const stored = writeCalibration(values.out, result, { label });
  const output = {
    ok: true,
    calibrationDir: values.out,
    summary: stored.record.summary,
    darkSource: stored.record.darkSource,
    normalization: stored.record.normalization,
    gainPolicy: stored.record.gainPolicy,
    channelStatistics: stored.record.channelStatistics,
    warnings: stored.record.warnings,
  };
  console.log(JSON.stringify(output, null, 2));
}

function regionsFromArg(values, width, height) {
  const parsed = loadJsonArg(values.regions, '区域');
  if (parsed) return parsed;
  return [
    { label: '中心', x: Math.round(width * 0.4), y: Math.round(height * 0.4), w: Math.round(width * 0.2), h: Math.round(height * 0.2) },
    { label: '左下角', x: Math.round(width * 0.04), y: Math.round(height * 0.82), w: Math.round(width * 0.12), h: Math.round(height * 0.12) },
    { label: '右上角', x: Math.round(width * 0.84), y: Math.round(height * 0.04), w: Math.round(width * 0.12), h: Math.round(height * 0.12) },
  ];
}

function applyOne(calibration, filePath, settings, values) {
  const image = loadImage(filePath);
  const applyOptions = {
    targetSettings: settings,
    confidenceThreshold: values.confidence !== undefined ? Number(values.confidence) : undefined,
    maxGain: values['max-gain'] !== undefined ? Number(values['max-gain']) : undefined,
    minGain: values['min-gain'] !== undefined ? Number(values['min-gain']) : undefined,
  };
  const application = applyFlat(calibration.record, calibration, image, applyOptions);
  const regions = regionsFromArg(values, image.width, image.height);
  const profileSpec = { y: Math.round(image.height * 0.5), x: 0, w: image.width };
  const report = {
    ok: true,
    image: describeImage(filePath, image),
    acquisition: settings,
    calibration: { id: calibration.record.id, createdAt: calibration.record.createdAt },
    application: {
      trustThreshold: application.threshold,
      trustedFraction: application.trustedFraction,
      meanAppliedGain: application.meanAppliedGain,
      meanAppliedGainTrusted: application.meanAppliedGainTrusted,
      maxAppliedGain: application.maxAppliedGain,
      gainLimits: { maxGain: applyOptions.maxGain, minGain: applyOptions.minGain },
      counts: application.counts,
      compatibilityWarnings: application.compatibility.warnings,
    },
    regions: regions.map((r) => {
      const b = regionStats(image, r, r.channel);
      const a = regionStats(application.output, r, r.channel);
      return { label: r.label, rect: b.rect, before: b, after: a, deltaMeanDn: a.meanDn - b.meanDn };
    }),
    profile: numericProfile(image, application.output, profileSpec, null),
  };
  return { application, image, report };
}

function commandApply(values) {
  if (!values.calibration) fail('缺少 --calibration 标定目录');
  const settings = settingsOrFail(values);
  let calibration;
  try {
    calibration = loadCalibration(values.calibration);
  } catch (err) {
    if (err instanceof CalibrationStoreError) fail(err.message);
    throw err;
  }
  let targets;
  if (values.image) targets = [values.image];
  else if (values.batch) {
    try {
      targets = fs.globSync(path.join(values.batch, '*.png')).filter((p) => !p.includes(`${path.sep}exports${path.sep}`));
    } catch (err) {
      fail(`批量目录无效：${err.message}`);
    }
    if (!targets.length) fail(`目录 ${values.batch} 中没有 PNG 文件`);
    targets.sort();
  } else fail('缺少 --image 或 --batch');
  if (!values.out) fail('缺少 --out');

  const batchMode = targets.length > 1 || !!values.batch;
  if (batchMode) fs.mkdirSync(values.out, { recursive: true });
  else fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });

  const reports = [];
  let firstFailure = null;
  for (const targetPath of targets) {
    const base = path.basename(targetPath, '.png');
    const outPath = batchMode ? path.join(values.out, `${base}_flat.png`) : values.out;
    try {
      const { application, image, report } = applyOne(calibration, targetPath, settings, values);
      fs.writeFileSync(outPath, encodePng(application.output));
      report.output = outPath;
      reports.push(report);
      if (values.csv) {
        const csvPath = batchMode ? path.join(values.out, `${base}_profile.csv`) : `${values.out}.csv`;
        fs.writeFileSync(csvPath, profileCsv({ ...report.profile, label: '水平剖面 y=' + report.profile.y }));
      }
    } catch (err) {
      if (err instanceof RefusalError) {
        const refusal = {
          ok: false,
          refused: true,
          image: targetPath,
          message: err.message,
          details: err.details,
        };
        reports.push(refusal);
        if (!firstFailure) firstFailure = refusal;
      } else {
        const failure = { ok: false, refused: false, image: targetPath, message: err.message };
        if (err.details) failure.details = err.details;
        reports.push(failure);
        if (!firstFailure) firstFailure = failure;
      }
    }
  }
  const out = { ok: !firstFailure, batch: batchMode, count: targets.length, results: reports };
  if (values.report) fs.writeFileSync(values.report, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (firstFailure) {
    if (firstFailure.refused) process.exit(EXIT_REFUSED);
    process.exit(EXIT_INPUT);
  }
}

function commandValidate(values) {
  if (!values.out) fail('缺少 --out 验证输出目录');
  const options = optionsFromFlags(values);
  const validation = buildValidation(options);
  fs.mkdirSync(values.out, { recursive: true });
  if (!validation.ok) {
    fs.writeFileSync(path.join(values.out, 'report.json'), JSON.stringify(validation, null, 2));
    fail('合成验证失败', EXIT_INPUT, { report: path.join(values.out, 'report.json'), errors: validation.errors });
  }
  fs.writeFileSync(path.join(values.out, 'report.json'), JSON.stringify(validation, null, 2));
  for (const profile of validation.profiles) {
    const name = profile.label.includes('主') ? 'profile_main.csv' : 'profile_occluder.csv';
    fs.writeFileSync(path.join(values.out, name), profileCsv(profile));
  }
  for (const [name, image] of Object.entries(validation.images)) {
    fs.writeFileSync(path.join(values.out, `${name}.png`), image.png);
  }
  const summary = {
    ok: true,
    out: values.out,
    scenario: validation.scenario,
    gainAccuracy: validation.gainAccuracy,
    uniformity: validation.uniformity,
    checks: validation.checks,
    regions: validation.regions.map((r) => ({
      label: r.label,
      beforeMeanDn: r.beforeMeanDn,
      afterMeanDn: r.afterMeanDn,
      expectedAfterDn: r.expectedAfterDn,
      residualPercent: r.brightnessResidualPercent,
      noiseGainRatio: r.noiseGainRatio,
    })),
    files: Object.keys(validation.images).map((k) => `${k}.png`).concat(['report.json', 'profile_main.csv', 'profile_occluder.csv']),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!values.json) {
    const p = validation.profiles[0];
    if (!p) return;
    // Keep stdout machine-readable: the textual profile goes to stderr.
    console.error(`\n主剖面 y=${p.y}（同区域校正前后对比，截取每 12 点）:`);
    console.error('x\tbefore\t\tafter\t\texpected');
    for (let i = 0; i < p.points.length; i += 12) {
      const pt = p.points[i];
      console.error(`${pt.x}\t${pt.beforeDn}\t\t${pt.afterDn}\t\t${pt.expectedDn}`);
    }
  }
}

function commandInspect(values) {
  if (!values.calibration) fail('缺少 --calibration 标定目录');
  const calibration = loadCalibration(values.calibration);
  const record = calibration.record;
  const check = record.settings ? { settings: record.settings } : {};
  console.log(JSON.stringify({
    ok: true,
    id: record.id,
    createdAt: record.createdAt,
    width: record.width,
    height: record.height,
    bitDepth: record.bitDepth,
    channels: calibration.channels,
    darkLevelDn: record.darkLevelDn,
    darkSource: record.darkSource,
    saturationThresholdDn: record.saturationThresholdDn,
    normalization: record.normalization,
    gainPolicy: record.gainPolicy,
    refinement: record.refinement,
    options: record.options,
    settings: record.settings,
    summary: record.summary,
    warnings: record.warnings,
    references: record.referenceNames,
    darkFrames: record.darkFrameNames,
    ...check,
  }, null, 2));
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(usage());
    return;
  }
  const command = argv[0];
  const { values, positionals } = parseFlags(argv.slice(1));
  switch (command) {
    case 'calibrate': commandCalibrate(values, positionals); break;
    case 'apply': commandApply(values); break;
    case 'validate': commandValidate(values); break;
    case 'inspect': commandInspect(values); break;
    default:
      fail(`未知命令 ${command}`, EXIT_INPUT, { usage: usage() });
  }
}

main();
