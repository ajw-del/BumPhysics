const $ = id => document.getElementById(id);
const state = { jobTimer: null };

function getGeminiKey(){ return localStorage.getItem('gemini_api_key') || ''; }
async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const key = getGeminiKey();
  if (key) headers.set('x-gemini-api-key', key);
  const r = await fetch(url, { ...options, headers }); const data = await r.json();
  if (!r.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}
function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function formatDate(s){if(!s)return ''; const d=new Date(s); return isNaN(d)?'':d.toLocaleDateString('ko-KR');}
function showJob(job){
  $('jobBox').classList.remove('hidden'); $('jobMessage').textContent=job.message||'처리 중…'; $('jobPercent').textContent=`${job.progress||0}%`; $('progressBar').style.width=`${job.progress||0}%`; $('jobCurrent').textContent=job.current?`현재: ${job.current}`:'';
}
async function loadConfig(){
  try{const c=await api('/api/config'); $('configBadge').textContent=c.youtubeConfigured?'YouTube 연결됨':'YouTube API 키 설정 필요'; $('configBadge').className='badge '+(c.youtubeConfigured?'ok':'warn');}catch{}
}
async function loadChannels(){
  const data=await api('/api/channels'); const select=$('channelSelect'); select.innerHTML='<option value="">전체 채널</option>' + data.channels.map(c=>`<option value="${esc(c.id)}">${esc(c.title)} (${c.videoCount})</option>`).join('');
  $('channelList').innerHTML=data.channels.length?data.channels.map(c=>`<div class="channel-item"><div class="channel-main">${c.thumbnail?`<img src="${esc(c.thumbnail)}" alt="">`:''}<div><strong>${esc(c.title)}</strong><span>${c.videoCount.toLocaleString()}개 영상 · ${c.chunkCount.toLocaleString()}개 검색 구간</span></div></div><span class="muted">${formatDate(c.updatedAt)}</span></div>`).join(''):'<div class="empty small-empty">아직 등록된 채널이 없습니다.</div>';
}
function updateKeyStatus(){
  const has=!!getGeminiKey();
  $('keyStatus').textContent=has?'키 저장됨':'키 미설정';
  $('keyStatus').className='badge '+(has?'ok':'warn');
  $('geminiKey').value=has?'••••••••••••••••':'';
}
async function saveGeminiKey(){
  const value=$('geminiKey').value.trim();
  if(!value || value.startsWith('••')){ if(getGeminiKey()) return updateKeyStatus(); alert('Gemini API 키를 입력해주세요.'); return; }
  localStorage.setItem('gemini_api_key', value);
  try{ await api('/api/test-gemini',{method:'POST'}); updateKeyStatus(); alert('Gemini API 키가 저장되고 연결이 확인되었습니다.'); }
  catch(e){ localStorage.removeItem('gemini_api_key'); updateKeyStatus(); alert(e.message); }
}
function clearGeminiKey(){ localStorage.removeItem('gemini_api_key'); $('geminiKey').value=''; updateKeyStatus(); }
async function testGeminiKey(){
  if(!getGeminiKey()){ alert('먼저 Gemini API 키를 저장해주세요.'); return; }
  try{ await api('/api/test-gemini',{method:'POST'}); alert('Gemini API 연결 정상입니다.'); } catch(e){ alert(e.message); }
}
async function startImport(){
  if(!getGeminiKey()){ alert('먼저 Gemini API 키를 입력하고 저장해주세요.'); return; }
  const channelUrl=$('channelUrl').value.trim(); if(!channelUrl)return alert('채널 URL을 입력해주세요.');
  $('importBtn').disabled=true;
  try{
    const data=await api('/api/import-channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelUrl,excludeShorts:$('excludeShorts').checked,limit:Number($('limit').value||0),refresh:$('refresh').checked})});
    pollJob(data.jobId);
  }catch(e){alert(e.message);}finally{$('importBtn').disabled=false;}
}
function pollJob(id){ clearInterval(state.jobTimer); state.jobTimer=setInterval(async()=>{ try { const job=await api('/api/jobs/'+id); showJob(job); if(job.status==='done'||job.status==='error'||job.status==='missing'){ clearInterval(state.jobTimer); loadChannels(); if(job.status==='error') alert(job.message); } } catch(e) { clearInterval(state.jobTimer); alert(e.message); } },800); }
async function search(){
  const q=$('query').value.trim(); if(!q)return;
  $('searchBtn').disabled=true; $('results').innerHTML='<div class="loading">관련 내용을 찾는 중…</div>';
  try{const data=await api(`/api/search?q=${encodeURIComponent(q)}&channelId=${encodeURIComponent($('channelSelect').value)}`);renderResults(data);}catch(e){$('results').innerHTML=`<div class="empty">${esc(e.message)}</div>`;}finally{$('searchBtn').disabled=false;}
}
function renderResults(data){
  const list=data.results||[];
  if(!list.length){$('results').innerHTML=`<div class="empty"><strong>“${esc(data.query)}”</strong>와 관련된 구간을 찾지 못했습니다.<br><span>채널을 먼저 등록하거나 다른 표현으로 검색해보세요.</span></div>`;return;}
  $('results').innerHTML=`<div class="result-summary"><div><span class="eyebrow">SEARCH RESULT</span><h2>“${esc(data.query)}” 관련 내용</h2></div><span class="mode">${data.mode==='semantic'?'의미 기반 검색':'문자열 검색'} · ${list.length}개 구간</span></div>`+list.map(x=>`<article class="result-card"><div class="thumb">${x.thumbnail?`<img src="${esc(x.thumbnail)}" alt="">`:'<div class="no-thumb">VIDEO</div>'}</div><div class="result-body"><div class="result-title"><a href="${esc(x.url)}" target="_blank" rel="noreferrer">${esc(x.title)}</a></div><div class="meta"><span>⏱ ${esc(x.timestamp)}</span><span>관련도 ${Math.round(x.score*100)}%</span><span>${formatDate(x.publishedAt)}</span></div><p>${highlight(esc(x.text), data.query)}</p><a class="jump" href="${esc(x.url)}" target="_blank" rel="noreferrer">이 구간에서 영상 보기 ↗</a></div></article>`).join('');
}
function highlight(text,q){const words=q.split(/\s+/).filter(Boolean).slice(0,4);let out=text;for(const w of words){const safe=w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');out=out.replace(new RegExp(`(${safe})`,'gi'),'<mark>$1</mark>');}return out;}
$('saveKeyBtn').onclick=saveGeminiKey; $('testKeyBtn').onclick=testGeminiKey; $('clearKeyBtn').onclick=clearGeminiKey; $('importBtn').onclick=startImport; $('searchBtn').onclick=search; $('query').addEventListener('keydown',e=>{if(e.key==='Enter')search();}); document.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>{$('query').value=b.dataset.q;search();}); loadConfig(); loadChannels(); updateKeyStatus();
