'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const webURL = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const preview = value => typeof value === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value) ? value : '';
const auth = () => $('token').value.trim() ? {'Authorization':'Bearer ' + $('token').value.trim()} : {};
let report = null;
let progressTimer = null;

function apiURL(path) {
  const value = $('backend').value.trim();
  if (!value) {
    if (location.hostname.endsWith('.github.io')) throw new Error('请在连接与细节设置中填写已部署的后端地址');
    return path;
  }
  const base = new URL(value);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('后端地址只填域名，不含路径、参数或账户信息');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1'].includes(base.hostname))) throw new Error('后端应使用 HTTPS；本地服务可使用 HTTP');
  return base.origin + path;
}

async function status() {
  try {
    const endpoint = apiURL('/api/status'); $('apiDocs').href = apiURL('/docs');
    const response = await fetch(endpoint, {headers:auth(), redirect:'error'});
    if (response.status === 401) { $('status').textContent = '服务在线 · 需要访问令牌'; return; }
    if (!response.ok) throw new Error();
    const data = await response.json();
    $('status').textContent = data.missing_required.length ? '服务在线 · API 待配置' : '调查接口已配置';
    document.querySelector('.service-state i').style.background = data.missing_required.length ? 'var(--gold)' : 'var(--accent)';
  } catch (error) { $('status').textContent = error.message.includes('后端') ? error.message : '服务暂时无法连接'; }
}

function setFile(file) {
  if (!file) return;
  $('fileName').textContent = file.name;
  $('fileMeta').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ${file.type || '图片文件'}`;
  const url = URL.createObjectURL(file);
  const image = $('localPreview'); image.src = url; image.hidden = false;
}

$('file').addEventListener('change', event => setFile(event.target.files[0]));
const drop = $('fileDrop');
['dragenter','dragover'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('dragging'); }));
['dragleave','drop'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('dragging'); }));
drop.addEventListener('drop', event => { const file = event.dataTransfer.files[0]; if (!file) return; const transfer = new DataTransfer(); transfer.items.add(file); $('file').files = transfer.files; setFile(file); });
$('token').addEventListener('change', status); $('backend').addEventListener('change', status); status();

function startProgress() {
  const box = $('progress'); box.hidden = false;
  const stages = [...document.querySelectorAll('[data-progress]')]; let index = 0;
  stages.forEach((stage, i) => stage.classList.toggle('active', i === 0));
  clearInterval(progressTimer);
  progressTimer = setInterval(() => { index = Math.min(index + 1, stages.length - 1); stages.forEach((stage, i) => stage.classList.toggle('active', i === index)); }, 11000);
}
function stopProgress() { clearInterval(progressTimer); $('progress').hidden = true; }

$('form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('file').files[0]; if (!file) return;
  $('error').hidden = true; $('report').hidden = true;
  if (file.size > 20*1024*1024) { $('error').textContent = '图片不能超过 20MB'; $('error').hidden = false; return; }
  $('submit').disabled = true; startProgress();
  const body = new FormData(); body.append('file', file); body.append('claimed_location', $('location').value); body.append('crops', $('crops').value.trim() || '[]');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 160000);
  try {
    const response = await fetch(apiURL('/api/investigate'), {method:'POST', body, headers:auth(), signal:controller.signal, redirect:'error'});
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请求格式无效，请检查图片和输入');
    report = data; render(data);
  } catch (error) { $('error').textContent = error.name === 'AbortError' ? '调查超时，请稍后重试' : error.message; $('error').hidden = false; }
  finally { clearTimeout(timer); stopProgress(); $('submit').disabled = false; }
});

function statusLabel(value) { return {complete:'完成',failed:'失败',not_configured:'待配置',skipped:'跳过',no_results:'无结果'}[value] || value || '未知'; }
function sourceLink(source) { const url = webURL(source.url); return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(source.id)} · ${esc(source.title || '打开公开来源')} ↗</a>` : esc(source.id); }
function render(data) {
  const sources = Object.fromEntries((data.sources || []).map(s => [s.id, s]));
  const state = {complete:'调查流程完成',partial:'部分步骤完成',needs_configuration:'需要配置 API'};
  const clueHTML = data.clues?.length ? data.clues.map(c => `<div class="clue-item"><span class="clue-id">${esc(c.id)}</span><span>${esc(c.observation)}</span></div>`).join('') : '<p class="report-scene">暂时没有可用的可观察线索。</p>';
  const cropsHTML = data.crops?.length ? `<div class="crop-list">${data.crops.map(c => `<figure><img src="${esc(preview(c.preview))}" alt="${esc(c.label)}"><figcaption>${esc(c.label)}</figcaption></figure>`).join('')}</div>` : '';
  const candidatesHTML = data.candidates?.length ? data.candidates.map((candidate, i) => `<article class="candidate"><div class="candidate-top"><span class="candidate-num">0${i+1}</span><div><h4>${esc(candidate.name)}</h4><p class="area">${esc(candidate.area || '公开来源中的公共对象')}</p></div><span class="badge">待核对</span></div>${(candidate.matches || []).map(match => `<p>${esc(match.explanation)} <small>· ${match.clue_ids.map(esc).join('、')}</small><br>${sourceLink(sources[match.source_id] || {id:match.source_id})}</p>`).join('')}<ul>${(candidate.uncertainties || []).map(u => `<li>${esc(u)}</li>`).join('')}</ul></article>`).join('') : '<p class="report-scene">证据不足，暂时无法给出具体候选。仍可查看公开来源和执行记录。</p>';
  const sourcesHTML = data.sources?.length ? data.sources.map(source => `<article>${sourceLink(source)}<p>${esc(source.snippet || '该来源没有摘要')}</p><small>${esc(source.evidence_scope || '')}</small>${source.photos?.length ? `<p>${source.photos.filter(webURL).map((photo, i) => `<a href="${esc(webURL(photo))}" target="_blank" rel="noopener noreferrer">地图照片 ${i+1} ↗</a>`).join(' · ')}</p>` : ''}</article>`).join('') : '<p class="report-scene">尚无可引用公开来源。</p>';
  const stepsHTML = (data.steps || []).map(step => `<div class="step-row"><span class="step-status ${step.status === 'failed' ? 'failed' : step.status === 'not_configured' ? 'pending' : ''}">${esc(statusLabel(step.status))}</span><code>${esc(step.name)}</code><span>${step.message ? esc(step.message) : ''}</span></div>`).join('');
  $('report').innerHTML = `<div class="report-summary panel"><div><div class="section-kicker">02 / 调查报告</div><h2>${esc(data.summary || '调查结果')}</h2><p>${esc(state[data.status] || data.status || '')}${data.claimed_location ? ` · 需要核对：${esc(data.claimed_location)}` : ''}</p></div><div class="report-actions"><span class="report-stamp">${data.status === 'complete' ? '流程完成 · 结论仍待核对' : '保留疑点 · 需要继续调查'}</span><button id="export" type="button">导出 JSON ↓</button></div></div>
  <div class="report-grid"><section class="report-card panel"><div class="card-head"><h3>现场观察</h3><small>${esc(data.scene || '室内外环境')}</small></div><img class="report-photo" src="${esc(preview(data.image?.preview))}" alt="调查图片"><p class="report-scene">${esc(data.scene || '模型尚未返回场景描述')}</p><div class="clue-list">${clueHTML}</div>${cropsHTML}</section><section class="report-card panel"><div class="card-head"><h3>候选地点 / 对象</h3><small>引用来源才能进入列表</small></div>${candidatesHTML}</section></div>
  <section class="source-card panel"><div class="card-head"><h3>公开证据来源</h3><small>${data.sources?.length || 0} 条可追溯记录</small></div>${sourcesHTML}</section><section class="steps-card panel"><div class="card-head"><h3>调查路径与边界</h3><small>每一步都可回看</small></div>${stepsHTML || '<p class="report-scene">没有执行记录。</p>'}<ul class="limits">${(data.limitations || []).map(item => `<li>${esc(item)}</li>`).join('')}</ul></section>`;
  if (data.configuration?.missing_required?.length) $('report').insertAdjacentHTML('afterbegin', `<p class="error panel">待配置：${data.configuration.missing_required.map(esc).join('、')}</p>`);
  $('report').hidden = false;
  $('export').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)], {type:'application/json;charset=utf-8'})); const a = document.createElement('a'); a.href = url; a.download = 'pictrace-report.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); });
}
