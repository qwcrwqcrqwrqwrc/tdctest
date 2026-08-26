require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── WebSub (PubSubHubbub) XML ve Gövde Ayrıştırıcıları ──
app.use(express.text({ type: ['application/atom+xml', 'text/xml', 'application/xml', 'text/plain'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files ──
app.use(express.static(path.join(__dirname)));

// ── CORS (allow frontend requests) ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ══════════════════════════════════════════════════
//  TOKEN CACHE
// ══════════════════════════════════════════════════
const tokenCache = {
  kick: { token: null, expiresAt: 0 }
};

// ══════════════════════════════════════════════════
//  KICK API
// ══════════════════════════════════════════════════

async function getKickAppToken() {
  const now = Date.now();
  if (tokenCache.kick.token && now < tokenCache.kick.expiresAt) {
    return tokenCache.kick.token;
  }

  const clientId = process.env.KICK_CLIENT_ID;
  const clientSecret = process.env.KICK_CLIENT_SECRET;

  if (!clientId || !clientSecret || clientId.startsWith('BURAYA')) {
    throw new Error('Kick API anahtarları .env dosyasında tanımlı değil');
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });

  const resp = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Kick token alınamadı: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  tokenCache.kick.token = data.access_token;
  // 5 dakika önce expire olarak yenile
  tokenCache.kick.expiresAt = now + (data.expires_in - 300) * 1000;

  console.log('[Kick] App Access Token alındı, geçerlilik:', data.expires_in, 's');
  return data.access_token;
}

async function getKickChannelSlug() {
  return process.env.KICK_CHANNEL_SLUG || 'turkdostclan';
}

// Kick'ten user ID almak için slug ile arama yap (ilk çalıştırmada)
let kickUserId = null;

async function resolveKickUserId(token) {
  if (kickUserId) return kickUserId;

  const slug = await getKickChannelSlug();

  try {
    const resp = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TDC-StreamProxy/1.0'
      }
    });
    if (resp.ok) {
      const data = await resp.json();
      kickUserId = data.user_id || data.user?.id;
      if (kickUserId) {
        console.log('[Kick] User ID çözümlendi:', kickUserId, 'slug:', slug);
        return kickUserId;
      }
    }
  } catch (e) {
    console.warn('[Kick] v2 channels API erişilemedi, fallback kullanılacak:', e.message);
  }

  return null;
}

app.get('/api/kick-status', async (req, res) => {
  try {
    const token = await getKickAppToken();
    const slug = await getKickChannelSlug();

    // Method 1: Try official API with user ID
    const userId = await resolveKickUserId(token);

    if (userId) {
      const apiResp = await fetch(`https://api.kick.com/public/v1/users/livestreams?user_id=${userId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });

      if (apiResp.ok) {
        const apiData = await apiResp.json();
        const streams = apiData.data || [];

        if (streams.length > 0) {
          const stream = streams[0];
          return res.json({
            platform: 'kick',
            is_live: true,
            viewer_count: stream.viewer_count || 0,
            title: stream.title || '',
            thumbnail: stream.thumbnail || '',
            channel_url: `https://kick.com/${slug}`
          });
        } else {
          return res.json({
            platform: 'kick',
            is_live: false,
            viewer_count: 0,
            title: '',
            thumbnail: '',
            channel_url: `https://kick.com/${slug}`
          });
        }
      }
    }

    // Method 2: Fallback to undocumented v2 API (from server, no CORS issue)
    const fallbackResp = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TDC-StreamProxy/1.0'
      }
    });

    if (fallbackResp.ok) {
      const chData = await fallbackResp.json();
      const ls = chData.livestream;

      return res.json({
        platform: 'kick',
        is_live: !!ls && ls.is_live === true,
        viewer_count: ls ? (ls.viewer_count || 0) : 0,
        title: ls ? (ls.session_title || '') : '',
        thumbnail: ls ? (ls.thumbnail?.url || '') : '',
        channel_url: `https://kick.com/${slug}`
      });
    }

    // If both fail
    return res.json({
      platform: 'kick',
      is_live: false,
      viewer_count: 0,
      title: '',
      thumbnail: '',
      channel_url: `https://kick.com/${slug}`,
      error: 'Kick API erişilemedi'
    });

  } catch (err) {
    console.error('[Kick] Hata:', err.message);
    res.status(500).json({
      platform: 'kick',
      is_live: false,
      viewer_count: 0,
      error: err.message
    });
  }
});

app.get('/api/youtube-status', async (req, res) => {
  try {
    const status = await fetchYouTubeStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      platform: 'youtube',
      is_live: false,
      viewer_count: 0,
      error: err.message
    });
  }
});

// ══════════════════════════════════════════════════
//  COMBINED STATUS ENDPOINT (fetch both at once)
// ══════════════════════════════════════════════════

app.get('/api/stream-status', async (req, res) => {
  try {
    const [kickRes, youtubeRes] = await Promise.allSettled([
      fetchKickStatus(),
      fetchYouTubeStatus()
    ]);

    res.json({
      kick: kickRes.status === 'fulfilled' ? kickRes.value : { is_live: false, viewer_count: 0, error: kickRes.reason?.message },
      youtube: youtubeRes.status === 'fulfilled' ? youtubeRes.value : { is_live: false, viewer_count: 0, error: youtubeRes.reason?.message }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Internal helpers for combined endpoint
async function fetchKickStatus() {
  const token = await getKickAppToken();
  const slug = process.env.KICK_CHANNEL_SLUG || 'turkdostclan';
  const userId = await resolveKickUserId(token);

  if (userId) {
    const apiResp = await fetch(`https://api.kick.com/public/v1/users/livestreams?user_id=${userId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    if (apiResp.ok) {
      const apiData = await apiResp.json();
      const streams = apiData.data || [];
      if (streams.length > 0) {
        const s = streams[0];
        return { platform: 'kick', is_live: true, viewer_count: s.viewer_count || 0, title: s.title || '', thumbnail: s.thumbnail || '', channel_url: `https://kick.com/${slug}` };
      }
      return { platform: 'kick', is_live: false, viewer_count: 0, title: '', thumbnail: '', channel_url: `https://kick.com/${slug}` };
    }
  }

  // Fallback
  const fbResp = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'TDC-StreamProxy/1.0' }
  });
  if (fbResp.ok) {
    const ch = await fbResp.json();
    const ls = ch.livestream;
    return { platform: 'kick', is_live: !!ls && ls.is_live === true, viewer_count: ls ? (ls.viewer_count || 0) : 0, title: ls ? (ls.session_title || '') : '', thumbnail: ls ? (ls.thumbnail?.url || '') : '', channel_url: `https://kick.com/${slug}` };
  }

  return { platform: 'kick', is_live: false, viewer_count: 0, channel_url: `https://kick.com/${slug}` };
}

// ══════════════════════════════════════════════════
//  YOUTUBE 2-KATMANLI MİMARİ
//  1. Katman: WebSub (PubSubHubbub) Webhook (Anlık Push)
//  2. Katman: YouTube RSS Feed (Polling & Fallback)
// ══════════════════════════════════════════════════

const ytCache = {
  data: null,
  expiresAt: 0,
  latestVideoId: null
};

/**
 * YouTube Data API v3 ile Video ID'sinin Canlılık ve Yayın Detaylarını Doğrular
 */
async function checkYouTubeVideoDetails(videoId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  let handle = process.env.YOUTUBE_CHANNEL_HANDLE || '@turkdostclan55';
  if (!handle.startsWith('@')) handle = '@' + handle;
  const channelUrl = `https://www.youtube.com/${handle}/live`;
  const referer = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || 'https://tdctest.onrender.com/';

  if (!apiKey || apiKey.startsWith('BURAYA') || !videoId) {
    return null;
  }

  try {
    const videoResp = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoId}&key=${apiKey}`,
      {
        headers: { 'Referer': referer }
      }
    );

    if (!videoResp.ok) {
      const errText = await videoResp.text();
      console.warn(`[YouTube API] Video sorgu hatası (${videoResp.status}):`, errText);
      return null;
    }

    const videoData = await videoResp.json();
    if (videoData.items && videoData.items.length > 0) {
      const item = videoData.items[0];

      // Canlı yayın kontrolü: liveBroadcastContent === 'live' ve actualEndTime olmamalıdır
      const isLive = item.snippet?.liveBroadcastContent === 'live' && !item.liveStreamingDetails?.actualEndTime;

      if (isLive) {
        let viewerCount = 0;
        if (item.liveStreamingDetails?.concurrentViewers) {
          viewerCount = parseInt(item.liveStreamingDetails.concurrentViewers, 10);
        }

        const title = item.snippet?.title || '';
        const thumbnail =
          item.snippet?.thumbnails?.maxres?.url ||
          item.snippet?.thumbnails?.high?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.default?.url ||
          '';

        return {
          platform: 'youtube',
          is_live: true,
          viewer_count: viewerCount,
          title: title,
          thumbnail: thumbnail,
          channel_url: `https://www.youtube.com/watch?v=${videoId}`
        };
      }
    }

    // Video mevcut ama canlı değil (VOD veya sona ermiş)
    return {
      platform: 'youtube',
      is_live: false,
      viewer_count: 0,
      title: '',
      thumbnail: '',
      channel_url: channelUrl
    };
  } catch (err) {
    console.error('[YouTube API] Detay sorgulama hatası:', err.message);
    return null;
  }
}

/**
 * 2. Katman: YouTube RSS XML Akışından En Son Video ID'sini Çeker (Decapi Bağımsız)
 */
async function fetchLatestVideoIdFromRSS(channelId) {
  try {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const resp = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!resp.ok) {
      throw new Error(`YouTube RSS erişim hatası: HTTP ${resp.status}`);
    }

    const xml = await resp.text();
    const match = xml.match(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/i) ||
                  xml.match(/<id>yt:video:([a-zA-Z0-9_-]{11})<\/id>/i);

    if (match && match[1]) {
      return match[1];
    }
    return null;
  } catch (err) {
    console.warn('[YouTube RSS] Hata:', err.message);
    return null;
  }
}

/**
 * YouTube Durumunu Getirir (Önbellek -> WebSub Push Durumu -> RSS & Data API)
 */
async function fetchYouTubeStatus() {
  const now = Date.now();
  if (ytCache.data && now < ytCache.expiresAt) {
    return ytCache.data;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  let handle = process.env.YOUTUBE_CHANNEL_HANDLE || '@turkdostclan55';
  if (!handle.startsWith('@')) handle = '@' + handle;
  const channelUrl = `https://www.youtube.com/${handle}/live`;
  const channelId = process.env.YOUTUBE_CHANNEL_ID || 'UCNpMoAARNn9fenbbyWZB2Wg';

  if (!apiKey || apiKey.startsWith('BURAYA')) {
    return { platform: 'youtube', is_live: false, viewer_count: 0, channel_url: channelUrl, error: 'API Key eksik' };
  }

  try {
    // 2. Katman: RSS üzerinden en güncel video ID'sini al
    const latestVideoId = await fetchLatestVideoIdFromRSS(channelId);

    if (latestVideoId) {
      const result = await checkYouTubeVideoDetails(latestVideoId);
      if (result) {
        ytCache.data = result;
        ytCache.expiresAt = now + (10 * 1000); // 10 saniye önbellek
        ytCache.latestVideoId = latestVideoId;
        return result;
      }
    }

    // Kanalda aktif canlı yayın yok
    const offlineResult = {
      platform: 'youtube',
      is_live: false,
      viewer_count: 0,
      title: '',
      thumbnail: '',
      channel_url: channelUrl
    };

    ytCache.data = offlineResult;
    ytCache.expiresAt = now + (10 * 1000);
    return offlineResult;

  } catch (err) {
    console.error('[YouTube] Durum getirme hatası:', err.message);
    return { platform: 'youtube', is_live: false, viewer_count: 0, channel_url: channelUrl, error: err.message };
  }
}

// ══════════════════════════════════════════════════
//  1. KATMAN: WEBSUB (PUBSUBHUBBUB) WEBHOOK ROUTES
// ══════════════════════════════════════════════════

/**
 * WebSub Hub Doğrulama Endpoint'i (Challenge Yanıtı)
 */
app.get('/api/youtube-webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const topic = req.query['hub.topic'];
  const leaseSeconds = req.query['hub.lease_seconds'];

  if (mode === 'subscribe' || mode === 'unsubscribe') {
    console.log(`[YouTube WebSub] Doğrulama (${mode}) başarılı! Topic: ${topic} - Süre: ${leaseSeconds || 'varsayılan'}s`);
    return res.status(200).send(challenge);
  } else if (mode === 'denied') {
    console.warn(`[YouTube WebSub] Abonelik reddedildi. Neden:`, req.query['hub.reason']);
    return res.status(200).send('OK');
  }

  res.status(400).send('Geçersiz WebSub isteği');
});

/**
 * WebSub Hub Anlık Bildirim (Push Notification) Endpoint'i
 */
app.post('/api/youtube-webhook', async (req, res) => {
  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    console.log('[YouTube WebSub] 📡 Anlık yayın/video bildirimi alındı (Push Notification)');

    const match = rawBody.match(/<yt:videoId>(.*?)<\/yt:videoId>/i) ||
                  rawBody.match(/<id>yt:video:(.*?)<\/id>/i);

    if (match && match[1]) {
      const videoId = match[1].trim();
      console.log(`[YouTube WebSub] 🎯 Video ID tespit edildi: ${videoId}`);

      // Gelen video için YouTube Data API ile canlılık durumunu hemen sorgula ve önbelleği güncelle
      const status = await checkYouTubeVideoDetails(videoId);
      if (status) {
        ytCache.data = status;
        ytCache.expiresAt = Date.now() + (15 * 1000);
        ytCache.latestVideoId = videoId;
        console.log(`[YouTube WebSub] ⚡ Canlı yayın durumu güncellendi: ${status.is_live ? '🟢 CANLI (' + status.viewer_count + ' izleyici)' : '⚫ OFFLINE'}`);
      }
    } else {
      console.log('[YouTube WebSub] XML içinde Video ID bulunamadı veya silinme bildirimi.');
    }

    // Google Hub'a her zaman 200/204 yanıtı verilir
    res.status(200).send('OK');
  } catch (err) {
    console.error('[YouTube WebSub] Webhook bildirim işleme hatası:', err.message);
    res.status(200).send('OK');
  }
});

/**
 * Google PubSubHubbub Hub'ına Otomatik Abone Olur
 */
async function subscribeToYouTubeWebSub() {
  const channelId = process.env.YOUTUBE_CHANNEL_ID || 'UCNpMoAARNn9fenbbyWZB2Wg';
  const baseUrl = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;

  if (!baseUrl) {
    console.log('   ℹ️  WebSub: Dışa açık URL (WEBHOOK_URL / RENDER_EXTERNAL_URL) bulunamadı. WebSub push atlandı, 2. Katman (RSS) tam kapasite aktif.');
    return;
  }

  const callbackUrl = `${baseUrl.replace(/\/$/, '')}/api/youtube-webhook`;
  const topicUrl = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
  const hubUrl = 'https://pubsubhubbub.appspot.com/subscribe';

  const params = new URLSearchParams({
    'hub.callback': callbackUrl,
    'hub.topic': topicUrl,
    'hub.mode': 'subscribe',
    'hub.verify': 'async',
    'hub.lease_seconds': '864000' // 10 gün
  });

  try {
    console.log(`[YouTube WebSub] Google Hub'a abonelik isteği gönderiliyor... (${callbackUrl})`);
    const resp = await fetch(hubUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (resp.status === 202 || resp.status === 200 || resp.status === 204) {
      console.log(`   ✅ YouTube WebSub abonelik talebi Hub'a iletildi (${resp.status} Accepted).`);
    } else {
      const errText = await resp.text();
      console.warn(`   ⚠️  YouTube WebSub Hub yanıtı: ${resp.status} - ${errText}`);
    }
  } catch (e) {
    console.error('   ❌ YouTube WebSub abonelik hatası:', e.message);
  }
}

// ══════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════

app.listen(PORT, async () => {
  console.log(`\n🎮 TurkDostClan Stream Proxy çalışıyor: http://localhost:${PORT}`);
  console.log(`   Kick kanal: ${process.env.KICK_CHANNEL_SLUG || 'turkdostclan'}`);
  console.log(`   YouTube kanal: ${process.env.YOUTUBE_CHANNEL_HANDLE || '@turkdostclan55'}`);

  const kickOk = process.env.KICK_CLIENT_ID && !process.env.KICK_CLIENT_ID.startsWith('BURAYA');
  const ytOk = process.env.YOUTUBE_API_KEY && !process.env.YOUTUBE_API_KEY.startsWith('BURAYA');

  if (!kickOk) console.warn('   ⚠️  Kick API anahtarları tanımlı değil (.env dosyasını düzenle)');
  if (kickOk) console.log('   ✅ Kick API anahtarları tanımlı');

  if (!ytOk) console.warn('   ⚠️  YouTube API Key eksik (.env dosyasını düzenle)');
  if (ytOk) {
    console.log('   ✅ YouTube API Key tanımlı');
    console.log('   ✅ 2-Katmanlı YouTube Mimarisi devrede (Katman 1: WebSub Webhook | Katman 2: RSS Feed)');
    // WebSub aboneliğini başlat
    await subscribeToYouTubeWebSub();
    // 24 saatte bir WebSub aboneliğini tazele
    setInterval(subscribeToYouTubeWebSub, 24 * 60 * 60 * 1000);
  }
  console.log();
});
