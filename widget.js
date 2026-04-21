(function() {
  'use strict';

  // ── Defaults ─────────────────────────────────────────────────────────────
  // Every value here can be overridden via window.__CHATBOT_CONFIG before the
  // script loads, or by calling ChatbotSDK.init({ ... }) at any time.
  const defaultCfg = {
    apiUrl:         'https://chatbot-dashboard-h719.onrender.com/api/v1',
    primaryColor:   '#0ea5e9',
    position:       'bottom-right',
    welcomeMessage: 'Hello! How can I help you today?',
    companyName:    'Support',
  };

  // Merge window config immediately — no waiting, no timeout
  let cfg = Object.assign({}, defaultCfg, window.__CHATBOT_CONFIG || {});

  let API     = cfg.apiUrl;
  let COLOR   = cfg.primaryColor;
  let POS     = cfg.position;
  let WELCOME = cfg.welcomeMessage;
  let COMPANY = cfg.companyName;

  // tenant_id is optional — the backend can work session-only
  let TENANT_ID = cfg.tenantId || cfg.tenant_id || null;

  // Runtime state
  const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  let sessionId = null;
  let ws = null;
  let wsReconnectDelay = 1000;
  let isOpen = false;
  let msgQueue = [];
  let isConnecting = false;
  let isDisconnecting = false;

  let container, msgList, inputField, sendBtn;
  let wsPingInterval = null;
  let inactivityTimer = null;
  let chatWindowSize = { width: 380, height: 600 };

  // Allow late config via ChatbotSDK.init({ ... }) even after the script loads
  window.ChatbotSDK = window.ChatbotSDK || {};
  window.ChatbotSDK.init = function(c) {
    if (!c) return;
    cfg = Object.assign(cfg, c);
    API     = cfg.apiUrl     || API;
    COLOR   = cfg.primaryColor || COLOR;
    POS     = cfg.position   || POS;
    WELCOME = cfg.welcomeMessage || WELCOME;
    COMPANY = cfg.companyName || COMPANY;
    TENANT_ID = cfg.tenantId || cfg.tenant_id || TENANT_ID;
  };

  function init() {
    if (document.getElementById('chatbot-btn')) return;

    // When running inside an iframe (embed.html), open the chat UI directly — the
    // launcher button lives in the parent page (loader.js).
    const inIframe = window.parent !== window;
    if (inIframe) {
      openChatWindow();
      return;
    }

    // Standalone mode: render a floating launcher button
    const btn = document.createElement('div');
    btn.id = 'chatbot-btn';
    btn.innerHTML = '💬';
    btn.style.cssText = `
      position:fixed;${POS.includes('right') ? 'right:20px' : 'left:20px'};bottom:20px;
      width:60px;height:60px;border-radius:50%;background:${COLOR};color:#fff;
      cursor:pointer;display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:9999;font-size:28px;
      transition:transform .2s;user-select:none;
    `;
    btn.onmouseenter = () => btn.style.transform = 'scale(1.1)';
    btn.onmouseleave = () => btn.style.transform = 'scale(1)';
    btn.onclick = toggle;
    document.body.appendChild(btn);
  }

  function initSession() {
    if (sessionId) return;
    sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    connectWebSocket();
  }

  function connectWebSocket() {
    if (!sessionId || isConnecting) return;

    if (ws) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      ws = null;
    }

    isConnecting = true;
    const wsUrl = API.replace(/^http/, 'ws');

    // Build query string — only include params that exist
    const params = new URLSearchParams({ session_id: sessionId });
    if (TENANT_ID) params.set('tenant_id', TENANT_ID);

    const url = `${wsUrl}/ws/chat?${params.toString()}`;

    try {
      ws = new WebSocket(url);
      
      ws.onopen = () => {
        isConnecting = false;
        wsReconnectDelay = 1000;
      };
      
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          
          if (data.type === 'connected') {
            clearStatusMessages();
          }
          else if (data.type === 'chunk') {
            handleStreamingChunk(data);
          }
          else if (data.type === 'chunk_done') {
            finalizeStreamingMessage(data.message_id);
          }
          else if (data.type === 'chat_message' || data.type === 'bot_response') {
            removeTypingIndicator();
            addMessage('bot', data.text || data.message);
          }
          else if (data.type === 'staff_message') {
            removeTypingIndicator();
            addMessage('staff', data.text || data.message, data.staff_name || 'Agent');
          }
          else if (data.type === 'staff_joined') {
            removeTypingIndicator();
            handleStaffJoined(data);
          }
          else if (data.type === 'staff_left') {
            removeTypingIndicator();
            addSystemMessage(`ℹ️ ${data.message || 'Agent has left. I\'m back to assist you!'}`);
          }
          else if (data.type === 'closure_prompt') {
            removeTypingIndicator();
            handleClosurePrompt(data);
          }
          else if (data.type === 'error') {
            removeTypingIndicator();
            console.error('[Chatbot] Server error:', data.message);
            addMessage('bot', data.message || 'Sorry, something went wrong.');
          }
        } catch (err) {
          console.error('[Chatbot] WS parse error:', err);
        }
      };
      
      ws.onerror = (err) => {
        console.error('[Chatbot] WS error:', err);
        isConnecting = false;
      };
      
      ws.onclose = () => {
        isConnecting = false;
        ws = null;
        
        if (!isDisconnecting && isOpen && sessionId) {
          wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
          setTimeout(connectWebSocket, wsReconnectDelay);
        } else {
          isOpen = false;
          sessionId = null;
        }
      };

      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20000);
      
    } catch (err) {
      console.error('[Chatbot] WS connect failed:', err);
    }
  }

  function toggle() {
    isOpen ? closeChatWindow() : openChatWindow();
  }

  async function openChatWindow() {
    if (!container) createChatUI();
    
    if (!sessionId) {
      showStatusMessage('Connecting...');
      try {
        await initSession();
        clearStatusMessages();
      } catch (err) {
        clearStatusMessages();
        showStatusMessage('⚠️ Connection failed. Please refresh the page.');
        return;
      }
    }
    
    container.style.display = 'flex';
    isOpen = true;
    
    if (msgList.children.length === 0) {
      addMessage('bot', WELCOME);
    }
    
    setTimeout(() => inputField?.focus(), 100);
  }

  function closeChatWindow() {
    if (container) container.style.display = 'none';
    isOpen = false;
    // Notify parent frame (loader.js) so it can toggle its launcher icon
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'chatbot:close' }, '*');
    }
  }

  function createChatUI() {
    container = document.createElement('div');
    container.id = 'chatbot-window';
    container.style.cssText = `
      position:fixed;${POS.includes('right') ? 'right:20px' : 'left:20px'};bottom:90px;
      width:${chatWindowSize.width}px;height:${chatWindowSize.height}px;
      max-height:calc(100vh - 120px);min-width:300px;min-height:400px;
      background:#fff;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.15);
      display:none;flex-direction:column;z-index:9998;overflow:hidden;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      padding:20px;background:${COLOR};color:#fff;border-radius:16px 16px 0 0;
      display:flex;justify-content:space-between;align-items:center;cursor:move;
      user-select:none;
    `;
    header.innerHTML = `
      <div>
        <div style="font-weight:600;font-size:16px">${COMPANY}</div>
        <div style="font-size:12px;opacity:.9">Online</div>
      </div>
      <button id="cb-close" style="background:none;border:none;color:#fff;
        font-size:24px;cursor:pointer;width:30px;height:30px;padding:0">×</button>
    `;

    let isDraggingWindow = false;
    let windowDragOffset = { x: 0, y: 0 };
    
    header.addEventListener('mousedown', (e) => {
      if (e.target.id === 'cb-close') return;
      isDraggingWindow = true;
      const rect = container.getBoundingClientRect();
      windowDragOffset.x = e.clientX - rect.left;
      windowDragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isDraggingWindow) return;
      
      const x = e.clientX - windowDragOffset.x;
      const y = e.clientY - windowDragOffset.y;
      
      const maxX = window.innerWidth - container.offsetWidth;
      const maxY = window.innerHeight - container.offsetHeight;
      
      const finalX = Math.max(0, Math.min(x, maxX));
      const finalY = Math.max(0, Math.min(y, maxY));
      
      container.style.left = finalX + 'px';
      container.style.top = finalY + 'px';
      container.style.right = 'auto';
      container.style.bottom = 'auto';
    });
    
    document.addEventListener('mouseup', () => {
      isDraggingWindow = false;
    });

    msgList = document.createElement('div');
    msgList.style.cssText = `
      flex:1;overflow-y:auto;padding:20px;
      display:flex;flex-direction:column;gap:12px;
    `;

    const inputArea = document.createElement('div');
    inputArea.style.cssText = `
      padding:20px;border-top:1px solid #e5e7eb;
      display:flex;gap:10px;align-items:center;
    `;

    inputField = document.createElement('input');
    inputField.type = 'text';
    inputField.placeholder = 'Type your message...';
    inputField.autocomplete = 'off';
    inputField.style.cssText = `
      flex:1;padding:12px 16px;border:1px solid #e5e7eb;border-radius:24px;
      outline:none;font-size:14px;box-sizing:border-box;
    `;
    inputField.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send';
    sendBtn.style.cssText = `
      padding:12px 24px;background:${COLOR};color:#fff;border:none;
      border-radius:24px;cursor:pointer;font-weight:600;font-size:14px;
      transition:opacity .2s;
    `;
    sendBtn.onmouseenter = () => sendBtn.style.opacity = '0.9';
    sendBtn.onmouseleave = () => sendBtn.style.opacity = '1';
    sendBtn.onclick = sendMessage;

    inputArea.appendChild(inputField);
    inputArea.appendChild(sendBtn);
    container.appendChild(header);
    container.appendChild(msgList);
    container.appendChild(inputArea);

    createResizeHandles(container);
    
    document.body.appendChild(container);

    document.getElementById('cb-close').onclick = closeChatWindow;
    
    startInactivityTimer();
  }

  function createResizeHandles(container) {
    const handles = [
      { name: 'n', cursor: 'ns-resize', style: 'top:0;left:0;right:0;height:5px;' },
      { name: 's', cursor: 'ns-resize', style: 'bottom:0;left:0;right:0;height:5px;' },
      { name: 'e', cursor: 'ew-resize', style: 'top:0;right:0;bottom:0;width:5px;' },
      { name: 'w', cursor: 'ew-resize', style: 'top:0;left:0;bottom:0;width:5px;' },
      { name: 'ne', cursor: 'nesw-resize', style: 'top:0;right:0;width:10px;height:10px;' },
      { name: 'nw', cursor: 'nwse-resize', style: 'top:0;left:0;width:10px;height:10px;' },
      { name: 'se', cursor: 'nwse-resize', style: 'bottom:0;right:0;width:10px;height:10px;' },
      { name: 'sw', cursor: 'nesw-resize', style: 'bottom:0;left:0;width:10px;height:10px;' }
    ];

    handles.forEach(({ name, cursor, style }) => {
      const handle = document.createElement('div');
      handle.className = `resize-handle-${name}`;
      handle.style.cssText = `position:absolute;${style}cursor:${cursor};z-index:10;`;
      
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startResize(e, name, container);
      });
      
      container.appendChild(handle);
    });
  }

  function startResize(e, direction, container) {
    isResizing = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = container.offsetWidth;
    const startHeight = container.offsetHeight;
    const startLeft = container.offsetLeft;
    const startTop = container.offsetTop;

    const onMouseMove = (e) => {
      if (!isResizing) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newWidth = startWidth;
      let newHeight = startHeight;
      let newLeft = startLeft;
      let newTop = startTop;

      if (direction.includes('e')) {
        newWidth = Math.max(300, startWidth + dx);
      } else if (direction.includes('w')) {
        newWidth = Math.max(300, startWidth - dx);
        newLeft = startLeft + (startWidth - newWidth);
      }

      if (direction.includes('s')) {
        newHeight = Math.max(400, startHeight + dy);
      } else if (direction.includes('n')) {
        newHeight = Math.max(400, startHeight - dy);
        newTop = startTop + (startHeight - newHeight);
      }

      newWidth = Math.min(newWidth, window.innerWidth - 40);
      newHeight = Math.min(newHeight, window.innerHeight - 120);

      container.style.width = newWidth + 'px';
      container.style.height = newHeight + 'px';
      
      if (direction.includes('w') || direction.includes('n')) {
        container.style.left = newLeft + 'px';
        container.style.top = newTop + 'px';
        container.style.right = 'auto';
        container.style.bottom = 'auto';
      }

      chatWindowSize.width = newWidth;
      chatWindowSize.height = newHeight;
    };

    const onMouseUp = () => {
      isResizing = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function startInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      handleClosurePrompt({ message: 'Are you still there?', options: [{id:'continue',text:'Continue'},{id:'end',text:'End'}] });
    }, 450000);
  }

  async function sendMessage() {
    const text = inputField?.value?.trim();
    if (!text) return;

    inputField.value = '';
    inputField.focus();
    startInactivityTimer();
    
    addMessage('user', text);
    

    showTypingIndicator();

    if (ws?.readyState === WebSocket.OPEN) {
      const payload = {
        type: 'chat_message',
        text,
        session_id: sessionId,
        tenant_id: TENANT_ID
      };
      ws.send(JSON.stringify(payload));
    } else {
      console.log('[Chatbot] WebSocket not open, using REST API');
      await sendViaREST(text);
    }
  }

  async function sendViaREST(text) {
    try {
      const res = await fetch(`${API}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: TENANT_ID,
          session_id: sessionId,
          user_message: text,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const botMsg = data.bot_response || data.text || 'Sorry, I didn\'t understand that.';
      
      removeTypingIndicator();
      addMessage('bot', botMsg);
    } catch (err) {
      console.error('[Chatbot] Send failed:', err);
      removeTypingIndicator();
      addMessage('bot', 'Sorry, there was an error. Please try again.');
    }
  }

  function addMessage(who, text) {
    if (!msgList) return;

    msgQueue.push({ who, text, time: Date.now() });
    if (msgQueue.length > 50) msgQueue.shift(); 

    const wrapper = document.createElement('div');
    wrapper.style.cssText = `display:flex;justify-content:${who === 'user' ? 'flex-end' : 'flex-start'}`;

    const bubble = document.createElement('div');

    if (who === 'staff') {
      // Staff message styling
      bubble.style.cssText = `
        max-width:70%;padding:12px 16px;border-radius:16px;
        font-size:14px;line-height:1.5;word-wrap:break-word;
        background:#10b981;color:#fff;box-shadow:0 2px 8px rgba(16,185,129,0.12);
      `;

      // staffName may be passed as third arg in some calls
      const staffName = arguments[2] || 'Agent';
      const label = document.createElement('div');
      label.textContent = staffName;
      label.style.cssText = 'font-size:11px;opacity:0.95;margin-bottom:6px;font-weight:600;';
      bubble.appendChild(label);

      const textDiv = document.createElement('div');
      textDiv.innerHTML = parseMarkdown(text);
      applyMarkdownStyles(textDiv);
      bubble.appendChild(textDiv);
    } else {
      bubble.style.cssText = `
        max-width:70%;padding:12px 16px;border-radius:16px;
        font-size:14px;line-height:1.5;word-wrap:break-word;
        ${who === 'user' ? `background:${COLOR};color:#fff` : 'background:#f3f4f6;color:#1f2937'}
      `;

      if (who === 'bot') {
        bubble.innerHTML = parseMarkdown(text);
        applyMarkdownStyles(bubble);
      } else {
        bubble.textContent = text;
      }
    }

    wrapper.appendChild(bubble);
    msgList.appendChild(wrapper);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function addSystemMessage(text) {
    if (!msgList) return;
    const div = document.createElement('div');
    div.style.cssText = 'text-align:center;color:#6b7280;font-size:13px;padding:8px 12px;';
    div.textContent = text;
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function handleStaffJoined(data) {
    const staffName = data.staff_name || 'Agent';
    const message = data.message || `${staffName} has joined the conversation`;
    
    // Step 1: Show "Agent is connecting..." message
    const connectingMsg = addSystemMessage(`🔄 ${staffName} is connecting...`);
    
    // Step 2: After 800ms, update to "Agent connected"
    setTimeout(() => {
      // Remove the connecting message
      const messages = msgList.querySelectorAll('div');
      messages.forEach(msg => {
        if (msg.textContent && msg.textContent.includes('is connecting...')) {
          msg.remove();
        }
      });
      
      // Add connected message
      addSystemMessage(`✅ ${message}`);
      
      // Step 3: After another 500ms, show typing indicator
      setTimeout(() => {
        showTypingIndicator();
      }, 500);
      
    }, 800);
  }

  function applyMarkdownStyles(bubble) {
    bubble.querySelectorAll('pre').forEach(pre => {
      pre.style.cssText = 'background:#1e293b;color:#e2e8f0;padding:12px;border-radius:8px;overflow-x:auto;margin:8px 0;';
    });
    bubble.querySelectorAll('code:not(pre code)').forEach(code => {
      code.style.cssText = 'background:#e5e7eb;color:#1f2937;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:13px;';
    });
    bubble.querySelectorAll('ul, ol').forEach(list => {
      list.style.cssText = 'margin:8px 0;padding-left:20px;';
    });
    bubble.querySelectorAll('a').forEach(link => {
      link.style.cssText = `color:${COLOR};text-decoration:underline;`;
    });
    bubble.querySelectorAll('h1, h2, h3').forEach(header => {
      header.style.cssText = 'margin:8px 0;font-weight:600;';
    });
    bubble.querySelectorAll('p').forEach(p => {
      p.style.cssText = 'margin:8px 0;';
    });
  }

  let streamingMessages = {};

  function handleStreamingChunk(data) {
    const messageId = data.message_id;
    
    if (!streamingMessages[messageId]) {
      removeTypingIndicator();
      
      const wrapper = document.createElement('div');
      wrapper.id = `msg-${messageId}`;
      wrapper.style.cssText = 'display:flex;justify-content:flex-start';

      const bubble = document.createElement('div');
      bubble.className = 'streaming-bubble';
      bubble.style.cssText = `
        max-width:70%;padding:12px 16px;border-radius:16px;
        font-size:14px;line-height:1.5;word-wrap:break-word;
        background:#f3f4f6;color:#1f2937;
      `;
      
      wrapper.appendChild(bubble);
      msgList.appendChild(wrapper);
      
      streamingMessages[messageId] = { wrapper, bubble, text: '' };
    }
    
    const streaming = streamingMessages[messageId];
    streaming.text += data.text;
    streaming.bubble.innerHTML = parseMarkdown(streaming.text);
    applyMarkdownStyles(streaming.bubble);
    
    msgList.scrollTop = msgList.scrollHeight;
  }

  function finalizeStreamingMessage(messageId) {
    const streaming = streamingMessages[messageId];
    if (streaming) {
      msgQueue.push({ who: 'bot', text: streaming.text, time: Date.now() });
      if (msgQueue.length > 50) msgQueue.shift();
      
      delete streamingMessages[messageId];
    }
  }

  function handleClosurePrompt(data) {
    console.log('[Chatbot] Handling closure prompt:', data);
    
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;justify-content:flex-start;margin:10px 0';

    const bubble = document.createElement('div');
    bubble.style.cssText = `
      max-width:70%;padding:12px 16px;border-radius:16px;
      font-size:14px;line-height:1.5;
      background:#f3f4f6;color:#1f2937;
    `;
    
    const messageText = document.createElement('div');
    messageText.textContent = data.message;
    messageText.style.marginBottom = '10px';
    bubble.appendChild(messageText);
    
    const buttonsContainer = document.createElement('div');
    buttonsContainer.style.cssText = 'display:flex;gap:8px;margin-top:8px';
    
    if (data.options && Array.isArray(data.options)) {
      data.options.forEach(option => {
        const btn = document.createElement('button');
        btn.textContent = option.text;
        btn.style.cssText = `
          padding:8px 16px;border-radius:8px;border:none;
          background:${COLOR};color:#fff;cursor:pointer;
          font-size:13px;font-weight:500;transition:opacity .2s;
        `;
        btn.onmouseenter = () => btn.style.opacity = '0.8';
        btn.onmouseleave = () => btn.style.opacity = '1';
        btn.onclick = () => handleClosureResponse(option.id, buttonsContainer);
        buttonsContainer.appendChild(btn);
      });
    }
    
    bubble.appendChild(buttonsContainer);
    wrapper.appendChild(bubble);
    msgList.appendChild(wrapper);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function handleClosureResponse(choice, buttonsContainer) {
    
    if (buttonsContainer) {
      const buttons = buttonsContainer.querySelectorAll('button');
      buttons.forEach(btn => {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
      });
    }
    
    if (choice === 'continue') {
      addMessage('bot', 'Great! How else can I help you?');
      startInactivityTimer();
    } else if (choice === 'end') {
      addMessage('bot', 'Thank you for chatting! Feel free to come back anytime.');
      
      // Send disconnect message to properly close the session
      if (ws && ws.readyState === WebSocket.OPEN) {
        isDisconnecting = true;
        ws.send(JSON.stringify({
          type: 'disconnect',
          session_id: sessionId,
          tenant_id: TENANT_ID,
          reason: 'user_ended_chat'
        }));
      }
      
      setTimeout(() => closeChatWindow(), 2000);
    }
  }

  function showStatusMessage(text) {
    if (!msgList) return;
    const div = document.createElement('div');
    div.className = 'status-message';
    div.textContent = text;
    div.style.cssText = `
      text-align:center;color:#718096;padding:20px;
      font-size:14px;font-style:italic;
    `;
    msgList.appendChild(div);
  }

  function clearStatusMessages() {
    if (!msgList) return;
    const statusMessages = msgList.querySelectorAll('.status-message');
    statusMessages.forEach(msg => msg.remove());
  }

  function parseMarkdown(text) {
    if (!text) return '';
    
    let html = text;
    
    const codeBlocks = [];
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
      const placeholder = `___CODE_${codeBlocks.length}___`;
      codeBlocks.push(`<pre><code class="language-${lang || 'plaintext'}">${escapeHtml(code.trim())}</code></pre>`);
      return placeholder;
    });
    
    const inlineCodes = [];
    html = html.replace(/`([^`]+)`/g, (match, code) => {
      const placeholder = `___INLINE_${inlineCodes.length}___`;
      inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
      return placeholder;
    });
    
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    html = html.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>'); // Bold
    html = html.replace(/\*([^\*]+)\*/g, '<em>$1</em>'); // Italic
    html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>'); // Links
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>'); // Headers
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    
    html = html.replace(/(?:^[\*\-] .+$\n?)+/gm, match => {
      const items = match.trim().split('\n').map(line => line.replace(/^[\*\-] (.+)$/, '<li>$1</li>')).join('');
      return `<ul>${items}</ul>`;
    });
    html = html.replace(/(?:^\d+\. .+$\n?)+/gm, match => {
      const items = match.trim().split('\n').map(line => line.replace(/^\d+\. (.+)$/, '<li>$1</li>')).join('');
      return `<ol>${items}</ol>`;
    });
    
    html = html.split(/\n\n+/).map(p => {
      p = p.trim();
      if (p.startsWith('<h') || p.startsWith('<ul') || p.startsWith('<ol') || p.startsWith('<pre') || p.startsWith('___')) return p;
      p = p.replace(/\n/g, '<br>');
      return p ? `<p>${p}</p>` : '';
    }).join('');
    
    codeBlocks.forEach((block, i) => html = html.replace(`___CODE_${i}___`, block));
    inlineCodes.forEach((code, i) => html = html.replace(`___INLINE_${i}___`, code));
    
    return html;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function showTypingIndicator() {
    if (!msgList) return;
    
    removeTypingIndicator();
    
    const wrapper = document.createElement('div');
    wrapper.id = 'typing-indicator';
    wrapper.style.cssText = 'display:flex;justify-content:flex-start;margin:8px 0;';

    const bubble = document.createElement('div');
    bubble.style.cssText = `
      padding:12px 16px;border-radius:16px;
      background:#f3f4f6;color:#1f2937;
      display:flex;align-items:center;gap:4px;
    `;

    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      dot.style.cssText = `
        width:8px;height:8px;border-radius:50%;
        background:#9ca3af;
        animation:typing-bounce 1.4s infinite ease-in-out;
        animation-delay:${i * 0.2}s;
      `;
      bubble.appendChild(dot);
    }
    
    wrapper.appendChild(bubble);
    msgList.appendChild(wrapper);
    msgList.scrollTop = msgList.scrollHeight;
    
    if (!document.getElementById('typing-animation-style')) {
      const style = document.createElement('style');
      style.id = 'typing-animation-style';
      style.textContent = `
        @keyframes typing-bounce {
          0%, 60%, 100% {
            transform: translateY(0);
            opacity: 0.7;
          }
          30% {
            transform: translateY(-10px);
            opacity: 1;
          }
        }
      `;
      document.head.appendChild(style);
    }
  }

  function removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) {
      indicator.remove();
    }
  }

  window.addEventListener('beforeunload', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      isDisconnecting = true;
      try {
        ws.send(JSON.stringify({ 
          type: 'disconnect',
          session_id: sessionId,
          tenant_id: TENANT_ID,
          reason: 'page_unload'
        }));
      } catch (e) { /* ignore */ }
      ws.close();
    }
    if (wsPingInterval) clearInterval(wsPingInterval);
    if (inactivityTimer) clearTimeout(inactivityTimer);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.ChatbotSDK = {
    open: openChatWindow,
    close: closeChatWindow,
    isOpen: () => isOpen,
    getSession: () => sessionId
  };

})();
