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
    #sendBtn svg { width: 18px; height: 18px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">X</div>
    <div class="header-info">
      <h1>Xiaohaha Chat</h1>
      <p>Cursor AI 额度放大器</p>
    </div>
    <div class="status-pill" id="statusPill">
      <span class="status-dot"></span>
      <span id="statusText">未连接</span>
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
    const messagesEl = document.getElementById('messages');
    const emptyState = document.getElementById('emptyState');
    const statusPill = document.getElementById('statusPill');
    const statusText = document.getElementById('statusText');
    const conversationId = new URLSearchParams(window.location.search).get('conversationId');
    let lastSeenId = 0;
    let isComposing = false;

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

    async function send() {
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
        }
      } catch { addMsg('[发送失败，请检查 MCP 服务是否运行]', 'ai'); }
    }

    function addMsg(text, role) {
      if (emptyState) emptyState.remove();
      const row = document.createElement('div');
      row.className = 'msg-row ' + role;
      const av = role === 'user' ? '&#x1f464;' : '&#x2728;';
      const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      row.innerHTML =
        '<div class="avatar">' + av + '</div>' +
        '<div class="bubble">' + escaped +
        '<div class="time">' + new Date().toLocaleTimeString() + '</div></div>';
      messagesEl.appendChild(row);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function poll() {
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
            addMsg(resp.text, 'ai');
            lastSeenId = resp.id;
          }
        }
      } catch {
        statusText.textContent = '未连接';
        statusPill.className = 'status-pill';
      }
    }

    setInterval(poll, 1500);
    poll();
    input.focus();
  </script>
</body>
</html>`;
