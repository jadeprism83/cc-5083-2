'use strict';

// Single source of truth for flat-field options. The HTTP API and the web UI
// both consume this descriptor, so a control the UI shows is always understood
// by the kernel and recorded in the calibration manifest.

const DEFAULTS = {
  darkMode: 'manual', // 'none' | 'manual' | 'darkFrames'
  darkDn: 700,
  saturationFraction: 0.995, // fraction of full scale treated as clipped
  lowSignalFactor: 4, // signal below this many noise sigmas is weakly observed
  normalizationMode: 'percentile', // 'mean' | 'median' | 'percentile' | 'fixed'
  normalizationPercentile: 95,
  normalizationDn: 12000,
  maxGain: 8,
  minGain: 0.1,
  gainSmoothingPx: 9,
  outlierSigma: 3.5,
  minValidFrames: 2,
  deadPixelFraction: 0.5,
  badPixelSigma: 8,
  confidenceThreshold: 0.5,
  requireRadiometryMatch: false,
  radiometryTolerance: 0.05,
  gainModel: 'grid', // 'field' 稠密场 | 'grid' 网格插值（默认，见 docs/gain-model-comparison.md）| 'basis' 受约束基函数
  gridCellPx: 8,
  basisDegree: 4,
  basisResidualSigma: 4,
};

// Fields are the advanced controls; groups control UI placement.
const FIELDS = [
  {
    key: 'darkMode', label: '暗电平处理', group: 'radiometry', type: 'select',
    options: [
      { value: 'manual', label: '手动定值' },
      { value: 'none', label: '不扣除（0 DN）' },
      { value: 'darkFrames', label: '使用暗场组' },
    ],
    help: '参考图与目标图使用同一暗电平。暗场组取逐通道稳健均值。',
  },
  {
    key: 'darkDn', label: '暗电平数值', group: 'radiometry', type: 'number',
    min: 0, max: 65535, step: 1, unit: 'DN',
    help: '仅在“手动定值”时生效；按图像自身的位深填写（8 位图应显著小于 16 位默认 700 DN）。',
  },
  {
    key: 'lowSignalFactor', label: '低信号阈值（噪声倍数）', group: 'radiometry',
    type: 'range', min: 1, max: 20, step: 0.5, unit: 'σ',
    help: '低于该值的观测仍保留，但降低可信度并受最大倍率限制。',
  },
  {
    key: 'saturationFraction', label: '饱和判定（满量程比例）', group: 'radiometry',
    type: 'range', min: 0.8, max: 1, step: 0.001,
    help: '达到该比例的像素视为无效观测，不参与增益估计。',
  },
  {
    key: 'normalizationMode', label: '归一基准', group: 'normalization', type: 'select',
    options: [
      { value: 'mean', label: '可靠区均值 → 增益均值 1' },
      { value: 'median', label: '可靠区中位数' },
      { value: 'percentile', label: '可靠区分位数' },
      { value: 'fixed', label: '固定 DN 基准' },
    ],
    help: '决定参考场归一化后的目标电平；该基准会写入标定记录。',
  },
  {
    key: 'normalizationPercentile', label: '归一化分位点', group: 'normalization',
    type: 'range', min: 1, max: 99, step: 1, unit: '%',
  },
  {
    key: 'normalizationDn', label: '固定归一化电平', group: 'normalization',
    type: 'number', min: 1, max: 65535, step: 1, unit: 'DN',
  },
  {
    key: 'maxGain', label: '最大补偿倍率', group: 'gain', type: 'range',
    min: 1, max: 32, step: 0.1, unit: '×',
    help: '只限制放大。超过该倍率的区域按此倍率封顶并标记，不做无限放大。',
  },
  {
    key: 'minGain', label: '最大衰减倍率', group: 'gain', type: 'range',
    min: 0.02, max: 1, step: 0.01, unit: '×',
  },
  {
    key: 'gainSmoothingPx', label: '增益场平滑半径', group: 'gain', type: 'range',
    min: 0, max: 64, step: 1, unit: 'px',
    help: '抑制单帧噪声与局部坏点对增益场的影响。半径为像素支撑，实际高斯 σ = 半径/3；不改变目标图纹理。',
  },
  {
    key: 'outlierSigma', label: '单帧离群阈值', group: 'trust', type: 'range',
    min: 1.5, max: 8, step: 0.1, unit: 'σ',
  },
  {
    key: 'minValidFrames', label: '最少有效帧数', group: 'trust', type: 'number',
    min: 1, max: 32, step: 1, unit: '帧',
  },
  {
    key: 'deadPixelFraction', label: '坏点出现比例阈值', group: 'trust', type: 'range',
    min: 0.1, max: 1, step: 0.01,
  },
  {
    key: 'badPixelSigma', label: '空间坏点阈值', group: 'trust', type: 'range',
    min: 3, max: 40, step: 0.5, unit: 'σ',
  },
  {
    key: 'confidenceThreshold', label: '可信区阈值', group: 'trust', type: 'range',
    min: 0.2, max: 0.95, step: 0.01,
  },
  {
    key: 'gainModel', label: '增益模型', group: 'model', type: 'select',
    options: [
      { value: 'field', label: '稠密场（逐像素，基线）' },
      { value: 'grid', label: '网格插值（控制点 + 双线性）' },
      { value: 'basis', label: '受约束基函数（log 多项式）' },
    ],
    help: '三种表示共用同一观测与可信度模型；区别在增益场的存储与展开方式。网格在缺邻点时按跳数退化并降权，基函数无法表达的细小遮光会被标记为 MODEL_UNFIT 而不强行校正。',
  },
  {
    key: 'gridCellPx', label: '网格间距', group: 'model', type: 'range',
    min: 8, max: 128, step: 4, unit: 'px',
    help: '仅网格模型：控制点间距。过小会过拟合单帧噪声，过大会丢失局部遮光。',
  },
  {
    key: 'basisDegree', label: '基函数阶数', group: 'model', type: 'range',
    min: 1, max: 6, step: 1, unit: '阶',
    help: '仅基函数模型：log 增益的二维多项式总阶数，带岭正则与 IRLS 抗离群。',
  },
  {
    key: 'basisResidualSigma', label: '基函数残差阈值', group: 'model', type: 'range',
    min: 2, max: 10, step: 0.5, unit: 'σ',
    help: '仅基函数模型：观测增益与模型偏差超过该倍数时标记 MODEL_UNFIT 并降低可信度，不对这些像素强行校正。',
  },
  {
    key: 'requireRadiometryMatch', label: '同时要求 ISO/曝光一致', group: 'trust', type: 'select', inline: true,
    options: [
      { value: false, label: '否（仅要求几何与装置设置一致）' },
      { value: true, label: '是（ISO 与曝光也须匹配）' },
    ],
  },
  {
    key: 'radiometryTolerance', label: '辐射量匹配容差', group: 'trust', type: 'range',
    min: 0, max: 0.3, step: 0.01, inline: false,
  },
];

// Mandatory acquisition settings: a mismatch means the gain field is not
// applicable to the image. Radiometric fields are checked only when requested.
const SETTINGS_SCHEMA = [
  { key: 'device', label: '装置', type: 'string', mandatory: true },
  { key: 'lens', label: '镜头', type: 'string', mandatory: true },
  { key: 'aperture', label: '光圈', type: 'string', mandatory: true },
  { key: 'focalLengthMm', label: '焦距', type: 'number', unit: 'mm', mandatory: true },
  { key: 'zoom', label: '变焦位置', type: 'number', mandatory: true },
  { key: 'binning', label: '像素合并', type: 'number', mandatory: true },
  { key: 'focusDn', label: '对焦位置', type: 'number', mandatory: false },
  { key: 'iso', label: 'ISO', type: 'number', mandatory: false },
  { key: 'exposureMs', label: '曝光时间', type: 'number', unit: 'ms', mandatory: false },
];

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function validateOptions(input) {
  const out = Object.assign(cloneDefaults(), input || {});
  const errors = [];
  const numbers = {
    darkDn: [0, 65535], saturationFraction: [0.5, 1], lowSignalFactor: [1, 100],
    normalizationPercentile: [1, 99], normalizationDn: [1, 65535],
    maxGain: [1, 64], minGain: [0.001, 2], gainSmoothingPx: [0, 256],
    outlierSigma: [1, 12], minValidFrames: [1, 64], deadPixelFraction: [0.05, 1],
    badPixelSigma: [2, 100], confidenceThreshold: [0.1, 0.99],
    radiometryTolerance: [0, 0.5],
    gridCellPx: [8, 512], basisResidualSigma: [1.5, 20],
  };
  for (const [key, [lo, hi]] of Object.entries(numbers)) {
    const v = out[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${key} 必须是数值`);
    else if (v < lo || v > hi) errors.push(`${key} 超出允许范围 [${lo}, ${hi}]`);
  }
  if (!Number.isInteger(out.basisDegree) || out.basisDegree < 1 || out.basisDegree > 6) {
    errors.push('basisDegree 必须是 1..6 的整数');
  }
  if (!['field', 'grid', 'basis'].includes(out.gainModel)) errors.push('gainModel 非法');
  if (out.maxGain < 1) errors.push('maxGain 必须不小于 1');
  if (!['none', 'manual', 'darkFrames'].includes(out.darkMode)) errors.push('darkMode 非法');
  if (!['mean', 'median', 'percentile', 'fixed'].includes(out.normalizationMode)) {
    errors.push('normalizationMode 非法');
  }
  if (out.darkMode === 'manual' && !(out.darkDn >= 0)) errors.push('darkDn 必须 ≥ 0');
  out.requireRadiometryMatch = !!out.requireRadiometryMatch;
  return { ok: errors.length === 0, errors, options: out };
}

function describe() {
  return {
    defaults: cloneDefaults(),
    fields: FIELDS,
    settingsSchema: SETTINGS_SCHEMA,
    units: { dn: 'DN（数字计数）', gain: '倍率', sigma: '噪声标准差' },
  };
}

module.exports = { DEFAULTS, FIELDS, SETTINGS_SCHEMA, validateOptions, describe, cloneDefaults };
