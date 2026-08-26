document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  // ── Login Modal ──
  const modal = document.getElementById('tdc-login');
  document.querySelectorAll('[data-login-open]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      if (!modal) return;
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('tdc-modal-open');
    });
  });
  document.querySelectorAll('[data-login-close]').forEach(function (el) {
    el.addEventListener('click', function () {
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('tdc-modal-open');
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('tdc-modal-open');
    }
  });

  // ── Search Panel ──
  const searchPanel = document.getElementById('tdc-v27-search-panel');
  const searchBtn = document.getElementById('search-btn');
  if (searchBtn && searchPanel) {
    searchBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      searchPanel.classList.add('is-open');
      searchPanel.setAttribute('aria-hidden', 'false');
      var input = searchPanel.querySelector('input[name="s"]');
      if (input) input.focus();
    });
  }
  if (searchPanel) {
    var closeBtn = searchPanel.querySelector('.tdc-v27-search-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        searchPanel.classList.remove('is-open');
        searchPanel.setAttribute('aria-hidden', 'true');
      });
    }
    searchPanel.addEventListener('click', function (e) {
      if (e.target === searchPanel) {
        searchPanel.classList.remove('is-open');
        searchPanel.setAttribute('aria-hidden', 'true');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        searchPanel.classList.remove('is-open');
        searchPanel.setAttribute('aria-hidden', 'true');
      }
    });
  }

  // ── News Feature Carousel ──
  const track = document.querySelector('.news-feature-track');
  const slides = document.querySelectorAll('.news-feature-slide');
  const dots = document.querySelectorAll('.news-feature-dot');
  const prevBtn = document.querySelector('.news-feature-arrow.prev');
  const nextBtn = document.querySelector('.news-feature-arrow.next');
  let currentSlide = 0;
  let autoplayTimer;

  function goToSlide(index) {
    if (index < 0) index = slides.length - 1;
    if (index >= slides.length) index = 0;
    currentSlide = index;
    track.style.transform = 'translateX(-' + (currentSlide * 100) + '%)';
    dots.forEach(function (dot, i) {
      dot.classList.toggle('active', i === currentSlide);
    });
  }

  function startAutoplay() {
    stopAutoplay();
    autoplayTimer = setInterval(function () {
      goToSlide(currentSlide + 1);
    }, 6000);
  }

  function stopAutoplay() {
    if (autoplayTimer) clearInterval(autoplayTimer);
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', function () {
      goToSlide(currentSlide - 1);
      startAutoplay();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', function () {
      goToSlide(currentSlide + 1);
      startAutoplay();
    });
  }

  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      goToSlide(parseInt(dot.dataset.dot, 10));
      startAutoplay();
    });
  });

  // Touch/swipe support for carousel
  let touchStartX = 0;
  let touchEndX = 0;
  const carousel = document.querySelector('.tdc-news-main');
  if (carousel) {
    carousel.addEventListener('touchstart', function (e) {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });
    carousel.addEventListener('touchend', function (e) {
      touchEndX = e.changedTouches[0].screenX;
      var diff = touchStartX - touchEndX;
      if (Math.abs(diff) > 50) {
        if (diff > 0) goToSlide(currentSlide + 1);
        else goToSlide(currentSlide - 1);
        startAutoplay();
      }
    }, { passive: true });
  }

  startAutoplay();

  // ══════════════════════════════════════════════════
  //  STREAM STATUS MANAGER - Kick Live API
  // ══════════════════════════════════════════════════

  const STREAM_POLL_INTERVAL = 5000; // 5 saniye
  const API_BASE = window.location.origin; // Same origin (proxy server)

  /**
   * Updates a stream card's DOM to reflect live/offline status
   */
  function updateStreamCard(platform, data) {
    const card = document.getElementById('stream-' + platform);
    if (!card) return;

    const thumb = card.querySelector('.tdc-stream-thumb');
    const badge = card.querySelector('.tdc-status-badge');
    const viewersEl = card.querySelector('.tdc-stream-viewers');
    const viewerCount = card.querySelector('.tdc-viewer-count');
    const titleEl = card.querySelector('.tdc-stream-title');
    const linkBtn = card.querySelector('.tdc-stream-link');

    if (!thumb || !badge) return;

    // Add transition class
    card.classList.add('tdc-stream-updating');

    setTimeout(function () {
      if (data.is_live) {
        // ── LIVE STATE ──
        card.classList.add('is-live');
        card.classList.remove('is-offline');

        // Badge
        badge.className = 'tdc-status-badge tdc-live-badge';
        badge.innerHTML = '<i></i> CANLI';

        // Thumbnail
        if (data.thumbnail) {
          thumb.style.backgroundImage =
            "linear-gradient(180deg,rgba(4,5,8,.2),rgba(4,5,8,.82)),url('" + data.thumbnail + "')";
          thumb.style.backgroundSize = 'cover';
          thumb.style.backgroundPosition = 'center';
        }

        // Viewer count
        if (viewersEl && viewerCount) {
          viewerCount.textContent = formatViewerCount(data.viewer_count || 0);
          viewersEl.style.display = 'flex';
        }

        // Stream title
        if (titleEl && data.title) {
          titleEl.textContent = data.title;
          titleEl.style.display = 'block';
        }

        // Button
        if (linkBtn) {
          linkBtn.className = 'btn btn-red tdc-stream-btn tdc-stream-link';
          linkBtn.textContent = 'CANLI YAYINA KATIL';
          if (data.channel_url) linkBtn.href = data.channel_url;
        }

      } else {
        // ── OFFLINE STATE ──
        card.classList.remove('is-live');
        card.classList.add('is-offline');

        // Badge
        badge.className = 'tdc-status-badge tdc-offline-badge';
        badge.textContent = 'OFFLINE';

        // Clear thumbnail
        thumb.style.backgroundImage = '';
        thumb.style.backgroundSize = '';
        thumb.style.backgroundPosition = '';

        // Hide viewer count
        if (viewersEl) viewersEl.style.display = 'none';

        // Hide title
        if (titleEl) {
          titleEl.textContent = '';
          titleEl.style.display = 'none';
        }

        // Button
        if (linkBtn) {
          linkBtn.className = 'btn btn-dark tdc-stream-btn tdc-stream-link';
          linkBtn.textContent = 'YAYIN SAYFASINA GİT';
        }
      }

      // Remove transition class
      card.classList.remove('tdc-stream-updating');
    }, 150);
  }

  /**
   * Format viewer count: 1234 → "1.234", 12345 → "12,3K"
   */
  function formatViewerCount(count) {
    if (count >= 10000) {
      return (count / 1000).toFixed(1).replace('.', ',') + 'K';
    }
    return count.toLocaleString('tr-TR');
  }

  /**
   * Fetches status from the proxy and updates UI
   */
  async function fetchStreamStatus() {
    try {
      const resp = await fetch(API_BASE + '/api/stream-status');
      if (!resp.ok) {
        console.warn('[StreamStatus] API hatası:', resp.status);
        return;
      }

      const data = await resp.json();

      if (data.kick) {
        updateStreamCard('kick', data.kick);
      }
      
      if (data.youtube) {
        updateStreamCard('youtube', data.youtube);
      }

      console.log('[StreamStatus] Güncellendi —',
        'Kick:', data.kick?.is_live ? '🟢 CANLI (' + data.kick.viewer_count + ')' : '⚫ Offline',
        '| YouTube:', data.youtube?.is_live ? '🔴 CANLI (' + data.youtube.viewer_count + ')' : '⚫ Offline'
      );

    } catch (err) {
      console.warn('[StreamStatus] Bağlantı hatası:', err.message);
    }
  }

  /**
   * Start polling loop
   */
  function startStreamPolling() {
    // İlk çağrıyı hemen yap
    fetchStreamStatus();

    // Sonra her 30 saniyede tekrarla
    setInterval(fetchStreamStatus, STREAM_POLL_INTERVAL);

    console.log('[StreamStatus] Polling başladı — her', STREAM_POLL_INTERVAL / 1000, 'saniyede güncelleme');
  }

  // Start polling (only if running from server, not file://)
  if (window.location.protocol !== 'file:') {
    startStreamPolling();
  } else {
    console.info('[StreamStatus] file:// protokolünde API çağrısı yapılamaz. "npm start" ile sunucuyu başlatın.');
  }
});
