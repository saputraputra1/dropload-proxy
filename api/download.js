// DropLoad Proxy — Vercel Serverless Function
// POST /api/download  →  { url: "https://..." }

const COBALT = 'https://cobalt-production-de8b.up.railway.app/';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, mode } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });

  const platform = detect(url);
  if (!platform) return res.status(400).json({ ok: false, error: 'Platform tidak didukung' });

  const log = [];
  const dlog = msg => { log.push(msg); console.log('[DropLoad]', msg); };

  try {
    let result;
    if (platform === 'tiktok')         result = await doTikTok(url, dlog);
    else if (platform === 'instagram') result = await doInstagram(url, dlog);
    else if (platform === 'facebook')  result = await doFacebook(url, dlog);
    else if (platform === 'youtube')   result = await doYouTube(url, dlog);
    else if (platform === 'twitter')   result = await doTwitter(url, dlog);
    return res.status(200).json({ ok: true, ...result, log });
  } catch (e) {
    dlog('ERROR: ' + e.message);
    return res.status(500).json({ ok: false, error: e.message, log });
  }
};

// ─── detect platform ──────────────────────────────────────
function detect(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('instagram.com') || u.includes('instagr.am')) return 'instagram';
  if (u.includes('tiktok.com') || u.includes('vm.tiktok'))     return 'tiktok';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  if (u.includes('youtube.com') || u.includes('youtu.be'))     return 'youtube';
  if (u.includes('twitter.com') || u.includes('x.com'))        return 'twitter';
  return null;
}

// ─── cobalt helper ────────────────────────────────────────
async function cobalt(url, mode, extra) {
  const body = {
    url,
    videoQuality: '1080',
    audioFormat: 'mp3',
    audioBitrate: '128',
    filenameStyle: 'basic',
    downloadMode: mode || 'auto',
    youtubeVideoCodec: 'h264',
    youtubeHLS: false,
    ...( extra || {} ),
  };
  const r = await fetch(COBALT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const d = await r.json();
  if (d.status === 'error') throw new Error('cobalt: ' + (d.error?.code || JSON.stringify(d.error)));
  if (!['tunnel','redirect','picker','local-processing'].includes(d.status))
    throw new Error('cobalt: status ' + d.status);
  return d;
}

function fromCobalt(d, platform, meta) {
  meta = meta || {};
  const downloads = [];
  if (d.status === 'picker') {
    (d.picker || []).forEach((item, i) => {
      const v = item.type === 'video' || item.type === 'gif';
      downloads.push({ label: v ? 'Video '+(i+1) : 'Foto '+(i+1), sub: v ? 'Video' : 'Gambar', quality: '', type: v ? 'video' : 'image', url: item.url, cls: v ? 'dl-hd' : 'dl-photo' });
    });
    if (d.audio) downloads.push({ label:'Audio', sub:'Track audio', quality:'', type:'audio', url: d.audio, cls:'dl-audio' });
    if (!meta.thumb && d.picker?.[0]?.thumb) meta.thumb = d.picker[0].thumb;
  } else {
    if (!d.url) throw new Error('cobalt: no url');
    downloads.push({ label:'Video HD', sub:'Kualitas terbaik', quality:'HD', type:'video', url: d.url, cls:'dl-hd' });
  }
  return {
    platform,
    title:      meta.title || (d.filename ? d.filename.replace(/\.[^.]+$/, '') : '') || platform,
    author:     meta.author || '',
    thumb:      meta.thumb  || '',
    duration:   meta.duration || '',
    likes:      meta.likes  || '',
    views:      meta.views  || '',
    downloads,
    isPortrait: meta.isPortrait || false,
  };
}

async function ogThumb(pageUrl) {
  try {
    const r = await fetch(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(8000), redirect: 'follow',
    });
    const html = await r.text();
    const m = html.match(/<meta[^>]+(?:property="og:image"|name="twitter:image")[^>]+content="([^"]+)"/i)
           || html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:property="og:image"|name="twitter:image")/i);
    return m ? m[1] : '';
  } catch { return ''; }
}

// ─── TikTok ───────────────────────────────────────────────
async function doTikTok(url, dlog) {
  dlog('TikTok: tikwm...');
  try {
    const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1', {
      headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(12000),
    });
    const d = await r.json();
    if (d?.code === 0 && d?.data) {
      const v = d.data;
      const downloads = [];
      if (v.hdplay) downloads.push({ label:'Video HD',   sub:'Tanpa watermark', quality:'1080p', type:'video', url:v.hdplay, cls:'dl-hd' });
      if (v.play)   downloads.push({ label:'Video SD',   sub:'Tanpa watermark', quality:'720p',  type:'video', url:v.play,   cls:'dl-sd' });
      if (v.wmplay) downloads.push({ label:'Video + WM', sub:'Dengan watermark', quality:'',    type:'video', url:v.wmplay, cls:'dl-sd' });
      if (v.music)  downloads.push({ label:'Audio MP3',  sub:'Musik/suara',      quality:'',    type:'audio', url:v.music,  cls:'dl-audio' });
      if (downloads.length) {
        dlog('TikTok: berhasil tikwm ✓');
        const dur = v.duration ? Math.floor(v.duration/60)+':'+String(v.duration%60).padStart(2,'0') : '';
        const fn = n => !n ? '' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
        return { platform:'tiktok', title:v.title||'TikTok', author:v.author?.nickname||'', thumb:v.cover||'', duration:dur, likes:fn(v.digg_count), views:fn(v.play_count), downloads, isPortrait:true };
      }
    }
  } catch(e) { dlog('tikwm: ' + e.message); }
  dlog('TikTok: cobalt fallback...');
  const d = await cobalt(url, 'auto', { tiktokFullAudio:true });
  return fromCobalt(d, 'tiktok', { isPortrait:true });
}

// ─── Instagram ────────────────────────────────────────────
async function doInstagram(url, dlog) {
  // Method 1: cobalt
  dlog('IG: cobalt...');
  try {
    const d = await cobalt(url, 'auto');
    const r = fromCobalt(d, 'instagram');
    if (!r.thumb) r.thumb = await ogThumb(url);
    try {
      const a = await cobalt(url, 'audio');
      if (a.url && !r.downloads.find(x => x.type === 'audio'))
        r.downloads.push({ label:'Audio', sub:'Audio saja', quality:'', type:'audio', url:a.url, cls:'dl-audio' });
    } catch {}
    if (r.downloads.length) { dlog('IG: cobalt ✓'); return r; }
  } catch(e) { dlog('IG cobalt: ' + e.message); }

  // Method 2–4: scraper sites — dari server tidak kena CORS
  const scrapers = [
    'https://snapinsta.to/api/ajaxSearch',
    'https://saveig.app/api/ajaxSearch',
    'https://igdownloader.app/api/ajaxSearch',
  ];
  for (const ep of scrapers) {
    const name = new URL(ep).hostname;
    dlog('IG: ' + name + '...');
    try {
      const r2 = await fetch(ep, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Origin': 'https://' + name,
          'Referer': 'https://' + name + '/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        },
        body: 'url=' + encodeURIComponent(url) + '&lang=id',
        signal: AbortSignal.timeout(15000),
      });
      const text = await r2.text();
      const result = parseIG(text);
      if (result.downloads.length) { dlog('IG: ' + name + ' ✓'); return result; }
    } catch(e) { dlog(name + ': ' + e.message); }
  }
  throw new Error('Semua method Instagram gagal');
}

function parseIG(raw) {
  let html = raw;
  try { const j = JSON.parse(raw); html = j.data || j.html || j.content || raw; } catch {}
  const downloads = []; const seen = new Set();
  const re = /href=["']([^"']+)["'][^>]*>([^<]*)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    const lbl  = (m[2]||'').trim().toLowerCase();
    if (!href || href==='#' || href.startsWith('javascript') || seen.has(href)) continue;
    const full = href.startsWith('//') ? 'https:'+href : href;
    if (!full.startsWith('http')) continue;
    const isPhoto = /\.(jpg|jpeg|png|webp)/i.test(full) || lbl.includes('foto') || lbl.includes('photo');
    const isAudio = /\.(mp3|m4a)/i.test(full) || lbl.includes('audio');
    const isVideo = /\.(mp4|mov|webm)/i.test(full) || lbl.includes('video') || lbl.includes('download')
                 || full.includes('instagram') || full.includes('fbcdn') || full.includes('cdninstagram');
    if (!isPhoto && !isAudio && !isVideo) continue;
    seen.add(full);
    if (isAudio) downloads.push({ label:'Audio', sub:'MP3', quality:'', type:'audio', url:full, cls:'dl-audio' });
    else if (isPhoto) { const n = downloads.filter(d=>d.type==='image').length+1; downloads.push({ label:'Foto '+n, sub:'Gambar', quality:'', type:'image', url:full, cls:'dl-photo' }); }
    else { const first = !downloads.find(d=>d.type==='video'); downloads.push({ label:first?'Video HD':'Video SD', sub:first?'Kualitas tinggi':'Kualitas standar', quality:first?'HD':'SD', type:'video', url:full, cls:first?'dl-hd':'dl-sd' }); }
  }
  const tm = html.match(/src=["'](https:\/\/[^"']*(?:cdninstagram|fbcdn)[^"']*)["']/i);
  return { platform:'instagram', title:'Konten Instagram', author:'', thumb:tm?tm[1]:'', duration:'', likes:'', views:'', downloads, isPortrait:false };
}

// ─── Facebook ─────────────────────────────────────────────
async function doFacebook(url, dlog) {
  // Method 1: cobalt
  dlog('FB: cobalt...');
  try {
    const d = await cobalt(url, 'auto');
    const r = fromCobalt(d, 'facebook');
    if (!r.thumb) r.thumb = await ogThumb(url);
    try {
      const mu = await cobalt(url, 'mute');
      if (mu.url && mu.url !== r.downloads[0]?.url)
        r.downloads.push({ label:'Video SD', sub:'Tanpa audio', quality:'SD', type:'video', url:mu.url, cls:'dl-sd' });
    } catch {}
    if (r.downloads.length) { dlog('FB: cobalt ✓'); return r; }
  } catch(e) { dlog('FB cobalt: ' + e.message); }

  // Method 2: fdown.net
  dlog('FB: fdown.net...');
  try {
    const r2 = await fetch('https://fdown.net/download.php?URLz=' + encodeURIComponent(url), {
      headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer':'https://fdown.net/' },
      signal: AbortSignal.timeout(15000),
    });
    const html = await r2.text();
    const r3 = parseFB(html);
    if (r3.downloads.length) { dlog('FB: fdown.net ✓'); return r3; }
  } catch(e) { dlog('fdown: ' + e.message); }

  // Method 3: getfvid.com
  dlog('FB: getfvid.com...');
  try {
    let token = '';
    try {
      const pg = await fetch('https://getfvid.com/', { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(8000) });
      const pgHtml = await pg.text();
      const mt = pgHtml.match(/name=["']_token["'][^>]+value=["']([^"']+)["']/i);
      token = mt ? mt[1] : '';
    } catch {}
    const r2 = await fetch('https://getfvid.com/downloader', {
      method: 'POST',
      headers: { 'Content-Type':'application/x-www-form-urlencoded', 'X-Requested-With':'XMLHttpRequest', 'Origin':'https://getfvid.com', 'Referer':'https://getfvid.com/', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      body: 'url=' + encodeURIComponent(url) + (token ? '&_token='+encodeURIComponent(token) : ''),
      signal: AbortSignal.timeout(15000),
    });
    const html = await r2.text();
    const r3 = parseFB(html);
    if (r3.downloads.length) { dlog('FB: getfvid ✓'); return r3; }
  } catch(e) { dlog('getfvid: ' + e.message); }

  throw new Error('Semua method Facebook gagal');
}

function parseFB(html) {
  const downloads = []; const seen = new Set();
  try {
    const j = JSON.parse(html);
    const hd = j.hd || j.url_hd || j.links?.hd || '';
    const sd = j.sd || j.url_sd || j.links?.sd || '';
    if (hd) { downloads.push({ label:'Video HD', sub:'Kualitas tinggi', quality:'HD', type:'video', url:hd, cls:'dl-hd' }); seen.add(hd); }
    if (sd) { downloads.push({ label:'Video SD', sub:'Kualitas standar', quality:'SD', type:'video', url:sd, cls:'dl-sd' }); seen.add(sd); }
  } catch {}
  if (!downloads.length) {
    const re = /href=["']([^"']+)["'][^>]*>([^<]*)/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1].trim(); const lbl = (m[2]||'').trim();
      if (!href || href==='#' || seen.has(href) || !href.startsWith('http')) continue;
      if (!href.includes('video') && !href.includes('.mp4') && !href.includes('fbcdn') && !href.includes('lookaside')) continue;
      seen.add(href);
      const isHD = /hd|high|1080|720/i.test(lbl) || !downloads.find(d=>d.type==='video');
      downloads.push({ label:isHD?'Video HD':'Video SD', sub:isHD?'Kualitas tinggi':'Kualitas standar', quality:isHD?'HD':'SD', type:'video', url:href, cls:isHD?'dl-hd':'dl-sd' });
    }
  }
  return { platform:'facebook', title:'Video Facebook', author:'', thumb:'', duration:'', likes:'', views:'', downloads, isPortrait:false };
}

// ─── YouTube ──────────────────────────────────────────────
async function doYouTube(url, dlog) {
  dlog('YT: cobalt...');
  const d = await cobalt(url, 'auto', { youtubeVideoCodec:'h264', videoQuality:'1080' });
  const r = fromCobalt(d, 'youtube');
  const mv = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (mv) r.thumb = 'https://img.youtube.com/vi/' + mv[1] + '/hqdefault.jpg';
  try {
    const sd = await cobalt(url, 'auto', { youtubeVideoCodec:'h264', videoQuality:'720' });
    if (sd.url && sd.url !== r.downloads[0]?.url)
      r.downloads.push({ label:'Video 720p', sub:'Kualitas standar', quality:'720p', type:'video', url:sd.url, cls:'dl-sd' });
  } catch {}
  try {
    const au = await cobalt(url, 'audio', { audioFormat:'mp3', audioBitrate:'128' });
    if (au.url) r.downloads.push({ label:'Audio MP3', sub:'128kbps', quality:'', type:'audio', url:au.url, cls:'dl-audio' });
  } catch {}
  dlog('YT: berhasil ✓');
  return r;
}

// ─── Twitter / X ──────────────────────────────────────────
async function doTwitter(url, dlog) {
  dlog('Twitter: cobalt...');
  const d = await cobalt(url, 'auto');
  const r = fromCobalt(d, 'twitter');
  if (!r.thumb) r.thumb = await ogThumb(url);
  dlog('Twitter: berhasil ✓');
  return r;
}
