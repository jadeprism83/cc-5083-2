'use strict';

// Synthetic ground truth for validating the flat-field chain.
//
// A known multiplicative response (vignetting + local occlusion) is imposed on
// a uniform illumination, degraded with read noise, hot/dead pixels and
// saturation. A separate target scene with its own texture is then captured
// through the same response. Because the truth is known, both the restored
// brightness and the noise amplification can be measured numerically.

const { encodePng, decodePng } = require('./png');

const DEFAULT_GEOMETRY = { width: 512, height: 384 };

// A few pinned sensor defects, present in only some frames so the per-pixel
// temporal combination has to reject them rather than average them in.
const DEFAULT_HOT_PIXELS = [
  [38, 64, 65000], [500, 52, 65535], [300, 300, 0], [214, 190, 64000],
];

// Deterministic Gaussian noise (Box-Muller with an xorshift RNG).
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function normal(rand) {
  let u = rand();
  let v = rand();
  if (u < 1e-12) u = 1e-12;
  const r = Math.sqrt(-2 * Math.log(u));
  return r * Math.cos(2 * Math.PI * v);
}

// Radial vignetting (cos^4-like falloff about an off-centre axis) plus a dust
// disc and a soft rectangular flap, both of which reduce local throughput.
function responseAt(x, y, geometry, response) {
  const w = geometry.width;
  const h = geometry.height;
  const vignette = response && Number.isFinite(response.vignette) ? response.vignette : 0;
  const cx = w * 0.52;
  const cy = h * 0.48;
  const nx = (x - cx) / (w * 0.5);
  const ny = (y - cy) / (h * 0.5);
  const r2 = nx * nx + ny * ny;
  const vign = 1 - vignette * Math.min(1, r2);
  const dustX = w * 0.3;
  const dustY = h * 0.32;
  const dustR = Math.min(w, h) * 0.06;
  const dist = Math.hypot(x - dustX, y - dustY);
  const dust = dist < dustR ? 0.45 : 1;
  const flapX0 = w * 0.7;
  const flapX1 = w * 0.9;
  const flapY0 = h * 0.6;
  const flapY1 = h * 0.82;
  let flap = 1;
  if (x >= flapX0 && x <= flapX1 && y >= flapY0 && y <= flapY1) flap = 0.35;
  return { gain: vign * dust * flap, vignetting: vign, dust, flap };
}

function makeUniformReference(geometry, lightLevel, response, noise, rand, options = {}) {
  const { width, height } = geometry;
  const data = new Float64Array(width * height);
  const truth = new Float64Array(width * height);
  const dark = options.darkLevel || 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const g = responseAt(x, y, geometry, response).gain;
      truth[p] = lightLevel * g;
      data[p] = dark + truth[p] + normal(rand) * noise;
    }
  }
  if (options.hotPixels) {
    for (const [x, y, value] of options.hotPixels) data[y * width + x] = value;
  }
  if (options.saturationLevel) {
    for (let p = 0; p < data.length; p++) {
      if (data[p] > options.saturationLevel) data[p] = options.saturationLevel;
    }
  }
  // A local patch driven into saturation, simulating a specular reflection or
  // a lamp inside the reference field.
  if (options.saturatedPatch) {
    const patch = options.saturatedPatch;
    for (let y = patch.y; y < patch.y + patch.h; y++) {
      for (let x = patch.x; x < patch.x + patch.w; x++) {
        data[y * width + x] = options.saturationLevel || 65535;
      }
    }
  }
  return { data, truth, width, height };
}

// A target scene carrying structure: drift texture, thin lines and an
// intensity wedge. The same response function multiplies it.
function makeTarget(opts) {
  const w = opts.width;
  const h = opts.height;
  const response = opts.response;
  const base = opts.baseLevel;
  const data = new Float64Array(w * h);
  const scene = new Float64Array(w * h);
  const rand = rng(opts.seed || 7);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let v = base;
      // Smooth broad texture plus fine detail.
      v += base * 0.08 * Math.sin((x / w) * Math.PI * 3.2) * Math.cos((y / h) * Math.PI * 2.1);
      v += base * 0.03 * Math.sin((x / w) * Math.PI * 31 + (y / h) * Math.PI * 17);
      // A vertical intensity wedge on the left third.
      if (x > w * 0.08 && x < w * 0.30) {
        v *= 0.55 + 0.9 * ((x - w * 0.08) / (w * 0.22));
      }
      // Thin bright strokes (a resolution chart) on the right.
      if (x > w * 0.62 && x < w * 0.82 && y > h * 0.2 && y < h * 0.45) {
        if (Math.floor((x - w * 0.62) / 4) % 2 === 0) v *= 1.6;
      }
      // Hard edge step to prove no smoothing of genuine edges.
      if (x > w * 0.55 && y > h * 0.55 && y < h * 0.78) v *= 0.5;
      // A small dark-but-nonzero patch to exercise bounded boost.
      if (x > w * 0.16 && y > h * 0.7 && x < w * 0.24 && y < h * 0.8) v *= 0.25;
      scene[p] = v;
      data[p] = (opts.darkLevel || 0) + v * responseAt(x, y, { width: w, height: h }, response).gain + normal(rand) * opts.noise;
    }
  }
  return { scene, data, width: w, height: h };
}

function clampImage(values, fullScale) {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.max(0, Math.min(fullScale, Math.round(values[i])));
  return out;
}

function toImage(values, geometry, bitDepth) {
  return {
    width: geometry.width,
    height: geometry.height,
    bitDepth,
    channels: 1,
    data: clampImage(values, bitDepth === 8 ? 255 : 65535),
  };
}

// Compose the exact documented scenario used by the validation report.
function buildScenario(params = {}) {
  const geometry = params.geometry || DEFAULT_GEOMETRY;
  const bitDepth = params.bitDepth || 16;
  const fullScale = bitDepth === 8 ? 255 : 65535;
  const lightLevel = params.lightLevel ?? (bitDepth === 8 ? 150 : 24000);
  const noise = params.noise ?? (bitDepth === 8 ? 1.6 : 420);
  const response = {
    vignette: params.vignette ?? 0.42,
    ...(params.response || {}),
  };
  const saturationLevel = params.saturationLevel ?? fullScale;
  const darkLevel = params.darkLevel ?? (bitDepth === 8 ? 4 : 700);
  const hotPixels = params.hotPixels ?? params.disableDefects ? null : DEFAULT_HOT_PIXELS;
  const saturatedPatch = params.saturatedPatch ?? params.disableDefects ? null : {
    x: Math.round(geometry.width * 0.84), y: Math.round(geometry.height * 0.1),
    w: Math.round(geometry.width * 0.07), h: Math.round(geometry.height * 0.1),
  };
  const referenceRand = rng(params.referenceSeed || 11);
  const refs = [];
  const refTruths = [];
  const nRefs = params.referenceFrames ?? 6;
  for (let i = 0; i < nRefs; i++) {
    const r = makeUniformReference(geometry, lightLevel, response, noise, referenceRand, {
      darkLevel,
      hotPixels: hotPixels && (i === 1 || i === 3) ? hotPixels : null,
      saturationLevel: saturationLevel,
      saturatedPatch,
    });
    refs.push(toImage(r.data, geometry, bitDepth));
    refTruths.push(r.truth);
  }
  const target = makeTarget({
    ...geometry,
    response,
    baseLevel: params.targetLevel ?? lightLevel,
    noise: params.targetNoise ?? noise,
    darkLevel,
    seed: params.targetSeed || 23,
  });
  const targetImage = toImage(target.data, geometry, bitDepth);

  const gainTruth = new Float32Array(geometry.width * geometry.height);
  for (let y = 0; y < geometry.height; y++) {
    for (let x = 0; x < geometry.width; x++) {
      gainTruth[y * geometry.width + x] = 1 / responseAt(x, y, geometry, response).gain;
    }
  }
  // The ideal corrected target: scene texture with no response and no noise.
  const idealCorrected = new Float64Array(geometry.width * geometry.height);
  for (let p = 0; p < idealCorrected.length; p++) {
    idealCorrected[p] = target.scene[p];
  }

  return {
    geometry, bitDepth, response, lightLevel, noise, darkLevel,
    hotPixels, saturatedPatch,
    references: refs, trueReference: toImage(refTruths[0], geometry, bitDepth),
    target: targetImage, targetScene: target.scene, idealCorrected,
    gainTruth,
    responseAt: (x, y) => responseAt(x, y, geometry, response),
  };
}

function encodeGray(image) {
  return encodePng(image);
}

module.exports = { buildScenario, responseAt, encodeGray, decodePng, rng, normal };
