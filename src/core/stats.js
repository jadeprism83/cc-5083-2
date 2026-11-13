'use strict';

// Robust statistics and separable filters used by the flat-field kernel.

function median(values) {
  if (values.length === 0) return NaN;
  const copy = Array.from(values).sort((a, b) => a - b);
  const mid = copy.length >> 1;
  return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2;
}

function medianInPlace(arr, n) {
  const view = arr.subarray(0, n);
  view.sort();
  const mid = n >> 1;
  return n % 2 ? view[mid] : (view[mid - 1] + view[mid]) / 2;
}

function percentileSorted(sorted, p) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mad(values, center) {
  const c = center === undefined ? median(values) : center;
  const dev = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i] - c);
  const m = median(Array.from(dev));
  return { mad: m, sigma: 1.4826 * m, center: c };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function meanOf(arr) {
  if (!arr.length) return NaN;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return { kernel, radius };
}

function blurH(src, dst, w, h, kernel, radius) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
        sum += src[row + xx] * kernel[k + radius];
      }
      dst[row + x] = sum;
    }
  }
}

function blurV(src, dst, w, h, kernel, radius) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
        sum += src[yy * w + x] * kernel[k + radius];
      }
      dst[y * w + x] = sum;
    }
  }
}

function gaussianBlur(src, w, h, sigma) {
  if (!(sigma > 0)) return Float32Array.from(src);
  const { kernel, radius } = gaussianKernel(sigma);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  blurH(src, tmp, w, h, kernel, radius);
  blurV(tmp, out, w, h, kernel, radius);
  return out;
}

// Normalized convolution over an arbitrary validity mask so invalid regions do
// not bleed into the smoothed field.
function maskedGaussianBlur(src, weight, w, h, sigma, treatWeightAsConfidence) {
  if (!(sigma > 0)) {
    const copy = Float32Array.from(src);
    return { values: copy, weight: Float32Array.from(weight) };
  }
  const { kernel, radius } = gaussianKernel(sigma);
  const v = new Float32Array(w * h);
  const wv = new Float32Array(w * h);
  for (let i = 0; i < v.length; i++) {
    const m = treatWeightAsConfidence ? weight[i] : weight[i] > 0 ? 1 : 0;
    v[i] = src[i] * m;
    wv[i] = m;
  }
  const tmpA = new Float32Array(w * h);
  const tmpB = new Float32Array(w * h);
  const outA = new Float32Array(w * h);
  const outB = new Float32Array(w * h);
  blurH(v, tmpA, w, h, kernel, radius);
  blurH(wv, tmpB, w, h, kernel, radius);
  blurV(tmpA, outA, w, h, kernel, radius);
  blurV(tmpB, outB, w, h, kernel, radius);
  const values = new Float32Array(w * h);
  const weights = new Float32Array(w * h);
  for (let i = 0; i < values.length; i++) {
    const denom = outB[i];
    weights[i] = denom;
    values[i] = denom > 1e-9 ? outA[i] / denom : 0;
  }
  return { values, weight: weights };
}

// 3x3 median, restricted to pixels that have usable source weight.
function median3Masked(src, weight, w, h) {
  const out = new Float32Array(w * h);
  const buf = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      let centreValid = false;
      const centre = y * w + x;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const idx = yy * w + xx;
          if (dx === 0 && dy === 0) centreValid = true;
          if (weight[idx] > 0) buf[n++] = src[idx];
        }
      }
      out[centre] = n >= 3 ? medianInPlace(buf, n) : src[centre];
      void centreValid;
    }
  }
  return out;
}

// White-noise estimate from the residual against a 3x3 box mean. The residual
// sigma is 0.943 * white sigma for an ideal boxcar, corrected below. Extended
// texture biases this upward; callers label it as a high-pass estimate.
function highPassNoiseSigma(src, w, h, mask) {
  const samples = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const idx = y * w + x;
      if (mask && mask[idx] <= 0) continue;
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * w + (x + dx);
          if (!mask || mask[j] > 0) {
            sum += src[j];
            n++;
          }
        }
      }
      if (n >= 5) samples.push(src[idx] - sum / n);
    }
  }
  if (samples.length < 16) return NaN;
  const abs = samples.map(Math.abs);
  const m = median(abs);
  return (1.4826 * m) / 0.943;
}

function quantileStats(arr, mask) {
  const values = [];
  const step = Math.max(1, Math.floor(Math.sqrt((arr.length) / 200000)));
  for (let i = 0; i < arr.length; i += step) {
    if (mask && mask[i] <= 0) continue;
    values.push(arr[i]);
  }
  if (!values.length) return { n: 0, mean: NaN, p1: NaN, p50: NaN, p99: NaN };
  values.sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return {
    n: values.length,
    mean: sum / values.length,
    p1: percentileSorted(values, 0.01),
    p50: percentileSorted(values, 0.5),
    p99: percentileSorted(values, 0.99),
    min: values[0],
    max: values[values.length - 1],
  };
}

module.exports = {
  median,
  medianInPlace,
  mad,
  percentileSorted,
  clamp,
  smoothstep,
  meanOf,
  gaussianBlur,
  maskedGaussianBlur,
  median3Masked,
  highPassNoiseSigma,
  quantileStats,
};
