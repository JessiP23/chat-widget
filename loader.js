(function () {
  'use strict';

  var CFG = window.__CHATBOT_CONFIG || {};

  // widgetUrl must point to wherever embed.html is hosted.
  // Auto-detect localhost vs production
  var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var WIDGET_URL = CFG.widgetUrl || (isLocal
    ? 'http://localhost:3000/embed.html'
    : 'https://chat-widget.fly.dev/embed.html');

  // ── Build iframe src with config as query params ─────────────────────────
  function buildSrc() {
    var p = new URLSearchParams();
    // Always pass apiUrl — fall back to the deployed backend
    p.set('apiUrl', CFG.apiUrl || 'https://chat-widget.fly.dev/api/v1');
    if (CFG.primaryColor) p.set('primaryColor', CFG.primaryColor);
    if (CFG.companyName) p.set('companyName', CFG.companyName);
    if (CFG.welcomeMessage) p.set('welcomeMessage', CFG.welcomeMessage);
    if (CFG.tenantId) p.set('tenantId', CFG.tenantId);
    if (CFG.theme) p.set('theme', CFG.theme);
    return WIDGET_URL + '?' + p.toString();
  }

  var iframe = null;
  var launcher = null;
  var isVisible = false;

  // ── Design tokens (must match widget.js) ─────────────────────────────────
  var C_PANEL  = '#141416';
  var C_EDGE   = '#2A2A2E';
  var C_DIM    = '#5A5A62';
  var C_VOID   = '#0C0C0E';
  var C_WM     = CFG.primaryColor || '#f97316';

  // ── Launcher button (fixed, bottom-right) — matches widget.js WM brand ──
  function createLauncher() {
    if (document.getElementById('__cb-launcher-wrap')) return;

    // Inject Geist Mono font + blink keyframe once
    if (!document.getElementById('__cb-loader-styles')) {
      var lnk = document.createElement('link');
      lnk.rel = 'stylesheet';
      lnk.href = 'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;700&display=swap';
      document.head.appendChild(lnk);

      var sty = document.createElement('style');
      sty.id = '__cb-loader-styles';
      sty.textContent =
        '@keyframes __cb-pulse{0%,100%{opacity:1}50%{opacity:.55}}' +
        '#__cb-launcher-wrap *{box-sizing:border-box;}';
      document.head.appendChild(sty);
    }

    var wrap = document.createElement('div');
    wrap.id = '__cb-launcher-wrap';
    wrap.style.cssText =
      'position:fixed;right:28px;bottom:28px;' +
      'display:flex;flex-direction:column;align-items:center;gap:6px;' +
      'z-index:999998;font-family:"Geist Mono",monospace;';

    launcher = document.createElement('button');
    launcher.id = '__cb-launcher';
    launcher.setAttribute('aria-label', 'Open ' + (CFG.companyName || 'Support') + ' chat');
    launcher.style.cssText =
      'all:initial;width:52px;height:52px;border-radius:8px;cursor:pointer;' +
      'background:' + C_PANEL + ';border:1px solid ' + C_EDGE + ';' +
      'color:' + C_WM + ';font-family:"Geist Mono",monospace;font-size:14px;font-weight:700;' +
      'display:flex;align-items:center;justify-content:center;letter-spacing:0.06em;' +
      'transition:border-color 0.25s ease,background 0.25s ease,color 0.25s ease,letter-spacing 0.25s ease;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.32);';
    launcher.textContent = 'WM';

    var label = document.createElement('div');
    label.id = '__cb-launcher-label';
    label.textContent = 'ASK';
    label.style.cssText =
      'font-family:"Geist Mono",monospace;font-size:8px;font-weight:700;' +
      'letter-spacing:0.22em;color:' + C_DIM + ';text-transform:uppercase;' +
      'transition:opacity 0.25s ease;';

    launcher.addEventListener('mouseenter', function () {
      if (!isVisible) { launcher.style.borderColor = C_WM; }
      launcher.style.letterSpacing = '0.12em';
    });
    launcher.addEventListener('mouseleave', function () {
      if (!isVisible) { launcher.style.borderColor = C_EDGE; }
      launcher.style.letterSpacing = '0.06em';
    });
    launcher.addEventListener('click', toggle);

    wrap.appendChild(launcher);
    wrap.appendChild(label);
    document.body.appendChild(wrap);
  }

  function updateLauncherState(open) {
    if (!launcher) return;
    var label = document.getElementById('__cb-launcher-label');
    if (open) {
      launcher.style.background    = C_WM;
      launcher.style.color         = C_VOID;
      launcher.style.borderColor   = C_WM;
    } else {
      launcher.style.background    = C_PANEL;
      launcher.style.color         = C_WM;
      launcher.style.borderColor   = C_EDGE;
    }
    if (label) label.style.opacity = open ? '0' : '1';
  }

  // ── Iframe (lazy-created on first open) ──────────────────────────────────
  function createIframe() {
    if (iframe) return;

    iframe = document.createElement('iframe');
    iframe.id = '__cb-frame';
    iframe.src = buildSrc();
    iframe.setAttribute('title', 'Support chat');
    // Allow scripts + same-origin so widget.js can run; allow-forms for input;
    // allow-popups so links can open in new tabs.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    iframe.style.cssText =
      'position:fixed;bottom:96px;right:28px;' +
      'width:400px;height:580px;' +
      'max-height:calc(100vh - 120px);' +
      'border:none;border-radius:10px;' +
      'border:1px solid #2A2A2E;' +
      'z-index:999997;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.32);' +
      'transition:opacity .25s cubic-bezier(0.16,1,0.3,1),transform .25s cubic-bezier(0.16,1,0.3,1);' +
      'opacity:0;transform:translateY(8px);' +
      'display:block;';

    document.body.appendChild(iframe);

    // Animate in after paint
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        iframe.style.opacity = '1';
        iframe.style.transform = 'translateY(0)';
      });
    });

    // Listen for messages from inside the iframe
    window.addEventListener('message', onIframeMessage);
  }

  function onIframeMessage(e) {
    if (!iframe || e.source !== iframe.contentWindow) return;
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'chatbot:close') {
      hide();
    }
    if (msg.type === 'chatbot:ready') {
      // Widget finished loading — we can pass late config if needed
      iframe.contentWindow.postMessage({ type: 'chatbot:config', config: CFG }, '*');
    }
  }

  // ── Show / hide helpers ───────────────────────────────────────────────────
  function show() {
    if (!iframe) {
      createIframe();
    } else {
      iframe.style.display = 'block';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          iframe.style.opacity = '1';
          iframe.style.transform = 'translateY(0)';
        });
      });
    }
    isVisible = true;
    updateLauncherState(true);
  }

  function hide() {
    if (iframe) {
      iframe.style.opacity = '0';
      iframe.style.transform = 'translateY(8px)';
      setTimeout(function () {
        if (iframe) iframe.style.display = 'none';
      }, 250);
    }
    isVisible = false;
    updateLauncherState(false);
  }

  function toggle() {
    isVisible ? hide() : show();
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    createLauncher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.ChatbotLoader = {
    open: function () { show(); },
    close: function () { hide(); },
    toggle: function () { toggle(); },
    isOpen: function () { return isVisible; },
  };

})();
