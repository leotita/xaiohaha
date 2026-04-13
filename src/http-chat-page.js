// 独立浏览器页只负责展示历史消息和发送补充指令，和 MCP App 内嵌 UI 分开维护。
export const CHAT_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Xiaohaha Chat</title>
  <style>
    :root {
      --bg-primary: #0f0f1a;
      --bg-secondary: #161625;
      --bg-tertiary: #1e1e32;
      --bg-hover: #252540;
      --border: rgba(255,255,255,0.06);
      --text-primary: #e8e8f0;
      --text-secondary: #9898b0;
      --text-muted: #5a5a78;
      --accent: #6c5ce7;
      --accent-hover: #7c6ef7;
      --accent-glow: rgba(108,92,231,0.25);
      --success: #00cec9;
      --danger: #ff6b6b;
      --user-bubble: linear-gradient(135deg, #6c5ce7, #a855f7);
      --ai-bubble: #1e1e32;
      --radius: 16px;
      --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      font-family: var(--font);
      background: var(--bg-primary);
      color: var(--text-primary);
      display: flex; flex-direction: column;
      overflow: hidden;
    }

    .header {
      padding: 16px 24px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 14px;
      flex-shrink: 0;
      backdrop-filter: blur(20px);
    }
    .logo {
      width: 36px; height: 36px; border-radius: 10px;
      background: var(--user-bubble);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; flex-shrink: 0;
      box-shadow: 0 4px 15px var(--accent-glow);
    }
    .header-info { flex: 1; }
    .header-info h1 { font-size: 16px; font-weight: 700; letter-spacing: -0.3px; }
    .header-info p { font-size: 11px; color: var(--text-muted); margin-top: 1px; }
    .header-actions {
      display: flex; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    .session-picker {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px;
      border-radius: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      font-size: 12px;
    }
    .session-picker select {
      min-width: 260px;
      max-width: 360px;
      background: transparent;
      color: var(--text-primary);
      border: none;
      outline: none;
      font-size: 12px;
      font-family: var(--font);
    }
    .refresh-btn {
      border: 1px solid var(--border);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      border-radius: 10px;
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .refresh-btn:hover { color: var(--text-primary); border-color: rgba(255,255,255,0.14); }

    .status-pill {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; padding: 6px 14px; border-radius: 20px;
      background: var(--bg-tertiary); color: var(--text-secondary);
      border: 1px solid var(--border);
      transition: all 0.3s ease;
    }
    .status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--danger);
      transition: background 0.3s ease;
    }
    .status-pill.waiting { background: rgba(0,206,201,0.1); border-color: rgba(0,206,201,0.3); color: var(--success); }
    .status-pill.waiting .status-dot { background: var(--success); animation: blink 1.5s infinite; }
    .status-pill.connected { background: var(--bg-tertiary); color: var(--text-secondary); }
    .status-pill.connected .status-dot { background: var(--accent); }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }

    #messages {
      flex: 1; overflow-y: auto; padding: 24px;
      display: flex; flex-direction: column; gap: 16px;
      scroll-behavior: smooth;
    }
    #messages::-webkit-scrollbar { width: 5px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 10px; }
    #messages::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

    .msg-row { display: flex; gap: 10px; animation: fadeIn 0.3s ease; }
    .msg-row.user { flex-direction: row-reverse; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }

    .avatar {
      width: 32px; height: 32px; border-radius: 10px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; margin-top: 2px;
    }
    .msg-row.user .avatar { background: var(--user-bubble); }
    .msg-row.ai .avatar { background: var(--bg-tertiary); border: 1px solid var(--border); }

    .bubble {
      max-width: 75%; padding: 12px 16px; border-radius: var(--radius);
      font-size: 14px; line-height: 1.7; word-break: break-word; white-space: pre-wrap;
    }
    .msg-row.user .bubble {
      background: var(--user-bubble); color: #fff;
      border-bottom-right-radius: 6px;
      box-shadow: 0 4px 20px var(--accent-glow);
    }
    .msg-row.ai .bubble {
      background: var(--ai-bubble); color: var(--text-primary);
      border: 1px solid var(--border);
      border-bottom-left-radius: 6px;
    }
    .bubble .time {
      font-size: 10px; margin-top: 6px;
      opacity: 0.5;
    }

    .empty-state {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 16px;
      color: var(--text-muted); padding: 40px;
    }
    .empty-icon {
      width: 72px; height: 72px; border-radius: 20px;
      background: var(--bg-tertiary); border: 1px solid var(--border);
      display: flex; align-items: center; justify-content: center;
      font-size: 32px;
    }
    .empty-state h3 { font-size: 16px; font-weight: 600; color: var(--text-secondary); }
    .empty-state p { font-size: 13px; line-height: 1.8; text-align: center; }
    .kbd {
      display: inline-block; padding: 2px 7px; border-radius: 5px;
      background: var(--bg-tertiary); border: 1px solid var(--border);
      font-size: 11px; font-family: monospace; color: var(--text-secondary);
    }

    .input-area {
      padding: 16px 24px 20px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .input-wrapper {
      display: flex; align-items: flex-end; gap: 10px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 6px 6px 6px 16px;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .input-wrapper:focus-within {
      border-color: rgba(108,92,231,0.5);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    #input {
      flex: 1; padding: 10px 0; border: none; background: transparent;
      color: var(--text-primary); font-size: 14px; outline: none;
      resize: none; min-height: 24px; max-height: 120px;
      font-family: var(--font); line-height: 1.5;
    }
    #input::placeholder { color: var(--text-muted); }
    #sendBtn {
      width: 40px; height: 40px; border-radius: 10px;
      background: var(--accent); color: white; border: none;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: all 0.2s ease;
    }
    #sendBtn:hover { background: var(--accent-hover); transform: scale(1.05); }
    #sendBtn:active { transform: scale(0.95); }
    #sendBtn:disabled {
      background: var(--bg-tertiary);
      color: var(--text-muted);
      cursor: not-allowed;
      transform: none;
    }
    #sendBtn svg { width: 18px; height: 18px; }

    @media (max-width: 900px) {
      .header {
        align-items: stretch;
        flex-wrap: wrap;
      }
      .header-actions {
        width: 100%;
      }
      .session-picker {
        flex: 1;
      }
      .session-picker select {
        min-width: 0;
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">X</div>
    <div class="header-info">
      <h1>Xiaohaha Chat</h1>
      <p id="headerHint">Cursor AI 额度放大器</p>
    </div>
    <div class="header-actions">
      <label class="session-picker">
        <span>会话</span>
        <select id="conversationSelect">
          <option value="">加载中...</option>
        </select>
      </label>
      <button class="refresh-btn" id="reloadSessionsBtn" type="button">刷新</button>
      <div class="status-pill" id="statusPill">
        <span class="status-dot"></span>
        <span id="statusText">未连接</span>
      </div>
    </div>
  </div>

  <div id="messages">
    <div class="empty-state" id="emptyState">
      <div class="empty-icon">&#x1f680;</div>
      <h3>准备就绪</h3>
      <p>在下方输入消息发送给 Cursor AI<br>AI 回复完成后会在这里等待你的下一条指令<br><span class="kbd">Enter</span> 发送 &nbsp; <span class="kbd">Shift + Enter</span> 换行</p>
    </div>
  </div>

  <div class="input-area">
    <div class="input-wrapper">
      <textarea id="input" placeholder="输入消息..." rows="1"></textarea>
      <button id="sendBtn" onclick="send()" title="发送">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
  </div>

  <script>
    const INPUT_MIN_HEIGHT = 24;
    const INPUT_MAX_HEIGHT = 120;
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const messagesEl = document.getElementById('messages');
    const statusPill = document.getElementById('statusPill');
    const statusText = document.getElementById('statusText');
    const headerHint = document.getElementById('headerHint');
    const conversationSelect = document.getElementById('conversationSelect');
    const reloadSessionsBtn = document.getElementById('reloadSessionsBtn');
    let conversationId = new URLSearchParams(window.location.search).get('conversationId') || '';
    let lastSeenId = 0;
    let isComposing = false;
    let sessions = [];

    function autoResizeInput(force = false) {
      if (isComposing && !force) return;
      input.style.height = INPUT_MIN_HEIGHT + 'px';
      input.style.height = Math.max(INPUT_MIN_HEIGHT, Math.min(input.scrollHeight, INPUT_MAX_HEIGHT)) + 'px';
    }

    input.addEventListener('keydown', e => {
      if (e.isComposing || isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    input.addEventListener('compositionstart', () => {
      isComposing = true;
    });

    input.addEventListener('compositionend', () => {
      isComposing = false;
      autoResizeInput(true);
    });

    input.addEventListener('input', () => {
      autoResizeInput();
    });

    autoResizeInput(true);

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function setStatus(text, mode) {
      statusText.textContent = text;
      statusPill.className = 'status-pill';
      if (mode === 'waiting') {
        statusPill.classList.add('waiting');
      } else if (mode === 'connected') {
        statusPill.classList.add('connected');
      }
    }

    function setHeaderHint(text) {
      headerHint.textContent = text;
    }

    function updateComposerAvailability() {
      const enabled = Boolean(conversationId);
      input.disabled = !enabled;
      sendBtn.disabled = !enabled;
      input.placeholder = enabled ? '输入消息...' : '先选择一个会话...';
    }

    function renderEmptyState(title, messageHtml) {
      messagesEl.innerHTML =
        '<div class="empty-state" id="emptyState">' +
        '<div class="empty-icon">&#x1f680;</div>' +
        '<h3>' + escapeHtml(title) + '</h3>' +
        '<p>' + messageHtml + '</p>' +
        '</div>';
    }

    function syncConversationQuery() {
      const url = new URL(window.location.href);
      if (conversationId) {
        url.searchParams.set('conversationId', conversationId);
      } else {
        url.searchParams.delete('conversationId');
      }
      window.history.replaceState({}, '', url.toString());
    }

    function updateSelectOptions() {
      if (sessions.length === 0) {
        conversationSelect.innerHTML = '<option value="">暂无会话</option>';
        conversationSelect.disabled = true;
        return;
      }

      conversationSelect.disabled = false;
      conversationSelect.innerHTML = sessions.map((session) => {
        const status = session.waiting ? '等待' : '处理中';
        const preview = escapeHtml(session.preview || session.conversationId);
        const selected = session.conversationId === conversationId ? ' selected' : '';
        return '<option value="' + escapeHtml(session.conversationId) + '"' + selected + '>' +
          escapeHtml(status + ' · ') + preview +
          '</option>';
      }).join('');
    }

    function addMsg(text, role, time, shouldScroll = true) {
      const empty = document.getElementById('emptyState');
      if (empty) empty.remove();
      const row = document.createElement('div');
      row.className = 'msg-row ' + role;
      const av = role === 'user' ? '&#x1f464;' : '&#x2728;';
      row.innerHTML =
        '<div class="avatar">' + av + '</div>' +
        '<div class="bubble">' + escapeHtml(text) +
        '<div class="time">' + escapeHtml(time || new Date().toLocaleTimeString()) + '</div></div>';
      messagesEl.appendChild(row);
      if (shouldScroll) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function renderConversation(events) {
      messagesEl.innerHTML = '';
      if (!events || events.length === 0) {
        renderEmptyState('暂无消息', '当前会话还没有聊天记录。');
        return;
      }

      for (const event of events) {
        addMsg(event.text || '', event.role === 'user' ? 'user' : 'ai', event.time || '', false);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function updateLastSeenId(events) {
      lastSeenId = (events || []).reduce((maxId, event) => {
        if (event && event.role === 'ai' && typeof event.id === 'number') {
          return Math.max(maxId, event.id);
        }
        return maxId;
      }, 0);
    }

    async function loadConversationList({ loadConversationIfNeeded = true } = {}) {
      const response = await fetch('/conversations');
      const data = await response.json();
      sessions = Array.isArray(data.sessions) ? data.sessions : [];

      const selectedStillExists = conversationId && sessions.some((session) => session.conversationId === conversationId);
      if (!selectedStillExists) {
        conversationId = data.selectedConversationId || sessions[0]?.conversationId || '';
      }

      updateSelectOptions();
      updateComposerAvailability();

      if (!conversationId) {
        setHeaderHint('未检测到可控制的会话');
        setStatus(data.error || '未连接', '');
        renderEmptyState('暂无会话', '当 Agent 进入 <span class="kbd">check_messages</span> 后，会话会出现在这里。');
        syncConversationQuery();
        return;
      }

      setHeaderHint('当前会话: ' + conversationId);
      syncConversationQuery();

      if (loadConversationIfNeeded) {
        await loadConversation(conversationId);
      }
    }

    async function loadConversation(nextConversationId) {
      if (!nextConversationId) {
        return;
      }

      const response = await fetch('/conversation?conversationId=' + encodeURIComponent(nextConversationId));
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        setStatus(data.error || '加载失败', '');
        return;
      }

      conversationId = data.conversationId || nextConversationId;
      setHeaderHint('当前会话: ' + conversationId);
      renderConversation(data.events || []);
      updateLastSeenId(data.events || []);
      updateComposerAvailability();

      if (data.waiting) {
        setStatus('等待输入...', 'waiting');
      } else {
        setStatus('AI 处理中', 'connected');
      }

      updateSelectOptions();
      syncConversationQuery();
    }

    async function send() {
      if (!conversationId) return;
      const msg = input.value.trim();
      if (!msg) return;
      addMsg(msg, 'user');
      input.value = ''; autoResizeInput(true);
      try {
        const r = await fetch('/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg, conversationId })
        });
        const d = await r.json();
        if (!r.ok || d.ok === false) {
          addMsg('[' + (d.error || '发送失败') + ']', 'ai');
        } else {
          setStatus('AI 处理中', 'connected');
        }
      } catch { addMsg('[发送失败，请检查 MCP 服务是否运行]', 'ai'); }
    }

    async function poll() {
      if (!conversationId) {
        return;
      }

      try {
        // 只拉取 lastSeenId 之后的新消息，避免轮询时把历史 AI 回复重复渲染一遍。
        const params = new URLSearchParams({ after: String(lastSeenId) });
        if (conversationId) params.set('conversationId', conversationId);
        const r = await fetch('/poll?' + params.toString());
        const d = await r.json();
        if (d.error) {
          statusText.textContent = d.error;
          statusPill.className = 'status-pill';
          return;
        }
        if (d.waiting) {
          statusText.textContent = '等待输入...';
          statusPill.className = 'status-pill waiting';
        } else {
          statusText.textContent = 'AI 处理中';
          statusPill.className = 'status-pill connected';
        }
        if (d.responses && d.responses.length > 0) {
          for (const resp of d.responses) {
            addMsg(resp.text, 'ai', resp.time || '');
            lastSeenId = resp.id;
          }
        }
      } catch {
        statusText.textContent = '未连接';
        statusPill.className = 'status-pill';
      }
    }

    conversationSelect.addEventListener('change', async (event) => {
      conversationId = event.target.value || '';
      updateComposerAvailability();
      if (conversationId) {
        await loadConversation(conversationId);
      } else {
        renderEmptyState('暂无会话', '请先选择一个会话。');
      }
    });

    reloadSessionsBtn.addEventListener('click', async () => {
      await loadConversationList();
    });

    setInterval(poll, 1500);
    setInterval(() => {
      void loadConversationList({ loadConversationIfNeeded: false });
    }, 5000);
    loadConversationList().catch(() => {
      setStatus('未连接', '');
      renderEmptyState('连接失败', '请检查 Xiaohaha 服务是否正常运行。');
    }).finally(() => {
      updateComposerAvailability();
      if (conversationId) input.focus();
    });
  </script>
</body>
</html>`;
