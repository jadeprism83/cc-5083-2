'use strict';

// HTTP bridge between the web UI and the flat-field kernel. Every numeric
// result returned here comes from src/core; the UI only edits parameters and
// renders what the kernel reports.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { validateOptions, describe } = require('./core/options');
const { loadImage, encodePng, readPngInfo } = require('./core/image-io');
const { calibrate, APPLY_FLAG_LABELS, FLAG_LABELS } = require('./core/calibration');
const { applyFlat, regionStats, regionTrust, numericProfile, RefusalError } = require('./core/apply');
const { writeCalibration, loadCalibration, listCalibrations, CalibrationStoreError } = require('./core/store');
const { buildValidation, profileCsv } = require('./core/validation');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(__dirname, 'web');
const CAL_DIR = path.join(ROOT, 'calibrations');
const EXPORT_DIR = path.join(ROOT, 'exports');
const DEMO_DIR = path.join(ROOT, 'data', 'demo');
const MAX_BODY = 2 * 1024 * 1024; // JSON/control payloads only
const UPLOAD_MAX = 60 * 1024 * 1024;

const sessionUploads = new Map(); // token -> { dir, files: [] }

function ensureDirs() {
  fs.mkdirSync(CAL_DIR, { recursive: true });
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, code, filePath, contentType) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { ok: false, error: '文件不存在' });
    res.writeHead(code, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(Object.assign(new Error('请求 JSON 无效：' + err.message), { code: 'BAD_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('上传过大'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeName(name) {
  if (!name) return null;
  const base = path.basename(String(name));
  if (!/^[\w.\-一-龥]+$/.test(base) || base.includes('..')) return null;
  return base;
}

function imagePayload(image) {
  return { width: image.width, height: image.height, bitDepth: image.bitDepth, channels: image.channels, png: encodePng(image).toString('base64') };
}

// Gradient overlays for the UI: confidence (trust) and reference flags.
function confidencePng(calibration) {
  const w = calibration.width;
  const h = calibration.height;
  const data = new Uint16Array(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    const c = calibration.confidence[p];
    data[p * 3] = Math.round(255 * Math.min(1, c * 1.6));
    data[p * 3 + 1] = Math.round(255 * Math.max(0, c * 1.6 - 0.4));
    data[p * 3 + 2] = Math.round(255 * Math.max(0, 0.55 - c));
  }
  return imagePayload({ width: w, height: h, bitDepth: 8, channels: 3, data });
}

function flagsPng(calibration) {
  const w = calibration.width;
  const h = calibration.height;
  const data = new Uint16Array(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    const f = calibration.flags[p];
    let r = 40;
    let g = 40;
    let b = 40;
    if (f & 128) { r = 90; g = 90; b = 90; } // dead
    else if (f & 1) { r = 120; g = 60; b = 160; } // insufficient observations
    else if (f & 2) { r = 220; g = 60; b = 60; } // saturated
    else if (f & 4) { r = 230; g = 150; b = 40; } // bad pixel
    else if (f & 8) { r = 220; g = 210; b = 60; } // low signal
    else if (f & 64) { r = 80; g = 150; b = 200; } // filled
    else { r = 30; g = 120; b = 70; } // trusted
    data[p * 3] = r;
    data[p * 3 + 1] = g;
    data[p * 3 + 2] = b;
  }
  return imagePayload({ width: w, height: h, bitDepth: 8, channels: 3, data });
}

function trustMaskPng(calibration) {
  const w = calibration.width;
  const h = calibration.height;
  const threshold = calibration.record.options.confidenceThreshold;
  const data = new Uint16Array(w * h);
  for (let p = 0; p < w * h; p++) {
    data[p] = calibration.confidence[p] >= threshold ? 255 : 0;
  }
  return imagePayload({ width: w, height: h, bitDepth: 8, channels: 1, data });
}

function calibrationSummary(calibration) {
  const r = calibration.record;
  return {
    id: calibration.id,
    label: r.label || r.id,
    createdAt: r.createdAt,
    width: r.width,
    height: r.height,
    bitDepth: r.bitDepth,
    channels: calibration.channels,
    darkLevelDn: r.darkLevelDn,
    darkSource: r.darkSource,
    saturationThresholdDn: r.saturationThresholdDn,
    normalization: r.normalization,
    gainPolicy: r.gainPolicy,
    refinement: r.refinement,
    options: r.options,
    settings: r.settings,
    summary: r.summary,
    warnings: r.warnings || [],
    referenceCount: r.referenceCount,
    referenceNames: r.referenceNames,
    channelStatistics: r.channelStatistics,
    frameReports: r.frameReports,
  };
}

function loadCalibrationById(id) {
  const safe = safeName(id);
  if (!safe) throw Object.assign(new Error('标定 ID 非法'), { status: 400 });
  const dir = path.join(CAL_DIR, safe);
  try {
    const calibration = loadCalibration(dir);
    calibration.id = safe;
    return calibration;
  } catch (err) {
    if (err instanceof CalibrationStoreError) throw Object.assign(new Error(err.message), { status: 404 });
    throw err;
  }
}

function demoFiles() {
  const refsDir = path.join(DEMO_DIR, 'references');
  const targetsDir = path.join(DEMO_DIR, 'targets');
  const readSettings = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const listPng = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : []);
  return {
    references: listPng(refsDir),
    targets: listPng(targetsDir),
    referenceSettings: fs.existsSync(path.join(refsDir, 'settings.json')) ? readSettings(path.join(refsDir, 'settings.json')) : null,
    targetSettings: fs.existsSync(path.join(targetsDir, 'settings.json')) ? readSettings(path.join(targetsDir, 'settings.json')) : null,
    targetSettingsVariants: {
      zoomMismatch: fs.existsSync(path.join(targetsDir, 'settings_zoom_mismatch.json')) ? readSettings(path.join(targetsDir, 'settings_zoom_mismatch.json')) : null,
      isoMismatch: fs.existsSync(path.join(targetsDir, 'settings_iso_mismatch.json')) ? readSettings(path.join(targetsDir, 'settings_iso_mismatch.json')) : null,
    },
    scenario: {
      note: '合成参考组：已知径向渐晕 + 尘点 + 矩形遮光板，6 帧含噪声、坏点与饱和；目标图带自身纹理、硬边与低照度暗区。',
    },
  };
}

function loadDemoImage(which, name) {
  const safe = safeName(name);
  if (!safe) throw Object.assign(new Error('文件名非法'), { status: 400 });
  const dir = path.join(DEMO_DIR, which);
  return loadImage(path.join(dir, safe));
}

function resolveDemoSettings(variant) {
  const refSettings = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'references', 'settings.json'), 'utf8'));
  if (!variant || variant === 'match') return refSettings;
  const variantFile = path.join(DEMO_DIR, 'targets',
    variant === 'zoom' ? 'settings_zoom_mismatch.json' : variant === 'iso' ? 'settings_iso_mismatch.json' : 'settings.json');
  return JSON.parse(fs.readFileSync(variantFile, 'utf8'));
}

function imageInfoFromBuffer(buffer, name) {
  const info = readPngInfo(buffer);
  if (!info) throw Object.assign(new Error(`${name} 不是 PNG 文件`), { status: 400 });
  return info;
}

async function handleCalibrate(body) {
  const checked = validateOptions(body.options || {});
  if (!checked.ok) return { status: 400, value: { ok: false, error: '标定参数无效', details: checked.errors } };
  const options = checked.options;

  const group = { references: [], darkFrames: [] };
  const sources = body.sources || {};
  try {
    if (sources.demo) {
      const info = demoFiles();
      const names = body.demoReferences && body.demoReferences.length ? body.demoReferences : info.references;
      const settings = resolveDemoSettings('match');
      for (const name of names) {
        const image = loadDemoImage('references', name);
        group.references.push({ name, image, settings });
      }
      if (body.demoDarkFrames && body.demoDarkFrames.length) {
        for (const name of body.demoDarkFrames) {
          group.darkFrames.push({ name, image: loadDemoImage('references', name), settings });
        }
      }
    }
    if (sources.uploads && sources.uploads.length) {
      const session = sessionUploads.get(sources.uploadToken);
      if (!session) return { status: 400, value: { ok: false, error: '上传会话已失效，请重新上传文件' } };
      const settings = body.settings || {};
      for (const token of sources.uploads) {
        const file = session.files.find((f) => f.token === token);
        if (!file) return { status: 400, value: { ok: false, error: `找不到上传文件 ${token}` } };
        group.references.push({ name: file.name, image: loadImage(file.path), settings });
      }
    }
    if (sources.paths && sources.paths.length) {
      const settings = body.settings || {};
      for (const p of sources.paths) {
        const resolved = path.resolve(p);
        group.references.push({ name: path.basename(resolved), image: loadImage(resolved), settings });
      }
    }
  } catch (err) {
    return { status: 400, value: { ok: false, error: '读取参考图失败', details: [err.message] } };
  }
  if (!group.references.length) {
    return { status: 400, value: { ok: false, error: '未选择参考图', details: ['请从演示数据或上传文件中选择至少 2 张参考图'] } };
  }

  const result = calibrate(group, options);
  if (!result.ok) {
    return { status: 422, value: { ok: false, error: '标定失败', details: result.errors, warnings: result.warnings } };
  }
  const id = newCalibrationId(body.label || 'cal');
  const stored = writeCalibration(path.join(CAL_DIR, id), result, { label: body.label || id, id });
  const calibration = loadCalibration(path.join(CAL_DIR, id));
  calibration.id = id;

  const display = { gain: null };
  display.gain = normalizedGainImage(calibration);
  return {
    status: 200,
    value: {
      ok: true,
      calibrationId: id,
      summary: calibrationSummary(calibration),
      gainImage: display.gain,
      confidenceImage: confidencePng(calibration),
      flagsImage: flagsPng(calibration),
      trustImage: trustMaskPng(calibration),
      flagLabels: FLAG_LABELS,
      applyFlagLabels: APPLY_FLAG_LABELS,
      warnings: result.warnings,
    },
  };
}

function normalizedGainImage(calibration) {
  // Display-only mapping of the gain field to a grey image: gain 1 maps to
  // mid-grey, gains up to the configured cap are compressed logarithmically.
  const w = calibration.width;
  const h = calibration.height;
  const maxGain = calibration.record.options.maxGain;
  const data = new Uint16Array(w * h);
  const g = calibration.gain.data;
  const ch = calibration.gain.channels;
  for (let p = 0; p < w * h; p++) {
    let mean = 0;
    for (let c = 0; c < ch; c++) mean += g[p * ch + c];
    mean /= ch;
    const t = Math.log(Math.max(0.02, Math.min(maxGain, mean)) / 0.02) / Math.log(maxGain / 0.02);
    data[p] = Math.round(255 * Math.min(1, Math.max(0, t)));
  }
  return imagePayload({ width: w, height: h, bitDepth: 8, channels: 1, data });
}

function newCalibrationId(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const safe = String(label || 'cal').replace(/[^\w一-龥-]+/g, '_').slice(0, 36);
  return `${stamp}_${safe}`;
}

async function handleCalibrationDetail(id) {
  try {
    const calibration = loadCalibrationById(id);
    return {
      status: 200,
      value: {
        ok: true,
        summary: calibrationSummary(calibration),
        gainImage: normalizedGainImage(calibration),
        confidenceImage: confidencePng(calibration),
        flagsImage: flagsPng(calibration),
        trustImage: trustMaskPng(calibration),
        flagLabels: FLAG_LABELS,
        applyFlagLabels: APPLY_FLAG_LABELS,
      },
    };
  } catch (err) {
    return { status: err.status || 500, value: { ok: false, error: err.message } };
  }
}

async function handlePreview(body) {
  let calibration;
  try {
    calibration = loadCalibrationById(body.calibrationId);
  } catch (err) {
    return { status: err.status || 500, value: { ok: false, error: err.message } };
  }
  const overrides = body.applyOptions || {};
  const options = Object.assign({}, calibration.record.options, overrides);
  const checked = validateOptions(options);
  if (!checked.ok) return { status: 400, value: { ok: false, error: '应用参数无效', details: checked.errors } };

  let target;
  let settings;
  try {
    if (body.source && body.source.demo) {
      target = loadDemoImage('targets', body.source.name);
      const variant = body.source.settingsVariant || 'match';
      settings = resolveDemoSettings(variant);
    } else {
      const session = sessionUploads.get(body.source.uploadToken);
      if (!session) return { status: 400, value: { ok: false, error: '上传会话已失效，请重新上传文件' } };
      const file = session.files.find((f) => f.token === body.source.fileToken);
      if (!file) return { status: 400, value: { ok: false, error: '找不到目标图文件' } };
      target = loadImage(file.path);
      settings = body.source.settings || {};
    }
  } catch (err) {
    return { status: 400, value: { ok: false, error: '读取目标图失败：' + err.message } };
  }

  let application;
  try {
    application = applyFlat(calibration.record, {
      gain: calibration.gain,
      confidence: calibration.confidence,
      flags: calibration.flags,
    }, target, {
      targetSettings: settings,
      confidenceThreshold: checked.options.confidenceThreshold,
      maxGain: checked.options.maxGain,
      minGain: checked.options.minGain,
    });
  } catch (err) {
    if (err instanceof RefusalError) {
      return {
        status: 409,
        value: {
          ok: false, refused: true, error: err.message, details: err.details,
          expected: err.settings ? err.settings.expected : null,
          actual: err.settings ? err.settings.actual : null,
        },
      };
    }
    return { status: 500, value: { ok: false, error: err.message } };
  }

  const regions = body.regions && body.regions.length ? body.regions : defaultRegions(target.width, target.height);
  let profileSpec;
  if (body.profile && Number.isFinite(body.profile.yRatio)) {
    profileSpec = { y: Math.round(clampRatio(body.profile.yRatio) * (target.height - 1)), x: 0, w: target.width };
  } else {
    profileSpec = body.profile || { y: Math.round(target.height * 0.55), x: 0, w: target.width };
  }
  const regionReports = regions.map((r) => {
    const before = regionStats(target, r, r.channel);
    const after = regionStats(application.output, r, r.channel);
    const trust = regionTrust(calibration, r, checked.options.confidenceThreshold);
    return { label: r.label, rect: before.rect, before, after, trustedFraction: trust.trustedFraction, meanConfidence: trust.meanConfidence, calibrationMeanGain: trust.meanGain };
  });
  const profile = numericProfile(target, application.output, profileSpec, profileSpec.channel);
  const regionNoise = regionReports.map((r) => ({
    label: r.label,
    beforeNoiseDn: r.before.highPassNoiseDn,
    afterNoiseDn: r.after.highPassNoiseDn,
    noiseRatio: r.before.highPassNoiseDn > 0 ? r.after.highPassNoiseDn / r.before.highPassNoiseDn : null,
    beforeMeanDn: r.before.meanDn,
    afterMeanDn: r.after.meanDn,
    meanDeltaDn: r.after.meanDn - r.before.meanDn,
  }));

  return {
    status: 200,
    value: {
      ok: true,
      target: imagePayload(target),
      corrected: imagePayload(application.output),
      trust: imagePayload(trustMaskForApplication(application, target.width, target.height)),
      gain: imagePayload(appliedGainImage(application, target.width, target.height, checked.options)),
      flags: imagePayload(applicationFlagsImage(application, target.width, target.height)),
      regions: regionReports,
      noise: regionNoise,
      profile,
      application: {
        threshold: application.threshold,
        trustedFraction: application.trustedFraction,
        meanAppliedGain: application.meanAppliedGain,
        meanAppliedGainTrusted: application.meanAppliedGainTrusted,
        maxAppliedGain: application.maxAppliedGain,
        counts: application.counts,
        warnings: application.compatibility.warnings,
      },
      settings,
      calibrationId: calibration.id,
      applyOptions: checked.options,
      flagLabels: APPLY_FLAG_LABELS,
    },
  };
}

function clampRatio(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

function defaultRegions(width, height) {
  return [
    { label: '画面上部', x: Math.round(width * 0.08), y: Math.round(height * 0.08), w: Math.round(width * 0.18), h: Math.round(height * 0.14) },
    { label: '中心', x: Math.round(width * 0.41), y: Math.round(height * 0.41), w: Math.round(width * 0.18), h: Math.round(height * 0.18) },
    { label: '右下角', x: Math.round(width * 0.74), y: Math.round(height * 0.72), w: Math.round(width * 0.18), h: Math.round(height * 0.18) },
    { label: '遮光板', x: Math.round(width * 0.72), y: Math.round(height * 0.62), w: Math.round(width * 0.12), h: Math.round(height * 0.12) },
  ];
}

function trustMaskForApplication(application, width, height) {
  const data = new Uint16Array(width * height);
  for (let p = 0; p < width * height; p++) data[p] = application.trusted[p] ? 255 : 0;
  return { width, height, bitDepth: 8, channels: 1, data };
}

// Display-only view of the gain actually multiplied into the target, including
// the confidence taper and the gain limits in force for this preview.
function appliedGainImage(application, width, height, applyOptions) {
  const maxGain = Number.isFinite(applyOptions.maxGain) ? applyOptions.maxGain : 1;
  const render = new Uint16Array(width * height * 3);
  const g = application.appliedGain;
  const ch = application.appliedGainChannels;
  for (let p = 0; p < width * height; p++) {
    let mean = 0;
    for (let c = 0; c < ch; c++) mean += g[p * ch + c];
    mean /= ch;
    // Log mapping keeps mid-range gains visible: 0.5x = black, 1x = mid grey,
    // the configured cap = white.
    const t = Math.log(Math.max(0.5, Math.min(maxGain, mean)) / 0.5) / Math.log(Math.max(0.6, maxGain) / 0.5);
    const v = Math.round(255 * t);
    render[p * 3] = v;
    render[p * 3 + 1] = v;
    render[p * 3 + 2] = v;
  }
  return { width, height, bitDepth: 8, channels: 3, data: render };
}

function applicationFlagsImage(application, width, height) {
  const data = new Uint16Array(width * height * 3);
  const f = application.flags;
  for (let p = 0; p < width * height; p++) {
    const v = f[p];
    let r = 30; let g = 120; let b = 70; // corrected, trusted
    if (v & 32) { r = 150; g = 120; b = 60; } // no valid gain
    if (v & 16) { r = 180; g = 90; b = 40; } // low confidence
    if (v & 4) { r = 230; g = 170; b = 40; } // capped
    if (v & 8) { r = 200; g = 150; b = 60; } // floored
    if (v & 2) { r = 80; g = 80; b = 120; } // under dark
    if (v & 1) { r = 220; g = 60; b = 60; } // clipped
    if (v & 64) { r = 90; g = 150; b = 190; } // tapered
    data[p * 3] = r;
    data[p * 3 + 1] = g;
    data[p * 3 + 2] = b;
  }
  return { width, height, bitDepth: 8, channels: 3, data };
}

async function handleExport(body) {
  let calibration;
  try {
    calibration = loadCalibrationById(body.calibrationId);
  } catch (err) {
    return { status: err.status || 500, value: { ok: false, error: err.message } };
  }
  const options = Object.assign({}, calibration.record.options, body.applyOptions || {});
  const checked = validateOptions(options);
  if (!checked.ok) return { status: 400, value: { ok: false, error: '应用参数无效', details: checked.errors } };

  const items = [];
  const settingsVariant = body.settingsVariant || 'match';
  const names = body.targets || [];
  for (const name of names) {
    const safe = safeName(name);
    if (!safe) { items.push({ name, ok: false, error: '文件名非法' }); continue; }
    const filePath = path.join(DEMO_DIR, 'targets', safe);
    let image;
    let settings;
    try {
      image = loadImage(filePath);
      settings = resolveDemoSettings(settingsVariant);
    } catch (err) {
      items.push({ name, ok: false, error: err.message });
      continue;
    }
    try {
      const application = applyFlat(calibration.record, {
        gain: calibration.gain, confidence: calibration.confidence, flags: calibration.flags,
      }, image, {
        targetSettings: settings,
        confidenceThreshold: checked.options.confidenceThreshold,
        maxGain: checked.options.maxGain,
        minGain: checked.options.minGain,
      });
      const outName = safe.replace(/\.png$/i, '') + '_flat.png';
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      const outPath = path.join(EXPORT_DIR, outName);
      fs.writeFileSync(outPath, encodePng(application.output));
      const regions = defaultRegions(image.width, image.height);
      const csvLines = ['label,channel,x,y,w,h,before_mean_dn,after_mean_dn,delta_dn,before_noise_dn,after_noise_dn,mean_applied_gain,trusted_fraction'];
      for (const r of regions) {
        const b = regionStats(image, r, r.channel);
        const a = regionStats(application.output, r, r.channel);
        const trust = regionTrust(calibration, r, checked.options.confidenceThreshold);
        csvLines.push([r.label, r.channel ?? '', b.rect.x, b.rect.y, b.rect.w, b.rect.h,
          b.meanDn.toFixed(2), a.meanDn.toFixed(2), (a.meanDn - b.meanDn).toFixed(2),
          b.highPassNoiseDn != null ? b.highPassNoiseDn.toFixed(2) : '',
          a.highPassNoiseDn != null ? a.highPassNoiseDn.toFixed(2) : '',
          trust.meanGain != null ? trust.meanGain.toFixed(3) : '',
          trust.trustedFraction != null ? trust.trustedFraction.toFixed(3) : ''].join(','));
      }
      const csvPath = path.join(EXPORT_DIR, outName.replace(/\.png$/i, '_regions.csv'));
      fs.writeFileSync(csvPath, csvLines.join('\n') + '\n');
      const reportPath = path.join(EXPORT_DIR, outName.replace(/\.png$/i, '_report.json'));
      fs.writeFileSync(reportPath, JSON.stringify({
        calibration: calibrationSummary(calibration),
        image: { name: safe, width: image.width, height: image.height, bitDepth: image.bitDepth },
        settings,
        applyOptions: checked.options,
        application: { threshold: application.threshold, counts: application.counts, trustedFraction: application.trustedFraction, meanAppliedGain: application.meanAppliedGain, meanAppliedGainTrusted: application.meanAppliedGainTrusted, maxAppliedGain: application.maxAppliedGain, warnings: application.compatibility.warnings },
        regions: regions.map((r) => {
          const b = regionStats(image, r, r.channel);
          const a = regionStats(application.output, r, r.channel);
          return { label: r.label, rect: b.rect, beforeMeanDn: b.meanDn, afterMeanDn: a.meanDn, beforeNoiseDn: b.highPassNoiseDn, afterNoiseDn: a.highPassNoiseDn };
        }),
        exportedAt: new Date().toISOString(),
      }, null, 2));
      items.push({ name: safe, ok: true, output: path.relative(ROOT, outPath), csv: path.relative(ROOT, csvPath), report: path.relative(ROOT, reportPath) });
    } catch (err) {
      if (err instanceof RefusalError) items.push({ name: safe, ok: false, refused: true, error: err.message, details: err.details });
      else items.push({ name: safe, ok: false, error: err.message });
    }
  }
  return { status: 200, value: { ok: items.some((i) => i.ok), items } };
}

async function handleUpload(body) {
  const token = crypto.randomBytes(10).toString('hex');
  const dir = path.join(os.tmpdir(), 'flatfield-uploads', token);
  fs.mkdirSync(dir, { recursive: true });
  sessionUploads.set(token, { dir, files: [] });
  return { status: 200, value: { ok: true, token, maxBytes: UPLOAD_MAX } };
}

async function handleUploadFile(req, query) {
  const token = safeName(query.get('token'));
  const session = token ? sessionUploads.get(token) : null;
  if (!session) return { status: 400, value: { ok: false, error: '上传会话无效' } };
  const rawName = query.get('name');
  if (!rawName) return { status: 400, value: { ok: false, error: '缺少文件名' } };
  const name = safeName(rawName);
  if (!name) return { status: 400, value: { ok: false, error: '文件名非法' } };
  const body = await readRawBody(req, UPLOAD_MAX);
  const info = imageInfoFromBuffer(body, name);
  if (info.bitDepth !== 8 && info.bitDepth !== 16) {
    return { status: 400, value: { ok: false, error: '仅支持 8 位或 16 位 PNG' } };
  }
  if (info.interlace !== 0) return { status: 400, value: { ok: false, error: '不支持隔行扫描 PNG' } };
  const fileToken = crypto.randomBytes(6).toString('hex');
  const filePath = path.join(session.dir, `${fileToken}.png`);
  fs.writeFileSync(filePath, body);
  // A file can serve both roles, so it is recorded once and referenced twice.
  const entry = { token: fileToken, name, path: filePath, width: info.width, height: info.height, bitDepth: info.bitDepth, uploadedAt: new Date().toISOString() };
  session.files.push(entry);
  return { status: 200, value: { ok: true, file: entry } };
}

async function handleValidate(body) {
  const checked = validateOptions(body.options || {});
  if (!checked.ok) return { status: 400, value: { ok: false, error: '验证参数无效', details: checked.errors } };
  const validation = buildValidation(checked.options, body.scenario || {});
  if (!validation.ok) return { status: 422, value: { ok: false, error: '合成验证失败', details: validation.errors, stage: validation.stage } };
  const dir = path.join(EXPORT_DIR, 'validation-' + newCalibrationId('val'));
  fs.mkdirSync(dir, { recursive: true });
  const profiles = validation.profiles.map((p) => ({
    label: p.label, y: p.y, points: p.points,
    beforeMeanDn: p.beforeMeanDn, afterMeanDn: p.afterMeanDn, expectedMeanDn: p.expectedMeanDn,
  }));
  for (const p of validation.profiles) {
    const name = p.label.includes('主') ? 'profile_main.csv' : 'profile_occluder.csv';
    fs.writeFileSync(path.join(dir, name), profileCsv(p));
  }
  // Strip the full pixel data from the JSON report; the files on disk keep it.
  const imageFiles = Object.entries(validation.images).map(([name, image]) => {
    fs.writeFileSync(path.join(dir, `${name}.png`), image.png);
    return [name, { width: image.width, height: image.height, file: `${name}.png` }];
  });
  // The UI needs the full-size images for the chart underlays, so base64 is
  // returned here and stripped by the caller when the JSON is written.
  const compact = {
    ok: true,
    scenario: validation.scenario,
    calibration: validation.calibration,
    application: validation.application,
    gainAccuracy: validation.gainAccuracy,
    uniformity: validation.uniformity,
    regions: validation.regions,
    checks: validation.checks,
    profiles,
    images: Object.fromEntries(imageFiles),
    imagePreviews: Object.fromEntries(Object.entries(validation.images).map(([k, v]) => [k, v.png.toString('base64')])),
    filesDir: path.relative(ROOT, dir),
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ ...compact, imagePreviews: undefined }, null, 2));
  return { status: 200, value: compact };
}

function handleListCalibrations() {
  ensureDirs();
  const items = listCalibrations(CAL_DIR).map((c) => ({ ...c }));
  return { status: 200, value: { ok: true, items } };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/') return sendFile(res, 200, path.join(WEB_DIR, 'index.html'), MIME['.html']);
  if (req.method === 'GET' && pathname.startsWith('/web/')) {
    const rel = pathname.slice('/web/'.length);
    const safe = path.relative('/', path.join(WEB_DIR, rel));
    if (safe.startsWith('..') || path.isAbsolute(safe)) return sendJson(res, 400, { ok: false, error: '路径非法' });
    return sendFile(res, 200, path.join(WEB_DIR, rel), MIME[path.extname(rel)] || 'application/octet-stream');
  }
  if (req.method === 'GET' && pathname === '/api/options') {
    return sendJson(res, 200, { ok: true, ...describe() });
  }
  if (req.method === 'GET' && pathname === '/api/demo') {
    return sendJson(res, 200, { ok: true, ...demoFiles() });
  }
  if (req.method === 'GET' && pathname === '/api/calibrations') {
    const result = handleListCalibrations();
    return sendJson(res, result.status, result.value);
  }
  if (req.method === 'GET' && pathname.startsWith('/api/calibrations/')) {
    const id = decodeURIComponent(pathname.slice('/api/calibrations/'.length));
    const result = await handleCalibrationDetail(id);
    return sendJson(res, result.status, result.value);
  }
  if (req.method === 'GET' && pathname.startsWith('/exports/')) {
    const rel = decodeURIComponent(pathname.slice('/exports/'.length));
    const safe = path.relative('/', path.join(EXPORT_DIR, rel));
    if (safe.startsWith('..')) return sendJson(res, 400, { ok: false, error: '路径非法' });
    return sendFile(res, 200, path.join(EXPORT_DIR, rel), MIME[path.extname(rel)] || 'application/octet-stream');
  }
  if (req.method === 'GET' && pathname.startsWith('/data/')) {
    const rel = decodeURIComponent(pathname.slice('/data/'.length));
    if (rel.includes('..')) return sendJson(res, 400, { ok: false, error: '路径非法' });
    const full = path.join(DEMO_DIR, rel);
    if (path.extname(rel) === '.json') return sendFile(res, 200, full, MIME['.json']);
    if (path.extname(rel) === '.png') return sendFile(res, 200, full, MIME['.png']);
    return sendJson(res, 404, { ok: false, error: '文件不存在' });
  }

  if (req.method === 'POST' && pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/uploads') {
        const result = await handleUpload({});
        return sendJson(res, result.status, result.value);
      }
      if (pathname === '/api/uploads/file') {
        const result = await handleUploadFile(req, url.searchParams);
        return sendJson(res, result.status, result.value);
      }
      const body = await readJsonBody(req, MAX_BODY);
      switch (pathname) {
        case '/api/calibrate': {
          const result = await handleCalibrate(body);
          return sendJson(res, result.status, result.value);
        }
        case '/api/preview': {
          const result = await handlePreview(body);
          return sendJson(res, result.status, result.value);
        }
        case '/api/export': {
          const result = await handleExport(body);
          return sendJson(res, result.status, result.value);
        }
        case '/api/validate': {
          const result = await handleValidate(body);
          return sendJson(res, result.status, result.value);
        }
        default:
          return sendJson(res, 404, { ok: false, error: '未知 API' });
      }
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { ok: false, error: '请求体过大' });
      if (err.code === 'BAD_JSON') return sendJson(res, 400, { ok: false, error: err.message });
      console.error(err);
      return sendJson(res, 500, { ok: false, error: '服务器内部错误：' + err.message });
    }
  }
  return sendJson(res, 404, { ok: false, error: '未找到' });
}

function start(port) {
  ensureDirs();
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' });
      else res.end();
    });
  });
  server.listen(port, () => {
    console.log(`平场补偿界面: http://localhost:${port}/`);
    console.log(`内核命令行: node src/cli.js --help`);
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  start(port);
}

module.exports = { start, route };
