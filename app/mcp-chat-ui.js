import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

import { STYLES } from "./lib/styles.js";
import { POLL_INTERVAL_MS, INPUT_MIN_HEIGHT_PX, INPUT_MAX_HEIGHT_PX, SLASH_COMMANDS } from "./lib/constants.js";
import { escapeHtml } from "./lib/utils.js";
import { AttachmentManager } from "./lib/attachment-manager.js";
import { CommandPalette } from "./lib/command-palette.js";

/* ── Inject styles ── */
const styleEl = document.createElement("style");
styleEl.textContent = STYLES;
document.head.appendChild(styleEl);

const BROWSER_CHAT_BASE_URL = typeof window.__XIAOHAHA_BROWSER_CHAT_URL === "string"
  ? window.__XIAOHAHA_BROWSER_CHAT_URL
  : "";
const LOCAL_HTTP_TIMEOUT_MS = 4000;
const LOCAL_SEND_TIMEOUT_MS = 8000;

/* ═══════════════════════════════════════════════════
   DOM Setup
   ═══════════════════════════════════════════════════ */

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app mount element.");

const needsFullDom = !root.querySelector("#inputShell") || !root.querySelector("#cmdPalette") || root.querySelector("#cmdPalette")?.closest("#inputShell");
if (needsFullDom) {
  root.innerHTML = `
    <div class="xh-root">
      <div class="xh-preview" id="sentPreview" hidden></div>
      <div class="xh-cmd-palette" id="cmdPalette" hidden></div>
      <form class="xh-form" id="composerForm">
        <div class="xh-input-shell" id="inputShell">
          <div class="xh-attachments" id="attachmentBar" hidden></div>
          <div class="xh-fake-caret" id="fakeCaret" hidden></div>
          <textarea
            class="xh-input"
            id="messageInput"
            rows="1"
            placeholder="继续给 Agent 发消息... (/ 调出命令)"
          ></textarea>
          <div class="xh-input-actions">
            <button class="xh-action-btn" id="openBrowserBtn" type="button" title="在浏览器继续输入">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>
            </button>
            <button class="xh-action-btn" id="attachFileBtn" type="button" title="添加文件">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <button class="xh-action-btn" id="attachImageBtn" type="button" title="添加图片">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </button>
          </div>
          <div class="xh-drag-overlay" id="dragOverlay" hidden>
            <div class="xh-drag-label">释放以添加文件</div>
          </div>
        </div>
      </form>
      <input type="file" id="fileInput" multiple hidden>
      <input type="file" id="imageInput" accept="image/*" multiple hidden>
      <div class="xh-error" id="errorBanner" hidden></div>
    </div>
  `;
}

const composerForm = document.getElementById("composerForm");
const messageInput = document.getElementById("messageInput");
const sentPreview = document.getElementById("sentPreview");
const errorBanner = document.getElementById("errorBanner");
const inputShell = document.getElementById("inputShell");
const attachmentBar = document.getElementById("attachmentBar");
const fakeCaret = document.getElementById("fakeCaret");
const openBrowserBtn = document.getElementById("openBrowserBtn");
const attachFileBtn = document.getElementById("attachFileBtn");
const attachImageBtn = document.getElementById("attachImageBtn");
const fileInput = document.getElementById("fileInput");
const imageInput = document.getElementById("imageInput");
const dragOverlay = document.getElementById("dragOverlay");

/* ═══════════════════════════════════════════════════
   MCP App + State
   ═══════════════════════════════════════════════════ */

const app = new App({ name: "xiaohaha-chat-ui", version: "1.0.3" }, {}, { autoResize: true });

const uiState = {
  connected: false,
  instanceId: "",
  conversationId: "",
  anyWaiting: false,
  waiting: false,
  activeTool: false,
  completedTool: false,
  error: "",
  sending: false,
  submittedMessage: "",
  submittedAt: "",
  latestAiMessage: "",
};

let pollTimer = null;
let isComposing = false;
let dragCounter = 0;

/* ── Managers ── */

const attachments = new AttachmentManager(attachmentBar);
attachments.onError = (msg) => {
  uiState.error = msg;
  render();
};

const cmdPalette = new CommandPalette(document.getElementById("cmdPalette"));
cmdPalette.onExecute = executeCommand;

/* ═══════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════ */

function autoResizeInput(force = false) {
  if (isComposing && !force) return;
  messageInput.style.height = `${INPUT_MIN_HEIGHT_PX}px`;
  messageInput.style.height = `${Math.max(
    INPUT_MIN_HEIGHT_PX,
    Math.min(messageInput.scrollHeight, INPUT_MAX_HEIGHT_PX)
  )}px`;
}

function updateFakeCaret() {
  const showComposer = uiState.sending || uiState.waiting || uiState.activeTool;
  const hasRealFocus = document.activeElement === messageInput;
  const showFakeCaret = showComposer
    && uiState.connected
    && !uiState.sending
    && !hasRealFocus
    && !messageInput.value
    && attachmentBar.hidden;

  fakeCaret.hidden = !showFakeCaret;
  inputShell.classList.toggle("xh-pseudo-focus", showFakeCaret);
}

function buildLocalUrl(pathname, params) {
  if (!BROWSER_CHAT_BASE_URL) {
    return null;
  }

  const url = new URL(pathname, BROWSER_CHAT_BASE_URL);
  if (params && typeof params === "object") {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

async function callLocalJson(pathname, { method = "GET", params, body, timeoutMs = LOCAL_HTTP_TIMEOUT_MS } = {}) {
  const url = buildLocalUrl(pathname, params);
  if (!url) {
    throw new Error("浏览器聊天地址不可用");
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok || payload?.ok === false) {
      const errorMessage = typeof payload?.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : `HTTP ${response.status}`;
      throw new Error(errorMessage);
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("本地服务请求超时");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function openBrowserChat() {
  if (!BROWSER_CHAT_BASE_URL) {
    uiState.error = "浏览器聊天地址不可用";
    render();
    return;
  }

  const url = new URL(BROWSER_CHAT_BASE_URL);
  if (uiState.conversationId) {
    url.searchParams.set("conversationId", uiState.conversationId);
  }

  try {
    const result = await app.openLink({ url: url.toString() });
    if (result?.isError) throw new Error("宿主拒绝打开链接");
    uiState.error = "";
    render();
  } catch {
    uiState.error = `打开浏览器失败，请手动访问: ${url.toString()}`;
    render();
  }
}

function syncHostContext(hostContext) {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) applyHostStyleVariables(hostContext.styles.variables);
  if (hostContext?.styles?.css?.fonts) applyHostFonts(hostContext.styles.css.fonts);
  if (hostContext?.toolInfo?.id !== undefined && hostContext?.toolInfo?.id !== null) {
    uiState.instanceId = String(hostContext.toolInfo.id);
  }
}

/* ── State extraction (from MCP results) ── */

function normalizeState(state) {
  return {
    conversationId: typeof state?.conversationId === "string" ? state.conversationId : "",
    anyWaiting: Boolean(state?.anyWaiting),
    waiting: Boolean(state?.waiting),
    previewMessage: typeof state?.previewMessage === "string" ? state.previewMessage : "",
    events: Array.isArray(state?.events) ? state.events : [],
  };
}

function getLatestAiMessage(events) {
  if (!Array.isArray(events)) return "";
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.role === "ai" && typeof ev?.text === "string" && ev.text.trim()) return ev.text.trim();
  }
  return "";
}

function extractState(result) {
  if (result?.structuredContent?.state) return normalizeState(result.structuredContent.state);
  const textBlock = result?.content?.find((item) => item.type === "text");
  if (!textBlock?.text) return null;
  try {
    return normalizeState(JSON.parse(textBlock.text).state);
  } catch {
    return null;
  }
}

function extractErrorMessage(result) {
  if (!result?.isError) return "";
  if (typeof result?.structuredContent?.error === "string" && result.structuredContent.error.trim()) {
    return result.structuredContent.error.trim();
  }
  const textBlock = result?.content?.find((item) => item.type === "text" && typeof item.text === "string");
  return textBlock?.text?.trim() || "发送失败";
}

function extractConversationIdFromArgs(args) {
  if (!args || typeof args !== "object") return "";
  return typeof args.conversation_id === "string" ? args.conversation_id : "";
}

function extractPromptStateFromToolResult(result) {
  const textBlocks = Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === "text" && typeof item.text === "string")
    : [];
  const combinedText = textBlocks.map((item) => item.text).join("\n");
  if (!combinedText) return { conversationId: "", previewMessage: "" };
  const conversationMatch = combinedText.match(/当前会话 conversation_id:\s*(.+)/);
  const previewMatch = combinedText.match(/用户发来新消息:\s*([\s\S]*?)\n\n请根据上述消息继续工作/);
  return {
    conversationId: conversationMatch?.[1]?.trim() || "",
    previewMessage: previewMatch?.[1]?.trim() || "",
  };
}

async function refreshStateFromLocalHttp() {
  const payload = await callLocalJson("/app/state", {
    params: {
      instanceId: uiState.instanceId || undefined,
      conversationId: uiState.conversationId || undefined,
    },
  });
  return normalizeState(payload?.state);
}

async function refreshStateFromServerTool() {
  const result = await app.callServerTool({
    name: "xiaohaha_get_chat_state",
    arguments: {
      instance_id: uiState.instanceId || undefined,
      conversation_id: uiState.conversationId || undefined,
    },
  }, {
    timeout: LOCAL_HTTP_TIMEOUT_MS,
  });
  return extractState(result);
}

async function sendAppMessageViaLocalHttp(message) {
  const payload = await callLocalJson("/send", {
    method: "POST",
    timeoutMs: LOCAL_SEND_TIMEOUT_MS,
    body: {
      message,
      instanceId: uiState.instanceId || undefined,
      conversationId: uiState.conversationId || undefined,
    },
  });
  return normalizeState(payload?.state);
}

async function sendAppMessageViaServerTool(message) {
  const result = await app.callServerTool({
    name: "xiaohaha_send_app_message",
    arguments: {
      message,
      instance_id: uiState.instanceId || undefined,
      conversation_id: uiState.conversationId || undefined,
    },
  }, {
    timeout: LOCAL_SEND_TIMEOUT_MS,
  });
  const errorMessage = extractErrorMessage(result);
  if (errorMessage) throw new Error(errorMessage);
  return extractState(result);
}

async function saveContextViaLocalHttp(summary) {
  return callLocalJson("/app/context", {
    method: "POST",
    body: {
      summary,
      conversationId: uiState.conversationId || undefined,
    },
  });
}

async function saveContextViaServerTool(summary) {
  return app.callServerTool({
    name: "xiaohaha_set_context",
    arguments: {
      summary,
      conversation_id: uiState.conversationId || undefined,
    },
  }, {
    timeout: LOCAL_HTTP_TIMEOUT_MS,
  });
}

/* ═══════════════════════════════════════════════════
   Render
   ═══════════════════════════════════════════════════ */

function render() {
  const showPreview = Boolean(uiState.submittedMessage);
  const showComposer = uiState.sending || uiState.waiting || uiState.activeTool;
  composerForm.hidden = !showComposer;
  sentPreview.hidden = !showPreview;
  errorBanner.hidden = !uiState.error;
  errorBanner.textContent = uiState.error;
  messageInput.disabled = uiState.sending;

  if (showPreview) {
    sentPreview.innerHTML = escapeHtml(uiState.submittedMessage);
  } else {
    sentPreview.innerHTML = "";
  }

  updateFakeCaret();
}

/* ═══════════════════════════════════════════════════
   Refresh State (poll)
   ═══════════════════════════════════════════════════ */

async function refreshState() {
  let nextState = null;
  try {
    nextState = await refreshStateFromLocalHttp();
  } catch {
    nextState = await refreshStateFromServerTool();
  }
  if (!nextState) throw new Error("Failed to parse chat state from MCP response.");

  const previewMessage = nextState.previewMessage.trim();
  uiState.connected = true;
  uiState.conversationId = nextState.conversationId || uiState.conversationId;
  uiState.anyWaiting = nextState.anyWaiting;
  uiState.waiting = nextState.waiting;
  uiState.error = "";
  uiState.latestAiMessage = getLatestAiMessage(nextState.events);

  if (previewMessage) {
    uiState.submittedMessage = previewMessage;
    uiState.completedTool = true;
  } else if (!uiState.completedTool || uiState.activeTool) {
    uiState.submittedMessage = "";
    uiState.submittedAt = "";
  }
  render();
}

/* ═══════════════════════════════════════════════════
   Command Execution
   ═══════════════════════════════════════════════════ */

const SYSTEM_COMMAND_MESSAGES = {
  summarize: "【系统指令 /summarize】请总结当前的工作进展：\n1. 已完成的内容\n2. 当前状态\n3. 下一步待办事项\n总结完后继续等待我的指令。",
  undo: "【系统指令 /undo】请撤销上一步操作，恢复到之前的状态。说明你撤销了什么，然后等待我的确认或后续指令。",
};

function executeCommand(cmdId) {
  const matchedCmd = SLASH_COMMANDS.find((c) => c.id === cmdId)
    || { id: cmdId, hostCommand: null };

  cmdPalette.hide();
  messageInput.value = "";
  autoResizeInput(true);

  if (matchedCmd.hostCommand) {
    void app.sendMessage({
      role: "user",
      content: [{ type: "text", text: matchedCmd.hostCommand }],
    }).catch((err) => {
      uiState.error = `命令发送失败: ${err instanceof Error ? err.message : "未知错误"}`;
      render();
    });
    return;
  }

  if (SYSTEM_COMMAND_MESSAGES[cmdId]) {
    messageInput.value = SYSTEM_COMMAND_MESSAGES[cmdId];
    autoResizeInput(true);
    messageInput.focus();
    return;
  }

  switch (cmdId) {
    case "file":
      fileInput.click();
      break;
    case "image":
      imageInput.click();
      break;
    case "clear":
      attachments.clear();
      uiState.error = "";
      render();
      break;
    case "context":
      messageInput.value = "";
      messageInput.placeholder = "输入你的上下文摘要，按 Enter 保存...";
      messageInput.dataset.contextMode = "1";
      autoResizeInput(true);
      messageInput.focus();
      break;
    case "clearctx":
      saveContextViaLocalHttp("").catch(() => saveContextViaServerTool(""))
      .then(() => {
        uiState.error = "";
        render();
      }).catch((err) => {
        uiState.error = `清除失败: ${err instanceof Error ? err.message : "未知错误"}`;
        render();
      });
      break;
    case "help": {
      messageInput.value = [
        "📎  拖拽文件到输入框添加附件",
        "🖼️  Ctrl/Cmd+V 粘贴图片",
        "📋  从编辑器复制代码可保留文件名和行号",
        "/   输入 / 调出命令菜单",
        "⏎  Enter 发送  ⇧⏎ 换行",
        "/compact  触发 Cursor 压缩上下文",
        "/context  手动写上下文摘要",
        "/clearctx 清除上下文摘要",
      ].join("\n");
      autoResizeInput(true);
      messageInput.focus();
      break;
    }
  }
}

/* ═══════════════════════════════════════════════════
   Send Message
   ═══════════════════════════════════════════════════ */

async function sendMessage() {
  const rawText = messageInput.value.trim();
  if (!rawText && attachments.length === 0) return;
  if (uiState.sending) return;

  if (messageInput.dataset.contextMode === "1") {
    delete messageInput.dataset.contextMode;
    messageInput.placeholder = "继续给 Agent 发消息... (/ 调出命令)";
    if (!rawText) return;

    try {
      const payload = await saveContextViaLocalHttp(rawText).catch(() => saveContextViaServerTool(rawText));
      if (payload?.conversationId) {
        uiState.conversationId = payload.conversationId;
      }
      messageInput.value = "";
      autoResizeInput();
      uiState.error = "";
      uiState.submittedMessage = `✅ 上下文摘要已保存 (${rawText.length} 字)`;
      render();
      setTimeout(() => {
        if (uiState.submittedMessage.startsWith("✅")) {
          uiState.submittedMessage = "";
          render();
          messageInput.focus();
        }
      }, 2000);
    } catch (err) {
      uiState.error = `保存失败: ${err instanceof Error ? err.message : "未知错误"}`;
      render();
    }
    return;
  }

  const fullMessage = attachments.buildFullMessage(rawText);
  const previewText = attachments.buildPreviewText(rawText);

  uiState.sending = true;
  uiState.error = "";
  uiState.anyWaiting = false;
  uiState.waiting = false;
  uiState.activeTool = false;
  uiState.completedTool = true;
  uiState.submittedMessage = previewText;
  uiState.submittedAt = new Date().toLocaleTimeString();
  uiState.latestAiMessage = "";
  render();

  try {
    const nextState = await sendAppMessageViaLocalHttp(fullMessage).catch(() => sendAppMessageViaServerTool(fullMessage));
    if (nextState) {
      uiState.conversationId = nextState.conversationId || uiState.conversationId;
      uiState.anyWaiting = nextState.anyWaiting;
      uiState.waiting = nextState.waiting;
      uiState.latestAiMessage = getLatestAiMessage(nextState.events);
      const pm = nextState.previewMessage.trim();
      if (pm) {
        uiState.submittedMessage = pm;
        uiState.completedTool = true;
      }
    }

    messageInput.value = "";
    attachments.clear();
    autoResizeInput();
  } catch (error) {
    uiState.anyWaiting = true;
    uiState.waiting = true;
    uiState.activeTool = true;
    uiState.completedTool = false;
    uiState.submittedMessage = "";
    uiState.submittedAt = "";
    uiState.error = error instanceof Error ? error.message : "发送失败";
    messageInput.value = rawText;
    autoResizeInput();
  } finally {
    uiState.sending = false;
    render();
    if (uiState.waiting) messageInput.focus();
  }
}

/* ═══════════════════════════════════════════════════
   Event Listeners
   ═══════════════════════════════════════════════════ */

composerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (cmdPalette.visible) {
    const id = cmdPalette.getSelectedCommandId();
    if (id) executeCommand(id);
    return;
  }
  void sendMessage();
});

messageInput.addEventListener("keydown", (e) => {
  if (e.isComposing || isComposing || e.keyCode === 229) return;

  if (cmdPalette.visible) {
    if (e.key === "ArrowDown") { e.preventDefault(); cmdPalette.moveSelection(1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); cmdPalette.moveSelection(-1); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const id = cmdPalette.getSelectedCommandId();
      if (id) executeCommand(id);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); cmdPalette.hide(); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const label = cmdPalette.getSelectedLabel();
      if (label) { messageInput.value = label + " "; autoResizeInput(true); }
      return;
    }
  }

  if (e.key === "Escape" && messageInput.dataset.contextMode === "1") {
    e.preventDefault();
    delete messageInput.dataset.contextMode;
    messageInput.placeholder = "继续给 Agent 发消息... (/ 调出命令)";
    messageInput.value = "";
    autoResizeInput(true);
    return;
  }

  if (e.key === "Escape" && attachments.length > 0) {
    e.preventDefault();
    attachments.clear();
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

messageInput.addEventListener("compositionstart", () => { isComposing = true; });
messageInput.addEventListener("compositionend", () => { isComposing = false; autoResizeInput(true); });
messageInput.addEventListener("input", () => {
  autoResizeInput();
  cmdPalette.handleInputChange(messageInput.value);
  updateFakeCaret();
});
messageInput.addEventListener("focus", () => { updateFakeCaret(); });
messageInput.addEventListener("blur", () => { updateFakeCaret(); });

messageInput.addEventListener("paste", async (e) => {
  const cd = e.clipboardData;
  if (!cd) return;

  const items = cd.items ? [...cd.items] : [];

  const imageItems = items.filter((item) => item.type.startsWith("image/"));
  if (imageItems.length > 0) {
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter(Boolean);
    await attachments.processFiles(files);
    updateFakeCaret();
    return;
  }

  const rawText = cd.getData("text/plain");

  const metaJson = cd.getData("application/vnd.code.copymetadata");
  if (metaJson && rawText) {
    e.preventDefault();
    attachments.processCodeMeta(metaJson, rawText);
    return;
  }

  const metaItem = items.find(
    (item) => item.type === "application/vnd.code.copymetadata"
  );
  if (metaItem && rawText) {
    e.preventDefault();
    metaItem.getAsString((json) => attachments.processCodeMeta(json, rawText));
    return;
  }

  const vsData = cd.getData("vscode-editor-data");
  if (vsData && rawText && (rawText.includes("\n") || rawText.length > 80)) {
    e.preventDefault();
    let lang = "text";
    try { lang = JSON.parse(vsData)?.mode || "text"; } catch {}

    const attId = attachments.add({
      type: "snippet",
      name: `snippet.${lang}`,
      content: rawText,
      mimeType: "text/plain",
      size: new TextEncoder().encode(rawText).length,
      filePath: "",
      lineRef: "",
    });

    if (attId > 0) {
      attachments.updateById(attId, { name: `snippet.${lang} ⏳` });
      app.callServerTool({
        name: "xiaohaha_locate_code",
        arguments: { code_text: rawText },
      }).then((result) => {
        const loc = result?.structuredContent;
        if (loc?.found) {
          const fileName = loc.filePath.split("/").pop() || loc.filePath;
          const lineLabel = loc.startLine === loc.endLine
            ? `(${loc.startLine})`
            : `(${loc.startLine}-${loc.endLine})`;
          attachments.updateById(attId, {
            name: `${fileName} ${lineLabel}`,
            filePath: loc.filePath,
            lineRef: `:${loc.startLine}-${loc.endLine}`,
          });
        } else {
          attachments.updateById(attId, { name: `snippet.${lang}` });
        }
      }).catch(() => {
        attachments.updateById(attId, { name: `snippet.${lang}` });
      });
    }
    return;
  }

  if (cd.files && cd.files.length > 0) {
    const nonText = [...cd.files].filter((f) => !f.type.startsWith("text/"));
    if (nonText.length > 0) {
      e.preventDefault();
      await attachments.processFiles(cd.files);
    }
  }
});

/* ── Drag & Drop ── */
inputShell.addEventListener("dragenter", (e) => {
  e.preventDefault(); e.stopPropagation();
  if (++dragCounter === 1) { dragOverlay.hidden = false; inputShell.classList.add("xh-drag-active"); }
});
inputShell.addEventListener("dragover", (e) => {
  e.preventDefault(); e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
inputShell.addEventListener("dragleave", (e) => {
  e.preventDefault(); e.stopPropagation();
  if (--dragCounter <= 0) { dragCounter = 0; dragOverlay.hidden = true; inputShell.classList.remove("xh-drag-active"); }
});
inputShell.addEventListener("drop", async (e) => {
  e.preventDefault(); e.stopPropagation();
  dragCounter = 0; dragOverlay.hidden = true; inputShell.classList.remove("xh-drag-active");

    if (e.dataTransfer?.files?.length > 0) {
      await attachments.processFiles(e.dataTransfer.files);
      messageInput.focus();
      updateFakeCaret();
      return;
    }

  const uriData = e.dataTransfer?.getData("text/uri-list")
    || e.dataTransfer?.getData("application/vnd.code.uri-list")
    || e.dataTransfer?.getData("text/plain")
    || "";

  if (uriData.trim()) {
    const paths = uriData.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        if (line.startsWith("file://")) {
          try { return decodeURIComponent(new URL(line).pathname); } catch { return line; }
        }
        return line;
      });

    if (paths.length > 0) {
      const refs = paths.map((p) => `@${p}`).join("\n");
      const cur = messageInput.value;
      messageInput.value = cur ? cur + (cur.endsWith("\n") ? "" : "\n") + refs : refs;
      autoResizeInput(true);
      messageInput.focus();
    }
  }
});

/* ── Action buttons & file inputs ── */
openBrowserBtn.addEventListener("click", () => {
  void openBrowserChat();
});
attachFileBtn.addEventListener("click", () => fileInput.click());
attachImageBtn.addEventListener("click", () => imageInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    const files = [...fileInput.files];
    fileInput.value = "";
    void attachments.processFiles(files).finally(() => updateFakeCaret());
  }
});
imageInput.addEventListener("change", () => {
  if (imageInput.files.length > 0) {
    const files = [...imageInput.files];
    imageInput.value = "";
    void attachments.processFiles(files).finally(() => updateFakeCaret());
  }
});

document.addEventListener("click", (e) => {
  if (cmdPalette.visible && !cmdPalette.el.contains(e.target) && e.target !== messageInput) {
    cmdPalette.hide();
  }
});

/* ═══════════════════════════════════════════════════
   App Lifecycle
   ═══════════════════════════════════════════════════ */

app.onteardown = async () => { if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; } return {}; };

app.ontoolinput = (params) => {
  uiState.anyWaiting = true; uiState.activeTool = true; uiState.waiting = true;
  uiState.completedTool = false; uiState.submittedMessage = ""; uiState.submittedAt = "";
  uiState.conversationId = extractConversationIdFromArgs(params?.arguments) || uiState.conversationId;
  void refreshState().catch((err) => { uiState.error = err instanceof Error ? err.message : "刷新失败"; render(); });
};

app.ontoolresult = (result) => {
  const nextState = extractPromptStateFromToolResult(result);
  uiState.conversationId = nextState.conversationId || uiState.conversationId;
  if (nextState.previewMessage) {
    uiState.anyWaiting = false; uiState.waiting = false; uiState.activeTool = false;
    uiState.completedTool = true; uiState.submittedMessage = nextState.previewMessage; uiState.submittedAt = "";
  }
  void refreshState().catch(() => render());
};

app.ontoolcancelled = () => { uiState.anyWaiting = false; uiState.waiting = false; uiState.activeTool = false; render(); };
app.onhostcontextchanged = (hostContext) => syncHostContext(hostContext);

/* ═══════════════════════════════════════════════════
   Start
   ═══════════════════════════════════════════════════ */

async function start() {
  render();
  autoResizeInput(true);
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  syncHostContext(app.getHostContext());
  uiState.connected = true;
  render();
  await refreshState();
  pollTimer = window.setInterval(() => {
    void refreshState().catch((err) => {
      uiState.connected = false; uiState.error = err instanceof Error ? err.message : "刷新失败"; render();
    });
  }, POLL_INTERVAL_MS);
}

start().catch((err) => {
  uiState.connected = false;
  uiState.error = err instanceof Error ? err.message : "MCP App 初始化失败";
  render();
});
