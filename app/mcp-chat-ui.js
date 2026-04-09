import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

const POLL_INTERVAL_MS = 1500;
const INPUT_MIN_HEIGHT_PX = 60;
const INPUT_MAX_HEIGHT_PX = 180;

const style = document.createElement("style");
style.textContent = `
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
    width: 100%;
    border-radius: 18px;
    border: 1px solid var(--xh-border);
    background: var(--xh-chat-bg);
    box-shadow: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }

  .xh-input-shell:focus-within {
    border-color: var(--xh-border-strong);
    box-shadow: 0 0 0 1px var(--xh-ring);
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
    padding: 16px 18px;
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
`;
document.head.appendChild(style);

const root = document.getElementById("app");

if (!root) {
  throw new Error("Missing #app mount element.");
}

if (!root.querySelector("#composerForm")) {
  root.innerHTML = `
    <div class="xh-root">
      <div class="xh-preview" id="sentPreview" hidden></div>
      <form class="xh-form" id="composerForm">
        <div class="xh-input-shell">
          <textarea
            class="xh-input"
            id="messageInput"
            rows="1"
            placeholder="继续给 Agent 发消息..."
          ></textarea>
        </div>
      </form>
      <div class="xh-error" id="errorBanner" hidden></div>
    </div>
  `;
}

const composerForm = document.getElementById("composerForm");
const messageInput = document.getElementById("messageInput");
const sentPreview = document.getElementById("sentPreview");
const errorBanner = document.getElementById("errorBanner");

const app = new App(
  {
    name: "xiaohaha-chat-ui",
    version: "1.0.2",
  },
  {},
  {
    autoResize: true,
  }
);

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

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function autoResizeInput(force = false) {
  if (isComposing && !force) {
    return;
  }

  messageInput.style.height = `${INPUT_MIN_HEIGHT_PX}px`;
  messageInput.style.height = `${Math.max(
    INPUT_MIN_HEIGHT_PX,
    Math.min(messageInput.scrollHeight, INPUT_MAX_HEIGHT_PX)
  )}px`;
}

function syncHostContext(hostContext) {
  if (hostContext?.theme) {
    applyDocumentTheme(hostContext.theme);
  }
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }
  if (hostContext?.toolInfo?.id !== undefined && hostContext?.toolInfo?.id !== null) {
    uiState.instanceId = String(hostContext.toolInfo.id);
  }
}

function render() {
  const showPreview = Boolean(uiState.submittedMessage);
  const showComposer = !showPreview;

  composerForm.hidden = !showComposer;
  sentPreview.hidden = !showPreview;
  errorBanner.hidden = !uiState.error;
  errorBanner.textContent = uiState.error;

  if (showPreview) {
    sentPreview.innerHTML = escapeHtml(uiState.submittedMessage);
  } else {
    sentPreview.innerHTML = "";
  }

  if (showComposer) {
    messageInput.disabled = uiState.sending;
  }
}

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
  if (!Array.isArray(events)) {
    return "";
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.role === "ai" && typeof event?.text === "string" && event.text.trim()) {
      return event.text.trim();
    }
  }

  return "";
}

function extractState(result) {
  if (result?.structuredContent?.state) {
    return normalizeState(result.structuredContent.state);
  }

  const textBlock = result?.content?.find((item) => item.type === "text");
  if (!textBlock?.text) {
    return null;
  }

  try {
    const parsed = JSON.parse(textBlock.text);
    return normalizeState(parsed.state);
  } catch {
    return null;
  }
}

function extractErrorMessage(result) {
  if (!result?.isError) {
    return "";
  }

  if (typeof result?.structuredContent?.error === "string" && result.structuredContent.error.trim()) {
    return result.structuredContent.error.trim();
  }

  const textBlock = result?.content?.find((item) => item.type === "text" && typeof item.text === "string");
  return textBlock?.text?.trim() || "发送失败";
}

function extractConversationIdFromArgs(args) {
  if (!args || typeof args !== "object") {
    return "";
  }

  if (typeof args.conversation_id === "string") {
    return args.conversation_id;
  }

  return "";
}

function extractPromptStateFromToolResult(result) {
  const textBlocks = Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === "text" && typeof item.text === "string")
    : [];
  const combinedText = textBlocks.map((item) => item.text).join("\n");

  if (!combinedText) {
    return {
      conversationId: "",
      previewMessage: "",
    };
  }

  const conversationMatch = combinedText.match(/当前会话 conversation_id:\s*(.+)/);
  const previewMatch = combinedText.match(/用户发来新消息:\s*([\s\S]*?)\n\n请根据上述消息继续工作/);

  return {
    conversationId: conversationMatch?.[1]?.trim() || "",
    previewMessage: previewMatch?.[1]?.trim() || "",
  };
}

async function refreshState() {
  const result = await app.callServerTool({
    name: "xiaohaha_get_chat_state",
    arguments: {
      instance_id: uiState.instanceId || undefined,
      conversation_id: uiState.conversationId || undefined,
    },
  });
  const nextState = extractState(result);
  if (!nextState) {
    throw new Error("Failed to parse chat state from MCP response.");
  }

  const previewMessage = nextState.previewMessage.trim();
  const latestAiMessage = getLatestAiMessage(nextState.events);

  uiState.connected = true;
  uiState.conversationId = nextState.conversationId || uiState.conversationId;
  uiState.anyWaiting = nextState.anyWaiting;
  uiState.waiting = nextState.waiting;
  uiState.error = "";
  uiState.latestAiMessage = latestAiMessage;

  if (previewMessage) {
    uiState.submittedMessage = previewMessage;
    uiState.completedTool = true;
  } else if (!uiState.completedTool || uiState.activeTool) {
    uiState.submittedMessage = "";
    uiState.submittedAt = "";
  }

  render();
}

async function sendMessage() {
  const message = messageInput.value.trim();
  const canSend = !uiState.sending;
  if (!message || uiState.sending || !canSend) {
    return;
  }

  uiState.sending = true;
  uiState.error = "";
  uiState.anyWaiting = false;
  uiState.waiting = false;
  uiState.activeTool = false;
  uiState.completedTool = true;
  uiState.submittedMessage = message;
  uiState.submittedAt = new Date().toLocaleTimeString();
  uiState.latestAiMessage = "";
  render();

  try {
    const result = await app.callServerTool({
      name: "xiaohaha_send_app_message",
      arguments: {
        message,
        instance_id: uiState.instanceId || undefined,
        conversation_id: uiState.conversationId || undefined,
      },
    });
    const errorMessage = extractErrorMessage(result);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    const nextState = extractState(result);
    if (nextState) {
      uiState.conversationId = nextState.conversationId || uiState.conversationId;
      uiState.anyWaiting = nextState.anyWaiting;
      const previewMessage = nextState.previewMessage.trim();
      uiState.latestAiMessage = getLatestAiMessage(nextState.events);
      uiState.waiting = nextState.waiting;
      if (previewMessage) {
        uiState.submittedMessage = previewMessage;
        uiState.completedTool = true;
      }
    }
    messageInput.value = "";
    autoResizeInput();
  } catch (error) {
    uiState.anyWaiting = true;
    uiState.waiting = true;
    uiState.activeTool = true;
    uiState.completedTool = false;
    uiState.submittedMessage = "";
    uiState.submittedAt = "";
    uiState.error = error instanceof Error ? error.message : "发送失败";
    messageInput.value = message;
    autoResizeInput();
  } finally {
    uiState.sending = false;
    render();
    if (uiState.waiting) {
      messageInput.focus();
    }
  }
}

composerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

messageInput.addEventListener("keydown", (event) => {
  if (event.isComposing || isComposing || event.keyCode === 229) {
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});

messageInput.addEventListener("compositionstart", () => {
  isComposing = true;
});

messageInput.addEventListener("compositionend", () => {
  isComposing = false;
  autoResizeInput(true);
});

messageInput.addEventListener("input", () => {
  autoResizeInput();
});

app.onteardown = async () => {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  return {};
};

app.ontoolinput = (params) => {
  uiState.anyWaiting = true;
  uiState.activeTool = true;
  uiState.waiting = true;
  uiState.completedTool = false;
  uiState.submittedMessage = "";
  uiState.submittedAt = "";
  uiState.conversationId =
    extractConversationIdFromArgs(params?.arguments) || uiState.conversationId;
  void refreshState().catch((error) => {
    uiState.error = error instanceof Error ? error.message : "刷新失败";
    render();
  });
};

app.ontoolresult = (result) => {
  const nextState = extractPromptStateFromToolResult(result);
  uiState.conversationId = nextState.conversationId || uiState.conversationId;
  if (nextState.previewMessage) {
    uiState.anyWaiting = false;
    uiState.waiting = false;
    uiState.activeTool = false;
    uiState.completedTool = true;
    uiState.submittedMessage = nextState.previewMessage;
    uiState.submittedAt = "";
  }
  void refreshState().catch(() => {
    render();
  });
};

app.ontoolcancelled = () => {
  uiState.anyWaiting = false;
  uiState.waiting = false;
  uiState.activeTool = false;
  render();
};

app.onhostcontextchanged = (hostContext) => {
  syncHostContext(hostContext);
};

async function start() {
  render();
  autoResizeInput(true);
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  syncHostContext(app.getHostContext());
  uiState.connected = true;
  render();
  await refreshState();
  pollTimer = window.setInterval(() => {
    void refreshState().catch((error) => {
      uiState.connected = false;
      uiState.error = error instanceof Error ? error.message : "刷新失败";
      render();
    });
  }, POLL_INTERVAL_MS);
  if (uiState.waiting) {
    messageInput.focus();
  }
}

start().catch((error) => {
  uiState.connected = false;
  uiState.error = error instanceof Error ? error.message : "MCP App 初始化失败";
  render();
});
