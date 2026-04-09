export const STYLES = `
  :root {
    --xh-text: var(--mcp-ui-fg, #e8ecf8);
    --xh-muted: var(--mcp-ui-fg-muted, #9ea7c3);
    --xh-border: rgba(255, 255, 255, 0.12);
    --xh-border-strong: rgba(255, 255, 255, 0.18);
    --xh-ring: rgba(255, 255, 255, 0.06);
    --xh-chat-bg: #181818;
    --xh-surface: #181818;
    --xh-surface-focus: #181818;
    --xh-user-bubble: linear-gradient(135deg, #6c5ce7, #8b5cf6);
    --xh-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --xh-accent: #6c5ce7;
    --xh-accent-soft: rgba(108, 92, 231, 0.15);
  }

  * {
    box-sizing: border-box;
  }

  html,
  body,
  #app {
    margin: 0;
    background: transparent !important;
    background-color: transparent !important;
  }

  body {
    font-family: var(--xh-font);
    color: var(--xh-text);
    background: var(--xh-chat-bg) !important;
    background-color: var(--xh-chat-bg) !important;
  }

  #app {
    padding: 0;
    width: 100%;
    background: var(--xh-chat-bg) !important;
    background-color: var(--xh-chat-bg) !important;
  }

  .xh-root {
    width: 100%;
    display: block;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: var(--xh-chat-bg) !important;
    background-color: var(--xh-chat-bg) !important;
    box-sizing: border-box;
  }

  .xh-form {
    margin: 0;
    padding: 0;
    background: transparent !important;
    background-color: transparent !important;
  }

  .xh-input-shell {
    position: relative;
    width: 100%;
    border-radius: 18px;
    border: 1px solid var(--xh-border);
    background: var(--xh-chat-bg);
    box-shadow: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
    overflow: visible;
  }

  .xh-input-shell:focus-within {
    border-color: var(--xh-border-strong);
    box-shadow: 0 0 0 1px var(--xh-ring);
  }

  .xh-input-shell.xh-drag-active {
    border-color: var(--xh-accent);
    box-shadow: 0 0 0 2px var(--xh-accent-soft);
  }

  .xh-form[hidden],
  .xh-preview[hidden],
  .xh-error[hidden] {
    display: none;
  }

  .xh-input {
    width: 100%;
    min-height: 60px;
    max-height: 180px;
    padding: 16px 18px 8px;
    resize: none;
    border: 0;
    border-radius: 18px;
    box-shadow: none;
    background: transparent;
    color: var(--xh-text);
    font: inherit;
    line-height: 1.6;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
  }

  .xh-input::placeholder {
    color: var(--xh-muted);
  }

  .xh-input:focus {
    border: 0;
    box-shadow: none;
    background: transparent;
  }

  .xh-preview {
    display: block;
    width: 100%;
    padding: 16px 18px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: #232323;
    color: var(--xh-text);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.55;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
  }

  .xh-error {
    margin-top: 8px;
    font-size: 12px;
    color: #ff8f8f;
  }

  .xh-ai-reply {
    margin: 0 0 14px;
    color: var(--xh-text);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.65;
  }

  .xh-ai-reply[hidden] {
    display: none;
  }

  /* ── Attachment bar ── */
  .xh-attachments {
    display: flex;
    gap: 6px;
    padding: 10px 14px 2px;
    overflow-x: auto;
    scrollbar-width: none;
    flex-wrap: wrap;
  }
  .xh-attachments::-webkit-scrollbar { display: none; }
  .xh-attachments[hidden] { display: none; }

  .xh-att-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 6px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.10);
    font-size: 12px;
    color: var(--xh-muted);
    white-space: nowrap;
    max-width: 220px;
    cursor: default;
    transition: background 120ms ease;
    animation: xh-chip-in 200ms ease;
  }
  @keyframes xh-chip-in {
    from { opacity: 0; transform: scale(0.92); }
    to   { opacity: 1; transform: scale(1); }
  }
  .xh-att-chip:hover {
    background: rgba(255, 255, 255, 0.10);
  }

  .xh-att-thumb {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .xh-att-icon {
    font-size: 14px;
    flex-shrink: 0;
    width: 20px;
    text-align: center;
  }

  .xh-att-name {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .xh-att-size {
    font-size: 10px;
    opacity: 0.6;
    flex-shrink: 0;
  }

  .xh-att-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border: none;
    background: rgba(255, 255, 255, 0.08);
    color: var(--xh-muted);
    border-radius: 50%;
    cursor: pointer;
    font-size: 10px;
    line-height: 1;
    padding: 0;
    flex-shrink: 0;
    transition: background 120ms ease, color 120ms ease;
  }
  .xh-att-remove:hover {
    background: rgba(255, 100, 100, 0.3);
    color: #ff8f8f;
  }

  /* ── Input action bar ── */
  .xh-input-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 10px 8px;
  }

  .xh-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--xh-muted);
    border-radius: 6px;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
    padding: 0;
  }
  .xh-action-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--xh-text);
  }
  .xh-action-btn svg {
    width: 16px;
    height: 16px;
  }

  /* ── Drag overlay ── */
  .xh-drag-overlay {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(108, 92, 231, 0.06);
    border: 2px dashed rgba(108, 92, 231, 0.45);
    border-radius: 18px;
    pointer-events: none;
    animation: xh-drag-pulse 1.5s ease infinite;
  }
  @keyframes xh-drag-pulse {
    0%, 100% { border-color: rgba(108, 92, 231, 0.45); }
    50%      { border-color: rgba(108, 92, 231, 0.7); }
  }
  .xh-drag-overlay[hidden] { display: none; }

  .xh-drag-label {
    padding: 6px 18px;
    border-radius: 10px;
    background: var(--xh-accent-soft);
    color: #a78bfa;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.3px;
  }

  /* ── Slash command palette ── */
  .xh-cmd-palette {
    width: 100%;
    background: var(--xh-surface, #202020);
    border: 1px solid var(--xh-border-strong);
    border-radius: 12px;
    padding: 4px;
    margin-bottom: 6px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);
    overflow-y: auto;
    animation: xh-palette-in 150ms ease;
  }
  @keyframes xh-palette-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .xh-cmd-palette[hidden] { display: none; }

  .xh-cmd-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 80ms ease;
  }
  .xh-cmd-item:hover,
  .xh-cmd-item.active {
    background: rgba(255, 255, 255, 0.07);
  }

  .xh-cmd-icon {
    font-size: 16px;
    width: 24px;
    text-align: center;
    flex-shrink: 0;
  }

  .xh-cmd-info {
    flex: 1;
    min-width: 0;
  }

  .xh-cmd-name {
    font-size: 13px;
    color: var(--xh-text);
    font-weight: 500;
  }

  .xh-cmd-desc {
    font-size: 11px;
    color: var(--xh-muted);
    margin-top: 1px;
  }

`;
