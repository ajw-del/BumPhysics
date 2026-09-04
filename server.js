import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import XLSX from 'xlsx';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { fetchTranscript } from 'youtube-transcript-plus';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-2';
const DB_FILE = process.env.DB_FILE || path.join(process.cwd(), 'data', 'index.json');

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const jobs = new Map();
let db = { version: 1, channels: [], videos: [], chunks: [] };
let dbWrite = Promise.resolve();

async function loadDb() {
  try { db = JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
  catch { await saveDb(); }
}
async function saveDb() {
  dbWrite = dbWrite.then(async () => {
    await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
    await fs.writeFile(DB_FILE, JSON.stringify(db), 'utf8');
  });
  return dbWrite;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}
function videoIdFromUrl(url='') {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0];
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v') || u.pathname.match(/\/shorts\/([^/]+)/)?.[1] || u.pathname.match(/\/live\/([^/]+)/)?.[1] || '';
  } catch {}
  return '';
}
function parseChannelInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('유튜브 채널 URL을 입력해주세요.');
  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(raw)) return { id: raw };
  let u;
  try { u = new URL(raw); } catch { throw new Error('올바른 유튜브 채널 URL이 아닙니다.'); }
  const m = u.pathname.match(/^\/channel\/(UC[a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1] };
  const h = u.pathname.match(/^\/@([^/]+)/);
  if (h) return { handle: '@' + h[1] };
  const user = u.pathname.match(/^\/user\/([^/]+)/);
  if (user) return { username: user[1] };
  throw new Error('지원하는 채널 주소는 /@핸들, /channel/UC..., /user/... 형식입니다.');
}
function isoDurationSeconds(iso='') {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1]||0)*3600 + Number(m[2]||0)*60 + Number(m[3]||0);
}
function formatTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}
function youtubeLink(id, sec=0) { return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${sec > 0 ? `&t=${Math.floor(sec)}s` : ''}`; }
function splitTranscript(items, windowSec=45, maxChars=2200) {
  const chunks = [];
  let cur = null;
  for (const item of items) {
    const text = String(item.text || item.content || '').replace(/\s+/g, ' ').trim();
    const start = Number(item.offset ?? item.start ?? 0);
    const duration = Number(item.duration ?? 0);
    const end = start + duration;
    if (!text) continue;
    if (!cur || start - cur.start >= windowSec || (cur.text.length + text.length > maxChars)) {
      if (cur) chunks.push(cur);
      cur = { start, end, text };
    } else {
      cur.end = Math.max(cur.end, end);
      cur.text += ' ' + text;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function ytApi(pathname, params) {
  if (!process.env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY가 설정되지 않았습니다.');
  const q = new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${pathname}?${q}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `YouTube API 오류 (${r.status})`);
  return data;
}

async function resolveChannel(input) {
  const criteria = parseChannelInput(input);
  const params = { part: 'id,snippet,contentDetails,statistics' };
  if (criteria.id) params.id = criteria.id;
  if (criteria.handle) params.forHandle = criteria.handle;
  if (criteria.username) params.forUsername = criteria.username;
  const data = await ytApi('channels', params);
  if (!data.items?.length) throw new Error('채널을 찾지 못했습니다.');
  const c = data.items[0];
  return {
    id: c.id,
    title: c.snippet?.title || '',
    description: c.snippet?.description || '',
    thumbnail: c.snippet?.thumbnails?.default?.url || '',
    uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads,
    subscriberCount: c.statistics?.subscriberCount || null
  };
}

async function listChannelVideos(playlistId) {
  const ids = [];
  let pageToken = '';
  do {
    const data = await ytApi('playlistItems', { part: 'contentDetails,snippet,status', playlistId, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    for (const item of data.items || []) {
      if (item.status?.privacyStatus === 'private' || !item.contentDetails?.videoId) continue;
      ids.push({ id: item.contentDetails.videoId, title: item.snippet?.title || '', publishedAt: item.snippet?.publishedAt || '', thumbnail: item.snippet?.thumbnails?.medium?.url || '' });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await ytApi('videos', { part: 'snippet,contentDetails,statistics', id: batch.map(x => x.id).join(',') });
    for (const v of data.items || []) {
      const base = ids.find(x => x.id === v.id) || {};
      videos.push({
        id: v.id, title: v.snippet?.title || base.title, description: v.snippet?.description || '',
        publishedAt: v.snippet?.publishedAt || base.publishedAt, thumbnail: v.snippet?.thumbnails?.medium?.url || base.thumbnail,
        duration: isoDurationSeconds(v.contentDetails?.duration),
        durationText: v.contentDetails?.duration || '', views: Number(v.statistics?.viewCount || 0)
      });
    }
  }
  return videos;
}

async function getTranscript(videoId) {
  const raw = await fetchTranscript(videoId, { lang: process.env.TRANSCRIPT_LANG || 'ko', retries: 1, retryDelay: 700 });
  const arr = Array.isArray(raw) ? raw : (raw?.transcript || raw?.segments || []);
  return arr.map(x => ({ text: x.text ?? x.content ?? '', offset: x.offset ?? x.start ?? 0, duration: x.duration ?? 0 }));
}

async function embedTexts(texts, apiKey) {
  if (!texts.length) return [];
  if (!apiKey) throw new Error('웹사이트에 Gemini API 키를 입력해주세요.');
  const ai = new GoogleGenAI({ apiKey });
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const r = await ai.models.embedContent({ model: EMBEDDING_MODEL, contents: batch, config: { outputDimensionality: 768 } });
    for (const e of r.embeddings || []) out.push(e.values || []);
  }
  return out;
}

async function processImport(job, channel, options, geminiApiKey) {
  try {
    job.status = 'running'; job.message = '채널 정보를 가져오는 중…';
    let videos = await listChannelVideos(channel.uploadsPlaylistId);
    if (options.limit > 0) videos = videos.slice(0, options.limit);
    if (options.excludeShorts) videos = videos.filter(v => v.duration > 180);
    job.total = videos.length; job.done = 0;

    const existingVideoIds = new Set(db.videos.filter(v => v.channelId === channel.id).map(v => v.id));
    const newVideos = videos.filter(v => !existingVideoIds.has(v.id));
    const selected = options.refresh ? videos : newVideos;
    job.total = selected.length;
    job.message = `${videos.length.toLocaleString()}개 영상 중 ${selected.length.toLocaleString()}개를 처리합니다.`;

    const oldByVideo = new Map(db.videos.filter(v => v.channelId === channel.id).map(v => [v.id, v]));
    for (const video of selected) {
      job.current = video.title;
      let transcript;
      try { transcript = await getTranscript(video.id); }
      catch (e) {
        transcript = [];
        job.lastError = `${video.title}: 자막을 가져오지 못했습니다.`;
      }
      const segments = splitTranscript(transcript);
      const texts = segments.map(s => `${video.title}\n${s.text}`);
      let embeddings = [];
      try { embeddings = await embedTexts(texts, geminiApiKey); }
      catch (e) { job.lastError = `임베딩 실패: ${e.message}`; }

      db.videos = db.videos.filter(v => !(v.channelId === channel.id && v.id === video.id));
      db.chunks = db.chunks.filter(c => c.videoId !== video.id);
      const record = { ...video, channelId: channel.id, indexedAt: new Date().toISOString(), transcriptAvailable: transcript.length > 0, chunkCount: segments.length };
      db.videos.push(record);
      segments.forEach((s, i) => db.chunks.push({
        id: crypto.randomUUID(), videoId: video.id, channelId: channel.id, index: i,
        start: s.start, end: s.end, text: s.text, embedding: embeddings[i] || []
      }));
      oldByVideo.set(video.id, record);
      job.done++;
      await saveDb();
      job.progress = Math.round(job.done / Math.max(job.total, 1) * 100);
    }

    const existingChannel = db.channels.find(c => c.id === channel.id);
    if (existingChannel) Object.assign(existingChannel, channel, { updatedAt: new Date().toISOString() });
    else db.channels.push({ ...channel, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await saveDb();
    job.status = 'done'; job.progress = 100; job.message = `완료: ${job.done.toLocaleString()}개 영상을 색인했습니다.`;
  } catch (e) {
    console.error(e); job.status = 'error'; job.message = e.message || String(e);
  }
}

app.get('/api/config', (req, res) => res.json({ youtubeConfigured: !!process.env.YOUTUBE_API_KEY, geminiConfigured: false, embeddingModel: EMBEDDING_MODEL, geminiKeyMode: 'browser-local' }));
app.post('/api/test-gemini', async (req, res) => {
  try {
    const geminiApiKey = String(req.get('x-gemini-api-key') || '').trim();
    if (!geminiApiKey) return res.status(401).json({ error: 'Gemini API 키가 없습니다.' });
    await embedTexts(['Gemini API 연결 테스트'], geminiApiKey);
    res.json({ ok: true, model: EMBEDDING_MODEL });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Gemini API 키를 확인해주세요.' });
  }
});
app.get('/api/channels', (req, res) => {
  const channels = db.channels.map(c => ({ ...c, videoCount: db.videos.filter(v => v.channelId === c.id).length, chunkCount: db.chunks.filter(x => x.channelId === c.id).length }));
  res.json({ channels });
});
app.post('/api/import-channel', async (req, res) => {
  try {
    const geminiApiKey = String(req.get('x-gemini-api-key') || '').trim();
    if (!geminiApiKey) return res.status(401).json({ error: 'Gemini API 키를 먼저 입력하고 저장해주세요.' });
    const channel = await resolveChannel(req.body.channelUrl);
    const jobId = crypto.randomUUID();
    const job = { id: jobId, status: 'queued', progress: 0, done: 0, total: 0, current: '', message: '대기 중…', createdAt: new Date().toISOString() };
    jobs.set(jobId, job);
    processImport(job, channel, { excludeShorts: !!req.body.excludeShorts, limit: Number(req.body.limit || 0), refresh: !!req.body.refresh }, geminiApiKey);
    res.json({ jobId, channel });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/jobs/:id', (req, res) => res.json(jobs.get(req.params.id) || { status: 'missing' }));

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const channelId = String(req.query.channelId || '').trim();
    const limit = clamp(Number(req.query.limit || 20), 1, 100);
    const geminiApiKey = String(req.get('x-gemini-api-key') || '').trim();
    if (!q) return res.status(400).json({ error: '검색어를 입력해주세요.' });
    if (!geminiApiKey) return res.status(401).json({ error: 'Gemini API 키를 먼저 입력하고 저장해주세요.' });
    const pool = db.chunks.filter(c => !channelId || c.channelId === channelId);
    if (!pool.length) return res.json({ query: q, results: [], mode: 'empty' });
    let qv = [];
    try { qv = (await embedTexts([q], geminiApiKey))[0] || []; } catch (e) {
      return res.status(400).json({ error: `Gemini API 키를 확인해주세요: ${e.message}` });
    }
    const normalized = q.toLowerCase();
    const scored = pool.map(c => {
      const semantic = qv.length && c.embedding?.length ? cosine(qv, c.embedding) : 0;
      const lexical = c.text.toLowerCase().includes(normalized) ? 1 : 0;
      return { c, score: qv.length ? semantic * 0.92 + lexical * 0.08 : lexical };
    }).filter(x => x.score > (qv.length ? 0.42 : 0));
    scored.sort((a,b) => b.score-a.score);
    const seen = new Set();
    const results = [];
    for (const { c, score } of scored) {
      const key = c.videoId;
      if (!seen.has(key) || results.filter(r => r.videoId === key).length < 3) {
        const v = db.videos.find(v => v.id === c.videoId) || {};
        results.push({ videoId: c.videoId, title: v.title || '제목 없음', publishedAt: v.publishedAt, thumbnail: v.thumbnail, start: c.start, end: c.end, timestamp: `${formatTime(c.start)}–${formatTime(c.end)}`, text: c.text, score: Number(score.toFixed(4)), url: youtubeLink(c.videoId, c.start) });
        seen.add(key);
      }
      if (results.length >= limit) break;
    }
    res.json({ query: q, results, mode: qv.length ? 'semantic' : 'lexical' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy Excel endpoint retained for the original workflow.
const aliases = { url:['video url','url','video_url','영상 url','영상주소','링크','유튜브 링크'], title:['title','video title','제목','영상 제목','name'], transcript:['transcript','script','subtitle','captions','대본','스크립트','자막','내용','영상 내용'], timestamp:['timestamp','time','timecode','타임스탬프','시간','구간','시작시간'], description:['description','설명','요약','summary'] };
const normalize = v => String(v ?? '').trim().toLowerCase().replace(/[\s_\-()[\]]/g,'');
function findColumn(headers,type){ const wanted=aliases[type].map(normalize); return headers.find(h=>wanted.some(w=>normalize(h).includes(w)||w.includes(normalize(h)))); }
function cleanRows(rows){ if(!rows.length)return{rows:[],columns:[]}; const headers=Object.keys(rows[0]); const mapped={url:findColumn(headers,'url'),title:findColumn(headers,'title'),transcript:findColumn(headers,'transcript'),timestamp:findColumn(headers,'timestamp'),description:findColumn(headers,'description')}; const out=rows.map((r,i)=>({rowNumber:i+2,url:mapped.url?String(r[mapped.url]??''):'',title:mapped.title?String(r[mapped.title]??''):'',transcript:mapped.transcript?String(r[mapped.transcript]??''):'',timestamp:mapped.timestamp?String(r[mapped.timestamp]??''):'',description:mapped.description?String(r[mapped.description]??''):''})).filter(r=>Object.values(r).some(v=>v&&v!==r.rowNumber)); return{rows:out,columns:headers,mapped}; }
app.post('/api/parse-excel', upload.single('file'), async (req,res)=>{ try { if(!req.file)return res.status(400).json({error:'엑셀 파일을 업로드해주세요.'}); const wb=XLSX.read(req.file.buffer,{type:'buffer'}); const sheets=wb.SheetNames.map(name=>{const raw=XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:''}); const parsed=cleanRows(raw); return{name,...parsed,rowCount:parsed.rows.length};}); const best=sheets.reduce((a,b)=>b.rowCount>a.rowCount?b:a,sheets[0]); res.json({fileName:req.file.originalname,sheets,selectedSheet:best?.name||null,...best}); } catch(e){res.status(400).json({error:`엑셀을 읽지 못했습니다: ${e.message}`});} });

await loadDb();
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
