require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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

  // Kick public API does not have a "get user by slug" endpoint.
  // The /public/v1/users endpoint returns the authenticated user or by ID.
  // We'll use the v2 channels endpoint with the old API as fallback.
  // For now, try the undocumented v2 channels API from server-side (no CORS issue).
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
//  YOUTUBE API STATUS FETCH
// ══════════════════════════════════════════════════

const ytCache = { data: null, expiresAt: 0 };

async function fetchYouTubeStatus() {
  const now = Date.now();
  if (ytCache.data && now < ytCache.expiresAt) {
    return ytCache.data;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  let handle = process.env.YOUTUBE_CHANNEL_HANDLE || '@turkdostclan55';
  if (!handle.startsWith('@')) handle = '@' + handle;
  const channelUrl = `https://www.youtube.com/${handle}/live`;

  if (!apiKey || apiKey.startsWith('BURAYA')) {
    return { platform: 'youtube', is_live: false, viewer_count: 0, channel_url: channelUrl, error: 'API Key eksik' };
  }

  try {
    // Google Cloud API Referer kisitlamasini asmak icin proxy sunucunun adresini iletiyoruz
    const referer = process.env.RENDER_EXTERNAL_URL || 'https://tdctest.onrender.com/';
    const channelId = process.env.YOUTUBE_CHANNEL_ID || 'UCNpMoAARNn9fenbbyWZB2Wg';

    // Render vb. bulut sunucularinin IP'leri YouTube tarafindan (Bot/Consent) engellendigi icin 
    // veya YouTube API Search gecikmeli calistigi icin "Decapi" uzerinden guncel videoyu buluyoruz.
    const decapiResp = await fetch(`https://decapi.me/youtube/latest_video?id=${channelId}`);
    if (!decapiResp.ok) throw new Error(`Decapi Hatasi: ${decapiResp.status}`);

    const decapiText = await decapiResp.text();

    const match = decapiText.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);

    if (match && match[1]) {
      const videoId = match[1];

      let viewerCount = 0;
      let title = '';
      let thumbnail = '';

      const videoResp = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoId}&key=${apiKey}`, {
        headers: { 'Referer': referer }
      });

      if (videoResp.ok) {
        const videoData = await videoResp.json();
        if (videoData.items && videoData.items.length > 0) {
          const item = videoData.items[0];

          // Sadece aktif olarak yayında olan (liveBroadcastContent === 'live' ve bitiş tarihi olmayan) videolar canlıdır
          const isLive = item.snippet?.liveBroadcastContent === 'live' && !item.liveStreamingDetails?.actualEndTime;

          if (isLive) {
            title = item.snippet?.title || '';
            thumbnail = item.snippet?.thumbnails?.maxres?.url || item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '';
            if (item.liveStreamingDetails?.concurrentViewers) {
              viewerCount = parseInt(item.liveStreamingDetails.concurrentViewers, 10);
            }

            const result = {
              platform: 'youtube',
              is_live: true,
              viewer_count: viewerCount,
              title: title,
              thumbnail: thumbnail,
              channel_url: `https://www.youtube.com/watch?v=${videoId}`
            };

            ytCache.data = result;
            ytCache.expiresAt = now + (5 * 1000);
            return result;
          }
        }
      }
    }

    // Kanalda canli yayin yok
    const offlineResult = { platform: 'youtube', is_live: false, viewer_count: 0, title: '', thumbnail: '', channel_url: channelUrl };
    ytCache.data = offlineResult;
    ytCache.expiresAt = now + (5 * 1000); // 5 saniye önbellek
    return offlineResult;

  } catch (err) {
    console.error('[YouTube] Hata:', err.message);
    return { platform: 'youtube', is_live: false, viewer_count: 0, channel_url: channelUrl, error: err.message };
  }
}

// ══════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n🎮 TurkDostClan Stream Proxy çalışıyor: http://localhost:${PORT}`);
  console.log(`   Kick kanal: ${process.env.KICK_CHANNEL_SLUG || 'turkdostclan'}`);
  console.log(`   YouTube kanal: ${process.env.YOUTUBE_CHANNEL_HANDLE || '@turkdostclan55'}`);

  const kickOk = process.env.KICK_CLIENT_ID && !process.env.KICK_CLIENT_ID.startsWith('BURAYA');
  const ytOk = process.env.YOUTUBE_API_KEY && !process.env.YOUTUBE_API_KEY.startsWith('BURAYA');

  if (!kickOk) console.warn('   ⚠️  Kick API anahtarları tanımlı değil (.env dosyasını düzenle)');
  if (kickOk) console.log('   ✅ Kick API anahtarları tanımlı');

  if (!ytOk) console.warn('   ⚠️  YouTube API Key eksik (.env dosyasını düzenle)');
  if (ytOk) console.log('   ✅ YouTube API Key tanımlı\n');
  else console.log();
});
