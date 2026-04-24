(function () {
  'use strict';

  var _isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var _backendUrl = 'https://wm-chatbot-api.fly.dev/api/v1';
  var defaultCfg = {
    apiUrl: _isLocal ? _backendUrl : (location.origin + '/api/v1'),
    primaryColor: '#C8FF00',
    position: 'bottom-right',
    welcomeMessage: 'Hi! How can I help you today?',
    companyName: 'Support',
  };

  var cfg = Object.assign({}, defaultCfg, window.__CHATBOT_CONFIG || {});
  var API = cfg.apiUrl;
  var COLOR = cfg.primaryColor;
  var POS = cfg.position;
  var WELCOME = cfg.welcomeMessage;
  var COMPANY = cfg.companyName;
  var TENANT_ID = cfg.tenantId || cfg.tenant_id || null;

  // ── Design tokens ──────────────────────────────────────────────────────────
  var C_VOID = '#0C0C0E';
  var C_PANEL = '#141416';
  var C_SURFACE = '#1C1C1F';
  var C_EDGE = '#2A2A2E';
  var C_TEXT = '#E8E8EC';
  var C_DIM = '#5A5A62';
  var C_WM = '#f97316';

  // Runtime state
  var sessionId = null;
  var ws = null;
  var wsReconnectDelay = 1000;
  var isOpen = false;
  var isConnecting = false;
  var isDisconnecting = false;
  var wsPingInterval = null;
  var inactivityTimer = null;
  var streamingMsgs = {};
  var msgQueue = [];
  var currentMode = 'GENERAL';
  var tokenCount = 0;

  // DOM refs
  var container, msgList, inputField, sendBtn, statusDot, statusText;
  var suggestionsEl, charCounter, tokenDotsEl;

  // ── Public API ─────────────────────────────────────────────────────────────
  window.ChatbotSDK = {
    init: function (c) {
      if (!c) return;
      cfg = Object.assign(cfg, c);
      API = cfg.apiUrl || API;
      COLOR = cfg.primaryColor || COLOR;
      POS = cfg.position || POS;
      WELCOME = cfg.welcomeMessage || WELCOME;
      COMPANY = cfg.companyName || COMPANY;
      TENANT_ID = cfg.tenantId || cfg.tenant_id || TENANT_ID;
    },
    open: function () { openChat(); },
    close: function () { closeChat(); },
    toggle: function () { isOpen ? closeChat() : openChat(); },
    isOpen: function () { return isOpen; },
    getSession: function () { return sessionId; },
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  function boot() {
    var inIframe = window.parent !== window;
    if (inIframe) {
      // Inside embed.html — build UI filling the entire iframe
      buildUI(true);
      startSession(function () {
        if (msgList && msgList.children.length === 0) addMsg('bot', WELCOME);
      });
    } else {
      // Standalone — floating launcher + panel
      buildLauncher();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // ── Session / WebSocket ────────────────────────────────────────────────────
  function startSession(cb) {
    if (!sessionId) {
      sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    }
    openWebSocket(cb);
  }

  function openWebSocket(cb) {
    if (ws && ws.readyState === WebSocket.OPEN) { if (cb) cb(true); return; }
    if (ws) { try { ws.close(); } catch (e) { } ws = null; }
    if (isConnecting) { if (cb) cb(false); return; }

    isConnecting = true;
    setStatus('connecting');

    var base = API.replace(/^http/, 'ws');
    var params = 'session_id=' + encodeURIComponent(sessionId);
    if (TENANT_ID) params += '&tenant_id=' + encodeURIComponent(TENANT_ID);
    var url = base + '/ws/chat?' + params;

    var giveUp = setTimeout(function () {
      isConnecting = false;
      setStatus('offline');
      if (cb) cb(false);
      cb = null;
    }, 20000);

    try {
      ws = new WebSocket(url);

      ws.onopen = function () {
        clearTimeout(giveUp);
        isConnecting = false;
        wsReconnectDelay = 1000;
        setStatus('online');
        if (wsPingInterval) clearInterval(wsPingInterval);
        wsPingInterval = setInterval(function () {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, 20000);
        if (cb) { cb(true); cb = null; }
      };

      ws.onmessage = function (e) {
        try { handleWsMsg(JSON.parse(e.data)); }
        catch (err) { console.error('[Chatbot] WS parse error', err); }
      };

      ws.onerror = function (err) {
        clearTimeout(giveUp);
        console.error('[Chatbot] WS error:', err);
        isConnecting = false;
        setStatus('offline');
        if (cb) { cb(false); cb = null; }
      };

      ws.onclose = function () {
        isConnecting = false;
        ws = null;
        if (wsPingInterval) { clearInterval(wsPingInterval); wsPingInterval = null; }
        if (!isDisconnecting && isOpen && sessionId) {
          setStatus('connecting');
          wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
          setTimeout(function () { openWebSocket(null); }, wsReconnectDelay);
        } else {
          setStatus('offline');
        }
      };
    } catch (err) {
      clearTimeout(giveUp);
      isConnecting = false;
      setStatus('offline');
      console.error('[Chatbot] WS connect failed:', err);
      if (cb) { cb(false); cb = null; }
    }
  }

  function handleWsMsg(data) {
    switch (data.type) {
      case 'connected':
        clearStatusMsgs(); break;
      case 'chunk':
        handleChunk(data); break;
      case 'chunk_done':
        finalizeChunk(data.message_id); break;
      case 'chat_message':
      case 'bot_response':
        removeTyping(); addMsg('bot', data.text || data.message); break;
      case 'staff_message':
        removeTyping(); addMsg('staff', data.text || data.message, data.staff_name || 'Agent'); break;
      case 'staff_joined':
        removeTyping(); handleStaffJoined(data); break;
      case 'staff_left':
        removeTyping(); addSysMsg('\u2139\ufe0f ' + (data.message || 'Agent has left the chat.')); break;
      case 'closure_prompt':
        removeTyping(); showClosurePrompt(data); break;
      case 'error':
        removeTyping(); addMsg('bot', data.message || 'Something went wrong. Please try again.'); break;
    }
  }

  // ── Launcher (standalone) ──────────────────────────────────────────────────
  function buildLauncher() {
    if (document.getElementById('cb-launcher')) return;
    injectStyles();

    var wrap = document.createElement('div');
    wrap.id = 'cb-launcher-wrap';
    var side = POS.includes('right') ? 'right:28px' : 'left:28px';
    wrap.style.cssText =
      'all:initial;position:fixed;' + side + ';bottom:28px;' +
      'display:flex;flex-direction:column;align-items:center;gap:6px;' +
      'z-index:2147483646;font-family:"Geist Mono",monospace;';

    var btn = document.createElement('button');
    btn.id = 'cb-launcher';
    btn.setAttribute('aria-label', 'Open WM Studio chat');
    btn.style.cssText =
      'all:initial;width:52px;height:52px;border-radius:8px;cursor:pointer;' +
      'background:' + C_PANEL + ';border:1px solid ' + C_EDGE + ';' +
      'color:' + C_WM + ';font-family:"Geist Mono",monospace;font-size:14px;font-weight:700;' +
      'display:flex;align-items:center;justify-content:center;letter-spacing:0.06em;' +
      'transition:border-color 0.25s ease,background 0.25s ease,color 0.25s ease,letter-spacing 0.25s ease;';
    btn.textContent = 'WM';

    btn.addEventListener('mouseenter', function () {
      if (!isOpen) { btn.style.borderColor = C_WM; }
      btn.style.letterSpacing = '0.12em';
    });
    btn.addEventListener('mouseleave', function () {
      if (!isOpen) { btn.style.borderColor = C_EDGE; }
      btn.style.letterSpacing = '0.06em';
    });
    btn.addEventListener('click', toggleChat);

    var label = document.createElement('div');
    label.id = 'cb-launcher-label';
    label.textContent = 'ASK';
    label.style.cssText =
      'font-family:"Geist Mono",monospace;font-size:8px;font-weight:700;' +
      'letter-spacing:0.22em;color:' + C_DIM + ';text-transform:uppercase;' +
      'transition:opacity 0.25s ease;';

    wrap.appendChild(btn);
    wrap.appendChild(label);
    document.body.appendChild(wrap);
  }

  function toggleChat() { isOpen ? closeChat() : openChat(); }

  // ── Open / close ───────────────────────────────────────────────────────────
  function openChat() {
    if (!container) buildUI(false);
    container.style.display = 'flex';
    requestAnimationFrame(function () {
      container.style.opacity = '0';
      container.style.transform = 'translateY(8px)';
      requestAnimationFrame(function () {
        container.style.transition = 'opacity 0.3s cubic-bezier(0.16,1,0.3,1),transform 0.3s cubic-bezier(0.16,1,0.3,1)';
        container.style.opacity = '1';
        container.style.transform = 'translateY(0)';
      });
    });
    isOpen = true;
    updateLauncherIcon(true);

    if (!sessionId) {
      showStatusMsg('Connecting\u2026');
      startSession(function (ok) {
        clearStatusMsgs();
        if (!ok) showStatusMsg('\u26a0\ufe0f Could not connect. Please refresh.');
        else if (msgList && msgList.querySelectorAll('.cb-msg-row').length === 0) addMsg('bot', WELCOME);
      });
    } else {
      if (msgList && msgList.querySelectorAll('.cb-msg-row').length === 0) addMsg('bot', WELCOME);
    }

    setTimeout(function () { if (inputField) inputField.focus(); }, 120);
  }

  function closeChat() {
    if (!container) return;
    generateInsight(); // summarise + clear before closing
    container.style.transition = 'opacity 0.3s cubic-bezier(0.16,1,0.3,1),transform 0.3s cubic-bezier(0.16,1,0.3,1)';
    container.style.opacity = '0';
    container.style.transform = 'translateY(8px)';
    setTimeout(function () { if (container) container.style.display = 'none'; }, 300);
    isOpen = false;
    updateLauncherIcon(false);
    if (window.parent !== window) window.parent.postMessage({ type: 'chatbot:close' }, '*');
  }

  function updateLauncherIcon(open) {
    var btn = document.getElementById('cb-launcher');
    var label = document.getElementById('cb-launcher-label');
    if (!btn) return;
    if (open) {
      btn.style.background = C_WM;
      btn.style.color = C_VOID;
      btn.style.borderColor = C_WM;
    } else {
      btn.style.background = C_PANEL;
      btn.style.color = C_WM;
      btn.style.borderColor = C_EDGE;
    }
    if (label) label.style.opacity = open ? '0' : '1';
  }

  // ── Build UI ───────────────────────────────────────────────────────────────
  function buildUI(iframeMode) {
    injectStyles();

    container = document.createElement('div');
    container.id = 'cb-root';

    if (iframeMode) {
      container.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;' +
        'display:flex;flex-direction:column;' +
        'background:' + C_PANEL + ';overflow:hidden;' +
        'font-family:"Geist Mono",monospace;color:' + C_TEXT + ';';
    } else {
      var side = POS.includes('right') ? 'right:28px' : 'left:28px';
      container.style.cssText =
        'position:fixed;' + side + ';bottom:96px;' +
        'width:400px;height:580px;max-height:calc(100vh - 120px);' +
        'display:none;flex-direction:column;' +
        'background:' + C_PANEL + ';border-radius:10px;' +
        'border:1px solid ' + C_EDGE + ';' +
        'z-index:2147483645;overflow:hidden;' +
        'font-family:"Geist Mono",monospace;color:' + C_TEXT + ';';
    }

    // ── Header ───────────────────────────────────────────────────────────────
    var header = document.createElement('div');
    header.style.cssText =
      'padding:13px 16px;flex-shrink:0;' +
      'background:' + C_PANEL + ';border-bottom:1px solid ' + C_EDGE + ';' +
      'display:flex;align-items:center;justify-content:space-between;';
    if (!iframeMode) {
      header.style.cursor = 'move';
      makeDraggable(header, container);
    }

    var headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;';

    var brandWm = document.createElement('span');
    brandWm.textContent = (COMPANY || 'Support').toUpperCase();
    brandWm.style.cssText =
      'font-size:9px;font-weight:700;letter-spacing:0.2em;color:' + C_WM + ';' +
      'text-transform:uppercase;font-family:"Geist Mono",monospace;';

    var brandSlash = document.createElement('span');
    brandSlash.textContent = ' / LIVE CHAT';
    brandSlash.style.cssText =
      'font-size:9px;font-weight:700;letter-spacing:0.2em;color:' + C_DIM + ';' +
      'text-transform:uppercase;font-family:"Geist Mono",monospace;';

    headerLeft.appendChild(brandWm);
    headerLeft.appendChild(brandSlash);

    var headerRight = document.createElement('div');
    headerRight.style.cssText = 'display:flex;align-items:center;gap:12px;';

    tokenDotsEl = document.createElement('div');
    tokenDotsEl.style.cssText = 'display:flex;align-items:center;gap:3px;';
    updateTokenDots();

    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.style.cssText =
      'all:initial;cursor:pointer;color:' + C_DIM + ';' +
      'font-family:"Geist Mono",monospace;font-size:18px;line-height:1;' +
      'display:flex;align-items:center;justify-content:center;' +
      'transition:color 0.2s ease;';
    closeBtn.textContent = '\xD7';
    closeBtn.addEventListener('mouseenter', function () { closeBtn.style.color = C_TEXT; });
    closeBtn.addEventListener('mouseleave', function () { closeBtn.style.color = C_DIM; });
    closeBtn.addEventListener('click', iframeMode
      ? function () { window.parent.postMessage({ type: 'chatbot:close' }, '*'); }
      : closeChat);

    headerRight.appendChild(tokenDotsEl);
    headerRight.appendChild(closeBtn);
    header.appendChild(headerLeft);
    header.appendChild(headerRight);

    // ── Mode Bar ──────────────────────────────────────────────────────────────
    var modeBarEl = document.createElement('div');
    modeBarEl.style.cssText =
      'display:flex;flex-shrink:0;border-bottom:1px solid ' + C_EDGE + ';' +
      'background:' + C_PANEL + ';';

    // ── Message area ──────────────────────────────────────────────────────────
    msgList = document.createElement('div');
    msgList.id = 'cb-msgs';
    msgList.style.cssText =
      'flex:1;overflow-y:auto;' +
      'display:flex;flex-direction:column;scroll-behavior:smooth;' +
      'background:' + C_PANEL + ';';

    // Suggestions grid (shown until first message)
    suggestionsEl = document.createElement('div');
    suggestionsEl.id = 'cb-suggestions';
    suggestionsEl.style.cssText =
      'display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:16px;';

    var suggestions = cfg.suggestions || [
      { label: 'ACCOUNT', text: 'I need help with my account' },
      { label: 'BILLING', text: 'I have a question about billing' },
      { label: 'BUG', text: 'Something is not working properly' },
      { label: 'OTHER', text: 'I have a general question' },
    ];
    suggestions.forEach(function (sg) {
      var tile = document.createElement('div');
      tile.style.cssText =
        'background:' + C_SURFACE + ';border:1px solid ' + C_EDGE + ';border-radius:6px;' +
        'padding:10px 12px;cursor:pointer;transition:border-color 0.2s ease;';
      var tlabel = document.createElement('div');
      tlabel.textContent = sg.label;
      tlabel.style.cssText =
        'font-size:8px;font-weight:700;letter-spacing:0.22em;color:' + C_DIM + ';' +
        'text-transform:uppercase;margin-bottom:5px;font-family:"Geist Mono",monospace;' +
        'transition:color 0.2s ease;';
      var ttext = document.createElement('div');
      ttext.textContent = sg.text;
      ttext.style.cssText =
        'font-size:11px;color:' + C_TEXT + ';line-height:1.5;font-family:"Geist Mono",monospace;';
      tile.appendChild(tlabel);
      tile.appendChild(ttext);
      tile.addEventListener('mouseenter', function () {
        tile.style.borderColor = C_WM;
        tlabel.style.color = C_WM;
      });
      tile.addEventListener('mouseleave', function () {
        tile.style.borderColor = C_EDGE;
        tlabel.style.color = C_DIM;
      });
      tile.addEventListener('click', function () {
        if (inputField) {
          inputField.value = sg.text;
          inputField.style.height = 'auto';
          inputField.style.height = Math.min(inputField.scrollHeight, 120) + 'px';
          inputField.focus();
          updateCharCounter();
          updateSendState();
        }
      });
      suggestionsEl.appendChild(tile);
    });
    msgList.appendChild(suggestionsEl);

    // ── Input area ────────────────────────────────────────────────────────────
    var inputArea = document.createElement('div');
    inputArea.style.cssText =
      'padding:10px 12px 12px;background:' + C_PANEL + ';' +
      'border-top:1px solid ' + C_EDGE + ';flex-shrink:0;';

    var charRow = document.createElement('div');
    charRow.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:5px;';
    charCounter = document.createElement('span');
    charCounter.textContent = '000/500';
    charCounter.style.cssText =
      'font-family:"Geist Mono",monospace;font-size:9px;color:' + C_DIM + ';' +
      'font-variant-numeric:tabular-nums;letter-spacing:0.05em;';
    charRow.appendChild(charCounter);

    inputField = document.createElement('textarea');
    inputField.placeholder = cfg.inputPlaceholder || 'Type your message\u2026';
    inputField.autocomplete = 'off';
    inputField.rows = 1;
    inputField.style.cssText =
      'display:block;width:100%;box-sizing:border-box;resize:none;overflow:hidden;' +
      'background:' + C_SURFACE + ';border:1px solid ' + C_EDGE + ';border-radius:6px;' +
      'padding:10px 12px;color:' + C_TEXT + ';' +
      'font-family:"Geist Mono",monospace;font-size:13px;line-height:1.5;' +
      'outline:none;max-height:120px;scrollbar-width:none;' +
      'transition:border-color 0.2s ease;';

    inputField.addEventListener('focus', function () { inputField.style.borderColor = C_WM; });
    inputField.addEventListener('blur', function () { inputField.style.borderColor = C_EDGE; });
    inputField.addEventListener('input', function () {
      inputField.style.height = 'auto';
      inputField.style.height = Math.min(inputField.scrollHeight, 120) + 'px';
      updateCharCounter();
      updateSendState();
    });
    inputField.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });

    var toolbar = document.createElement('div');
    toolbar.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;margin-top:8px;';

    var hint = document.createElement('span');
    hint.textContent = 'SHIFT+\u21B5 NEW LINE';
    hint.style.cssText =
      'font-family:"Geist Mono",monospace;font-size:9px;color:' + C_DIM + ';letter-spacing:0.06em;';

    sendBtn = document.createElement('button');
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.textContent = 'SEND \u21B5';
    sendBtn.style.cssText =
      'all:initial;padding:5px 12px;cursor:pointer;' +
      'background:' + C_EDGE + ';color:' + C_DIM + ';' +
      'font-family:"Geist Mono",monospace;font-size:9px;font-weight:700;' +
      'letter-spacing:0.1em;text-transform:uppercase;border:none;' +
      'transition:opacity 0.2s ease,background 0.2s ease,color 0.2s ease;';
    sendBtn.addEventListener('mouseenter', function () {
      if (sendBtn.style.background !== C_EDGE) sendBtn.style.opacity = '0.85';
    });
    sendBtn.addEventListener('mouseleave', function () { sendBtn.style.opacity = '1'; });
    sendBtn.addEventListener('click', doSend);

    toolbar.appendChild(hint);
    toolbar.appendChild(sendBtn);

    inputArea.appendChild(charRow);
    inputArea.appendChild(inputField);
    inputArea.appendChild(toolbar);

    container.appendChild(header);
    container.appendChild(modeBarEl);
    container.appendChild(msgList);
    container.appendChild(inputArea);
    document.body.appendChild(container);
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  function updateTokenDots() {
    if (!tokenDotsEl) return;
    tokenDotsEl.innerHTML = '';
    for (var i = 0; i < 5; i++) {
      var dot = document.createElement('span');
      dot.style.cssText =
        'display:inline-block;width:5px;height:5px;border-radius:50%;' +
        'background:' + (i < tokenCount ? C_WM : C_EDGE) + ';';
      tokenDotsEl.appendChild(dot);
    }
  }

  function updateCharCounter() {
    if (!charCounter || !inputField) return;
    var len = (inputField.value || '').length;
    charCounter.textContent = String(len).padStart(3, '0') + '/500';
  }

  function updateSendState() {
    if (!sendBtn || !inputField) return;
    var empty = !(inputField.value || '').trim();
    sendBtn.style.background = empty ? C_EDGE : C_WM;
    sendBtn.style.color = empty ? C_DIM : C_VOID;
    sendBtn.style.cursor = empty ? 'default' : 'pointer';
  }

  // ── Draggable (standalone) ─────────────────────────────────────────────────
  function makeDraggable(handle, el) {
    var ox = 0, oy = 0, drag = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('button')) return;
      drag = true;
      var r = el.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      el.style.left = Math.max(0, Math.min(e.clientX - ox, window.innerWidth - el.offsetWidth)) + 'px';
      el.style.top = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - el.offsetHeight)) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', function () { drag = false; });
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  function setStatus(state) {
    // Status is reflected silently via connection logic; no visible indicator in this UI.
    void state;
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  function addMsg(who, text, staffName) {
    if (!msgList) return;

    // Dismiss suggestions on first message
    if (suggestionsEl && suggestionsEl.parentNode) {
      suggestionsEl.parentNode.removeChild(suggestionsEl);
      suggestionsEl = null;
    }

    msgQueue.push({ who: who, text: text, time: Date.now() });
    if (msgQueue.length > 100) msgQueue.shift();

    // Advance token counter
    tokenCount = Math.min(tokenCount + 1, 5);
    updateTokenDots();

    var isUser = who === 'user';
    var isStaff = who === 'staff';
    var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Separator between message pairs
    var rows = msgList.querySelectorAll('.cb-msg-row');
    if (rows.length > 0) {
      var sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:' + C_EDGE + ';flex-shrink:0;';
      msgList.appendChild(sep);
    }

    var row = document.createElement('div');
    row.className = 'cb-msg-row';
    row.style.cssText =
      'padding:12px 16px;position:relative;cursor:default;' +
      'border-left:2px solid ' + (isUser ? C_EDGE : C_WM) + ';' +
      'background:transparent;transition:background 0.2s ease;';

    var copyEl = document.createElement('span');
    copyEl.textContent = 'COPY';
    copyEl.style.cssText =
      'font-family:"Geist Mono",monospace;font-size:9px;color:' + C_DIM + ';' +
      'cursor:pointer;opacity:0;transition:opacity 0.15s ease;letter-spacing:0.1em;';
    copyEl.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        navigator.clipboard.writeText(text);
        copyEl.textContent = 'COPIED';
        setTimeout(function () { copyEl.textContent = 'COPY'; }, 1200);
      } catch (ex) { }
    });

    row.addEventListener('mouseenter', function () { row.style.background = C_SURFACE; copyEl.style.opacity = '1'; });
    row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; copyEl.style.opacity = '0'; });

    if (isStaff && staffName) {
      var nm = document.createElement('div');
      nm.textContent = staffName.toUpperCase();
      nm.style.cssText =
        'font-size:8px;font-weight:700;letter-spacing:0.22em;color:' + C_DIM + ';' +
        'margin-bottom:5px;font-family:"Geist Mono",monospace;';
      row.appendChild(nm);
    }

    var bubble = document.createElement('div');
    if (isUser) {
      bubble.style.cssText =
        'font-family:"Geist Mono",monospace;font-size:13px;font-weight:500;' +
        'color:' + C_TEXT + ';line-height:1.5;word-break:break-word;text-align:right;';
      bubble.textContent = text;
    } else {
      bubble.style.cssText =
        'font-family:"Geist Mono",monospace;font-size:13.5px;font-weight:400;' +
        'color:' + C_TEXT + ';line-height:1.75;word-break:break-word;';
      bubble.innerHTML = parseMarkdown(text);
      applyMdStyles(bubble);
    }

    var meta = document.createElement('div');
    meta.style.cssText =
      'display:flex;align-items:center;justify-content:' + (isUser ? 'flex-end' : 'space-between') + ';' +
      'margin-top:5px;gap:12px;';

    var ts = document.createElement('span');
    ts.textContent = time;
    ts.style.cssText = 'font-family:"Geist Mono",monospace;font-size:10px;color:' + C_DIM + ';';

    if (isUser) {
      meta.appendChild(ts);
    } else {
      meta.appendChild(copyEl);
      meta.appendChild(ts);
    }

    row.appendChild(bubble);
    row.appendChild(meta);
    msgList.appendChild(row);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function addSysMsg(text) {
    if (!msgList) return;
    var row = document.createElement('div');
    row.style.cssText =
      'padding:8px 16px;text-align:center;' +
      'font-family:"Geist Mono",monospace;font-size:9px;font-weight:700;' +
      'letter-spacing:0.16em;color:' + C_DIM + ';text-transform:uppercase;';
    row.textContent = text;
    msgList.appendChild(row);
    msgList.scrollTop = msgList.scrollHeight;
  }

  // ── Typing indicator ───────────────────────────────────────────────────────
  function showTyping() {
    if (!msgList || document.getElementById('cb-typing')) return;
    var row = document.createElement('div');
    row.id = 'cb-typing';
    row.style.cssText =
      'padding:12px 16px;border-left:2px solid ' + C_WM + ';' +
      'display:flex;align-items:center;gap:8px;background:transparent;flex-shrink:0;';

    var label = document.createElement('span');
    label.textContent = 'GENERATING';
    label.style.cssText =
      'font-family:"Geist Mono",monospace;font-size:9px;font-weight:700;' +
      'letter-spacing:0.2em;color:' + C_WM + ';text-transform:uppercase;';

    var cursor = document.createElement('span');
    cursor.textContent = '\u2587';
    cursor.style.cssText =
      'font-family:"Geist Mono",monospace;font-size:13px;color:' + C_WM + ';' +
      'animation:cb-blink 0.8s step-end infinite;';

    row.appendChild(label);
    row.appendChild(cursor);
    msgList.appendChild(row);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function removeTyping() {
    var el = document.getElementById('cb-typing');
    if (el) el.parentNode.removeChild(el);
  }

  // ── Status messages ────────────────────────────────────────────────────────
  function showStatusMsg(text) {
    if (!msgList) return;
    var d = document.createElement('div');
    d.className = 'cb-status';
    d.textContent = text;
    d.style.cssText =
      'text-align:center;color:' + C_DIM + ';padding:14px;' +
      'font-family:"Geist Mono",monospace;font-size:11px;font-style:italic;';
    msgList.appendChild(d);
  }

  function clearStatusMsgs() {
    if (!msgList) return;
    var els = msgList.querySelectorAll('.cb-status');
    for (var i = 0; i < els.length; i++) els[i].parentNode.removeChild(els[i]);
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  function doSend() {
    var text = inputField && inputField.value && inputField.value.trim();
    if (!text) return;
    inputField.value = '';
    inputField.style.height = 'auto';
    updateCharCounter();
    updateSendState();
    inputField.focus();
    resetInactivity();
    addMsg('user', text);
    showTyping();
    setSendDisabled(true);

    if (!sessionId) {
      startSession(function (ok) {
        if (ok) { trySend(text); }
        else {
          removeTyping();
          addMsg('bot', '\u26a0\ufe0f Could not connect. Please check your internet connection and try again.');
          setSendDisabled(false);
        }
      });
    } else {
      trySend(text);
    }
  }

  function trySend(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send full history so backend stays stateless — browser owns the conversation
      var history = msgQueue.map(function (m) {
        return { role: m.who === 'user' ? 'user' : 'assistant', content: m.text };
      });
      ws.send(JSON.stringify({ type: 'chat_message', text: text, session_id: sessionId, tenant_id: TENANT_ID, history: history }));
      setSendDisabled(false);
    } else {
      // WS not ready — try REST fallback
      sendREST(text);
    }
  }

  function setSendDisabled(v) {
    if (!sendBtn) return;
    sendBtn.style.opacity = v ? '.45' : '1';
    sendBtn.style.cursor = v ? 'not-allowed' : 'pointer';
  }

  function sendREST(text) {
    var history = msgQueue.map(function (m) {
      return { role: m.who === 'user' ? 'user' : 'assistant', content: m.text };
    });
    fetch(API + '/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: TENANT_ID, session_id: sessionId, user_message: text, history: history }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var msg = data.bot_response || data.text || data.message || "I didn\u2019t quite catch that. Could you rephrase?";
        removeTyping();
        addMsg('bot', msg);
      })
      .catch(function (err) {
        console.error('[Chatbot] REST error:', err);
        removeTyping();
        addMsg('bot', '\u26a0\ufe0f Unable to reach the server. Please try again.');
      })
      .finally(function () {
        setSendDisabled(false);
      });
  }

  // ── Streaming chunks ───────────────────────────────────────────────────────
  function handleChunk(data) {
    var mid = data.message_id;
    if (!streamingMsgs[mid]) {
      removeTyping();
      // Dismiss suggestions
      if (suggestionsEl && suggestionsEl.parentNode) {
        suggestionsEl.parentNode.removeChild(suggestionsEl);
        suggestionsEl = null;
      }
      // Separator
      var rows = msgList.querySelectorAll('.cb-msg-row');
      if (rows.length > 0) {
        var sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:' + C_EDGE + ';flex-shrink:0;';
        msgList.appendChild(sep);
      }
      var row = document.createElement('div');
      row.id = 'cb-stream-' + mid;
      row.className = 'cb-msg-row';
      row.style.cssText =
        'padding:12px 16px;border-left:2px solid ' + C_WM + ';' +
        'background:transparent;transition:background 0.2s ease;';

      var bubble = document.createElement('div');
      bubble.style.cssText =
        'font-family:"Geist Mono",monospace;font-size:13.5px;font-weight:400;' +
        'color:' + C_TEXT + ';line-height:1.75;word-break:break-word;';

      row.appendChild(bubble);
      msgList.appendChild(row);
      streamingMsgs[mid] = { bubble: bubble, text: '' };
    }
    var s = streamingMsgs[mid];
    s.text += data.text;
    s.bubble.innerHTML = parseMarkdown(s.text);
    applyMdStyles(s.bubble);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function finalizeChunk(mid) {
    var s = streamingMsgs[mid];
    if (s) { msgQueue.push({ who: 'bot', text: s.text, time: Date.now() }); delete streamingMsgs[mid]; }
    setSendDisabled(false);
    tokenCount = Math.min(tokenCount + 1, 5);
    updateTokenDots();
  }

  // ── Staff ──────────────────────────────────────────────────────────────────
  function handleStaffJoined(data) {
    var name = data.staff_name || 'Agent';
    addSysMsg(name + ' IS CONNECTING\u2026');
    setTimeout(function () {
      var msgs = msgList.querySelectorAll('div');
      for (var i = 0; i < msgs.length; i++) {
        if (msgs[i].textContent.indexOf('IS CONNECTING') !== -1) {
          var par = msgs[i].parentNode;
          if (par) par.parentNode && par.parentNode.removeChild(par);
        }
      }
      addSysMsg(data.message || (name + ' HAS JOINED'));
      setTimeout(showTyping, 500);
    }, 900);
  }

  // ── Closure prompt ─────────────────────────────────────────────────────────
  function showClosurePrompt(data) {
    var row = document.createElement('div');
    row.style.cssText =
      'padding:12px 16px;border-left:2px solid ' + C_EDGE + ';background:transparent;';

    var msg = document.createElement('div');
    msg.textContent = data.message;
    msg.style.cssText =
      'font-family:"Geist Mono",monospace;font-size:13px;color:' + C_TEXT + ';margin-bottom:10px;';
    row.appendChild(msg);

    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    var options = data.options || [];
    options.forEach(function (opt) {
      var b = document.createElement('button');
      b.textContent = opt.text.toUpperCase();
      b.style.cssText =
        'all:initial;padding:5px 14px;font-family:"Geist Mono",monospace;' +
        'border:1px solid ' + C_EDGE + ';color:' + C_TEXT + ';' +
        'font-size:9px;font-weight:700;letter-spacing:0.1em;cursor:pointer;' +
        'transition:border-color 0.2s ease,color 0.2s ease;';
      b.addEventListener('mouseenter', function () { b.style.borderColor = C_WM; b.style.color = C_WM; });
      b.addEventListener('mouseleave', function () { b.style.borderColor = C_EDGE; b.style.color = C_TEXT; });
      b.addEventListener('click', function () { handleClosureChoice(opt.id, btns); });
      btns.appendChild(b);
    });
    row.appendChild(btns);
    msgList.appendChild(row);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function handleClosureChoice(choice, btnsEl) {
    var bbs = btnsEl.querySelectorAll('button');
    for (var i = 0; i < bbs.length; i++) {
      bbs[i].disabled = true; bbs[i].style.opacity = '.45'; bbs[i].style.cursor = 'not-allowed';
    }
    if (choice === 'continue') {
      addMsg('bot', 'Great! How else can I help you? \uD83D\uDE0A');
      resetInactivity();
    } else {
      addMsg('bot', 'Thanks for chatting! Come back any time. \uD83D\uDC4B');
      if (ws && ws.readyState === WebSocket.OPEN) {
        isDisconnecting = true;
        ws.send(JSON.stringify({ type: 'disconnect', session_id: sessionId, tenant_id: TENANT_ID, reason: 'user_ended_chat' }));
      }
      setTimeout(closeChat, 2200);
    }
  }

  // ── Inactivity ─────────────────────────────────────────────────────────────
  function resetInactivity() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(function () {
      showClosurePrompt({
        message: 'Are you still there?',
        options: [{ id: 'continue', text: 'Continue' }, { id: 'end', text: 'End chat' }]
      });
    }, 450000);
  }

  // ── Markdown ───────────────────────────────────────────────────────────────
  function parseMarkdown(text) {
    if (!text) return '';
    var codes = [], inlines = [];
    var html = text;

    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, function (_, lang, code) {
      var idx = codes.length;
      codes.push('<pre><code class="lang-' + (lang || 'text') + '">' + esc(code.trim()) + '</code></pre>');
      return '___C' + idx + '___';
    });
    html = html.replace(/`([^`]+)`/g, function (_, code) {
      var idx = inlines.length;
      inlines.push('<code>' + esc(code) + '</code>');
      return '___I' + idx + '___';
    });

    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/(?:^[*\-] .+$\n?)+/gm, function (m) {
      return '<ul>' + m.trim().split('\n').map(function (l) { return '<li>' + l.replace(/^[*\-] /, '') + '</li>'; }).join('') + '</ul>';
    });
    html = html.replace(/(?:^\d+\. .+$\n?)+/gm, function (m) {
      return '<ol>' + m.trim().split('\n').map(function (l) { return '<li>' + l.replace(/^\d+\. /, '') + '</li>'; }).join('') + '</ol>';
    });
    html = html.split(/\n\n+/).map(function (p) {
      p = p.trim();
      if (!p || /^<(h[123]|ul|ol|pre)/.test(p) || /^___/.test(p)) return p;
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');

    codes.forEach(function (b, i) { html = html.replace('___C' + i + '___', b); });
    inlines.forEach(function (c, i) { html = html.replace('___I' + i + '___', c); });
    return html;
  }

  function applyMdStyles(el) {
    var pres = el.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) pres[i].style.cssText = 'background:' + C_VOID + ';color:' + C_TEXT + ';padding:12px;border-radius:6px;overflow-x:auto;margin:8px 0;font-size:12px;line-height:1.5;border:1px solid ' + C_EDGE + ';';
    var codes = el.querySelectorAll('code:not(pre code)');
    for (var i = 0; i < codes.length; i++) codes[i].style.cssText = 'background:' + C_SURFACE + ';color:' + C_WM + ';padding:2px 5px;border-radius:3px;font-size:12px;font-family:"Geist Mono",monospace;';
    var lists = el.querySelectorAll('ul,ol');
    for (var i = 0; i < lists.length; i++) lists[i].style.cssText = 'margin:6px 0;padding-left:18px;';
    var links = el.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) links[i].style.cssText = 'color:' + C_TEXT + ';text-decoration:underline;';
    var hdrs = el.querySelectorAll('h1,h2,h3');
    for (var i = 0; i < hdrs.length; i++) hdrs[i].style.cssText = 'margin:6px 0;font-weight:700;font-family:"Geist Mono",monospace;';
    var ps = el.querySelectorAll('p');
    for (var i = 0; i < ps.length; i++) ps[i].style.cssText = 'margin:4px 0;';
  }

  function esc(t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

  // ── Global styles ──────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('cb-global-styles')) return;

    // Load Geist Mono from Google Fonts
    var link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = 'https://fonts.googleapis.com';
    document.head.appendChild(link);
    var link2 = document.createElement('link');
    link2.rel = 'stylesheet';
    link2.href = 'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;700&display=swap';
    document.head.appendChild(link2);

    var s = document.createElement('style');
    s.id = 'cb-global-styles';
    s.textContent =
      '@keyframes cb-blink{0%,100%{opacity:1}50%{opacity:0}}' +
      '@keyframes cb-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}' +
      '#cb-msgs::-webkit-scrollbar{width:3px}' +
      '#cb-msgs::-webkit-scrollbar-track{background:transparent}' +
      '#cb-msgs::-webkit-scrollbar-thumb{background:' + C_EDGE + ';border-radius:0}' +
      '#cb-msgs::-webkit-scrollbar-thumb:hover{background:' + C_DIM + '}' +
      '#cb-suggestions div:focus{outline:none}' +
      'textarea::-webkit-scrollbar{display:none}' +
      '@media(max-width:480px){' +
      '#cb-root{position:fixed!important;top:0!important;left:0!important;' +
      'right:0!important;bottom:0!important;width:100%!important;' +
      'height:100%!important;border-radius:0!important;border:none!important;}' +
      '}';
    document.head.appendChild(s);
  }

  // ── Color helpers (kept for parseMarkdown/applyMdStyles compatibility) ─────
  function darken(hex, amount) {
    try {
      var r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
      var g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
      var b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
      return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
    } catch (e) { return hex; }
  }

  function rgba(hex, a) {
    try {
      var r = parseInt(hex.slice(1, 3), 16);
      var g = parseInt(hex.slice(3, 5), 16);
      var b = parseInt(hex.slice(5, 7), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    } catch (e) { return hex; }
  }

  // ── Icons (removed — text characters used instead) ────────────────────────

  // ── Session insight ────────────────────────────────────────────────────────
  // Called when the session ends. Sends messages to backend → Groq summarises
  // → stored in Supabase. Browser messages are then cleared.
  function generateInsight() {
    if (!sessionId || msgQueue.length < 2) return;
    var messages = msgQueue.map(function (m) {
      return { role: m.who === 'user' ? 'user' : 'assistant', content: m.text };
    });
    var payload = JSON.stringify({ session_id: sessionId, tenant_id: TENANT_ID, messages: messages });
    var url = API + '/sessions/insight';
    // keepalive:true works on page-unload AND normal closes; handles CORS correctly
    // sendBeacon with application/json cannot do CORS preflight so we avoid it
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(function () { });
    msgQueue = []; // clear browser messages — session is over
    sessionId = null;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  window.addEventListener('beforeunload', function () {
    // Disconnect WS first (needs sessionId), then generate insight (nulls sessionId)
    if (ws && ws.readyState === WebSocket.OPEN) {
      isDisconnecting = true;
      try { ws.send(JSON.stringify({ type: 'disconnect', session_id: sessionId, tenant_id: TENANT_ID, reason: 'page_unload' })); } catch (e) { }
      ws.close();
    }
    if (wsPingInterval) clearInterval(wsPingInterval);
    if (inactivityTimer) clearTimeout(inactivityTimer);
    generateInsight(); // fire after WS is closed — keepalive fetch survives page unload
  });

})();