(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  // On fly.dev (chat-widget.fly.dev): use relative /api/v1 — nginx proxies it to the backend.
  // On localhost with python http.server: hit the backend directly (python can't proxy).
  var _isLocal  = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var _backendUrl = 'https://chatbot-dashboard-h719.onrender.com/api/v1';
  var defaultCfg = {
    apiUrl:         _isLocal ? _backendUrl : (location.origin + '/api/v1'),
    primaryColor:   '#6366f1',
    position:       'bottom-right',
    welcomeMessage: 'Hi! How can I help you today?',
    companyName:    'Support',
  };

  var cfg       = Object.assign({}, defaultCfg, window.__CHATBOT_CONFIG || {});
  var API       = cfg.apiUrl;
  var COLOR     = cfg.primaryColor;
  var POS       = cfg.position;
  var WELCOME   = cfg.welcomeMessage;
  var COMPANY   = cfg.companyName;
  var TENANT_ID = cfg.tenantId || cfg.tenant_id || null;

  // Runtime state
  var sessionId        = null;
  var ws               = null;
  var wsReconnectDelay = 1000;
  var isOpen           = false;
  var isConnecting     = false;
  var isDisconnecting  = false;
  var wsPingInterval   = null;
  var inactivityTimer  = null;
  var streamingMsgs    = {};
  var msgQueue         = [];

  // DOM refs
  var container, msgList, inputField, sendBtn, statusDot, statusText;

  // ── Public API ─────────────────────────────────────────────────────────────
  window.ChatbotSDK = {
    init: function(c) {
      if (!c) return;
      cfg       = Object.assign(cfg, c);
      API       = cfg.apiUrl        || API;
      COLOR     = cfg.primaryColor  || COLOR;
      POS       = cfg.position      || POS;
      WELCOME   = cfg.welcomeMessage || WELCOME;
      COMPANY   = cfg.companyName   || COMPANY;
      TENANT_ID = cfg.tenantId || cfg.tenant_id || TENANT_ID;
    },
    open:       function() { openChat(); },
    close:      function() { closeChat(); },
    toggle:     function() { isOpen ? closeChat() : openChat(); },
    isOpen:     function() { return isOpen; },
    getSession: function() { return sessionId; },
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  function boot() {
    var inIframe = window.parent !== window;
    if (inIframe) {
      // Inside embed.html — build UI filling the entire iframe
      buildUI(true);
      startSession(function() {
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
    if (ws) { try { ws.close(); } catch(e) {} ws = null; }
    if (isConnecting) { if (cb) cb(false); return; }

    isConnecting = true;
    setStatus('connecting');

    var base   = API.replace(/^http/, 'ws');
    var params = 'session_id=' + encodeURIComponent(sessionId);
    if (TENANT_ID) params += '&tenant_id=' + encodeURIComponent(TENANT_ID);
    var url = base + '/ws/chat?' + params;

    var giveUp = setTimeout(function() {
      isConnecting = false;
      setStatus('offline');
      if (cb) cb(false);
      cb = null;
    }, 8000);

    try {
      ws = new WebSocket(url);

      ws.onopen = function() {
        clearTimeout(giveUp);
        isConnecting     = false;
        wsReconnectDelay = 1000;
        setStatus('online');
        if (wsPingInterval) clearInterval(wsPingInterval);
        wsPingInterval = setInterval(function() {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, 20000);
        if (cb) { cb(true); cb = null; }
      };

      ws.onmessage = function(e) {
        try { handleWsMsg(JSON.parse(e.data)); }
        catch(err) { console.error('[Chatbot] WS parse error', err); }
      };

      ws.onerror = function(err) {
        clearTimeout(giveUp);
        console.error('[Chatbot] WS error:', err);
        isConnecting = false;
        setStatus('offline');
        if (cb) { cb(false); cb = null; }
      };

      ws.onclose = function() {
        isConnecting = false;
        ws = null;
        if (wsPingInterval) { clearInterval(wsPingInterval); wsPingInterval = null; }
        if (!isDisconnecting && isOpen && sessionId) {
          setStatus('connecting');
          wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
          setTimeout(function() { openWebSocket(null); }, wsReconnectDelay);
        } else {
          setStatus('offline');
        }
      };
    } catch(err) {
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
    var btn    = document.createElement('button');
    btn.id     = 'cb-launcher';
    var side   = POS.includes('right') ? 'right:24px' : 'left:24px';
    btn.setAttribute('style',
      'all:initial;position:fixed;' + side + ';bottom:24px;' +
      'width:60px;height:60px;border-radius:50%;' +
      'background:linear-gradient(135deg,' + COLOR + ',' + darken(COLOR,40) + ');' +
      'color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 4px 20px rgba(0,0,0,.28);z-index:2147483646;border:none;' +
      'transition:transform .2s,box-shadow .2s;font-family:sans-serif;');
    btn.innerHTML = iconChat();
    btn.setAttribute('aria-label', 'Open chat');
    btn.addEventListener('mouseenter', function() {
      btn.style.transform = 'scale(1.1)';
      btn.style.boxShadow = '0 8px 32px rgba(0,0,0,.35)';
    });
    btn.addEventListener('mouseleave', function() {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = '0 4px 20px rgba(0,0,0,.28)';
    });
    btn.addEventListener('click', toggleChat);
    document.body.appendChild(btn);
  }

  function toggleChat() { isOpen ? closeChat() : openChat(); }

  // ── Open / close ───────────────────────────────────────────────────────────
  function openChat() {
    if (!container) buildUI(false);
    container.style.display = 'flex';
    requestAnimationFrame(function() {
      container.style.opacity   = '0';
      container.style.transform = 'translateY(16px) scale(.97)';
      requestAnimationFrame(function() {
        container.style.transition = 'opacity .24s ease,transform .24s ease';
        container.style.opacity    = '1';
        container.style.transform  = 'translateY(0) scale(1)';
      });
    });
    isOpen = true;
    updateLauncherIcon(true);

    if (!sessionId) {
      showStatusMsg('Connecting\u2026');
      startSession(function(ok) {
        clearStatusMsgs();
        if (!ok) showStatusMsg('\u26a0\ufe0f Could not connect. Please refresh.');
        else if (msgList && msgList.querySelectorAll('.cb-msg-row').length === 0) addMsg('bot', WELCOME);
      });
    } else {
      if (msgList && msgList.querySelectorAll('.cb-msg-row').length === 0) addMsg('bot', WELCOME);
    }

    setTimeout(function() { if (inputField) inputField.focus(); }, 120);
  }

  function closeChat() {
    if (!container) return;
    container.style.opacity   = '0';
    container.style.transform = 'translateY(16px) scale(.97)';
    setTimeout(function() { if (container) container.style.display = 'none'; }, 250);
    isOpen = false;
    updateLauncherIcon(false);
    if (window.parent !== window) window.parent.postMessage({ type: 'chatbot:close' }, '*');
  }

  function updateLauncherIcon(open) {
    var btn = document.getElementById('cb-launcher');
    if (!btn) return;
    btn.innerHTML = open ? iconClose() : iconChat();
  }

  // ── Build UI ───────────────────────────────────────────────────────────────
  function buildUI(iframeMode) {
    injectStyles();

    container    = document.createElement('div');
    container.id = 'cb-root';

    if (iframeMode) {
      // Fill the entire iframe — no offsets
      container.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;' +
        'display:flex;flex-direction:column;' +
        'background:#f1f5f9;overflow:hidden;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Inter",Roboto,sans-serif;';
    } else {
      var side = POS.includes('right') ? 'right:24px' : 'left:24px';
      container.style.cssText =
        'position:fixed;' + side + ';bottom:96px;' +
        'width:370px;height:580px;max-height:calc(100vh - 120px);' +
        'display:none;flex-direction:column;' +
        'background:#f1f5f9;border-radius:20px;' +
        'box-shadow:0 24px 60px rgba(0,0,0,.22),0 0 0 1px rgba(0,0,0,.07);' +
        'z-index:2147483645;overflow:hidden;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Inter",Roboto,sans-serif;';
    }

    // ── Header ───────────────────────────────────────────────────────────────
    var header = document.createElement('div');
    header.style.cssText =
      'padding:14px 16px;flex-shrink:0;position:relative;overflow:hidden;' +
      'background:linear-gradient(135deg,' + COLOR + ' 0%,' + darken(COLOR,50) + ' 100%);' +
      'display:flex;align-items:center;gap:12px;';
    if (!iframeMode) {
      header.style.cursor = 'move';
      makeDraggable(header, container);
    }

    // Decorative circles
    var d1 = document.createElement('div');
    d1.style.cssText = 'position:absolute;top:-28px;right:-28px;width:110px;height:110px;border-radius:50%;background:rgba(255,255,255,.08);pointer-events:none;';
    var d2 = document.createElement('div');
    d2.style.cssText = 'position:absolute;bottom:-40px;left:30px;width:90px;height:90px;border-radius:50%;background:rgba(255,255,255,.06);pointer-events:none;';
    header.appendChild(d1);
    header.appendChild(d2);

    var botAv = document.createElement('div');
    botAv.style.cssText =
      'width:42px;height:42px;border-radius:50%;flex-shrink:0;z-index:1;' +
      'background:rgba(255,255,255,.18);border:2px solid rgba(255,255,255,.35);' +
      'display:flex;align-items:center;justify-content:center;font-size:20px;';
    botAv.textContent = '\uD83E\uDD16';

    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;z-index:1;';

    var nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-weight:700;font-size:15px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    nameEl.textContent = COMPANY;

    var statusRow = document.createElement('div');
    statusRow.style.cssText = 'display:flex;align-items:center;gap:5px;margin-top:2px;';
    statusDot  = document.createElement('span');
    statusText = document.createElement('span');
    statusDot.style.cssText  = 'width:7px;height:7px;border-radius:50%;background:#34d399;display:inline-block;flex-shrink:0;transition:background .3s;';
    statusText.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,.85);font-weight:500;';
    statusText.textContent   = 'Online';
    statusRow.appendChild(statusDot);
    statusRow.appendChild(statusText);
    info.appendChild(nameEl);
    info.appendChild(statusRow);

    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.style.cssText =
      'all:initial;width:32px;height:32px;border-radius:50%;z-index:1;flex-shrink:0;' +
      'background:rgba(255,255,255,.15);color:#fff;cursor:pointer;border:none;' +
      'display:flex;align-items:center;justify-content:center;font-size:20px;line-height:1;' +
      'transition:background .15s;font-family:sans-serif;';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('mouseenter', function() { closeBtn.style.background = 'rgba(255,255,255,.28)'; });
    closeBtn.addEventListener('mouseleave', function() { closeBtn.style.background = 'rgba(255,255,255,.15)'; });
    closeBtn.addEventListener('click', iframeMode
      ? function() { window.parent.postMessage({ type: 'chatbot:close' }, '*'); }
      : closeChat);

    header.appendChild(botAv);
    header.appendChild(info);
    header.appendChild(closeBtn);

    // ── Message area ──────────────────────────────────────────────────────────
    msgList    = document.createElement('div');
    msgList.id = 'cb-msgs';
    msgList.style.cssText =
      'flex:1;overflow-y:auto;padding:14px 12px;' +
      'display:flex;flex-direction:column;gap:4px;scroll-behavior:smooth;';

    // Date divider
    var today     = new Date().toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
    var divider   = document.createElement('div');
    divider.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 0 10px;';
    var l1 = document.createElement('div'); l1.style.cssText = 'flex:1;height:1px;background:#e2e8f0;';
    var dl = document.createElement('span'); dl.style.cssText = 'font-size:11px;color:#94a3b8;white-space:nowrap;font-weight:500;'; dl.textContent = today;
    var l2 = document.createElement('div'); l2.style.cssText = 'flex:1;height:1px;background:#e2e8f0;';
    divider.appendChild(l1); divider.appendChild(dl); divider.appendChild(l2);
    msgList.appendChild(divider);

    // ── Input area ────────────────────────────────────────────────────────────
    var inputArea = document.createElement('div');
    inputArea.style.cssText =
      'padding:10px 12px 14px;background:#fff;border-top:1px solid #e8ecf0;flex-shrink:0;';

    var inputWrap = document.createElement('div');
    inputWrap.style.cssText =
      'display:flex;align-items:center;gap:8px;' +
      'background:#f8fafc;border-radius:26px;padding:7px 7px 7px 16px;' +
      'border:2px solid #e2e8f0;transition:border-color .2s;';

    inputField = document.createElement('input');
    inputField.type         = 'text';
    inputField.placeholder  = 'Type a message\u2026';
    inputField.autocomplete = 'off';
    inputField.style.cssText =
      'flex:1;border:none;background:transparent;outline:none;' +
      'font-size:14px;color:#1e293b;font-family:inherit;min-width:0;';
    inputField.addEventListener('focus', function() { inputWrap.style.borderColor = COLOR; });
    inputField.addEventListener('blur',  function() { inputWrap.style.borderColor = '#e2e8f0'; });
    inputField.addEventListener('keypress', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });

    sendBtn = document.createElement('button');
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.style.cssText =
      'all:initial;width:36px;height:36px;border-radius:50%;flex-shrink:0;' +
      'background:linear-gradient(135deg,' + COLOR + ',' + darken(COLOR,40) + ');' +
      'color:#fff;cursor:pointer;border:none;' +
      'display:flex;align-items:center;justify-content:center;' +
      'transition:transform .15s,opacity .15s;' +
      'box-shadow:0 2px 10px ' + rgba(COLOR,.38) + ';font-family:sans-serif;';
    sendBtn.innerHTML = iconSend();
    sendBtn.addEventListener('mouseenter', function() { sendBtn.style.transform = 'scale(1.1)'; });
    sendBtn.addEventListener('mouseleave', function() { sendBtn.style.transform = 'scale(1)'; });
    sendBtn.addEventListener('click', doSend);

    inputWrap.appendChild(inputField);
    inputWrap.appendChild(sendBtn);

    var powered = document.createElement('div');
    powered.style.cssText = 'text-align:center;font-size:10px;color:#b0bec5;padding-top:6px;font-family:inherit;letter-spacing:.03em;';
    powered.textContent = '\u2736 Powered by WM Studio';

    inputArea.appendChild(inputWrap);
    inputArea.appendChild(powered);

    container.appendChild(header);
    container.appendChild(msgList);
    container.appendChild(inputArea);
    document.body.appendChild(container);
  }

  // ── Draggable (standalone) ─────────────────────────────────────────────────
  function makeDraggable(handle, el) {
    var ox = 0, oy = 0, drag = false;
    handle.addEventListener('mousedown', function(e) {
      if (e.target.closest && e.target.closest('button')) return;
      drag = true;
      var r = el.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!drag) return;
      el.style.left   = Math.max(0, Math.min(e.clientX - ox, window.innerWidth  - el.offsetWidth))  + 'px';
      el.style.top    = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - el.offsetHeight)) + 'px';
      el.style.right  = 'auto'; el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', function() { drag = false; });
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  function setStatus(state) {
    if (!statusDot || !statusText) return;
    if (state === 'online') {
      statusDot.style.background = '#34d399'; statusText.textContent = 'Online';
    } else if (state === 'connecting') {
      statusDot.style.background = '#fbbf24'; statusText.textContent = 'Connecting\u2026';
    } else {
      statusDot.style.background = '#f87171'; statusText.textContent = 'Offline';
    }
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  function addMsg(who, text, staffName) {
    if (!msgList) return;
    msgQueue.push({ who: who, text: text, time: Date.now() });
    if (msgQueue.length > 100) msgQueue.shift();

    var isUser  = who === 'user';
    var isStaff = who === 'staff';
    var time    = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

    var row = document.createElement('div');
    row.className    = 'cb-msg-row';
    row.style.cssText =
      'display:flex;flex-direction:' + (isUser ? 'row-reverse' : 'row') + ';' +
      'align-items:flex-end;gap:8px;' +
      'margin:' + (isUser ? '4px 0 2px' : '2px 0 4px') + ';' +
      'animation:cb-in .22s ease;';

    if (!isUser) {
      var av = document.createElement('div');
      av.style.cssText =
        'width:30px;height:30px;border-radius:50%;flex-shrink:0;' +
        'display:flex;align-items:center;justify-content:center;font-size:14px;' +
        'background:' + (isStaff ? 'linear-gradient(135deg,#10b981,#059669)' : 'linear-gradient(135deg,' + COLOR + ',' + darken(COLOR,40) + ')') + ';' +
        'color:#fff;font-weight:700;border:2px solid #fff;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.1);';
      av.textContent = isStaff ? (staffName || 'A')[0].toUpperCase() : '\uD83E\uDD16';
      row.appendChild(av);
    }

    var col = document.createElement('div');
    col.style.cssText = 'display:flex;flex-direction:column;max-width:72%;' + (isUser ? 'align-items:flex-end' : 'align-items:flex-start');

    if (isStaff && staffName) {
      var nm = document.createElement('div');
      nm.textContent   = staffName;
      nm.style.cssText = 'font-size:11px;color:#6b7280;margin-bottom:3px;font-weight:600;';
      col.appendChild(nm);
    }

    var bubble = document.createElement('div');
    if (isUser) {
      bubble.style.cssText =
        'padding:10px 14px;border-radius:18px 18px 4px 18px;' +
        'background:linear-gradient(135deg,' + COLOR + ',' + darken(COLOR,40) + ');' +
        'color:#fff;font-size:14px;line-height:1.55;word-break:break-word;' +
        'box-shadow:0 2px 10px ' + rgba(COLOR,.32) + ';';
      bubble.textContent = text;
    } else {
      bubble.style.cssText =
        'padding:10px 14px;' +
        'border-radius:' + (isStaff ? '18px 18px 18px 4px' : '4px 18px 18px 18px') + ';' +
        'background:' + (isStaff ? '#f0fdf4' : '#fff') + ';' +
        'color:#1e293b;font-size:14px;line-height:1.55;word-break:break-word;' +
        'box-shadow:0 1px 6px rgba(0,0,0,.07);' +
        'border:1px solid ' + (isStaff ? '#a7f3d0' : '#e8ecf0') + ';';
      bubble.innerHTML = parseMarkdown(text);
      applyMdStyles(bubble);
    }

    var ts = document.createElement('div');
    ts.textContent   = time;
    ts.style.cssText = 'font-size:10px;color:#94a3b8;margin-top:3px;padding:0 2px;';

    col.appendChild(bubble);
    col.appendChild(ts);
    row.appendChild(col);
    msgList.appendChild(row);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function addSysMsg(text) {
    if (!msgList) return;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;justify-content:center;margin:6px 0;';
    var pill = document.createElement('div');
    pill.style.cssText = 'font-size:11.5px;color:#64748b;background:rgba(148,163,184,.12);border-radius:999px;padding:4px 12px;border:1px solid rgba(148,163,184,.2);';
    pill.textContent = text;
    wrap.appendChild(pill);
    msgList.appendChild(wrap);
    msgList.scrollTop = msgList.scrollHeight;
  }

  // ── Typing indicator ───────────────────────────────────────────────────────
  function showTyping() {
    if (!msgList || document.getElementById('cb-typing')) return;
    var row = document.createElement('div');
    row.id = 'cb-typing';
    row.style.cssText = 'display:flex;align-items:flex-end;gap:8px;margin:2px 0 6px;animation:cb-in .22s ease;';

    var av = document.createElement('div');
    av.style.cssText =
      'width:30px;height:30px;border-radius:50%;flex-shrink:0;' +
      'display:flex;align-items:center;justify-content:center;font-size:14px;' +
      'background:linear-gradient(135deg,' + COLOR + ',' + darken(COLOR,40) + ');' +
      'color:#fff;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.1);';
    av.textContent = '\uD83E\uDD16';

    var bubble = document.createElement('div');
    bubble.style.cssText =
      'padding:11px 15px;border-radius:4px 18px 18px 18px;' +
      'background:#fff;border:1px solid #e8ecf0;' +
      'box-shadow:0 1px 6px rgba(0,0,0,.07);' +
      'display:flex;align-items:center;gap:5px;';

    for (var i = 0; i < 3; i++) {
      var dot = document.createElement('span');
      dot.style.cssText =
        'width:7px;height:7px;border-radius:50%;background:#94a3b8;display:inline-block;' +
        'animation:cb-bounce 1.2s ' + (i * .18) + 's infinite ease-in-out;';
      bubble.appendChild(dot);
    }
    row.appendChild(av);
    row.appendChild(bubble);
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
    d.className     = 'cb-status';
    d.textContent   = text;
    d.style.cssText = 'text-align:center;color:#94a3b8;padding:14px;font-size:13px;font-style:italic;';
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
    inputField.focus();
    resetInactivity();
    addMsg('user', text);
    showTyping();
    setSendDisabled(true);

    if (!sessionId) {
      startSession(function(ok) {
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
      ws.send(JSON.stringify({ type: 'chat_message', text: text, session_id: sessionId, tenant_id: TENANT_ID }));
      setSendDisabled(false);
    } else {
      // WS not ready — try REST fallback
      sendREST(text);
    }
  }

  function setSendDisabled(v) {
    if (!sendBtn) return;
    sendBtn.style.opacity = v ? '.45' : '1';
    sendBtn.style.cursor  = v ? 'not-allowed' : 'pointer';
  }

  function sendREST(text) {
    fetch(API + '/conversations', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: TENANT_ID, session_id: sessionId, user_message: text }),
    })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      var msg = data.bot_response || data.text || data.message || "I didn\u2019t quite catch that. Could you rephrase?";
      removeTyping();
      addMsg('bot', msg);
    })
    .catch(function(err) {
      console.error('[Chatbot] REST error:', err);
      removeTyping();
      addMsg('bot', '\u26a0\ufe0f Unable to reach the server. Please try again.');
    })
    .finally(function() {
      setSendDisabled(false);
    });
  }

  // ── Streaming chunks ───────────────────────────────────────────────────────
  function handleChunk(data) {
    var mid = data.message_id;
    if (!streamingMsgs[mid]) {
      removeTyping();
      var row = document.createElement('div');
      row.id = 'cb-stream-' + mid;
      row.style.cssText = 'display:flex;flex-direction:row;align-items:flex-end;gap:8px;margin:2px 0 6px;animation:cb-in .22s ease;';

      var av = document.createElement('div');
      av.style.cssText =
        'width:30px;height:30px;border-radius:50%;flex-shrink:0;' +
        'display:flex;align-items:center;justify-content:center;font-size:14px;' +
        'background:linear-gradient(135deg,' + COLOR + ',' + darken(COLOR,40) + ');' +
        'color:#fff;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.1);';
      av.textContent = '\uD83E\uDD16';

      var bubble = document.createElement('div');
      bubble.style.cssText =
        'padding:10px 14px;border-radius:4px 18px 18px 18px;max-width:72%;' +
        'background:#fff;color:#1e293b;font-size:14px;line-height:1.55;word-break:break-word;' +
        'box-shadow:0 1px 6px rgba(0,0,0,.07);border:1px solid #e8ecf0;';

      row.appendChild(av);
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
  }

  // ── Staff ──────────────────────────────────────────────────────────────────
  function handleStaffJoined(data) {
    var name = data.staff_name || 'Agent';
    addSysMsg('\uD83D\uDD04 ' + name + ' is connecting\u2026');
    setTimeout(function() {
      var msgs = msgList.querySelectorAll('div');
      for (var i = 0; i < msgs.length; i++) {
        if (msgs[i].textContent.indexOf('is connecting') !== -1) {
          var par = msgs[i].parentNode;
          if (par) par.parentNode && par.parentNode.removeChild(par);
        }
      }
      addSysMsg('\u2705 ' + (data.message || (name + ' has joined')));
      setTimeout(showTyping, 500);
    }, 900);
  }

  // ── Closure prompt ─────────────────────────────────────────────────────────
  function showClosurePrompt(data) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-end;gap:8px;margin:4px 0;animation:cb-in .22s ease;';

    var av = document.createElement('div');
    av.style.cssText =
      'width:30px;height:30px;border-radius:50%;flex-shrink:0;' +
      'display:flex;align-items:center;justify-content:center;font-size:14px;' +
      'background:linear-gradient(135deg,' + COLOR + ',' + darken(COLOR,40) + ');' +
      'color:#fff;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.1);';
    av.textContent = '\uD83E\uDD16';

    var bubble = document.createElement('div');
    bubble.style.cssText =
      'padding:12px 14px;border-radius:4px 18px 18px 18px;max-width:72%;' +
      'background:#fff;border:1px solid #e8ecf0;font-size:14px;color:#1e293b;';

    var msg = document.createElement('div');
    msg.textContent      = data.message;
    msg.style.marginBottom = '10px';
    bubble.appendChild(msg);

    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    var options = data.options || [];
    options.forEach(function(opt) {
      var b = document.createElement('button');
      b.textContent   = opt.text;
      b.style.cssText =
        'all:initial;padding:6px 16px;border-radius:999px;font-family:inherit;' +
        'border:2px solid ' + COLOR + ';color:' + COLOR + ';font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;';
      b.addEventListener('mouseenter', function() { b.style.background = COLOR; b.style.color = '#fff'; });
      b.addEventListener('mouseleave', function() { b.style.background = 'transparent'; b.style.color = COLOR; });
      b.addEventListener('click', function() { handleClosureChoice(opt.id, btns); });
      btns.appendChild(b);
    });
    bubble.appendChild(btns);
    row.appendChild(av);
    row.appendChild(bubble);
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
    inactivityTimer = setTimeout(function() {
      showClosurePrompt({
        message: 'Are you still there?',
        options: [{ id:'continue', text:'Continue' }, { id:'end', text:'End chat' }]
      });
    }, 450000);
  }

  // ── Markdown ───────────────────────────────────────────────────────────────
  function parseMarkdown(text) {
    if (!text) return '';
    var codes = [], inlines = [];
    var html  = text;

    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, function(_, lang, code) {
      var idx = codes.length;
      codes.push('<pre><code class="lang-' + (lang||'text') + '">' + esc(code.trim()) + '</code></pre>');
      return '___C' + idx + '___';
    });
    html = html.replace(/`([^`]+)`/g, function(_, code) {
      var idx = inlines.length;
      inlines.push('<code>' + esc(code) + '</code>');
      return '___I' + idx + '___';
    });

    html = html.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    html = html.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g,'<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    html = html.replace(/^### (.+)$/gm,'<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm,'<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm,'<h1>$1</h1>');
    html = html.replace(/(?:^[*\-] .+$\n?)+/gm, function(m) {
      return '<ul>' + m.trim().split('\n').map(function(l){ return '<li>' + l.replace(/^[*\-] /,'') + '</li>'; }).join('') + '</ul>';
    });
    html = html.replace(/(?:^\d+\. .+$\n?)+/gm, function(m) {
      return '<ol>' + m.trim().split('\n').map(function(l){ return '<li>' + l.replace(/^\d+\. /,'') + '</li>'; }).join('') + '</ol>';
    });
    html = html.split(/\n\n+/).map(function(p) {
      p = p.trim();
      if (!p || /^<(h[123]|ul|ol|pre)/.test(p) || /^___/.test(p)) return p;
      return '<p>' + p.replace(/\n/g,'<br>') + '</p>';
    }).join('');

    codes.forEach(function(b,i)   { html = html.replace('___C'+i+'___', b); });
    inlines.forEach(function(c,i) { html = html.replace('___I'+i+'___', c); });
    return html;
  }

  function applyMdStyles(el) {
    var pres = el.querySelectorAll('pre');
    for (var i=0;i<pres.length;i++) pres[i].style.cssText='background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow-x:auto;margin:8px 0;font-size:12.5px;line-height:1.5;';
    var codes = el.querySelectorAll('code:not(pre code)');
    for (var i=0;i<codes.length;i++) codes[i].style.cssText='background:#f1f5f9;color:#be185d;padding:2px 6px;border-radius:4px;font-size:12.5px;font-family:monospace;';
    var lists = el.querySelectorAll('ul,ol');
    for (var i=0;i<lists.length;i++) lists[i].style.cssText='margin:6px 0;padding-left:18px;';
    var links = el.querySelectorAll('a');
    for (var i=0;i<links.length;i++) links[i].style.cssText='color:'+COLOR+';text-decoration:underline;';
    var hdrs = el.querySelectorAll('h1,h2,h3');
    for (var i=0;i<hdrs.length;i++) hdrs[i].style.cssText='margin:6px 0;font-weight:700;';
    var ps = el.querySelectorAll('p');
    for (var i=0;i<ps.length;i++) ps[i].style.cssText='margin:4px 0;';
  }

  function esc(t) { var d=document.createElement('div'); d.textContent=t; return d.innerHTML; }

  // ── Global styles ──────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('cb-global-styles')) return;
    var s    = document.createElement('style');
    s.id     = 'cb-global-styles';
    s.textContent =
      '@keyframes cb-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
      '@keyframes cb-bounce{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-8px);opacity:1}}' +
      '#cb-msgs::-webkit-scrollbar{width:4px}' +
      '#cb-msgs::-webkit-scrollbar-track{background:transparent}' +
      '#cb-msgs::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:99px}' +
      '#cb-msgs::-webkit-scrollbar-thumb:hover{background:#94a3b8}';
    document.head.appendChild(s);
  }

  // ── Color helpers ──────────────────────────────────────────────────────────
  function darken(hex, amount) {
    try {
      var r = Math.max(0, parseInt(hex.slice(1,3),16) - amount);
      var g = Math.max(0, parseInt(hex.slice(3,5),16) - amount);
      var b = Math.max(0, parseInt(hex.slice(5,7),16) - amount);
      return '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + b.toString(16).padStart(2,'0');
    } catch(e) { return hex; }
  }

  function rgba(hex, a) {
    try {
      var r = parseInt(hex.slice(1,3),16);
      var g = parseInt(hex.slice(3,5),16);
      var b = parseInt(hex.slice(5,7),16);
      return 'rgba('+r+','+g+','+b+','+a+')';
    } catch(e) { return hex; }
  }

  // ── Icons ──────────────────────────────────────────────────────────────────
  function iconChat() {
    return '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  }
  function iconClose() {
    return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  }
  function iconSend() {
    return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  window.addEventListener('beforeunload', function() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      isDisconnecting = true;
      try { ws.send(JSON.stringify({ type: 'disconnect', session_id: sessionId, tenant_id: TENANT_ID, reason: 'page_unload' })); } catch(e) {}
      ws.close();
    }
    if (wsPingInterval)  clearInterval(wsPingInterval);
    if (inactivityTimer) clearTimeout(inactivityTimer);
  });

})();
