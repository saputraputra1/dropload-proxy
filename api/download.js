// DropLoad — Vercel Serverless Proxy
// Endpoint: POST /api/download
// Body: { url: "https://..." }
// Memanggil cobalt + scraper dari sisi server — bebas CORS

const COBALT_API = 'https://cobalt-production-de8b.up.railway.app/';

// ── CORS headers ──────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

// ── Main handler ──────────────────────────────────────────
export default async function handler(req, res) {
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).set(corsHeaders()).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  const { url, mode } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'url required' });
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({ error: 'Platform tidak didukung' });
  }

  const log = [];
  const dlog = (msg) => { log.push(msg); console.log('[DropLoad Proxy]', msg); };

  try {
    let result;
    if (platform === 'tiktok')    result = await fetchTikTok(url, dlog);
    else if (platform === 'instagram') result = await fetchInstagram(url, mode || 'auto', dlog);
    else if (platform === 'facebook')  result = await fetchFacebook(url, dlog);
    else if (platform === 'youtube')   result = await fetchYouTube(url, mode || 'auto', dlog);
    else if (platform === 'twitter')   result = await fetchTwitter(url, dlog);
    else throw new Error('Platform tidak didukung: ' + platform);

    return res.status(200).json({ ok: true, ...result, log });
  } catch (err) {
    dlog('FINAL ERROR: ' + err.message);
    return res.status(500).json({ ok: false, error: err.message, log });
  }
}

// ── Platform detection ────────────────────────────────────
function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('instagram.com') || u.includes('instagr.am')) return 'instagram';
  if (u.includes('tiktok.com') || u.includes('vm.tiktok') || u.includes('vt.tiktok')) return 'tiktok';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('twitter.com') || u.includes('x.com') || u.includes('t.co')) return 'twitter';
  return null;
}

// ── cobalt helper ─────────────────────────────────────────
async function cobaltFetch(url, mode, extra) {
  mode  = mode  || 'auto';
  extra = extra || {};
  const body = {
    url,
    videoQuality:      '1080',
    audioFormat:       'mp3',
    audioBitrate:      '128',
    filenameStyle:     'basic',
    downloadMode:      mode,
    youtubeVideoCodec: 'h264',
    youtubeHLS:        false,
    alwaysProxy:       false,
    disableMetadata:   false,
    ...extra,
  };

  const res = await fetch(COBALT_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(25000),
  });

  const data = await res.json();
  if (data.status === 'error') throw new Error('cobalt: ' + (data.error?.code || JSON.stringify(data.error)));
  if (!['tunnel','redirect','picker','local-processing'].includes(data.status)) throw new Error('cobalt: unexpected status ' + data.status);
  return data;
}

// ── cobalt → standard result ──────────────────────────────
function resultFromCobalt(data, platform, meta) {
  meta = meta || {};
  const downloads = [];

  if (data.status === 'picker') {
    (data.picker || []).forEach((item, i) => {
      const isVid = item.type === 'video' || item.type === 'gif';
      downloads.push({
        label:   isVid ? ('Video ' + (i + 1)) : ('Foto ' + (i + 1)),
        sub:     isVid ? 'Download video' : 'Download gambar',
        quality: '',
        type:    isVid ? 'video' : 'image',
        url:     item.url,
        cls:     isVid ? 'dl-hd' : 'dl-photo',
      });
    });
    if (data.audio) downloads.push({ label:'Audio', sub:'Track audio', quality:'', type:'audio', url:data.audio, cls:'dl-audio' });
    if (!meta.thumb && data.picker?.[0]?.thumb) meta.thumb = data.picker[0].thumb;
  } else {
    if (!data.url) throw new Error('cobalt: no URL in response');
    downloads.push({ label:'Video HD', sub:'Kualitas terbaik', quality:'HD', type:'video', url:data.url, cls:'dl-hd' });
  }

  return {
    platform,
    title:      meta.title || (data.filename ? data.filename.replace(/\.[^.]+$/, '') : '') || ('Konten ' + platform),
    author:     meta.author     || '',
    thumb:      meta.thumb      || '',
    duration:   meta.duration   || '',
    likes:      meta.likes      || '',
    views:      meta.views      || '',
    downloads,
    isPortrait: meta.isPortrait || false,
  };
}

// ── og:image thumbnail helper ─────────────────────────────
async function fetchOgThumb(pageUrl) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    const html = await res.text();
    const m = html.match(/<meta[^>]+(?:property="og:image"|name="twitter:image")[^>]+content="([^"]+)"/i)
           || html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:property="og:image"|name="twitter:image")/i);
    return m ? m[1] : '';
  } catch { return ''; }
}

// ══════════════════════════════════════════════════════════
//  TikTok
// ══════════════════════════════════════════════════════════
async function fetchTikTok(url, dlog) {
  dlog('TikTok: tikwm.com...');
  try {
    const res = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json();
    if (data?.code === 0 && data?.data) {
      const d = data.data;
      const downloads = [];
      if (d.hdplay) downloads.push({ label:'Video HD',   sub:'Tanpa watermark', quality:'1080p', type:'video', url:d.hdplay, cls:'dl-hd' });
      if (d.play)   downloads.push({ label:'Video SD',   sub:'Tanpa watermark', quality:'720p',  type:'video', url:d.play,   cls:'dl-sd' });
      if (d.wmplay) downloads.push({ label:'Video + WM', sub:'Dengan watermark', quality:'',     type:'video', url:d.wmplay, cls:'dl-sd' });
      if (d.music)  downloads.push({ label:'Audio MP3',  sub:'Musik/suara',      quality:'',     type:'audio', url:d.music,  cls:'dl-audio' });
      if (downloads.length) {
        dlog('TikTok: berhasil via tikwm ✓');
        return { platform:'tiktok', title:d.title||'Video TikTok', author:d.author?.nickname||'', thumb:d.cover||'', duration:d.duration?`${Math.floor(d.duration/60)}:${String(d.duration%60).padStart(2,'0')}` :'', likes:d.digg_count?formatNum(d.digg_count):'', views:d.play_count?formatNum(d.play_count):'', downloads, isPortrait:true };
      }
    }
  } catch(e) { dlog('tikwm gagal: ' + e.message); }

  dlog('TikTok: cobalt fallback...');
  const data = await cobaltFetch(url, 'auto', { tiktokFullAudio:true });
  dlog('TikTok: berhasil via cobalt ✓');
  return resultFromCobalt(data, 'tiktok', { isPortrait:true });
}

// ══════════════════════════════════════════════════════════
//  Instagram
// ══════════════════════════════════════════════════════════
async function fetchInstagram(url, mode, dlog) {

  // Method 1: cobalt
  dlog('Instagram: cobalt...');
  try {
    const data = await cobaltFetch(url, mode || 'auto');
    const result = resultFromCobalt(data, 'instagram');
    if (!result.thumb) result.thumb = await fetchOgThumb(url);
    try {
      const aud = await cobaltFetch(url, 'audio');
      if (aud.url && !result.downloads.find(d => d.type === 'audio')) {
        result.downloads.push({ label:'Audio', sub:'Audio saja', quality:'', type:'audio', url:aud.url, cls:'dl-audio' });
      }
    } catch {}
    if (result.downloads.length) { dlog('Instagram: berhasil via cobalt ✓'); return result; }
  } catch(e) { dlog('cobalt gagal: ' + e.message); }

  // Method 2: snapinsta.to — dari server, tidak ada CORS!
  dlog('Instagram: snapinsta.to...');
  try {
    const res = await fetch('https://snapinsta.to/api/ajaxSearch', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':        'application/json, text/javascript, */*; q=0.01',
        'Origin':        'https://snapinsta.to',
        'Referer':       'https://snapinsta.to/',
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body:   'url=' + encodeURIComponent(url) + '&lang=id',
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const result = parseSnapinstaHTML(text, 'instagram');
    if (result.downloads.length) { dlog('Instagram: berhasil via snapinsta.to ✓'); return result; }
  } catch(e) { dlog('snapinsta.to gagal: ' + e.message); }

  // Method 3: saveig.app
  dlog('Instagram: saveig.app...');
  try {
    const res = await fetch('https://saveig.app/api/ajaxSearch', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':        'application/json, text/javascript, */*; q=0.01',
        'Origin':        'https://saveig.app',
        'Referer':       'https://saveig.app/',
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body:   'url=' + encodeURIComponent(url) + '&lang=id',
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const result = parseSnapinstaHTML(text, 'instagram');
    if (result.downloads.length) { dlog('Instagram: berhasil via saveig.app ✓'); return result; }
  } catch(e) { dlog('saveig.app gagal: ' + e.message); }

  // Method 4: igdownloader.app
  dlog('Instagram: igdownloader.app...');
  try {
    const res = await fetch('https://igdownloader.app/api/ajaxSearch', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin':        'https://igdownloader.app',
        'Referer':       'https://igdownloader.app/',
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body:   'url=' + encodeURIComponent(url) + '&lang=id',
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const result = parseSnapinstaHTML(text, 'instagram');
    if (result.downloads.length) { dlog('Instagram: berhasil via igdownloader.app ✓'); return result; }
  } catch(e) { dlog('igdownloader.app gagal: ' + e.message); }

  throw new Error('Semua method Instagram gagal. Log:\n' + dlog.toString());
}

function parseSnapinstaHTML(rawText, platform) {
  let html = rawText;
  try {
    const json = JSON.parse(rawText);
    html = json.data || json.html || json.content || rawText;
  } catch {}

  // Simple regex-based parser (no DOM in Node)
  const downloads = [];
  const seen = new Set();

  // Extract href links
  const linkRegex = /href=["']([^"']+)["'][^>]*>([^<]*)/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const href = m[1].trim();
    const label = (m[2] || '').trim().toLowerCase();
    if (!href || href === '#' || href.startsWith('javascript') || seen.has(href)) continue;
    const full = href.startsWith('//') ? 'https:' + href : href;
    if (!full.startsWith('http')) continue;

    const isPhoto = /\.(jpg|jpeg|png|webp)/i.test(full) || label.includes('photo') || label.includes('foto');
    const isAudio = /\.(mp3|m4a)/i.test(full) || label.includes('audio');
    const isVideo = /\.(mp4|mov|webm)/i.test(full) || label.includes('video') || label.includes('download')
                 || full.includes('instagram') || full.includes('fbcdn') || full.includes('cdninstagram');

    if (!isPhoto && !isAudio && !isVideo) continue;
    seen.add(full);

    if (isAudio) {
      downloads.push({ label:'Audio', sub:'MP3', quality:'', type:'audio', url:full, cls:'dl-audio' });
    } else if (isPhoto) {
      const n = downloads.filter(d => d.type === 'image').length + 1;
      downloads.push({ label:'Foto ' + n, sub:'Download gambar', quality:'', type:'image', url:full, cls:'dl-photo' });
    } else {
      const first = downloads.filter(d => d.type === 'video').length === 0;
      const isHD = label.includes('hd') || label.includes('high') || first;
      downloads.push({ label:isHD?'Video HD':'Video SD', sub:isHD?'Kualitas tinggi':'Kualitas standar', quality:isHD?'HD':'SD', type:'video', url:full, cls:isHD?'dl-hd':'dl-sd' });
    }
  }

  // Extract thumbnail
  const thumbMatch = html.match(/class=["'][^"']*thumb[^"']*["'][^>]*>\s*<img[^>]+src=["']([^"']+)["']/i)
                  || html.match(/src=["'](https:\/\/[^"']*(?:cdninstagram|fbcdn)[^"']*)["']/i);
  const thumb = thumbMatch ? thumbMatch[1] : '';

  return { platform, title:'Konten Instagram', author:'', thumb, duration:'', likes:'', views:'', downloads, isPortrait:false };
}

// ══════════════════════════════════════════════════════════
//  Facebook
// ══════════════════════════════════════════════════════════
async function fetchFacebook(url, dlog) {

  // Method 1: cobalt
  dlog('Facebook: cobalt...');
  try {
    const data = await cobaltFetch(url, 'auto');
    const result = resultFromCobalt(data, 'facebook');
    if (!result.thumb) result.thumb = await fetchOgThumb(url);
    try {
      const muted = await cobaltFetch(url, 'mute');
      if (muted.url && muted.url !== result.downloads[0]?.url) {
        result.downloads.push({ label:'Video SD', sub:'Tanpa audio', quality:'SD', type:'video', url:muted.url, cls:'dl-sd' });
      }
    } catch {}
    if (result.downloads.length) { dlog('Facebook: berhasil via cobalt ✓'); return result; }
  } catch(e) { dlog('cobalt gagal: ' + e.message); }

  // Method 2: fdown.net GET — dari server, tidak ada CORS!
  dlog('Facebook: fdown.net...');
  try {
    const res = await fetch('https://fdown.net/download.php?URLz=' + encodeURIComponent(url), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer':    'https://fdown.net/',
      },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const result = parseFBHTML(html);
    if (result.downloads.length) { dlog('Facebook: berhasil via fdown.net ✓'); return result; }
  } catch(e) { dlog('fdown.net gagal: ' + e.message); }

  // Method 3: getfvid.com POST
  dlog('Facebook: getfvid.com...');
  try {
    // Step 1: get CSRF token
    let token = '';
    try {
      const pg = await fetch('https://getfvid.com/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(8000),
      });
      const pgHtml = await pg.text();
      const m = pgHtml.match(/name=["']_token["'][^>]+value=["']([^"']+)["']/i)
             || pgHtml.match(/_token[^>]+value=["']([^"']+)["']/i);
      token = m ? m[1] : '';
    } catch {}

    const res = await fetch('https://getfvid.com/downloader', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin':        'https://getfvid.com',
        'Referer':       'https://getfvid.com/',
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: 'url=' + encodeURIComponent(url) + (token ? '&_token=' + encodeURIComponent(token) : ''),
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const result = parseFBHTML(html);
    if (result.downloads.length) { dlog('Facebook: berhasil via getfvid.com ✓'); return result; }
  } catch(e) { dlog('getfvid.com gagal: ' + e.message); }

  throw new Error('Semua method Facebook gagal.');
}

function parseFBHTML(html) {
  const downloads = [];
  const seen = new Set();

  // Check JSON response
  try {
    const json = JSON.parse(html);
    const hd = json.hd || json.url_hd || json.links?.hd || '';
    const sd = json.sd || json.url_sd || json.links?.sd || '';
    if (hd) { downloads.push({ label:'Video HD', sub:'Kualitas tinggi', quality:'HD', type:'video', url:hd, cls:'dl-hd' }); seen.add(hd); }
    if (sd) { downloads.push({ label:'Video SD', sub:'Kualitas standar', quality:'SD', type:'video', url:sd, cls:'dl-sd' }); seen.add(sd); }
  } catch {}

  if (!downloads.length) {
    const linkRegex = /href=["']([^"']+)["'][^>]*>([^<]*)/gi;
    let m;
    while ((m = linkRegex.exec(html)) !== null) {
      const href = m[1].trim();
      const label = (m[2] || '').trim();
      if (!href || href === '#' || seen.has(href) || !href.startsWith('http')) continue;
      const isFb = href.includes('video') || href.includes('.mp4') || href.includes('fbcdn')
                || href.includes('lookaside') || href.includes('fdown') || href.includes('getfvid');
      if (!isFb) continue;
      seen.add(href);
      const isHD = /hd|high|1080|720/i.test(label) || downloads.filter(d => d.type === 'video').length === 0;
      downloads.push({ label:isHD?'Video HD':'Video SD', sub:isHD?'Kualitas tinggi':'Kualitas standar', quality:isHD?'HD':'SD', type:'video', url:href, cls:isHD?'dl-hd':'dl-sd' });
    }
  }

  return { platform:'facebook', title:'Video Facebook', author:'', thumb:'', duration:'', likes:'', views:'', downloads, isPortrait:false };
}

// ══════════════════════════════════════════════════════════
//  YouTube
// ══════════════════════════════════════════════════════════
async function fetchYouTube(url, mode, dlog) {
  dlog('YouTube: cobalt...');
  const data = await cobaltFetch(url, mode || 'auto', { youtubeVideoCodec:'h264', videoQuality:'1080' });
  const result = resultFromCobalt(data, 'youtube');

  // Thumbnail direct
  const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) result.thumb = 'https://img.youtube.com/vi/' + m[1] + '/hqdefault.jpg';

  // 720p variant
  try {
    const sd = await cobaltFetch(url, 'auto', { youtubeVideoCodec:'h264', videoQuality:'720' });
    if (sd.url && sd.url !== result.downloads[0]?.url) {
      result.downloads.push({ label:'Video 720p', sub:'Kualitas standar', quality:'720p', type:'video', url:sd.url, cls:'dl-sd' });
    }
  } catch {}

  // Audio MP3
  try {
    const aud = await cobaltFetch(url, 'audio', { audioFormat:'mp3', audioBitrate:'128' });
    if (aud.url) result.downloads.push({ label:'Audio MP3', sub:'128kbps', quality:'', type:'audio', url:aud.url, cls:'dl-audio' });
  } catch {}

  dlog('YouTube: berhasil ✓');
  return result;
}

// ══════════════════════════════════════════════════════════
//  Twitter / X
// ══════════════════════════════════════════════════════════
async function fetchTwitter(url, dlog) {
  dlog('Twitter/X: cobalt...');
  const data = await cobaltFetch(url, 'auto');
  const result = resultFromCobalt(data, 'twitter');
  if (!result.thumb) result.thumb = await fetchOgThumb(url);
  dlog('Twitter/X: berhasil ✓');
  return result;
}

// ── Utilities ─────────────────────────────────────────────
function formatNum(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
