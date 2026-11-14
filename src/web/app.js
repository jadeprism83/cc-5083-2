// Flat-field UI. This module only edits parameters and renders what the
// kernel returns over HTTP; no correction maths lives here.

const state = {
  optionsMeta: null,
  options: {},
  demo: null,
  demoRefsSelected: new Set(),
  uploadToken: null,
  refUploads: [],
  refSource: 'demo',
  targetSource: 'demo',
  demoTargetSelected: null,
  targetUpload: null,
  settingsText: '',
  targetVariant: 'match',
  calibrationId: null,
  calibration: null,
  preview: null,
  view: 'split',
  images: null,
  profileRow: null,
  exportSelected: new Set(),
  busy: false,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function toast(message, kind = '') {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast show ' + kind;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.className = 'toast ' + kind; }, 4200);
}

function setStatus(text, kind = '') {
  $('statusText').textContent = text;
  $('statusDot').className = 'status-dot ' + kind;
}

function setBusy(busy, label) {
  state.busy = busy;
  $('calibrateButton').disabled = busy;
  $('validateButton').disabled = busy;
  $('exportButton').disabled = busy || !state.calibrationId;
  $('calibrateButton').innerHTML = busy ? '<span class="spin"></span> ' + (label || '处理中') : '估计增益';
  if (busy) setStatus(label || '处理中', 'busy');
}

async function api(path, body, method = 'POST') {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`服务返回非 JSON（HTTP ${response.status}）`);
  }
  data.httpStatus = response.status;
  return data;
}

function pngDataUrl(image) {
  return 'data:image/png;base64,' + image.png;
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return '—';
  return Number(value).toFixed(digits);
}

function fmtPercent(fraction) {
  return Number.isFinite(fraction) ? (fraction * 100).toFixed(1) + '%' : '—';
}

/* ---------------- options metadata -> controls ---------------- */

function buildOptionsUi() {
  const { fields, defaults } = state.optionsMeta;
  state.options = { ...defaults };
  const groups = {
    radiometry: $('radiometryFields'), normalization: $('radiometryFields'),
    gain: $('gainFields'), trust: $('gainFields'), model: $('modelFields'),
  };
  groups.radiometry.innerHTML = '';
  groups.gain.innerHTML = '';
  groups.model.innerHTML = '';
  for (const field of fields) {
    const target = groups[field.group];
    if (!target) continue;
    const wrap = el('div', 'field' + (field.inline ? ' inline' : ''));
    const head = el('div', 'field-head');
    const label = el('label', '', field.label);
    label.htmlFor = 'opt-' + field.key;
    head.appendChild(label);
    const valueEl = el('span', 'field-value', '');
    head.appendChild(valueEl);
    wrap.appendChild(head);

    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      for (const opt of field.options) {
        const option = document.createElement('option');
        option.value = String(opt.value);
        option.textContent = opt.label;
        input.appendChild(option);
      }
      input.value = String(state.options[field.key]);
      input.addEventListener('change', () => {
        state.options[field.key] = field.key === 'requireRadiometryMatch' ? input.value === 'true' : input.value;
        updateFieldValue(field, valueEl);
        maybeAutoPreview();
      });
    } else if (field.type === 'range' || field.type === 'number') {
      input = document.createElement('input');
      input.type = field.type;
      input.min = field.min;
      input.max = field.max;
      input.step = field.step;
      input.value = state.options[field.key];
      input.addEventListener('input', () => {
        const n = Number(input.value);
        if (Number.isFinite(n)) state.options[field.key] = n;
        updateFieldValue(field, valueEl);
        const row = $('profileRow');
        if (row) row.value = row.value;
      });
      input.addEventListener('change', () => maybeAutoPreview());
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.value = state.options[field.key];
      input.addEventListener('change', () => {
        state.options[field.key] = Number(input.value);
        updateFieldValue(field, valueEl);
        maybeAutoPreview();
      });
    }
    input.id = 'opt-' + field.key;
    wrap.appendChild(input);
    if (field.help) wrap.appendChild(el('div', 'help', field.help));
    if (field.key === 'normalizationDn' || field.key === 'normalizationPercentile' || field.key === 'darkDn') {
      input.dataset.dependent = 'normalization';
    }
    updateFieldValue(field, valueEl);
    target.appendChild(wrap);
  }
  syncDependentFields();
}

function updateFieldValue(field, node) {
  const v = state.options[field.key];
  if (field.type === 'range' || field.type === 'number') {
    const digits = field.step && field.step < 0.01 ? 3 : field.step && field.step < 1 ? 2 : 0;
    node.textContent = fmt(v, digits) + (field.unit ? ' ' + field.unit : '');
  } else if (field.type === 'select') {
    const opt = field.options.find((o) => String(o.value) === String(v));
    node.textContent = opt ? opt.label : String(v);
  }
  syncDependentFields();
}

function syncDependentFields() {
  const mode = state.options.normalizationMode;
  const pct = $('opt-normalizationPercentile');
  const dn = $('opt-normDn') || $('opt-normalizationDn');
  const darkDn = $('opt-darkDn');
  if (pct) pct.closest('.field').style.opacity = mode === 'percentile' ? '1' : '0.45';
  if (dn) dn.closest('.field').style.opacity = mode === 'fixed' ? '1' : '0.45';
  if (darkDn) darkDn.closest('.field').style.opacity = state.options.darkMode === 'manual' ? '1' : '0.45';
  const model = state.options.gainModel;
  const gridCell = $('opt-gridCellPx');
  const basisDegree = $('opt-basisDegree');
  const basisResidual = $('opt-basisResidualSigma');
  if (gridCell) gridCell.closest('.field').style.opacity = model === 'grid' ? '1' : '0.45';
  if (basisDegree) basisDegree.closest('.field').style.opacity = model === 'basis' ? '1' : '0.45';
  if (basisResidual) basisResidual.closest('.field').style.opacity = model === 'basis' ? '1' : '0.45';
}

/* ---------------- demo + uploads ---------------- */

async function loadDemo() {
  const data = await api('/api/demo', null, 'GET');
  if (!data.ok) { toast(data.error || '演示数据不可用', 'bad'); return; }
  state.demo = data;
  state.demoRefsSelected = new Set(data.references);
  state.demoTargetSelected = data.targets.find((t) => t.startsWith('target_0')) || data.targets[0];
  state.settingsText = JSON.stringify(data.referenceSettings || {}, null, 2);
  $('referenceSettings').value = state.settingsText;
  renderDemoRefs();
  renderDemoTargets();
  renderExportTargets();
}

function renderDemoRefs() {
  const list = $('demoReferenceList');
  list.innerHTML = '';
  for (const name of state.demo.references) {
    const item = el('label', 'file-item' + (state.demoRefsSelected.has(name) ? ' selected' : ''));
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.demoRefsSelected.has(name);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.demoRefsSelected.add(name);
      else state.demoRefsSelected.delete(name);
      item.classList.toggle('selected', checkbox.checked);
    });
    item.appendChild(checkbox);
    const thumb = el('span', 'thumb');
    thumb.style.backgroundImage = `url("/data/references/${encodeURIComponent(name)}")`;
    item.appendChild(thumb);
    item.appendChild(el('span', '', name));
    item.appendChild(el('span', 'meta', '16-bit'));
    list.appendChild(item);
  }
}

function renderDemoTargets() {
  const list = $('demoTargetList');
  list.innerHTML = '';
  for (const name of state.demo.targets) {
    if (!name.startsWith('target_')) continue;
    const item = el('label', 'file-item' + (state.demoTargetSelected === name ? ' selected' : ''));
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'demo-target';
    radio.checked = state.demoTargetSelected === name;
    radio.addEventListener('change', () => {
      state.demoTargetSelected = name;
      renderDemoTargets();
      preview();
    });
    item.appendChild(radio);
    const thumb = el('span', 'thumb');
    thumb.style.backgroundImage = `url("/data/targets/${encodeURIComponent(name)}")`;
    item.appendChild(thumb);
    item.appendChild(el('span', '', name));
    list.appendChild(item);
  }
}

function renderExportTargets() {
  const list = $('exportTargetList');
  list.innerHTML = '';
  if (!state.demo) return;
  for (const name of state.demo.targets) {
    if (!name.startsWith('target_')) continue;
    const item = el('label', 'file-item' + (state.exportSelected.has(name) ? ' selected' : ''));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.exportSelected.has(name);
    cb.addEventListener('change', () => {
      if (cb.checked) state.exportSelected.add(name);
      else state.exportSelected.delete(name);
      item.classList.toggle('selected', cb.checked);
    });
    item.appendChild(cb);
    item.appendChild(el('span', '', name));
    if (name.includes('wrong_size')) item.appendChild(el('span', 'meta', '尺寸不符'));
    list.appendChild(item);
  }
}

async function ensureUploadSession() {
  if (state.uploadToken) return state.uploadToken;
  const data = await api('/api/uploads', {});
  if (!data.ok) throw new Error(data.error || '无法建立上传会话');
  state.uploadToken = data.token;
  return state.uploadToken;
}

async function uploadFile(file, multiple) {
  const token = await ensureUploadSession();
  const response = await fetch(`/api/uploads/file?token=${encodeURIComponent(token)}&name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || `上传 ${file.name} 失败`);
  void multiple;
  return data.file;
}

function wireUploads() {
  const refInput = $('refFileInput');
  $('refDropzone').addEventListener('click', () => refInput.click());
  refInput.addEventListener('change', async () => {
    for (const file of refInput.files) {
      try {
        const info = await uploadFile(file, true);
        state.refUploads.push(info);
      } catch (err) { toast(err.message, 'bad'); }
    }
    refInput.value = '';
    renderRefUploads();
  });

  const targetInput = $('targetFileInput');
  $('targetDropzone').addEventListener('click', () => targetInput.click());
  targetInput.addEventListener('change', async () => {
    if (!targetInput.files.length) return;
    try {
      state.targetUpload = await uploadFile(targetInput.files[0], false);
      renderTargetUpload();
      await preview();
    } catch (err) { toast(err.message, 'bad'); }
    targetInput.value = '';
  });

  for (const [zone, input] of [[$('refDropzone'), refInput], [$('targetDropzone'), targetInput]]) {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (input === refInput) {
        for (const file of e.dataTransfer.files) {
          try { state.refUploads.push(await uploadFile(file, true)); } catch (err) { toast(err.message, 'bad'); }
        }
        renderRefUploads();
      } else if (e.dataTransfer.files[0]) {
        try {
          state.targetUpload = await uploadFile(e.dataTransfer.files[0], false);
          renderTargetUpload();
          await preview();
        } catch (err) { toast(err.message, 'bad'); }
      }
    });
  }
}

function renderRefUploads() {
  const list = $('refUploads');
  list.innerHTML = '';
  if (!state.refUploads.length) { list.appendChild(el('div', 'hint', '尚未上传参考图')); return; }
  state.refUploads.forEach((file, index) => {
    const row = el('div', 'upload-row');
    row.appendChild(el('span', 'name', file.name));
    row.appendChild(el('span', 'meta', `${file.width}×${file.height} · ${file.bitDepth} 位`));
    const remove = el('button', 'ghost remove', '移除');
    remove.type = 'button';
    remove.addEventListener('click', () => { state.refUploads.splice(index, 1); renderRefUploads(); });
    row.appendChild(remove);
    list.appendChild(row);
  });
}

function renderTargetUpload() {
  const box = $('targetUploads');
  box.innerHTML = '';
  if (!state.targetUpload) { box.appendChild(el('div', 'hint', '尚未上传目标图')); return; }
  const row = el('div', 'upload-row');
  row.appendChild(el('span', 'name', state.targetUpload.name));
  row.appendChild(el('span', 'meta', `${state.targetUpload.width}×${state.targetUpload.height} · ${state.targetUpload.bitDepth} 位`));
  box.appendChild(row);
}

function applySourceSwitch() {
  document.querySelectorAll('[data-source]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.source === state.refSource);
    btn.setAttribute('aria-selected', String(btn.dataset.source === state.refSource));
  });
  $('demoReferenceList').classList.toggle('hidden', state.refSource !== 'demo');
  $('uploadReferenceArea').classList.toggle('hidden', state.refSource !== 'upload');

  document.querySelectorAll('[data-target]').forEach((btn) => {
    const mode = btn.dataset.target;
    btn.classList.toggle('active', mode === state.targetSource);
    btn.setAttribute('aria-selected', String(mode === state.targetSource));
  });
  $('demoTargetList').classList.toggle('hidden', state.targetSource !== 'demo');
  $('uploadTargetArea').classList.toggle('hidden', state.targetSource !== 'upload');
}

/* ---------------- calibration ---------------- */

function calibrationRequest() {
  const sources = {};
  if (state.refSource === 'demo') {
    sources.demo = true;
    sources.demoReferences = [...state.demoRefsSelected];
    sources.demoDarkFrames = [];
  } else {
    sources.uploads = state.refUploads.map((f) => f.token);
    sources.uploadToken = state.uploadToken;
  }
  let settings;
  try {
    settings = JSON.parse($('referenceSettings').value);
  } catch (err) {
    throw new Error('采集设置不是合法 JSON：' + err.message);
  }
  return {
    sources,
    uploadToken: state.uploadToken,
    settings,
    options: state.options,
    label: state.refSource === 'demo' ? '演示参考组' : '上传参考组',
  };
}

async function calibrate() {
  if (state.busy) return;
  let payload;
  try {
    payload = calibrationRequest();
  } catch (err) {
    toast(err.message, 'bad');
    setStatus('参数无效', 'bad');
    return;
  }
  if (state.refSource === 'demo' && payload.sources.demoReferences.length < 2) {
    toast('请至少选择 2 张参考图', 'bad');
    setStatus('参考不足', 'bad');
    return;
  }
  if (state.refSource === 'upload' && state.refUploads.length < 2) {
    toast('请至少上传 2 张参考图', 'bad');
    setStatus('参考不足', 'bad');
    return;
  }
  setBusy(true, '正在估计增益');
  try {
    const data = await api('/api/calibrate', payload);
    if (!data.ok) {
      setStatus(data.error || '标定失败', 'bad');
      renderCalibrationError(data);
      toast((data.error || '标定失败') + (data.details && data.details.length ? '：' + data.details[0] : ''), 'bad');
      return;
    }
    state.calibrationId = data.calibrationId;
    state.calibration = data;
    state.preview = null;
    state.exportSelected = new Set(state.demo ? state.demo.targets.filter((t) => t.startsWith('target_')) : []);
    renderCalibration(data);
    setStatus('标定完成 · ' + gainModelLabel(data.summary) + ' · ' + data.summary.referenceCount + ' 帧参考', 'ok');
    toast('增益已估计，可信区 ' + fmtPercent(data.summary.summary.trustedFraction), 'ok');
    $('exportButton').disabled = false;
    renderExportTargets();
    await preview();
  } catch (err) {
    setStatus('标定失败', 'bad');
    toast(err.message, 'bad');
  } finally {
    setBusy(false);
  }
}

function renderCalibrationError(data) {
  state.calibration = null;
  state.calibrationId = null;
  renderAnomalies([]);
  $('diagnosticHint').textContent = '标定未完成。';
  const text = $('diagnosticText');
  text.innerHTML = '';
  const block = el('div', 'diag-block');
  block.appendChild(el('h3', '', '标定反馈'));
  const ul = el('ul', 'error-list');
  for (const detail of data.details || [data.error]) ul.appendChild(el('li', '', detail));
  block.appendChild(ul);
  text.appendChild(block);
  $('metricTrust').textContent = '—';
  $('metricGain').textContent = '—';
  $('metricMaxGain').textContent = '—';
  $('viewerEmpty').classList.remove('hidden');
}

function renderCalibration(data) {
  const summary = data.summary;
  $('metricTrust').textContent = fmtPercent(summary.summary.trustedFraction);
  $('metricTrustNote').textContent = summary.referenceCount + ' 帧 · ' + summary.width + '×' + summary.height;
  $('metricGain').textContent = fmt(summary.summary.gainRawMin, 2) + '–' + fmt(summary.summary.gainRawMax, 2) + '×';
  $('metricMaxGain').textContent = '≤ ' + fmt(summary.gainPolicy.maxGain, 1) + '×';
  $('metricMaxGainNote').textContent = '归一 ' + normalizationLabel(summary);
  renderDiagnostics(data);
  renderAnomalies(data.anomalies || []);
  if (state.view === 'gain' || state.view === 'trust') renderCalibrationView();
}

function gainModelLabel(summary) {
  const model = summary && summary.gainModel;
  if (!model) return '稠密场';
  if (model.kind === 'grid') return `网格插值 ${model.params ? model.params.gridCellPx + 'px' : ''}`.trim();
  if (model.kind === 'basis') return `基函数 ${model.params ? model.params.basisDegree + ' 阶' : ''}`.trim();
  return '稠密场';
}

function renderAnomalies(anomalies) {
  const box = $('anomalies');
  box.innerHTML = '';
  if (!anomalies.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  for (const item of anomalies) {
    box.appendChild(el('span', 'anomaly ' + (item.level || ''), item.text));
  }
}

function normalizationLabel(summary) {
  const n = summary.normalization;
  if (!n) return '';
  if (n.mode === 'percentile') return `P${n.percentile}`;
  if (n.mode === 'fixed') return `固定 ${n.fixedDn} DN`;
  if (n.mode === 'median') return '中位数';
  return '均值';
}

function renderDiagnostics(data) {
  const summary = data.summary;
  $('diagnosticHint').textContent = `参考 ${summary.referenceCount} 帧 · ${gainModelLabel(summary)} · 暗电平 ${summary.darkLevelDn} DN · 归一 ${normalizationLabel(summary)} · 最大倍率 ${summary.gainPolicy.maxGain}×`;
  const text = $('diagnosticText');
  text.innerHTML = '';

  const kv = el('div', 'diag-kv');
  const add = (k, v) => { kv.appendChild(el('span', 'k', k)); kv.appendChild(el('span', 'v', v)); };
  add('图像', `${summary.width}×${summary.height} · ${summary.bitDepth} 位 · ${summary.channels} 通道`);
  add('增益模型', gainModelLabel(summary));
  if (summary.gainModel && Number.isFinite(summary.gainModel.modelBytes)) {
    const kb = (summary.gainModel.modelBytes / 1024);
    const denseKb = (summary.gainModel.denseBytes / 1024);
    add('模型大小', `${kb < 1 ? summary.gainModel.modelBytes + ' B' : kb.toFixed(1) + ' KiB'}（稠密场 ${denseKb.toFixed(0)} KiB）`);
  }
  if (summary.gainModel && Number.isFinite(summary.gainModel.unfitFraction) && summary.gainModel.unfitFraction > 0) {
    add('MODEL_UNFIT', fmtPercent(summary.gainModel.unfitFraction) + '（基函数无法表达，不强行校正）');
  }
  if (summary.gainModel && Number.isFinite(summary.gainModel.degradedPixelFraction) && summary.gainModel.degradedPixelFraction > 0) {
    add('GRID_DEGRADED', fmtPercent(summary.gainModel.degradedPixelFraction) + '（网格邻点填充）');
  }
  add('暗电平', `${summary.darkLevelDn} DN（${summary.darkSource.mode === 'darkFrames' ? '暗场' : summary.darkSource.mode === 'manual' ? '手动' : '未扣除'}）`);
  add('饱和阈值', `${summary.saturationThresholdDn} DN`);
  add('增益范围', `${fmt(summary.summary.gainRawMin, 2)} – ${fmt(summary.summary.gainRawMax, 2)} ×`);
  add('可信区', fmtPercent(summary.summary.trustedFraction));
  add('平均可信度', fmt(summary.summary.meanConfidence, 3));
  for (const ch of summary.channelStatistics) {
    add(`通道 ${ch.channel + 1} 可靠区`, fmtPercent(ch.reliableFraction));
    add(`通道 ${ch.channel + 1} 坏点`, fmtPercent(ch.badPixelFraction));
    add(`通道 ${ch.channel + 1} 填充`, fmtPercent(ch.filledFraction));
  }
  const block = el('div', 'diag-block');
  block.appendChild(el('h3', '', '标定摘要'));
  block.appendChild(kv);
  text.appendChild(block);

  if (summary.warnings && summary.warnings.length) {
    const warnBlock = el('div', 'diag-block');
    warnBlock.appendChild(el('h3', '', '告警'));
    const ul = el('ul', 'warning-list');
    for (const w of summary.warnings) ul.appendChild(el('li', '', w));
    warnBlock.appendChild(ul);
    text.appendChild(warnBlock);
  }

  drawFrameChart(data.summary.frameReports || []);
  drawGainChart(data);
}

/* ---------------- preview ---------------- */

function targetRequest() {
  if (state.targetSource === 'demo') {
    return { source: { demo: true, name: state.demoTargetSelected, settingsVariant: state.targetVariant } };
  }
  if (!state.targetUpload) return null;
  return {
    source: {
      uploadToken: state.uploadToken,
      fileToken: state.targetUpload.token,
      settings: JSON.parse($('referenceSettings').value),
    },
  };
}

async function preview() {
  if (!state.calibrationId) return;
  let target;
  try { target = targetRequest(); } catch (err) { toast(err.message, 'bad'); return; }
  if (!target) { toast('请先选择或上传目标图', 'bad'); return; }
  const row = Number($('profileRow').value) / 100;
  const body = {
    calibrationId: state.calibrationId,
    applyOptions: {
      confidenceThreshold: state.options.confidenceThreshold,
      maxGain: state.options.maxGain,
      minGain: state.options.minGain,
    },
    ...target,
  };
  body.profile = { yRatio: row };
  setStatus('正在应用补偿', 'busy');
  try {
    const data = await api('/api/preview', body);
    if (!data.ok) {
      state.preview = null;
      renderRefusal(data);
      return;
    }
    state.preview = data;
    state.profileRow = null;
    state.refused = false;
    renderPreview(data);
    setStatus('补偿已应用', 'ok');
  } catch (err) {
    setStatus('补偿失败', 'bad');
    toast(err.message, 'bad');
  }
}

function maybeAutoPreview() {
  clearTimeout(maybeAutoPreview._t);
  maybeAutoPreview._t = setTimeout(() => {
    if (state.calibrationId && !state.busy) preview();
  }, 320);
}

function renderRefusal(data) {
  state.images = null;
  state.refused = true;
  renderAnomalies([]);
  $('viewerEmpty').classList.remove('hidden');
  const empty = $('viewerEmpty');
  empty.innerHTML = '';
  empty.appendChild(el('div', 'empty-art'));
  empty.appendChild(el('h3', '', '拒绝套用'));
  const p = el('p', '', data.error || '目标图与标定不匹配');
  empty.appendChild(p);
  if (data.details && data.details.length) {
    const ul = el('ul', 'error-list');
    for (const d of data.details) ul.appendChild(el('li', '', d));
    empty.appendChild(ul);
  }
  $('viewerGrid').classList.add('hidden');
  $('leftImage').hidden = true;
  $('rightImage').hidden = true;
  $('leftBadge').textContent = '未处理';
  $('leftBadge').className = 'badge bad';
  $('rightBadge').textContent = '未处理';
  $('rightBadge').className = 'badge bad';
  $('metricTrust').textContent = '—';
  $('metricTrustNote').textContent = '目标图与标定不匹配';
  $('metricGain').textContent = '—';
  $('metricMaxGain').textContent = '—';
  $('metricNoise').textContent = '—';
  $('legend').classList.add('hidden');
  const tbody = document.querySelector('#regionTable tbody');
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  const td = el('td', 'empty-cell', '当前目标图未套用补偿');
  td.colSpan = 4;
  tr.appendChild(td);
  tbody.appendChild(tr);
  const canvas = $('profileChart');
  const ctx = setupCanvas(canvas, 220);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $('profileValues').innerHTML = '<div class="hint">目标图被拒绝，剖面不可用</div>';
  setStatus('已拒绝套用', 'bad');
  toast('目标图与标定不匹配，未生成补偿结果', 'bad');
}

function renderPreview(data) {
  $('viewerEmpty').classList.add('hidden');
  state.images = {
    target: pngDataUrl(data.target),
    corrected: pngDataUrl(data.corrected),
    trust: pngDataUrl(data.trust),
    gain: pngDataUrl(data.gain),
    flags: pngDataUrl(data.flags),
  };
  applyViewMode(state.images);

  $('metricTrust').textContent = fmtPercent(data.application.trustedFraction);
  $('metricTrustNote').textContent = `阈值 ${fmt(data.application.threshold, 2)} · 参考 ${data.calibrationId.split('_').slice(-1)[0]}`;
  $('legend').classList.remove('hidden');
  $('metricGain').textContent = fmt(data.application.meanAppliedGainTrusted, 2) + '×';
  $('metricMaxGain').textContent = fmt(data.application.maxAppliedGain, 2) + '×';
  $('metricMaxGainNote').textContent = '上限 ' + fmt(state.options.maxGain, 1) + '×';
  const regionNoise = data.noise || [];
  const maxNoise = regionNoise.reduce((m, r) => (Number.isFinite(r.noiseRatio) ? Math.max(m, r.noiseRatio) : m), 0);
  $('metricNoise').textContent = maxNoise ? '×' + fmt(maxNoise, 2) : '—';

  const counts = data.application.counts;
  $('leftBadge').textContent = data.target.bitDepth + ' 位';
  $('leftBadge').className = 'badge';
  const cappedFraction = (counts.gainCapped || 0) / (data.target.width * data.target.height);
  $('rightBadge').textContent = `补偿后 · 封顶 ${fmtPercent(cappedFraction)} · 最高 ×${fmt(data.application.maxAppliedGain, 2)}`;
  $('rightBadge').className = 'badge ' + (cappedFraction > 0 ? 'warn' : 'ok');
  renderAnomalies(data.anomalies || []);

  drawProfile(data);
  renderRegionTable(data);
}

function applyViewMode(images) {
  const left = $('leftImage');
  const right = $('rightImage');
  const grid = $('viewerGrid');
  $('viewerEmpty').classList.add('hidden');
  grid.classList.remove('hidden');
  $('legend').classList.remove('hidden');
  const mode = state.view;
  document.querySelectorAll('[data-view]').forEach((btn) => {
    const active = btn.dataset.view === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const setImg = (img, src) => {
    img.src = src;
    img.hidden = false;
  };
  if (mode === 'split') {
    grid.classList.remove('single');
    $('leftCaption').textContent = '校正前';
    $('rightCaption').textContent = '补偿后';
    if (images) { setImg(left, images.target); setImg(right, images.corrected); }
  } else if (mode === 'corrected') {
    grid.classList.add('single');
    $('rightCaption').textContent = '补偿图像';
    if (images) { setImg(right, images.corrected); setImg(left, images.target); }
  } else if (mode === 'trust') {
    grid.classList.remove('single');
    $('leftCaption').textContent = '补偿图像';
    $('rightCaption').textContent = '可信区域（白=可信）';
    if (images) { setImg(left, images.corrected); setImg(right, images.trust); }
  } else if (mode === 'gain') {
    grid.classList.remove('single');
    $('leftCaption').textContent = '补偿图像';
    $('rightCaption').textContent = '实际套用倍率（亮=高倍率）';
    if (images) { setImg(left, images.corrected); setImg(right, images.gain); }
  }
}

function renderCalibrationView() {
  // Before a target is previewed, the viewer shows the estimated gain field
  // itself alongside its trust/flag maps rather than an applied result.
  if (!state.calibration) return;
  const images = {
    target: null,
    corrected: pngDataUrl(state.calibration.gainImage),
    gain: pngDataUrl(state.calibration.gainImage),
    trust: pngDataUrl(state.calibration.trustImage),
    flags: pngDataUrl(state.calibration.flagsImage),
  };
  applyViewMode(images);
  $('leftCaption').textContent = '增益场';
  $('rightCaption').textContent = state.view === 'trust' ? '可信区域（白=可信）' : '参考标志位';
  if (state.view === 'gain') {
    $('leftImage').src = pngDataUrl(state.calibration.gainImage);
    $('rightImage').src = pngDataUrl(state.calibration.flagsImage);
    $('leftImage').hidden = false;
    $('rightImage').hidden = false;
  }
}

/* ---------------- profile chart ---------------- */

function drawProfile(data) {
  const canvas = $('profileChart');
  const ctx = setupCanvas(canvas, 220);
  const profile = data.profile;
  if (!profile) return;
  const points = profile.points;
  const xs = points.map((p) => p.x);
  const all = points.flatMap((p) => [p.beforeDn, p.afterDn, p.expectedDn].filter((v) => v != null));
  const minY = Math.min(...all);
  const maxY = Math.max(...all);
  const pad = { l: 46, r: 10, t: 10, b: 22 };
  const W = canvas.width / (window.devicePixelRatio || 1);
  const H = canvas.height / (window.devicePixelRatio || 1);
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const x0 = xs[0];
  const x1 = xs[xs.length - 1] || x0 + 1;
  const ySpan = maxY - minY || 1;
  const px = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * plotW;
  const py = (v) => pad.t + (1 - (v - minY) / ySpan) * plotH;

  ctx.clearRect(0, 0, W, H);
  // grid
  ctx.strokeStyle = '#20262f';
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = '#6d7683';
  for (let i = 0; i <= 4; i++) {
    const v = minY + (ySpan * i) / 4;
    const y = py(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(Math.round(v), 6, y + 3);
  }
  // before (muted) and after (accent)
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#7d8796';
  ctx.beginPath();
  points.forEach((p, i) => { const x = px(p.x); const y = py(p.beforeDn); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.strokeStyle = '#63b3ff';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  points.forEach((p, i) => { const x = px(p.x); const y = py(p.afterDn); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  // expected (dashed)
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = 'rgba(87,192,139,.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  points.forEach((p, i) => { const x = px(p.x); const y = py(p.expectedDn); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.setLineDash([]);
  // axis labels
  ctx.fillStyle = '#6d7683';
  ctx.fillText('x=' + x0, pad.l, H - 6);
  const endLabel = 'x=' + x1;
  ctx.fillText(endLabel, W - pad.r - ctx.measureText(endLabel).width, H - 6);
  ctx.fillText(`y=${profile.y}`, pad.l + plotW / 2 - 14, H - 6);

  const legend = el('div', 'profile-values');
  legend.innerHTML = '';
  const table = document.createElement('table');
  const head = document.createElement('tr');
  const hasExpected = points.some((p) => p.expectedDn != null);
  const columns = hasExpected ? ['x', '校正前', '补偿后', '期望'] : ['x', '校正前', '补偿后'];
  for (const h of columns) head.appendChild(el('th', '', h));
  table.appendChild(head);
  const stride = Math.max(1, Math.round(points.length / 8));
  for (let i = 0; i < points.length; i += stride) {
    const p = points[i];
    const tr = document.createElement('tr');
    tr.appendChild(el('td', '', String(p.x)));
    tr.appendChild(el('td', '', fmt(p.beforeDn, 0)));
    tr.appendChild(el('td', '', fmt(p.afterDn, 0)));
    if (hasExpected) tr.appendChild(el('td', '', fmt(p.expectedDn, 0)));
    table.appendChild(tr);
  }
  legend.appendChild(table);
  const meta = el('div', 'hint', `行 y=${profile.y} · 校正前均值 ${fmt(profile.beforeMeanDn, 0)} DN → 补偿后 ${fmt(profile.afterMeanDn, 0)} DN`);
  legend.appendChild(meta);
  $('profileValues').replaceWith(legend);
  legend.id = 'profileValues';
  $('profileRowLabel').textContent = 'y = ' + profile.y;
}

function setupCanvas(canvas, cssHeight) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width || canvas.parentElement.clientWidth || 600);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

/* ---------------- region table ---------------- */

function renderRegionTable(data) {
  const tbody = document.querySelector('#regionTable tbody');
  tbody.innerHTML = '';
  for (const region of data.regions) {
    const noise = (data.noise || []).find((n) => n.label === region.label) || {};
    const tr = document.createElement('tr');
    tr.appendChild(el('td', '', region.label));
    const before = region.before.meanDn;
    const after = region.after.meanDn;
    const delta = after - before;
    const deltaCell = el('td', 'num delta ' + (delta >= 0 ? 'up' : 'down'),
      `${fmt(before, 0)} → ${fmt(after, 0)} DN（${delta >= 0 ? '+' : ''}${fmt(delta, 0)}）`);
    tr.appendChild(deltaCell);
    tr.appendChild(el('td', 'num', noise.noiseRatio ? `×${fmt(noise.noiseRatio, 2)}（${fmt(noise.beforeNoiseDn, 0)} → ${fmt(noise.afterNoiseDn, 0)}）` : '—'));
    const trusted = region.trustedFraction !== undefined ? region.trustedFraction : null;
    tr.appendChild(el('td', 'num', trusted !== null ? fmtPercent(trusted) : '—'));
    tbody.appendChild(tr);
  }
  if (!data.regions.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'empty-cell', '暂无结果');
    td.colSpan = 4;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

/* ---------------- diagnostics charts ---------------- */

function drawFrameChart(frameReports) {
  const canvas = $('frameChart');
  const ctx = setupCanvas(canvas, 150);
  const W = canvas.width / (window.devicePixelRatio || 1);
  const H = canvas.height / (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, W, H);
  if (!frameReports.length) return;
  const levels = frameReports.map((f) => f.perChannel && f.perChannel[0] ? f.perChannel[0].meanSignalDn : 0);
  const noises = frameReports.map((f) => f.perChannel && f.perChannel[0] ? f.perChannel[0].noiseSigmaDn : 0);
  const maxLevel = Math.max(...levels, 1);
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const barW = Math.min(26, plotW / frameReports.length - 6);
  frameReports.forEach((f, i) => {
    const cx = pad.l + (i + 0.5) * (plotW / frameReports.length);
    const h = (levels[i] / maxLevel) * plotH;
    ctx.fillStyle = f.role === 'dark' ? '#3d4b5c' : '#31567c';
    ctx.fillRect(cx - barW / 2, pad.t + plotH - h, barW, h);
    ctx.fillStyle = '#63b3ff';
    const nh = (noises[i] / maxLevel) * plotH * 4;
    ctx.fillRect(cx - barW / 2, pad.t + plotH - nh, barW, Math.max(1, nh));
    ctx.fillStyle = '#6d7683';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText(String(i + 1), cx - 3, H - 5);
  });
  ctx.strokeStyle = '#20262f';
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t + plotH); ctx.lineTo(W - pad.r, pad.t + plotH); ctx.stroke();
  ctx.fillStyle = '#6d7683';
  ctx.fillText('均值', 4, pad.t + 10);
}

function drawGainChart(data) {
  const canvas = $('gainChart');
  const ctx = setupCanvas(canvas, 150);
  const W = canvas.width / (window.devicePixelRatio || 1);
  const H = canvas.height / (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, W, H);
  // The UI gets the summary only; render the raw gain range as a range bar
  // plus the configured cap, which is what a user adjusts.
  const gainMin = data.summary.summary.gainRawMin;
  const gainMax = data.summary.summary.gainRawMax;
  const cap = data.summary.gainPolicy.maxGain;
  const pad = { l: 30, r: 12, t: 16, b: 20 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const xOf = (g) => pad.l + (Math.log(Math.max(0.1, g) / 0.1) / Math.log(Math.max(0.2, cap) / 0.1)) * plotW;
  ctx.fillStyle = '#182029';
  ctx.fillRect(pad.l, pad.t, plotW, plotH);
  const grad = ctx.createLinearGradient(pad.l, 0, pad.l + plotW, 0);
  grad.addColorStop(0, '#22303f');
  grad.addColorStop(0.5, '#2f5f8c');
  grad.addColorStop(1, '#63b3ff');
  ctx.fillStyle = grad;
  const startX = Math.max(pad.l, xOf(gainMin));
  const endX = Math.min(pad.l + plotW, xOf(gainMax));
  ctx.fillRect(startX, pad.t + plotH / 2 - 5, Math.max(2, endX - startX), 10);
  ctx.fillStyle = '#6d7683';
  ctx.font = '9px ui-monospace, monospace';
  for (const g of [0.1, 0.25, 0.5, 1, 2, 4, 8, 16].filter((v) => v <= cap)) {
    const x = xOf(g);
    ctx.strokeStyle = '#28313c';
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + plotH); ctx.stroke();
    ctx.fillStyle = '#6d7683';
    ctx.fillText(String(g), x - 5, H - 6);
  }
  ctx.fillStyle = '#9aa4b2';
  ctx.fillText(`实测 ${gainMin.toFixed(2)}–${gainMax.toFixed(2)}× · 上限 ${cap}×`, pad.l, pad.t - 4);
  void H;
}

/* ---------------- export ---------------- */

async function exportBatch() {
  if (!state.calibrationId) { toast('请先完成标定', 'bad'); return; }
  const targets = [...state.exportSelected];
  if (!targets.length) { toast('请选择要导出的目标图', 'bad'); return; }
  setBusy(true, '正在导出');
  try {
    const data = await api('/api/export', {
      calibrationId: state.calibrationId,
      targets,
      settingsVariant: state.targetVariant,
      applyOptions: { confidenceThreshold: state.options.confidenceThreshold, maxGain: state.options.maxGain, minGain: state.options.minGain },
    });
    renderExportResults(data);
    const okCount = data.items.filter((i) => i.ok).length;
    toast(`导出完成：成功 ${okCount} / ${data.items.length}`, okCount === data.items.length ? 'ok' : 'bad');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    setBusy(false);
  }
}

function renderExportResults(data) {
  const box = $('exportResults');
  box.innerHTML = '';
  for (const item of data.items) {
    const row = el('div', 'export-row');
    row.appendChild(el('span', 'status ' + (item.ok ? 'ok' : 'bad')));
    row.appendChild(el('span', '', item.name));
    if (item.ok) {
      const link = el('a', '', 'PNG');
      link.href = '/' + item.output.split('\\').join('/');
      link.target = '_blank';
      link.rel = 'noopener';
      row.appendChild(link);
      const csv = el('a', '', 'CSV');
      csv.href = '/' + item.csv.split('\\').join('/');
      csv.target = '_blank';
      csv.rel = 'noopener';
      row.appendChild(csv);
      row.appendChild(el('span', 'path', item.output));
    } else {
      row.appendChild(el('span', 'path', (item.details && item.details[0]) || item.error));
    }
    box.appendChild(row);
  }
}

/* ---------------- validation ---------------- */

async function runValidation() {
  setBusy(true, '正在运行合成验证');
  try {
    const data = await api('/api/validate', { options: state.options });
    if (!data.ok) {
      toast(data.error || '验证失败', 'bad');
      setStatus('验证失败', 'bad');
      return;
    }
    showValidation(data);
    toast(`验证完成：增益平均相对误差 ${fmt(data.gainAccuracy.meanAbsRelativeError * 100, 2)}%，噪声放大上限 ×${fmt(data.checks.maxNoiseRatio, 2)}`, 'ok');
    setStatus('验证完成', 'ok');
  } catch (err) {
    toast(err.message, 'bad');
    setStatus('验证失败', 'bad');
  } finally {
    setBusy(false);
  }
}

function showValidation(data) {
  const text = $('diagnosticText');
  text.innerHTML = '';
  const block = el('div', 'diag-block');
  const modelKind = data.calibration && data.calibration.gainModel ? data.calibration.gainModel.kind : 'field';
  block.appendChild(el('h3', '', `合成验证（已知渐晕与局部遮光 · ${modelKind} 模型）`));
  const kv = el('div', 'diag-kv');
  const add = (k, v) => { kv.appendChild(el('span', 'k', k)); kv.appendChild(el('span', 'v', v)); };
  add('增益平均相对误差', fmt(data.gainAccuracy.meanAbsRelativeError * 100, 2) + '%');
  add('均匀度 CV 校正前', fmt(data.uniformity.uniformityCvBefore, 3));
  add('均匀度 CV 校正后', fmt(data.uniformity.uniformityCvAfter, 3));
  if (data.heldOut) {
    add('留出帧 CV（未参与估计）', `${fmt(data.heldOut.cvBefore, 3)} → ${fmt(data.heldOut.cvAfter, 3)}`);
  }
  if (data.texture) {
    add('纹理保持比', fmt(data.texture.ratio, 3) + '（1 为无损伤）');
  }
  if (data.lowLight) {
    add('低亮度区增益误差', `均值 ${fmt(data.lowLight.meanRelativeError * 100, 1)}% · P99 ${fmt(data.lowLight.p99RelativeError * 100, 1)}% · 最高 ${fmt(data.lowLight.maxRawGain, 2)}×`);
  }
  if (data.timing) {
    add('耗时', `标定 ${fmt(data.timing.calibrateMs, 0)} ms · 应用 ${fmt(data.timing.applyMs, 1)} ms/张`);
  }
  add('噪声放大最大', '×' + fmt(data.checks.maxNoiseRatio, 2));
  add('最大允许倍率', data.checks.maxAllowedGain + '×');
  for (const region of data.regions) {
    add(region.label, `${fmt(region.beforeMeanDn, 0)} → ${fmt(region.afterMeanDn, 0)} DN`);
  }
  block.appendChild(kv);
  const links = el('div', 'hint', '验证输出：' + data.filesDir + '（含 report.json、profiles CSV 与图像）');
  block.appendChild(links);
  text.appendChild(block);
  if (data.imagePreviews && data.imagePreviews.corrected) {
    const left = $('leftImage');
    const right = $('rightImage');
    left.src = 'data:image/png;base64,' + data.imagePreviews.target;
    right.src = 'data:image/png;base64,' + data.imagePreviews.corrected;
    left.hidden = false;
    right.hidden = false;
    $('viewerEmpty').classList.add('hidden');
    $('leftCaption').textContent = '验证：合成目标';
    $('rightCaption').textContent = '验证：补偿后';
  }
}

/* ---------------- wiring ---------------- */

function wireEvents() {
  document.querySelectorAll('[data-source]').forEach((btn) => {
    btn.addEventListener('click', () => { state.refSource = btn.dataset.source; applySourceSwitch(); });
  });
  document.querySelectorAll('[data-target]').forEach((btn) => {
    btn.addEventListener('click', () => { state.targetSource = btn.dataset.target; applySourceSwitch(); });
  });
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      if (state.images) {
        applyViewMode(state.images);
      } else if (state.calibration && !state.refused) {
        renderCalibrationView();
      }
    });
  });
  $('calibrateButton').addEventListener('click', calibrate);
  $('demoButton').addEventListener('click', async () => {
    try {
      await loadDemo();
      toast('已重新载入演示参考组', 'ok');
    } catch (err) {
      toast('演示数据不可用：' + err.message, 'bad');
    }
  });
  $('validateButton').addEventListener('click', runValidation);
  $('exportButton').addEventListener('click', exportBatch);
  $('selectAllTargets').addEventListener('click', () => {
    if (!state.demo) return;
    const all = state.demo.targets.filter((t) => t.startsWith('target_'));
    const allSelected = all.every((t) => state.exportSelected.has(t));
    state.exportSelected = allSelected ? new Set() : new Set(all);
    renderExportTargets();
  });
  $('targetSettingsVariant').addEventListener('change', (e) => {
    state.targetVariant = e.target.value;
    if (state.calibrationId) preview();
  });
  $('referenceSettings').addEventListener('change', () => {
    if (state.calibrationId) preview();
  });
  let rowTimer = null;
  $('profileRow').addEventListener('input', (e) => {
    const value = Number(e.target.value);
    $('profileRowLabel').textContent = 'y = ' + fmt((value / 100) * (state.preview ? state.preview.target.height : 0), 0);
    clearTimeout(rowTimer);
    rowTimer = setTimeout(() => { if (state.calibrationId) previewWithRow(value / 100); }, 180);
  });
  window.addEventListener('resize', () => {
    if (state.preview) drawProfile(state.preview);
    if (state.calibration) {
      drawFrameChart(state.calibration.summary.frameReports || []);
      drawGainChart(state.calibration);
    }
  });
}

async function previewWithRow(ratio) {
  const height = state.preview ? state.preview.target.height : null;
  if (!height) return;
  const body = {
    calibrationId: state.calibrationId,
    applyOptions: {
      confidenceThreshold: state.options.confidenceThreshold,
      maxGain: state.options.maxGain,
      minGain: state.options.minGain,
    },
    profile: { yRatio: ratio },
    ...targetRequest(),
  };
  try {
    const data = await api('/api/preview', body);
    if (data.ok) {
      state.preview = data;
      drawProfile(data);
      renderRegionTable(data);
    }
  } catch (err) { void err; }
}

async function boot() {
  setStatus('连接内核', 'busy');
  try {
    const meta = await api('/api/options', null, 'GET');
    if (!meta.ok) throw new Error(meta.error || '无法读取参数定义');
    state.optionsMeta = meta;
    buildOptionsUi();
    await loadDemo();
    wireUploads();
    wireEvents();
    applySourceSwitch();
    renderRefUploads();
    renderTargetUpload();
    $('exportButton').disabled = true;
    setStatus('就绪', 'ok');
  } catch (err) {
    setStatus('内核不可用', 'bad');
    toast('无法连接内核：' + err.message, 'bad');
  }
}

boot();
