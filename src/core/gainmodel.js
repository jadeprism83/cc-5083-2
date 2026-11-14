'use strict';

// Gain-field representations. The calibration pipeline produces per-pixel
// reliable gain observations (obsGain/weight/mask); a model turns those
// samples into a dense gain field plus a per-pixel model-confidence factor.
//
// Three kinds are kept switchable:
//   field  - dense per-pixel field (baseline): gain = basis/smoothed signal,
//            unsupported pixels stay at 1 and are flagged DEAD.
//   grid   - coarse control lattice + bilinear interpolation. Nodes with too
//            little support are filled from neighbours hop by hop; every hop
//            multiplies node confidence by HOP_CONFIDENCE, and pixels covered
//            by filled nodes are flagged GRID_DEGRADED. Nodes unreachable
//            within MAX_HOPS stay at gain 1 with confidence 0 (DEAD).
//   basis  - constrained polynomial basis: log(gain) is fitted with a
//            ridge-regularised, IRLS-robust weighted least squares, so the
//            model is strictly positive and smooth by construction. Structure
//            the basis cannot express (dust discs, small occluders) shows up
//            as fit residuals: pixels whose residual exceeds
//            basisResidualSigma robust sigmas are flagged MODEL_UNFIT, their
//            confidence is cut by UNFIT_CONFIDENCE, and the application stage
//            tapers their correction towards 1 instead of forcing a fit.

const { clamp, smoothstep } = require('./stats');

const HOP_CONFIDENCE = 0.7;
const MAX_HOPS = 8;
const MIN_NODE_SUPPORT = 3; // weighted samples needed for a direct grid node
const UNFIT_CONFIDENCE = 0.25;
const UNOBSERVED_BASIS_CONFIDENCE = 0.75; // model value without local observation
const BASIS_IRLS_ITERATIONS = 3;
const BASIS_RIDGE = 1e-4;

const MODEL_LABELS = {
  field: '稠密场',
  grid: '网格插值',
  basis: '受约束基函数',
};

// ---------------------------------------------------------------------------
// shared sample container

// observations: {
//   obsGain: Float32Array (valid where mask=1), weight: Float32Array,
//   mask: Uint8Array (reliable samples), supported: Uint8Array,
//   baseConfidence: Float32Array (existing observation-quality confidence),
//   basisSignal: number
// }

// ---------------------------------------------------------------------------
// field (baseline): reproduces the historical dense behaviour exactly.

function fitFieldModel(obs, width, height) {
  const n = width * height;
  const gain = new Float32Array(n);
  const modelConf = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    if (obs.supported[p]) {
      gain[p] = obs.obsGain[p];
      modelConf[p] = 1;
    } else {
      gain[p] = 1;
      modelConf[p] = 0;
    }
  }
  return {
    kind: 'field',
    gain,
    modelConfidence: modelConf,
    modelFlags: null,
    modelData: { kind: 'field' },
    stats: { denseOnly: true },
  };
}

// ---------------------------------------------------------------------------
// grid

function gridGeometry(width, height, cellPx) {
  const cols = Math.max(2, Math.round(width / cellPx));
  const rows = Math.max(2, Math.round(height / cellPx));
  return { cols, rows, sx: (width - 1) / (cols - 1), sy: (height - 1) / (rows - 1) };
}

// Node estimate: weighted MEDIAN of the reliable observations inside the
// support window. A mean averages across sharp occlusion edges (a dust disc
// or flap boundary inside the window drags the estimate toward the brighter
// side); the median follows the majority side and keeps local shadows local.
function weightedMedian(values, weights, count) {
  const order = new Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => values[a] - values[b]);
  let total = 0;
  for (let i = 0; i < count; i++) total += weights[i];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += weights[order[i]];
    if (acc >= total / 2) return values[order[i]];
  }
  return values[order[count - 1]];
}

function fitGridNodes(obs, width, height, geo) {
  const { cols, rows, sx, sy } = geo;
  const radius = 1.5 * Math.max(sx, sy);
  const r2 = radius * radius;
  const nodeValue = new Float32Array(cols * rows);
  const nodeSupport = new Float32Array(cols * rows);
  const cap = Math.ceil(Math.PI * r2) + 16;
  const values = new Float32Array(cap);
  const weights = new Float32Array(cap);
  for (let gy = 0; gy < rows; gy++) {
    const ny = gy * sy;
    for (let gx = 0; gx < cols; gx++) {
      const nx = gx * sx;
      let count = 0;
      let wsum = 0;
      const x0 = Math.max(0, Math.floor(nx - radius));
      const x1 = Math.min(width - 1, Math.ceil(nx + radius));
      const y0 = Math.max(0, Math.floor(ny - radius));
      const y1 = Math.min(height - 1, Math.ceil(ny + radius));
      for (let y = y0; y <= y1; y++) {
        const dy = y - ny;
        for (let x = x0; x <= x1; x++) {
          const p = y * width + x;
          if (!obs.mask[p]) continue;
          const dx = x - nx;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const tent = 1 - Math.sqrt(d2) / radius;
          const w = obs.weight[p] * tent;
          if (count < cap) {
            values[count] = obs.obsGain[p];
            weights[count] = w;
            count++;
          }
          wsum += w;
        }
      }
      const idx = gy * cols + gx;
      nodeSupport[idx] = wsum;
      nodeValue[idx] = count ? weightedMedian(values, weights, count) : 0;
    }
  }
  return { nodeValue, nodeSupport };
}

// Hop-fill invalid nodes from valid ones. Returns per-node hop distance
// (0 = direct estimate) and the filled values.
function fillGridNodes(nodeValue, nodeSupport, cols, rows) {
  const hops = new Int16Array(cols * rows).fill(-1);
  const values = Float32Array.from(nodeValue);
  let frontier = [];
  let direct = 0;
  let maxSupport = 0;
  for (let i = 0; i < cols * rows; i++) {
    if (nodeSupport[i] >= MIN_NODE_SUPPORT) {
      hops[i] = 0;
      frontier.push(i);
      direct++;
      if (nodeSupport[i] > maxSupport) maxSupport = nodeSupport[i];
    }
  }
  let hop = 0;
  while (frontier.length && hop < MAX_HOPS) {
    hop++;
    const next = [];
    for (const idx of frontier) {
      const gx = idx % cols;
      const gy = Math.floor(idx / cols);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x = gx + dx;
          const y = gy + dy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const j = y * cols + x;
          if (hops[j] !== -1) continue;
          hops[j] = hop;
          next.push(j);
        }
      }
    }
    // A node filled at this hop takes the mean of the previous hop's values.
    for (const j of next) {
      const gx = j % cols;
      const gy = Math.floor(j / cols);
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const k = y * cols + x;
          if (hops[k] === hop - 1) { sum += values[k]; n++; }
        }
      }
      values[j] = n ? sum / n : 1;
    }
    frontier = next;
  }
  let dead = 0;
  for (let i = 0; i < cols * rows; i++) {
    if (hops[i] === -1) { values[i] = 1; dead++; }
  }
  return { values, hops, direct, filled: cols * rows - direct - dead, dead, maxSupport };
}

function fitGridModel(obs, width, height, params) {
  const cellPx = params.gridCellPx;
  const geo = gridGeometry(width, height, cellPx);
  const { cols, rows, sx, sy } = geo;
  const { nodeValue, nodeSupport } = fitGridNodes(obs, width, height, geo);
  const filled = fillGridNodes(nodeValue, nodeSupport, cols, rows);

  const nodeConf = new Float32Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    if (filled.hops[i] === -1) { nodeConf[i] = 0; continue; }
    const supportFactor = filled.maxSupport > 0
      ? smoothstep(0.05, 0.35, nodeSupport[i] / filled.maxSupport)
      : 0;
    const direct = filled.hops[i] === 0 ? Math.max(0.25, supportFactor) : 0;
    nodeConf[i] = filled.hops[i] === 0
      ? direct
      : Math.pow(HOP_CONFIDENCE, filled.hops[i]);
  }

  const n = width * height;
  const gain = new Float32Array(n);
  const modelConf = new Float32Array(n);
  const modelFlags = new Uint8Array(n); // bit0: degraded, bit1: dead
  let degradedPixels = 0;
  let deadPixels = 0;
  for (let y = 0; y < height; y++) {
    const fy = clamp(y / sy, 0, rows - 1 - 1e-9);
    const y0 = Math.floor(fy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const fx = clamp(x / sx, 0, cols - 1 - 1e-9);
      const x0 = Math.floor(fx);
      const x1 = Math.min(cols - 1, x0 + 1);
      const tx = fx - x0;
      const i00 = y0 * cols + x0;
      const i10 = y0 * cols + x1;
      const i01 = y1 * cols + x0;
      const i11 = y1 * cols + x1;
      const g0 = filled.values[i00] * (1 - tx) + filled.values[i10] * tx;
      const g1 = filled.values[i01] * (1 - tx) + filled.values[i11] * tx;
      gain[p] = g0 * (1 - ty) + g1 * ty;
      const c0 = nodeConf[i00] * (1 - tx) + nodeConf[i10] * tx;
      const c1 = nodeConf[i01] * (1 - tx) + nodeConf[i11] * tx;
      modelConf[p] = c0 * (1 - ty) + c1 * ty;
      const maxHop = Math.max(filled.hops[i00], filled.hops[i10], filled.hops[i01], filled.hops[i11]);
      const minHop = Math.min(filled.hops[i00], filled.hops[i10], filled.hops[i01], filled.hops[i11]);
      if (minHop === -1) { modelFlags[p] |= 2; deadPixels++; }
      else if (maxHop >= 1) { modelFlags[p] |= 1; degradedPixels++; }
    }
  }

  return {
    kind: 'grid',
    gain,
    modelConfidence: modelConf,
    modelFlags,
    modelData: {
      kind: 'grid',
      cellPx,
      cols,
      rows,
      nodes: Array.from(filled.values, (v) => Number(v.toFixed(6))),
    },
    stats: {
      cellPx,
      cols,
      rows,
      directNodes: filled.direct,
      filledNodes: filled.filled,
      deadNodes: filled.dead,
      degradedPixelFraction: degradedPixels / n,
      deadPixelFraction: deadPixels / n,
    },
  };
}

// ---------------------------------------------------------------------------
// basis

function basisTerms(degree) {
  const terms = [];
  for (let order = 0; order <= degree; order++) {
    for (let i = order; i >= 0; i--) {
      terms.push({ px: i, py: order - i, order });
    }
  }
  return terms;
}

function evalBasis(terms, u, v) {
  const out = new Float64Array(terms.length);
  for (let i = 0; i < terms.length; i++) out[i] = Math.pow(u, terms[i].px) * Math.pow(v, terms[i].py);
  return out;
}

// Weighted ridge-regularised least squares on log(gain), solved by Gaussian
// elimination with partial pivoting. IRLS re-weights residual outliers so a
// dust disc or flap does not drag the global surface.
function fitBasisCoefficients(obs, width, height, terms) {
  const m = terms.length;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const su = 2 / Math.max(1, width - 1);
  const sv = 2 / Math.max(1, height - 1);
  const phi = new Float64Array(m);
  const residuals = new Float64Array(width * height);
  let weights = obs.weight;
  let coefficients = new Float64Array(m);

  for (let iter = 0; iter < BASIS_IRLS_ITERATIONS; iter++) {
    const A = new Float64Array(m * m);
    const b = new Float64Array(m);
    for (let y = 0; y < height; y++) {
      const v = (y - cy) * sv;
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!obs.mask[p]) continue;
        const w = weights[p];
        if (w <= 0) continue;
        const u = (x - cx) * su;
        for (let i = 0; i < m; i++) phi[i] = Math.pow(u, terms[i].px) * Math.pow(v, terms[i].py);
        const logG = Math.log(obs.obsGain[p]);
        for (let i = 0; i < m; i++) {
          b[i] += w * phi[i] * logG;
          for (let j = 0; j <= i; j++) A[i * m + j] += w * phi[i] * phi[j];
        }
      }
    }
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < i; j++) A[j * m + i] = A[i * m + j];
      // Higher-order terms are damped more strongly: the constraint that
      // keeps the basis "constrained" instead of a free polynomial.
      A[i * m + i] += BASIS_RIDGE * (1 + terms[i].order * terms[i].order);
    }
    coefficients = solveSymmetric(A, b, m);
    if (!coefficients) return null;

    if (iter === BASIS_IRLS_ITERATIONS - 1) break;
    // Robust residual scale from the current fit.
    let count = 0;
    for (let p = 0; p < width * height; p++) {
      if (!obs.mask[p]) continue;
      const x = p % width;
      const y = Math.floor(p / width);
      const u = (x - cx) * su;
      const v = (y - cy) * sv;
      for (let i = 0; i < m; i++) phi[i] = Math.pow(u, terms[i].px) * Math.pow(v, terms[i].py);
      let fit = 0;
      for (let i = 0; i < m; i++) fit += coefficients[i] * phi[i];
      residuals[count++] = Math.log(obs.obsGain[p]) - fit;
    }
    const sigma = robustSigma(residuals, count);
    const k = 2.5 * Math.max(sigma, 1e-3);
    const reweighted = new Float32Array(weights.length);
    for (let p = 0; p < width * height; p++) {
      if (!obs.mask[p]) continue;
      const x = p % width;
      const y = Math.floor(p / width);
      const u = (x - cx) * su;
      const v = (y - cy) * sv;
      let fit = 0;
      for (let i = 0; i < m; i++) fit += coefficients[i] * Math.pow(u, terms[i].px) * Math.pow(v, terms[i].py);
      const r = Math.abs(Math.log(obs.obsGain[p]) - fit);
      // Huber-style: full weight inside k, 1/r beyond.
      reweighted[p] = obs.weight[p] * (r <= k ? 1 : k / r);
    }
    weights = reweighted;
  }
  return { coefficients, terms };
}

function solveSymmetric(A, b, n) {
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r * n + col]) > Math.abs(M[pivot * n + col])) pivot = r;
    }
    if (Math.abs(M[pivot * n + col]) < 1e-12) return null;
    if (pivot !== col) {
      for (let j = 0; j < n; j++) {
        const t = M[col * n + j];
        M[col * n + j] = M[pivot * n + j];
        M[pivot * n + j] = t;
      }
      const t = x[col];
      x[col] = x[pivot];
      x[pivot] = t;
    }
    const d = M[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / d;
      if (f === 0) continue;
      for (let j = col; j < n; j++) M[r * n + j] -= f * M[col * n + j];
      x[r] -= f * x[col];
    }
  }
  const out = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let j = r + 1; j < n; j++) s -= M[r * n + j] * out[j];
    out[r] = s / M[r * n + r];
  }
  return out;
}

function robustSigma(values, count) {
  const slice = Array.from(values.subarray(0, count)).sort((a, b) => a - b);
  if (!slice.length) return 1e-3;
  const med = slice[Math.floor(slice.length / 2)];
  const dev = slice.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return Math.max(1.4826 * dev[Math.floor(dev.length / 2)], 1e-3);
}

function fitBasisModel(obs, width, height, params) {
  const degree = params.basisDegree;
  const terms = basisTerms(degree);
  const fit = fitBasisCoefficients(obs, width, height, terms);
  const n = width * height;
  if (!fit) {
    // Singular system: fall back to unit gain everywhere, confidence zero.
    return {
      kind: 'basis',
      gain: new Float32Array(n).fill(1),
      modelConfidence: new Float32Array(n),
      modelFlags: new Uint8Array(n).fill(2),
      modelData: { kind: 'basis', degree, terms: terms.length, singular: true, coefficients: [] },
      stats: { degree, terms: terms.length, singular: true, unfitFraction: 1, residualSigmaLog: NaN },
    };
  }
  const { coefficients } = fit;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const su = 2 / Math.max(1, width - 1);
  const sv = 2 / Math.max(1, height - 1);

  const gain = new Float32Array(n);
  const modelConf = new Float32Array(n);
  const modelFlags = new Uint8Array(n); // bit0: MODEL_UNFIT, bit1: dead(unused)
  const phi = new Float64Array(terms.length);
  for (let y = 0; y < height; y++) {
    const v = (y - cy) * sv;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const u = (x - cx) * su;
      for (let i = 0; i < terms.length; i++) phi[i] = Math.pow(u, terms[i].px) * Math.pow(v, terms[i].py);
      let logG = 0;
      for (let i = 0; i < terms.length; i++) logG += coefficients[i] * phi[i];
      gain[p] = Math.exp(clamp(logG, -4, 4));
    }
  }

  // Residual policy: reliable observations that the smooth basis cannot
  // express are flagged MODEL_UNFIT and their confidence is cut. The
  // application stage tapers their correction towards 1 - the occluder is
  // reported, not forcibly corrected by a model that cannot represent it.
  const residualLog = [];
  for (let p = 0; p < n; p++) {
    if (obs.mask[p]) residualLog.push(Math.log(obs.obsGain[p]) - Math.log(gain[p]));
  }
  const sigmaLog = residualLog.length ? robustSigma(Float64Array.from(residualLog), residualLog.length) : 1e-3;
  const limit = params.basisResidualSigma * sigmaLog;
  let unfit = 0;
  let observedCount = 0;
  for (let p = 0; p < n; p++) {
    if (obs.mask[p]) {
      observedCount++;
      const r = Math.abs(Math.log(obs.obsGain[p]) - Math.log(gain[p]));
      if (r > limit) {
        modelFlags[p] |= 1;
        modelConf[p] = UNFIT_CONFIDENCE;
        unfit++;
      } else {
        modelConf[p] = 1;
      }
    } else {
      modelConf[p] = UNOBSERVED_BASIS_CONFIDENCE;
    }
  }

  return {
    kind: 'basis',
    gain,
    modelConfidence: modelConf,
    modelFlags,
    modelData: {
      kind: 'basis',
      degree,
      terms: terms.map((t) => [t.px, t.py]),
      coefficients: Array.from(coefficients, (c) => Number(c.toFixed(8))),
      residualSigmaLog: Number(sigmaLog.toFixed(6)),
    },
    stats: {
      degree,
      terms: terms.length,
      singular: false,
      residualSigmaLog: sigmaLog,
      unfitFraction: observedCount ? unfit / n : 0,
      unfitPixels: unfit,
    },
  };
}

// ---------------------------------------------------------------------------

function fitGainModel(kind, obs, width, height, params) {
  if (kind === 'grid') return fitGridModel(obs, width, height, params);
  if (kind === 'basis') return fitBasisModel(obs, width, height, params);
  return fitFieldModel(obs, width, height);
}

// Re-expand a stored compact model (model.json) into a dense field. Used to
// verify saved calibrations and by the recompute tool.
function expandModelData(modelData, width, height) {
  if (!modelData || modelData.kind === 'field') return null;
  if (modelData.kind === 'grid') {
    const { cols, rows, nodes } = modelData;
    const sx = (width - 1) / (cols - 1);
    const sy = (height - 1) / (rows - 1);
    const gain = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const fy = clamp(y / sy, 0, rows - 1 - 1e-9);
      const y0 = Math.floor(fy);
      const y1 = Math.min(rows - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < width; x++) {
        const fx = clamp(x / sx, 0, cols - 1 - 1e-9);
        const x0 = Math.floor(fx);
        const x1 = Math.min(cols - 1, x0 + 1);
        const tx = fx - x0;
        const g0 = nodes[y0 * cols + x0] * (1 - tx) + nodes[y0 * cols + x1] * tx;
        const g1 = nodes[y1 * cols + x0] * (1 - tx) + nodes[y1 * cols + x1] * tx;
        gain[y * width + x] = g0 * (1 - ty) + g1 * ty;
      }
    }
    return gain;
  }
  if (modelData.kind === 'basis') {
    const terms = modelData.terms.map(([px, py]) => ({ px, py }));
    const coefficients = modelData.coefficients;
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const su = 2 / Math.max(1, width - 1);
    const sv = 2 / Math.max(1, height - 1);
    const gain = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const v = (y - cy) * sv;
      for (let x = 0; x < width; x++) {
        const u = (x - cx) * su;
        let logG = 0;
        for (let i = 0; i < terms.length; i++) {
          logG += coefficients[i] * Math.pow(u, terms[i].px) * Math.pow(v, terms[i].py);
        }
        gain[y * width + x] = Math.exp(clamp(logG, -4, 4));
      }
    }
    return gain;
  }
  return null;
}

function modelSizeBytes(kind, modelData, densePixels, channels) {
  const denseBytes = densePixels * channels * 4;
  if (kind === 'grid' && modelData) {
    return { modelBytes: modelData.nodes.length * 4, denseBytes };
  }
  if (kind === 'basis' && modelData) {
    return { modelBytes: modelData.coefficients.length * 8, denseBytes };
  }
  return { modelBytes: denseBytes, denseBytes };
}

module.exports = {
  fitGainModel,
  expandModelData,
  modelSizeBytes,
  gridGeometry,
  MODEL_LABELS,
  HOP_CONFIDENCE,
  MAX_HOPS,
  MIN_NODE_SUPPORT,
  UNFIT_CONFIDENCE,
};
