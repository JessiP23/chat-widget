/**
 * WM Studio Chatbot Loader
 * Lightweight (~1.5 KB) parent-side embed script.
 *
 * ── Production usage on wmstudio.io (add before </body>) ──────────────────
 *
 *   <script>
 *     window.__CHATBOT_CONFIG = {
 *       widgetUrl:      'https://wm-chatbot.fly.dev/embed.html',
 *       apiUrl:         'https://chat-widget.fly.dev/api/v1',
 *       primaryColor:   '#6366f1',
 *       companyName:    'WM Studio',
 *       welcomeMessage: 'Hi! How can I help you today?',
 *       tenantId:       'your-tenant-id',  // optional
 *     };
 *   </script>
 *   <script src="https://wm-chatbot.fly.dev/loader.js" defer></script>
 *
 * ── Local development (localhost) ─────────────────────────────────────────
 *   1. In your terminal: cd /path/to/chatbot && python3 -m http.server 3000
 *   2. Use widgetUrl: 'http://localhost:3000/embed.html'
 *
 * Programmatic control (after load):
 *   ChatbotLoader.open()   – open the widget
 *   ChatbotLoader.close()  – close/hide the widget
 *   ChatbotLoader.toggle() – toggle open/close
 */
(function () {
  'use strict';

  var CFG = window.__CHATBOT_CONFIG || {};

  // widgetUrl must point to wherever embed.html is hosted.
  // Auto-detect localhost vs production
  var isLocal    = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var WIDGET_URL = CFG.widgetUrl || (isLocal
    ? 'http://localhost:3000/embed.html'
    : 'https://chat-widget.fly.dev/embed.html');

  // ── Build iframe src with config as query params ─────────────────────────
  function buildSrc() {
    var p = new URLSearchParams();
    // Always pass apiUrl — fall back to the deployed backend
    p.set('apiUrl', CFG.apiUrl || 'https://chat-widget.fly.dev/api/v1');
    if (CFG.primaryColor)   p.set('primaryColor',   CFG.primaryColor);
    if (CFG.companyName)    p.set('companyName',     CFG.companyName);
    if (CFG.welcomeMessage) p.set('welcomeMessage',  CFG.welcomeMessage);
    if (CFG.tenantId)       p.set('tenantId',        CFG.tenantId);
    if (CFG.theme)          p.set('theme',           CFG.theme);
    return WIDGET_URL + '?' + p.toString();
  }

  var iframe = null;
  var launcher = null;
  var isVisible = false;

  // ── Launcher button (fixed, bottom-right) ────────────────────────────────
  function createLauncher() {
    if (document.getElementById('__cb-launcher')) return;

    launcher = document.createElement('button');
    launcher.id = '__cb-launcher';
    launcher.setAttribute('aria-label', 'Open support chat');
    launcher.setAttribute('title', 'Open support chat');
    launcher.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
      '</svg>';

    var color = CFG.primaryColor || '#0ea5e9';
    launcher.style.cssText =
      'position:fixed;bottom:22px;right:22px;width:56px;height:56px;' +
      'border-radius:50%;background:' + color + ';color:#fff;border:none;' +
      'cursor:pointer;z-index:999998;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.22);' +
      'display:flex;align-items:center;justify-content:center;' +
      'transition:transform .18s,box-shadow .18s;';

    launcher.addEventListener('mouseenter', function () {
      launcher.style.transform = 'scale(1.07)';
      launcher.style.boxShadow = '0 6px 20px rgba(0,0,0,.28)';
    });
    launcher.addEventListener('mouseleave', function () {
      launcher.style.transform = 'scale(1)';
      launcher.style.boxShadow = '0 4px 14px rgba(0,0,0,.22)';
    });
    launcher.addEventListener('click', toggle);

    document.body.appendChild(launcher);
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
      'position:fixed;bottom:90px;right:22px;' +
      'width:380px;height:600px;' +
      'max-height:calc(100vh - 110px);' +
      'border:none;border-radius:16px;' +
      'z-index:999997;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.18);' +
      'transition:opacity .2s,transform .2s;' +
      'opacity:0;transform:translateY(8px);' +  // start hidden for transition
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
    // Hide launcher bubble while chat is open
    if (launcher) launcher.style.display = 'none';
  }

  function hide() {
    if (iframe) {
      iframe.style.opacity = '0';
      iframe.style.transform = 'translateY(8px)';
      setTimeout(function () {
        if (iframe) iframe.style.display = 'none';
      }, 200);
    }
    isVisible = false;
    // Show launcher bubble again
    if (launcher) launcher.style.display = 'flex';
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
    open:   function () { show(); },
    close:  function () { hide(); },
    toggle: function () { toggle(); },
    isOpen: function () { return isVisible; },
  };

})();
