'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const webURL = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const preview = value => typeof value === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value) ? value : '';
const auth = () => $('token').value.trim() ? {'Authorization':'Bearer ' + $('token').value.trim()} : {};
let report = null;
let progressTimer = null;
let previewURL = null;

function connectionError(error) {
  const message = String(error?.message || '');
  if (message.includes('file://')) return message;
  if (error?.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(message)) {
    return '无法连接调查后端。请打开线上部署地址，不要直接双击 static/index.html；或在“连接设置”中填写后端 HTTPS 地址。';
  }
  return message || '调查服务暂时无法连接，请检查后端地址和访问令牌。';
}

async function responseJSON(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {detail: `后端返回了非 JSON 响应（HTTP ${response.status}），请检查 Vercel 部署状态`};
  }
}

function apiURL(path) {
  const value = $('backend').value.trim();
  if (!value) {
    if (location.protocol === 'file:') throw new Error('当前页面是 file:// 本地预览，不能直接调用图片搜索接口。请打开线上部署地址，或在“连接设置”中填写后端 HTTPS 地址。');
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
    if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`);
    const data = await responseJSON(response);
    $('status').textContent = data.missing_required.length ? '服务在线 · API 待配置' : '调查接口已配置';
    document.querySelector('.service-state i').style.background = data.missing_required.length ? 'var(--gold)' : 'var(--accent)';
  } catch (error) { $('status').textContent = connectionError(error); }
}

function openSettings() {
  $('connectionSettings').open = !$('connectionSettings').open;
  if ($('connectionSettings').open) $('connectionSettings').scrollIntoView({behavior:'smooth', block:'nearest'});
}
['openSettings', 'topSettings'].forEach(id => {
  if ($(id)) $(id).addEventListener('click', openSettings);
});
$('newCase').addEventListener('click', () => {
  if ($('submit').disabled) return;
  $('file').value = ''; $('location').value = ''; $('crops').value = '';
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null; $('localPreview').removeAttribute('src'); $('localPreview').hidden = true;
  $('fileName').textContent = '点击上传，或将图片拖到这里';
  $('fileMeta').textContent = 'JPG、PNG、WebP · 最大 20 MB';
  $('report').hidden = true; $('error').hidden = true;
  document.body.classList.remove('has-report'); report = null;
  window.scrollTo({top:0, behavior:'smooth'});
});
function setFile(file) {
  if (!file) return;
  $('fileName').textContent = file.name;
  $('fileMeta').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ${file.type || '图片文件'}`;
  if (previewURL) URL.revokeObjectURL(previewURL);
  const url = previewURL = URL.createObjectURL(file);
  const image = $('localPreview'); image.src = url; image.hidden = false;
}

$('file').addEventListener('change', event => setFile(event.target.files[0]));
const drop = $('fileDrop');
['dragenter','dragover'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('dragging'); }));
['dragleave','drop'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('dragging'); }));
drop.addEventListener('drop', event => { const file = event.dataTransfer.files[0]; if (!file) return; const transfer = new DataTransfer(); transfer.items.add(file); $('file').files = transfer.files; setFile(file); });
$('token').addEventListener('change', status); $('backend').addEventListener('change', status); status();

document.querySelectorAll('[data-prompt]').forEach(button => {
  button.addEventListener('click', () => {
    $('location').value = button.dataset.prompt || '';
    $('location').focus();
  });
});

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
  $('submit').disabled = true; $('newCase').disabled = true; startProgress();
  const body = new FormData(); body.append('file', file); body.append('claimed_location', $('location').value); body.append('crops', $('crops').value.trim() || '[]');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 160000);
  try {
    const response = await fetch(apiURL('/api/investigate'), {method:'POST', body, headers:auth(), signal:controller.signal, redirect:'error'});
    const data = await responseJSON(response);
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `调查服务返回 HTTP ${response.status}`);
    report = data; render(data);
  } catch (error) { $('error').textContent = error.name === 'AbortError' ? '调查超时，请稍后重试' : connectionError(error); $('error').hidden = false; }
  finally { clearTimeout(timer); stopProgress(); $('submit').disabled = false; $('newCase').disabled = false; }
});

function statusLabel(value) { return {complete:'完成',failed:'失败',not_configured:'待配置',skipped:'跳过',no_results:'无结果'}[value] || value || '未知'; }
function sourceLink(source) { const url = webURL(source.url); return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(source.title || '打开公开来源')} ↗</a>` : esc(source.id); }
function sourceImage(source) {
  const thumbnail = webURL(source.thumbnail) || webURL(source.image_url);
  const target = webURL(source.image_url) || webURL(source.url);
  return thumbnail && target ? `<a class="source-photo" href="${esc(target)}" target="_blank" rel="noopener noreferrer"><img src="${esc(thumbnail)}" alt="${esc(source.title || '搜索匹配图片')}" loading="lazy" referrerpolicy="no-referrer"></a>` : '';
}
function selectHighlights(data) {
  const sources = data.sources || [];
  const lookup = Object.fromEntries(sources.map(source => [source.id, source]));
  const weight = candidate => {
    const matches = (candidate.matches || []).filter(m => lookup[m.source_id]);
    const domains = new Set(matches.map(m => { try { return new URL(lookup[m.source_id].url).hostname; } catch { return ''; } }).filter(Boolean));
    const clues = new Set(matches.flatMap(m => m.clue_ids || []));
    return domains.size * 3 + clues.size;
  };
  const candidates = [...(data.candidates || [])].sort((a,b) => weight(b) - weight(a));
  const featured = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * .3)));
  const cited = new Set(featured.flatMap(c => (c.matches || []).map(m => m.source_id)));
  const text = [...(data.clues || []).map(c => c.search_text || ''), ...featured.map(c => c.name)].filter(Boolean);
  const score = source => (cited.has(source.id) ? 1000 : 0) + (source.kind === 'exact_match' ? 30 : 0)
    + text.reduce((n, term) => n + ((source.title || '') + (source.snippet || '')).includes(term) * 10, 0);
  const ordered = [...sources].sort((a,b) => score(b) - score(a));
  const count = Math.min(5, Math.max(1, Math.ceil(sources.length * .3)));
  const eligible = featured.length ? ordered.filter(source => score(source) > 0) : ordered;
  const selected = eligible.slice(0,count);
  const selectedIDs = new Set(selected.map(source => source.id));
  return {featured, remaining:candidates.slice(featured.length), selected, other:ordered.filter(source => !selectedIDs.has(source.id)), lookup};
}

function render(data) {
  const {featured, remaining, selected, other, lookup} = selectHighlights(data);
  const candidateHTML = candidate => {
    const matches = (candidate.matches || []).filter(m => lookup[m.source_id]);
    const links = [...new Set(matches.map(m => m.source_id))].slice(0,2);
    return `<article class="simple-candidate"><div class="result-location"><h3>${esc(candidate.name)}</h3><span>${esc(candidate.area)}</span><small>待核对 · Possible match</small></div><p>${esc(matches[0]?.explanation || '找到相关公开记录，具体地点仍待核对。')}</p><div class="result-citations">${links.map(id => sourceLink(lookup[id])).join('')}</div>${candidate.uncertainties?.[0] ? `<p class="result-caveat">待确认：${esc(candidate.uncertainties[0])}</p>` : ''}</article>`;
  };
  const sourceHTML = source => `<article class="source-result">${sourceImage(source)}<div>${sourceLink(source)}${source.snippet ? `<p>${esc(source.snippet.slice(0,180))}</p>` : ''}<small>${esc({exact_match:'原图匹配',visual_match:'相似图片',web_search:'网页来源',map_poi:'地图记录'}[source.kind] || '公开来源')}</small></div></article>`;
  $('report').innerHTML = `<div class="simple-report-head"><div><div class="section-kicker">SEARCH RESULTS</div><h2>发现的线索</h2></div><button id="export" type="button" class="text-button">导出 / Export ↓</button></div>
    <section class="panel result-main">${featured.length ? featured.map(candidateHTML).join('') : '<div class="empty-result"><h3>还没有足够证据确认地点</h3><p>可以先查看相关来源，或补充一张文字更清晰的照片。</p></div>'}</section>
    ${data.status !== 'complete' ? '<p class="result-caveat">部分分析尚未完成，当前展示已有结果。</p>' : ''}
    ${selected.length ? `<section class="selected-sources"><div class="card-head"><h3>相关来源 <small>Selected sources</small></h3><small>精选 ${selected.length} 条 / 共 ${(data.sources || []).length} 条</small></div>${selected.map(sourceHTML).join('')}</section>` : '<p class="result-caveat">暂未检索到可引用来源。</p>'}
    <details class="more-results"><summary>更多结果与细节 <span>View details</span></summary>
    ${(data.searched_terms || []).length ? `<h3>实际检索词 <small>Searched terms</small></h3><div class="searched-terms">${data.searched_terms.map(term => `<span>${esc(term.text)}<small>${term.status === 'complete' ? term.result_count + ' 条结果' : term.status === 'no_results' ? '无结果' : '检索未完成'}</small></span>`).join('')}</div>` : ''}
    ${remaining.map(candidateHTML).join('')}
    ${(data.clues || []).length ? `<h3>图片线索 <small>Image clues</small></h3><ul class="limits">${data.clues.map(c => `<li>${esc(c.observation)}</li>`).join('')}</ul>` : ''}
    ${other.map(sourceHTML).join('')}
    <h3>分析说明 <small>Notes</small></h3><ul class="limits">${(data.limitations || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    <p class="result-caveat">按引用来源与线索关联排序，精选约前 30% 的结果，来源最多展示 5 条；排序不代表定位准确率。完整执行记录可导出查看。</p></details>`;
  $('report').classList.add('report'); $('report').hidden = false;
  document.body.classList.add('has-report');
  requestAnimationFrame(() => $('report').scrollIntoView({behavior:'smooth', block:'start'}));
  $('export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], {type:'application/json;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = 'pictrace-report.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  });
}
