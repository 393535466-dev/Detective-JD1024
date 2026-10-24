'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const webURL = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const preview = value => typeof value === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value) ? value : '';
const auth = () => $('token').value.trim() ? {'Authorization':'Bearer ' + $('token').value.trim()} : {};
let report = null;
function apiURL(path) {
  const value = $('backend').value.trim();
  if (!value) {
    if (location.hostname.endsWith('.github.io')) throw new Error('请在连接设置中填写已部署的后端地址');
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
    if (response.status === 401) { $('status').textContent = '服务在线 · 请填写访问令牌'; return; }
    if (!response.ok) throw new Error();
    const data = await response.json();
    $('status').textContent = data.missing_required.length ? '服务在线 · API 待配置' : '调查接口已配置';
  } catch (error) { $('status').textContent = error.message.includes('后端') ? error.message : '服务暂时无法连接'; }
}
$('token').addEventListener('change', status);
$('backend').addEventListener('change', status);
status();
$('form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('file').files[0];
  if (!file) return;
  $('error').hidden = true; $('report').hidden = true;
  if (file.size > 20*1024*1024) { $('error').textContent = '图片不能超过 20MB'; $('error').hidden = false; return; }
  $('submit').disabled = true; $('progress').hidden = false;
  const body = new FormData(); body.append('file', file); body.append('claimed_location', $('location').value); body.append('crops', $('crops').value.trim() || '[]');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 160000);
  try {
    const response = await fetch(apiURL('/api/investigate'), {method:'POST', body, headers:auth(), signal:controller.signal, redirect:'error'});
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请求格式无效，请检查图片和输入');
    report = data; render(data);
  } catch (error) { $('error').textContent = error.name === 'AbortError' ? '调查超时，请稍后重试' : error.message; $('error').hidden = false; }
  finally { clearTimeout(timer); $('submit').disabled = false; $('progress').hidden = true; }
});
function render(data) {
  const sources = Object.fromEntries(data.sources.map(s => [s.id, s]));
  const link = id => sources[id] && webURL(sources[id].url) ? `<a href="${esc(webURL(sources[id].url))}" target="_blank" rel="noopener noreferrer">${esc(id)} ↗ ${esc(sources[id].title)}</a>` : esc(id);
  const state = {complete:'调查流程完成',partial:'部分步骤完成',needs_configuration:'需要配置 API'};
  const steps = {complete:'完成',failed:'未完成',not_configured:'待配置',skipped:'跳过',no_results:'未找到结果'};
  $('report').innerHTML = `<div class="panel"><div class="report-title"><div><div class="eyebrow">INVESTIGATION REPORT</div><h2>${esc(data.summary)}</h2><p>${esc(state[data.status] || data.status)}</p></div><button id="export" type="button">导出报告 ↓</button></div>${data.configuration.missing_required.length ? `<p class="error">待配置：${data.configuration.missing_required.map(esc).join('、')}</p>` : ''}${data.claimed_location ? `<p>待核对地点：${esc(data.claimed_location)}</p>` : ''}<p>${esc(data.comparison.note)}</p></div>
    <div class="columns"><div class="panel"><h2>图像与细节</h2><img class="photo" src="${esc(preview(data.image.preview))}" alt="调查图片"><p>${esc(data.scene || '尚未获得场景描述')}</p><div class="crops">${data.crops.map(c => `<figure><img src="${esc(preview(c.preview))}" alt="${esc(c.label)}"><figcaption>${esc(c.label)}</figcaption></figure>`).join('')}</div><h3>可观察线索</h3>${data.clues.length ? data.clues.map(c => `<p><span class="tag">${esc(c.id)}</span> ${esc(c.observation)}</p>`).join('') : '<p>尚无线索</p>'}${data.image.embedded_time ? `<p>文件内时间：${esc(data.image.embedded_time)}<br><small>${esc(data.image.time_note)}</small></p>` : ''}</div>
    <div class="panel"><h2>候选地点</h2>${data.candidates.length ? data.candidates.map(c => `<article><span class="tag">待核对候选</span><h3>${esc(c.name)}</h3><p>${esc(c.area)}</p>${c.matches.map(m => `<p>${esc(m.explanation)} <small>线索 ${m.clue_ids.map(esc).join('、')}</small><br>${link(m.source_id)}</p>`).join('')}<ul>${c.uncertainties.map(u => `<li>${esc(u)}</li>`).join('')}</ul></article>`).join('') : '<p>证据不足，暂时无法给出具体候选地点。仍可查看下方相似来源。</p>'}</div></div>
    <div class="panel"><h2>公开来源</h2>${data.sources.length ? data.sources.map(s => `<article>${link(s.id)}<p>${esc(s.snippet)}</p><small>${esc(s.evidence_scope)}</small>${s.photos?.length ? `<p>${s.photos.filter(webURL).map((p,i) => `<a href="${esc(webURL(p))}" target="_blank" rel="noopener noreferrer">地图照片 ${i+1} ↗</a>`).join(' · ')}</p>` : ''}</article>`).join('') : '<p>尚无可引用来源。</p>'}</div>
    <div class="panel"><h2>执行记录与边界</h2>${data.steps.map(s => `<p><code>${esc(s.name)}</code> · ${esc(steps[s.status] || s.status)}${s.message ? ' · ' + esc(s.message) : ''}</p>`).join('')}<ul>${data.limitations.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  $('report').hidden = false;
  $('export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)], {type:'application/json;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = 'pictrace-report.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  });
}
