import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

import { STYLES } from "./lib/styles.js";
import { POLL_INTERVAL_MS, INPUT_MIN_HEIGHT_PX, INPUT_MAX_HEIGHT_PX, SLASH_COMMANDS } from "./lib/constants.js";
import { escapeHtml, readAsDataUrl } from "./lib/utils.js";
import { AttachmentManager } from "./lib/attachment-manager.js";
import { CommandPalette } from "./lib/command-palette.js";
import { FileMentionPalette } from "./lib/file-mention-palette.js";
import {
  ProjectMentionManager,
  getEditorSelectionOffsets,
  insertEditorText,
  serializeEditorText,
  setEditorSelectionRange,
  setEditorText,
} from "./lib/project-mention-manager.js";

/* ── Inject styles ── */
const styleEl = document.createElement("style");
styleEl.textContent = STYLES;
document.head.appendChild(styleEl);

const BROWSER_CHAT_BASE_URL = typeof window.__XIAOHAHA_BROWSER_CHAT_URL === "string"
  ? window.__XIAOHAHA_BROWSER_CHAT_URL
  : "";
const LOCAL_HTTP_TIMEOUT_MS = 4000;
const LOCAL_SEND_TIMEOUT_MS = 8000;
const LOCAL_UPLOAD_TIMEOUT_MS = 20000;
const LOCAL_DIAGNOSTIC_TIMEOUT_MS = 1500;
const FILE_MENTION_SEARCH_DEBOUNCE_MS = 60;
const BOOTSTRAP_REFRESH_INTERVAL_MS = 160;
const BOOTSTRAP_REFRESH_MAX_ATTEMPTS = 12;
const USE_MANUAL_SIZE_SYNC = false;
const USE_COLLAPSE_SIZE_SYNC = true;
const CURRENT_APP_RESOURCE_URI = (() => {
  if (typeof window.__XIAOHAHA_APP_RESOURCE_URI === "string" && window.__XIAOHAHA_APP_RESOURCE_URI.trim()) {
    return window.__XIAOHAHA_APP_RESOURCE_URI.trim();
  }
  try {
    return String(window.location.href || "").split("#")[0] || "";
  } catch {
    return "";
  }
})();

/* ═══════════════════════════════════════════════════
   DOM Setup
   ═══════════════════════════════════════════════════ */

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app mount element.");

const needsFullDom = !root.querySelector("#inputShell")
  || !root.querySelector("#cmdPalette")
  || !root.querySelector("#fileMentionPalette")
  || !root.querySelector("#composerLayer")
  || !root.querySelector("#imageLightbox")
  || root.querySelector("#messageInput")?.tagName !== "DIV"
  || !root.querySelector("#cmdPalette")?.closest("#inputShell")
  || !root.querySelector("#fileMentionPalette")?.closest("#inputShell");
if (needsFullDom) {
  root.innerHTML = `
    <div class="xh-root">
      <div class="xh-preview" id="sentPreview" hidden></div>
      <div class="xh-composer-layer" id="composerLayer" hidden>
        <form class="xh-form" id="composerForm" hidden>
          <div class="xh-input-shell" id="inputShell">
            <div class="xh-cmd-palette xh-file-palette" id="fileMentionPalette" hidden></div>
            <div class="xh-cmd-palette" id="cmdPalette" hidden></div>
            <div class="xh-attachments" id="attachmentBar" hidden></div>
            <div class="xh-fake-caret" id="fakeCaret" hidden></div>
            <div
              class="xh-input"
              id="messageInput"
              contenteditable="true"
              role="textbox"
              aria-multiline="true"
              spellcheck="true"
              data-placeholder="继续给 Agent 发消息... (/ 调出命令)"
            ></div>
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
      </div>
      <input type="file" id="fileInput" multiple hidden>
      <input type="file" id="imageInput" accept="image/*" multiple hidden>
      <div class="xh-error" id="errorBanner" hidden></div>
      <div class="xh-lightbox" id="imageLightbox" hidden>
        <div class="xh-lightbox-panel">
          <button class="xh-lightbox-close" id="imageLightboxClose" type="button" aria-label="关闭预览">×</button>
          <div class="xh-lightbox-frame">
            <img class="xh-lightbox-img" id="imageLightboxImg" alt="">
          </div>
          <div class="xh-lightbox-caption" id="imageLightboxCaption"></div>
        </div>
      </div>
    </div>
  `;
}

const composerForm = document.getElementById("composerForm");
const composerLayer = document.getElementById("composerLayer");
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
const fileMentionPaletteEl = document.getElementById("fileMentionPalette");
const imageLightbox = document.getElementById("imageLightbox");
const imageLightboxFrame = document.getElementById("imageLightbox")?.querySelector(".xh-lightbox-frame");
const imageLightboxImg = document.getElementById("imageLightboxImg");
const imageLightboxCaption = document.getElementById("imageLightboxCaption");
const imageLightboxClose = document.getElementById("imageLightboxClose");

// 宿主在切换/复用 iframe 时，旧 DOM 可能会先保留下来。
// 这里在任何异步初始化之前，先把所有瞬态交互层收起，避免历史卡片在首帧闪出 composer。
composerLayer.hidden = true;
composerForm.hidden = true;
sentPreview.hidden = true;
errorBanner.hidden = true;
attachmentBar.hidden = true;
fakeCaret.hidden = true;
dragOverlay.hidden = true;
imageLightbox.hidden = true;
inputShell.classList.remove("xh-pseudo-focus");

/* ═══════════════════════════════════════════════════
   MCP App + State
   ═══════════════════════════════════════════════════ */

const app = new App({ name: "xiaohaha-chat-ui", version: "1.0.8" }, {}, { autoResize: true });

const uiState = {
  connected: false,
  hydrated: false,
  pendingView: false,
  instanceId: "",
  conversationId: "",
  workspaceRoot: "",
  workspaceFile: "",
  routeHint: "",
  anyWaiting: false,
  waiting: false,
  isCurrentView: false,
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
let isImageLightboxZoomed = false;
let activeImageLightboxAttachment = null;
let sizeSyncScheduled = false;
let lastSyncedSize = { width: 0, height: 0 };
let lastRenderedComposerVisible = false;
let teardownRequested = false;
let teardownCompleted = false;
let acceptedToolInputForInstance = false;
let historicalViewFrozen = false;
let bootstrapRefreshTimer = null;
let bootstrapRefreshAttempts = 0;
let lastRenderedPreviewText = "";

const HOST_WORKSPACE_ROOT_PATHS = [
  ["workspaceRoot"],
  ["workspace_root"],
  ["projectRoot"],
  ["project_root"],
  ["cwd"],
  ["workingDirectory"],
  ["working_directory"],
  ["workspace", "root"],
  ["workspace", "path"],
  ["workspace", "uri"],
  ["project", "root"],
  ["project", "path"],
  ["editor", "workspaceRoot"],
  ["editor", "workspace", "root"],
  ["activeWorkspace", "path"],
  ["activeWorkspace", "rootPath"],
];
const HOST_WORKSPACE_FILE_PATHS = [
  ["currentFile"],
  ["current_file"],
  ["activeFile"],
  ["active_file"],
  ["filePath"],
  ["file_path"],
  ["documentPath"],
  ["document_path"],
  ["editor", "document", "path"],
  ["editor", "document", "uri"],
  ["editor", "activeFile", "path"],
  ["editor", "activeFile", "uri"],
  ["activeDocument", "path"],
  ["activeDocument", "uri"],
  ["document", "path"],
  ["document", "uri"],
  ["selection", "filePath"],
  ["selection", "file_path"],
  ["resource", "path"],
  ["resource", "uri"],
];

function normalizeWorkspaceHint(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return "";
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized) && !normalized.startsWith("file://")) {
    return "";
  }

  const looksAbsolutePath = normalized.startsWith("/")
    || normalized.startsWith("\\\\")
    || /^[A-Za-z]:[\\/]/.test(normalized)
    || normalized.startsWith("file://");

  return looksAbsolutePath ? normalized : "";
}

function readNestedString(source, pathSegments = []) {
  let current = source;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return "";
    }
    current = current[segment];
  }
  return typeof current === "string" ? current.trim() : "";
}

function pickNestedString(source, candidatePaths = []) {
  for (const pathSegments of candidatePaths) {
    const value = readNestedString(source, pathSegments);
    if (value) {
      return value;
    }
  }
  return "";
}

function extractWorkspaceRootFromArgs(args) {
  if (!args || typeof args !== "object") {
    return "";
  }

  return normalizeWorkspaceHint(
    typeof args.workspace_root === "string"
      ? args.workspace_root
      : typeof args.workspaceRoot === "string"
        ? args.workspaceRoot
        : typeof args.project_root === "string"
          ? args.project_root
          : typeof args.projectRoot === "string"
            ? args.projectRoot
            : typeof args.cwd === "string"
              ? args.cwd
              : typeof args.working_directory === "string"
                ? args.working_directory
                : typeof args.workingDirectory === "string"
                  ? args.workingDirectory
                  : ""
  );
}

function extractWorkspaceFileFromArgs(args) {
  if (!args || typeof args !== "object") {
    return "";
  }

  return normalizeWorkspaceHint(
    typeof args.workspace_file === "string"
      ? args.workspace_file
      : typeof args.workspaceFile === "string"
        ? args.workspaceFile
        : typeof args.current_file === "string"
          ? args.current_file
          : typeof args.currentFile === "string"
            ? args.currentFile
            : typeof args.file_path === "string"
              ? args.file_path
              : typeof args.filePath === "string"
                ? args.filePath
                : typeof args.active_file === "string"
                  ? args.active_file
                  : typeof args.activeFile === "string"
                    ? args.activeFile
                    : ""
  );
}

function extractWorkspaceHintsFromHostContext(hostContext) {
  if (!hostContext || typeof hostContext !== "object") {
    return { workspaceRoot: "", workspaceFile: "" };
  }

  return {
    workspaceRoot: normalizeWorkspaceHint(pickNestedString(hostContext, HOST_WORKSPACE_ROOT_PATHS)),
    workspaceFile: normalizeWorkspaceHint(pickNestedString(hostContext, HOST_WORKSPACE_FILE_PATHS)),
  };
}

function applyWorkspaceHints({ workspaceRoot = "", workspaceFile = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeWorkspaceHint(workspaceRoot);
  const normalizedWorkspaceFile = normalizeWorkspaceHint(workspaceFile);
  let changed = false;

  if (normalizedWorkspaceRoot && normalizedWorkspaceRoot !== uiState.workspaceRoot) {
    uiState.workspaceRoot = normalizedWorkspaceRoot;
    changed = true;
  }

  if (normalizedWorkspaceFile && normalizedWorkspaceFile !== uiState.workspaceFile) {
    uiState.workspaceFile = normalizedWorkspaceFile;
    changed = true;
  }

  return changed;
}

function buildWorkspaceHttpParams() {
  return {
    workspaceRoot: uiState.workspaceRoot || undefined,
    workspaceFile: uiState.workspaceFile || undefined,
  };
}

function buildWorkspaceToolArgs() {
  return {
    workspace_root: uiState.workspaceRoot || undefined,
    workspace_file: uiState.workspaceFile || undefined,
  };
}

function installRichInputBridge(editorEl) {
  let disabled = false;
  let placeholder = editorEl.dataset.placeholder || "";

  Object.defineProperty(editorEl, "value", {
    configurable: true,
    get() {
      return serializeEditorText(editorEl);
    },
    set(nextValue) {
      setEditorText(editorEl, nextValue);
    },
  });

  Object.defineProperty(editorEl, "selectionStart", {
    configurable: true,
    get() {
      return getEditorSelectionOffsets(editorEl).start;
    },
  });

  Object.defineProperty(editorEl, "selectionEnd", {
    configurable: true,
    get() {
      return getEditorSelectionOffsets(editorEl).end;
    },
  });

  editorEl.setSelectionRange = (start, end = start) => {
    setEditorSelectionRange(editorEl, start, end);
  };

  Object.defineProperty(editorEl, "disabled", {
    configurable: true,
    get() {
      return disabled;
    },
    set(nextValue) {
      disabled = Boolean(nextValue);
      editorEl.contentEditable = disabled ? "false" : "true";
      editorEl.classList.toggle("xh-input-disabled", disabled);
      editorEl.setAttribute("aria-disabled", disabled ? "true" : "false");
    },
  });

  Object.defineProperty(editorEl, "placeholder", {
    configurable: true,
    get() {
      return placeholder;
    },
    set(nextValue) {
      placeholder = String(nextValue || "");
      editorEl.dataset.placeholder = placeholder;
    },
  });
}

installRichInputBridge(messageInput);

/* ── Managers ── */

const attachments = new AttachmentManager(attachmentBar);
attachments.onError = (msg) => {
  uiState.error = msg;
  render();
};
attachments.onPreview = openImageLightbox;

const mentions = new ProjectMentionManager(messageInput);
mentions.onOpen = (mention) => {
  void openProjectMention(mention);
};
mentions.onChange = () => {
  autoResizeInput(true);
  updateFakeCaret();
  scheduleSizeSync();
};
mentions.onRemove = (chip) => {
  if (chip?.kind === "snippet" && chip.attachmentId) {
    attachments.remove(chip.attachmentId);
  }
};

const cmdPalette = new CommandPalette(document.getElementById("cmdPalette"));
cmdPalette.setAnchorEl(inputShell);
cmdPalette.onExecute = executeCommand;

const fileMentionPalette = new FileMentionPalette(fileMentionPaletteEl);
fileMentionPalette.setAnchorEl(inputShell);
fileMentionPalette.onSelect = (item) => {
  void attachMentionedProjectFile(item);
};

let mentionSearchTimer = null;
let mentionSearchSeq = 0;
let activeMention = null;

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

function measureIntrinsicHeight(element) {
  if (!element) {
    return 0;
  }

  return Math.max(
    Number(element.scrollHeight) || 0,
    Number(element.offsetHeight) || 0,
    Math.ceil(element.getBoundingClientRect?.().height || 0)
  );
}

function measureAppSize() {
  const hostRoot = root.firstElementChild || root;
  const widthCandidates = [
    root.getBoundingClientRect().width,
    hostRoot?.getBoundingClientRect?.().width,
    root.scrollWidth,
    hostRoot?.scrollWidth,
    window.innerWidth,
  ].filter((value) => Number.isFinite(value) && value > 0);
  const width = Math.ceil(Math.max(...widthCandidates, 1));
  const hostHeight = measureIntrinsicHeight(hostRoot);
  const heightCandidates = [
    hostHeight,
    hostRoot === root ? 0 : measureIntrinsicHeight(root),
  ].filter((value) => Number.isFinite(value) && value > 0);

  // 只用应用根节点的固有内容高度，避免 iframe 已经被宿主拉高后，
  // body / viewport 的高度反向污染测量结果，导致历史卡片收起后仍保留大块空白。
  const height = Math.ceil(Math.max(...heightCandidates, 1));

  return {
    width,
    height,
  };
}

function sendMeasuredSizeChanged() {
  if (!uiState.connected || document.visibilityState === "hidden") {
    return;
  }

  const nextSize = measureAppSize();
  if (nextSize.width === lastSyncedSize.width && nextSize.height === lastSyncedSize.height) {
    return;
  }

  lastSyncedSize = nextSize;
  void app.sendSizeChanged(nextSize).catch(() => {});
}

function flushSizeSync() {
  if (!USE_MANUAL_SIZE_SYNC) {
    return;
  }

  sendMeasuredSizeChanged();
}

function scheduleSizeSync() {
  if (!USE_MANUAL_SIZE_SYNC) {
    return;
  }

  if (sizeSyncScheduled) {
    return;
  }

  sizeSyncScheduled = true;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      sizeSyncScheduled = false;
      flushSizeSync();
    });
  });
}

function scheduleCollapseSizeSyncBurst() {
  if (!USE_COLLAPSE_SIZE_SYNC) {
    return;
  }

  sendMeasuredSizeChanged();
  window.requestAnimationFrame(() => {
    sendMeasuredSizeChanged();
  });
  window.setTimeout(() => {
    sendMeasuredSizeChanged();
  }, 32);
}

function shouldShowComposer() {
  // 用户一旦在当前卡片发出消息，就让这张卡片只保留预览，不再继续展示输入框；
  // 下一轮新的 check_messages 卡片出现后，再由新卡片承接 composer，避免历史卡片闪动。
  return uiState.isCurrentView && (
    uiState.sending
    || (uiState.waiting && !uiState.submittedMessage)
  );
}

function shouldStopBootstrapRefresh() {
  return historicalViewFrozen
    || teardownCompleted
    || !uiState.connected
    || (uiState.hydrated && (
      uiState.isCurrentView
      || Boolean(uiState.submittedMessage)
    ));
}

function stopBootstrapRefresh() {
  if (bootstrapRefreshTimer) {
    window.clearInterval(bootstrapRefreshTimer);
    bootstrapRefreshTimer = null;
  }
  bootstrapRefreshAttempts = 0;
}

function runBootstrapRefresh(source) {
  if (shouldStopBootstrapRefresh()) {
    stopBootstrapRefresh();
    return;
  }

  bootstrapRefreshAttempts += 1;
  const instanceChanged = syncHostContext(app.getHostContext());
  if (instanceChanged) {
    acceptedToolInputForInstance = false;
  }

  void refreshState().catch(() => {});

  if (bootstrapRefreshAttempts >= BOOTSTRAP_REFRESH_MAX_ATTEMPTS) {
    reportDiagnosticsEvent("ui_bootstrap_refresh_exhausted", {
      source,
      instanceId: uiState.instanceId || "",
      conversationId: uiState.conversationId || "",
    });
    stopBootstrapRefresh();
  }
}

function ensureBootstrapRefresh(source) {
  if (shouldStopBootstrapRefresh()) {
    stopBootstrapRefresh();
    return;
  }

  if (!bootstrapRefreshTimer) {
    bootstrapRefreshAttempts = 0;
    bootstrapRefreshTimer = window.setInterval(() => {
      runBootstrapRefresh(source);
    }, BOOTSTRAP_REFRESH_INTERVAL_MS);
    reportDiagnosticsEvent("ui_bootstrap_refresh_started", {
      source,
      instanceId: uiState.instanceId || "",
      conversationId: uiState.conversationId || "",
    });
  }

  runBootstrapRefresh(source);
}

function shouldTeardownHistoricalView() {
  return uiState.connected
    && uiState.completedTool
    && uiState.anyWaiting
    && !uiState.isCurrentView
    && !uiState.sending
    && !teardownRequested
    && !teardownCompleted;
}

function shouldFreezeHistoricalView() {
  return uiState.connected
    && uiState.completedTool
    && Boolean(uiState.submittedMessage)
    && uiState.anyWaiting
    && !uiState.isCurrentView
    && !uiState.sending;
}

function isCheckMessagesToolContext(hostContext = app.getHostContext()) {
  return hostContext?.toolInfo?.tool?.name === "check_messages";
}

function enterPendingViewShell(source, options = {}) {
  const resetRouting = Boolean(options.resetRouting);
  uiState.hydrated = false;
  uiState.pendingView = true;
  uiState.anyWaiting = false;
  uiState.waiting = false;
  uiState.isCurrentView = false;
  uiState.activeTool = false;
  uiState.completedTool = false;
  uiState.error = "";
  uiState.submittedMessage = "";
  uiState.submittedAt = "";
  if (resetRouting) {
    uiState.conversationId = "";
    uiState.routeHint = "";
  }
  reportDiagnosticsEvent("ui_pending_shell_entered", {
    source,
    toolName: app.getHostContext()?.toolInfo?.tool?.name || "",
    instanceId: uiState.instanceId || "",
    conversationId: uiState.conversationId || "",
  });
}

function freezeHistoricalView(source) {
  if (historicalViewFrozen) {
    return;
  }

  historicalViewFrozen = true;
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  stopBootstrapRefresh();

  uiState.waiting = false;
  uiState.activeTool = false;
  uiState.isCurrentView = false;
  render();
  reportDiagnosticsEvent("ui_historical_view_frozen", {
    source,
    conversationId: uiState.conversationId || "",
    instanceId: uiState.instanceId || "",
  });
}

function freezeSubmittedView(source) {
  if (historicalViewFrozen) {
    return;
  }

  historicalViewFrozen = true;
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  stopBootstrapRefresh();

  uiState.waiting = false;
  uiState.activeTool = false;
  uiState.isCurrentView = false;
  uiState.sending = false;
  render();
  reportDiagnosticsEvent("ui_submitted_view_frozen", {
    source,
    conversationId: uiState.conversationId || "",
    instanceId: uiState.instanceId || "",
  });
}

function maybeRequestHistoricalTeardown(source) {
  if (!shouldTeardownHistoricalView()) {
    if (uiState.isCurrentView) {
      teardownRequested = false;
    }
    return;
  }

  teardownRequested = true;
  reportDiagnosticsEvent("ui_request_teardown_started", {
    source,
    conversationId: uiState.conversationId || "",
    instanceId: uiState.instanceId || "",
  });

  void app.requestTeardown().then(() => {
    reportDiagnosticsEvent("ui_request_teardown_sent", {
      source,
      conversationId: uiState.conversationId || "",
      instanceId: uiState.instanceId || "",
    });
  }).catch((error) => {
    teardownRequested = false;
    reportDiagnosticsEvent("ui_request_teardown_failed", {
      source,
      message: error instanceof Error ? error.message : "requestTeardown failed",
    });
  });
}

function updateFakeCaret() {
  const showComposer = shouldShowComposer();
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

function isImageLightboxOpen() {
  return !imageLightbox.hidden;
}

function setImageLightboxZoomed(nextValue) {
  isImageLightboxZoomed = Boolean(nextValue);
  imageLightboxFrame.classList.toggle("xh-lightbox-frame--zoomed", isImageLightboxZoomed);
  applyImageLightboxLayout();
}

function getImageLightboxViewportSize() {
  const panelWidth = Math.min(window.innerWidth * 0.92, 920);
  return {
    maxWidth: Math.max(160, Math.floor(panelWidth - 28)),
    maxHeight: Math.max(160, Math.floor(window.innerHeight - 140)),
  };
}

function setLightboxImageStyle(name, value) {
  imageLightboxImg.style.setProperty(name, value, "important");
}

function clearLightboxImageStyle(name) {
  imageLightboxImg.style.removeProperty(name);
}

function applyImageLightboxLayout() {
  if (imageLightbox.hidden) {
    return;
  }

  const naturalWidth = Number(activeImageLightboxAttachment?.pixelWidth) || imageLightboxImg.naturalWidth || 0;
  const naturalHeight = Number(activeImageLightboxAttachment?.pixelHeight) || imageLightboxImg.naturalHeight || 0;
  if (!naturalWidth || !naturalHeight) {
    return;
  }

  activeImageLightboxAttachment = {
    ...(activeImageLightboxAttachment || {}),
    pixelWidth: naturalWidth,
    pixelHeight: naturalHeight,
  };

  let displayWidth = naturalWidth;
  let displayHeight = naturalHeight;

  if (!isImageLightboxZoomed) {
    const { maxWidth, maxHeight } = getImageLightboxViewportSize();
    const fitScale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight);
    const safeScale = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;
    displayWidth = Math.max(1, Math.round(naturalWidth * safeScale));
    displayHeight = Math.max(1, Math.round(naturalHeight * safeScale));
  }

  setLightboxImageStyle("width", `${displayWidth}px`);
  setLightboxImageStyle("height", `${displayHeight}px`);
  setLightboxImageStyle("max-width", "none");
  setLightboxImageStyle("max-height", "none");
  setLightboxImageStyle("min-width", "0");
  setLightboxImageStyle("min-height", "0");
  setLightboxImageStyle("object-fit", "fill");
}

function openImageLightbox(att) {
  const src = typeof att?.content === "string" ? att.content : "";
  if (!src) {
    return;
  }

  activeImageLightboxAttachment = {
    pixelWidth: Number(att?.pixelWidth) || 0,
    pixelHeight: Number(att?.pixelHeight) || 0,
  };
  setImageLightboxZoomed(false);
  imageLightboxImg.src = src;
  imageLightboxImg.alt = att?.name || "image preview";
  imageLightboxCaption.textContent = `${att?.filePath || att?.name || ""}${att?.name || att?.filePath ? " · 点击图片切换缩放" : "点击图片切换缩放"}`;
  imageLightbox.hidden = false;
  applyImageLightboxLayout();
}

function closeImageLightbox() {
  if (imageLightbox.hidden) {
    return;
  }

  imageLightbox.hidden = true;
  setImageLightboxZoomed(false);
  imageLightboxFrame.scrollTop = 0;
  imageLightboxFrame.scrollLeft = 0;
  activeImageLightboxAttachment = null;
  imageLightboxImg.removeAttribute("src");
  imageLightboxImg.alt = "";
  imageLightboxCaption.textContent = "";
  clearLightboxImageStyle("width");
  clearLightboxImageStyle("height");
  clearLightboxImageStyle("max-width");
  clearLightboxImageStyle("max-height");
  clearLightboxImageStyle("min-width");
  clearLightboxImageStyle("min-height");
  clearLightboxImageStyle("object-fit");
}

function clearMentionSearchTimer() {
  if (mentionSearchTimer) {
    window.clearTimeout(mentionSearchTimer);
    mentionSearchTimer = null;
  }
}

function hideFileMentionPalette() {
  clearMentionSearchTimer();
  activeMention = null;
  fileMentionPalette.hide();
}

function getActiveMentionCandidate() {
  if (messageInput.selectionStart !== messageInput.selectionEnd) return null;

  const caretPos = messageInput.selectionStart ?? messageInput.value.length;
  const beforeCaret = messageInput.value.slice(0, caretPos);
  const atIndex = beforeCaret.lastIndexOf("@");
  if (atIndex < 0) return null;

  const previousChar = atIndex === 0 ? "" : beforeCaret[atIndex - 1];
  if (previousChar && /[A-Za-z0-9_./\\%+-]/.test(previousChar)) return null;

  const query = beforeCaret.slice(atIndex + 1);
  if (/\s/.test(query)) return null;

  return {
    query,
    tokenStart: atIndex,
    tokenEnd: caretPos,
  };
}

async function searchProjectFilesForMention(mention) {
  const currentSeq = ++mentionSearchSeq;
  activeMention = mention;
  cmdPalette.hide();
  fileMentionPalette.showLoading(mention.query);

  clearMentionSearchTimer();
  mentionSearchTimer = window.setTimeout(async () => {
    try {
      let items = [];
      try {
        const payload = await callLocalJson("/app/project-files", {
          params: {
            query: mention.query,
            limit: 20,
            ...buildWorkspaceHttpParams(),
          },
        });
        items = Array.isArray(payload?.items) ? payload.items : [];
      } catch (localError) {
        const localErrorMessage = localError instanceof Error ? localError.message : "";
        const shouldFallback = !localErrorMessage
          || localErrorMessage === "浏览器聊天地址不可用"
          || localErrorMessage === "本地服务请求超时"
          || localErrorMessage === "Failed to fetch";
        if (!shouldFallback) {
          throw localError;
        }

        const result = await app.callServerTool({
          name: "xiaohaha_search_project_files",
          arguments: {
            query: mention.query,
            limit: 20,
            ...buildWorkspaceToolArgs(),
          },
        }, {
          timeout: LOCAL_HTTP_TIMEOUT_MS,
        });
        if (result?.isError) {
          const toolErrorMessage = typeof result?.structuredContent?.error === "string" && result.structuredContent.error.trim()
            ? result.structuredContent.error.trim()
            : Array.isArray(result?.content)
              ? result.content.find((item) => typeof item?.text === "string" && item.text.trim())?.text || ""
              : "";
          throw new Error(toolErrorMessage || "搜索项目文件失败");
        }
        items = Array.isArray(result?.structuredContent?.items)
          ? result.structuredContent.items
          : [];
      }

      if (currentSeq !== mentionSearchSeq) return;

      uiState.error = "";
      fileMentionPalette.showItems(items, mention.query);
    } catch (error) {
      if (currentSeq !== mentionSearchSeq) return;
      const errorMessage = error instanceof Error ? error.message : "搜索项目文件失败";
      fileMentionPalette.showError(errorMessage, mention.query);
      uiState.error = errorMessage;
      render();
    }
  }, mention.query ? FILE_MENTION_SEARCH_DEBOUNCE_MS : 0);
}

function refreshInlinePalettes() {
  const mention = getActiveMentionCandidate();
  if (mention) {
    void searchProjectFilesForMention(mention);
    return;
  }

  mentionSearchSeq++;
  hideFileMentionPalette();
  cmdPalette.handleInputChange(messageInput.value);
}

async function attachMentionedProjectFile(item) {
  const mention = activeMention;
  mentionSearchSeq++;
  hideFileMentionPalette();
  if (!item?.path || !mention) return;

  try {
    mentions.add(item, mention);
    autoResizeInput(true);
    uiState.error = "";
    render();
  } catch (error) {
    uiState.error = error instanceof Error ? error.message : "插入文件路径失败";
    render();
    messageInput.focus();
  }
}

function insertInlineSnippetAttachment(attId, selectionRange = null) {
  const attachment = attachments.getById(attId);
  if (!attachment) {
    return false;
  }

  mentions.addInlineAttachment({
    attachmentId: attId,
    name: attachment.name,
    path: attachment.filePath || "",
  }, selectionRange);
  return true;
}

function updateInlineSnippetAttachment(attId, patch = {}) {
  attachments.updateById(attId, patch);
  mentions.updateInlineAttachment(attId, {
    name: patch.name,
    path: Object.prototype.hasOwnProperty.call(patch, "filePath")
      ? patch.filePath
      : patch.path,
  });
}

async function openProjectMention(mention) {
  if (!mention?.path) {
    return;
  }

  try {
    let payload = null;

    try {
      payload = await callLocalJson("/app/open-project-file", {
        method: "POST",
        timeoutMs: LOCAL_SEND_TIMEOUT_MS,
        body: {
          path: mention.path,
          ...buildWorkspaceHttpParams(),
        },
      });
    } catch {
      const result = await app.callServerTool({
        name: "xiaohaha_open_project_file",
        arguments: {
          file_path: mention.path,
          ...buildWorkspaceToolArgs(),
        },
      }, {
        timeout: LOCAL_SEND_TIMEOUT_MS,
      });

      payload = result?.structuredContent;
      if (result?.isError || !payload?.ok) {
        throw new Error(payload?.error || "打开文件失败");
      }
    }

    uiState.error = "";
    render();
  } catch (error) {
    uiState.error = error instanceof Error ? error.message : "打开文件失败";
    render();
  }
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

async function sendDiagnosticsEvent(event, detail = {}) {
  const payload = {
    event,
    detail,
    instanceId: uiState.instanceId || undefined,
    conversationId: uiState.conversationId || undefined,
    routeHint: uiState.routeHint || undefined,
    resourceUri: CURRENT_APP_RESOURCE_URI || undefined,
  };

  try {
    await callLocalJson("/app/log", {
      method: "POST",
      body: payload,
      timeoutMs: LOCAL_DIAGNOSTIC_TIMEOUT_MS,
    });
    return;
  } catch {}

  if (!uiState.connected) {
    return;
  }

  try {
    await app.callServerTool({
      name: "xiaohaha_log_app_event",
      arguments: {
        event,
        detail,
        instance_id: uiState.instanceId || undefined,
        conversation_id: uiState.conversationId || undefined,
        route_hint: uiState.routeHint || undefined,
        resource_uri: CURRENT_APP_RESOURCE_URI || undefined,
      },
    }, {
      timeout: LOCAL_DIAGNOSTIC_TIMEOUT_MS,
    });
  } catch {}
}

function reportDiagnosticsEvent(event, detail = {}) {
  void sendDiagnosticsEvent(event, detail);
}

async function uploadLocalAttachment({ type, name, mimeType, size, path, lineRef, encoding, body }) {
  const url = buildLocalUrl("/app/attachments", {
    type,
    name: name || undefined,
    mimeType: mimeType || undefined,
    size: Number.isFinite(size) ? size : undefined,
    path: path || undefined,
    lineRef: lineRef || undefined,
    encoding: encoding || undefined,
  });
  if (!url) {
    throw new Error("本地附件服务不可用");
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), LOCAL_UPLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body,
      signal: controller.signal,
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok || payload?.ok === false || !payload?.attachment) {
      const errorMessage = typeof payload?.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : `HTTP ${response.status}`;
      throw new Error(errorMessage);
    }

    return payload.attachment;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("附件上传超时");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function readClipboardImageFromLocalService() {
  const payload = await callLocalJson("/app/clipboard-image", {
    timeoutMs: LOCAL_SEND_TIMEOUT_MS,
  });
  const image = payload?.image;
  if (!image?.ok || typeof image?.base64 !== "string") {
    throw new Error("剪贴板图片不可用");
  }
  return {
    type: "image",
    name: "clipboard.png",
    mimeType: typeof image.mimeType === "string" ? image.mimeType : "image/png",
    size: Number(image.byteLength) || 0,
    pixelWidth: Number(image.pixelWidth) || 0,
    pixelHeight: Number(image.pixelHeight) || 0,
    previewSource: "clipboard-service",
    content: `data:${typeof image.mimeType === "string" ? image.mimeType : "image/png"};base64,${image.base64}`,
  };
}

function readImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => {
      resolve({
        pixelWidth: probe.naturalWidth || 0,
        pixelHeight: probe.naturalHeight || 0,
      });
    };
    probe.onerror = () => {
      resolve({
        pixelWidth: 0,
        pixelHeight: 0,
      });
    };
    probe.src = dataUrl;
  });
}

async function buildImageAttachmentFromFile(file, previewSource) {
  const content = await readAsDataUrl(file);
  const { pixelWidth, pixelHeight } = await readImageDimensions(content);
  return {
    type: "image",
    name: file.name || "image.png",
    mimeType: file.type || "image/png",
    size: Number(file.size) || 0,
    pixelWidth,
    pixelHeight,
    previewSource,
    content,
  };
}

function getImageAttachmentArea(att) {
  const width = Number(att?.pixelWidth) || 0;
  const height = Number(att?.pixelHeight) || 0;
  return width * height;
}

function choosePreferredImageAttachment(primaryAttachment, fallbackAttachment) {
  if (!fallbackAttachment?.content) {
    return primaryAttachment;
  }

  const primaryArea = getImageAttachmentArea(primaryAttachment);
  const fallbackArea = getImageAttachmentArea(fallbackAttachment);
  if (fallbackArea > primaryArea * 1.08) {
    return {
      ...fallbackAttachment,
      name: primaryAttachment?.name || fallbackAttachment.name,
    };
  }
  if (primaryArea > fallbackArea * 1.08) {
    return primaryAttachment;
  }

  const primarySize = Number(primaryAttachment?.size) || 0;
  const fallbackSize = Number(fallbackAttachment?.size) || 0;
  if (fallbackSize > primarySize * 1.2) {
    return {
      ...fallbackAttachment,
      name: primaryAttachment?.name || fallbackAttachment.name,
    };
  }

  return primaryAttachment;
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
  const hostWorkspaceHints = extractWorkspaceHintsFromHostContext(hostContext);
  const previousInstanceId = uiState.instanceId;
  if (hostContext?.toolInfo?.id !== undefined && hostContext?.toolInfo?.id !== null) {
    uiState.instanceId = String(hostContext.toolInfo.id);
  }
  const instanceChanged = previousInstanceId !== uiState.instanceId;
  if (instanceChanged) {
    uiState.workspaceRoot = "";
    uiState.workspaceFile = "";
  }
  applyWorkspaceHints(hostWorkspaceHints);
  return instanceChanged;
}

/* ── State extraction (from MCP results) ── */

function normalizeState(state) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const eventCount = Number.isFinite(state?.eventCount)
    ? Math.max(0, Math.floor(state.eventCount))
    : events.length;
  const latestAiMessage = typeof state?.latestAiMessage === "string" && state.latestAiMessage.trim()
    ? state.latestAiMessage.trim()
    : getLatestAiMessage(events);

  return {
    conversationId: typeof state?.conversationId === "string" ? state.conversationId : "",
    workspaceRoot: normalizeWorkspaceHint(
      typeof state?.workspaceRoot === "string"
        ? state.workspaceRoot
        : typeof state?.workspace_root === "string"
          ? state.workspace_root
          : ""
    ),
    anyWaiting: Boolean(state?.anyWaiting),
    waiting: Boolean(state?.waiting),
    isCurrentView: Boolean(state?.isCurrentView),
    previewMessage: typeof state?.previewMessage === "string" ? state.previewMessage : "",
    eventCount,
    latestAiMessage,
    events,
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

function hasResolvedChatState(state) {
  return Boolean(
    state
    && (
      state.conversationId
      || state.anyWaiting
      || state.waiting
      || state.isCurrentView
      || state.eventCount > 0
      || state.latestAiMessage
      || state.previewMessage
    )
  );
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
  return typeof args.conversation_id === "string"
    ? args.conversation_id
    : typeof args.conversationId === "string"
      ? args.conversationId
      : "";
}

function extractRouteHintFromArgs(args) {
  if (!args || typeof args !== "object") return "";
  return typeof args.ai_response === "string" ? args.ai_response.trim() : "";
}

function extractPromptStateFromToolResult(result) {
  const textBlocks = Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === "text" && typeof item.text === "string")
    : [];
  const combinedText = textBlocks.map((item) => item.text).join("\n");
  if (!combinedText) return { conversationId: "" };
  const conversationMatch = combinedText.match(/当前会话 conversation_id:\s*(.+)/);
  return {
    conversationId: conversationMatch?.[1]?.trim() || "",
  };
}

function isRoutingReady() {
  return Boolean(uiState.instanceId || uiState.conversationId || uiState.routeHint);
}

function shouldAttemptBindCurrentView() {
  return Boolean(
    uiState.instanceId
    && isCheckMessagesToolContext()
    && !historicalViewFrozen
    && !teardownCompleted
    && !uiState.completedTool
  );
}

function refreshHostContextForActiveView() {
  const hostContext = app.getHostContext();
  const instanceChanged = syncHostContext(hostContext);
  if (instanceChanged) {
    acceptedToolInputForInstance = false;
  }
  return { hostContext, instanceChanged };
}

function recoverActiveView(source) {
  if (!uiState.connected || historicalViewFrozen || teardownCompleted) {
    return;
  }

  const { hostContext, instanceChanged } = refreshHostContextForActiveView();
  if (instanceChanged && isCheckMessagesToolContext(hostContext) && !uiState.sending && !uiState.completedTool) {
    enterPendingViewShell(source, { resetRouting: true });
    render();
  }

  void refreshState().catch((err) => {
    reportDiagnosticsEvent("ui_refresh_failed", {
      source,
      message: err instanceof Error ? err.message : "刷新失败",
    });
    render();
  });
  ensureBootstrapRefresh(source);
}

async function refreshStateFromLocalHttp() {
  const payload = await callLocalJson("/app/state", {
    params: {
      instanceId: uiState.instanceId || undefined,
      conversationId: uiState.conversationId || undefined,
      routeHint: uiState.routeHint || undefined,
      resourceUri: CURRENT_APP_RESOURCE_URI || undefined,
      bindInstance: shouldAttemptBindCurrentView() ? "1" : undefined,
      ...buildWorkspaceHttpParams(),
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
      route_hint: uiState.routeHint || undefined,
      resource_uri: CURRENT_APP_RESOURCE_URI || undefined,
      bind_instance: shouldAttemptBindCurrentView() || undefined,
      ...buildWorkspaceToolArgs(),
    },
  }, {
    timeout: LOCAL_HTTP_TIMEOUT_MS,
  });
  return extractState(result);
}

async function sendAppMessageViaLocalHttp(message, previewMessage, attachmentsList) {
  const payload = await callLocalJson("/send", {
    method: "POST",
    timeoutMs: LOCAL_SEND_TIMEOUT_MS,
    body: {
      message,
      previewMessage: previewMessage || undefined,
      attachments: attachmentsList || undefined,
      instanceId: uiState.instanceId || undefined,
      conversationId: uiState.conversationId || undefined,
      routeHint: uiState.routeHint || undefined,
      ...buildWorkspaceHttpParams(),
    },
  });
  return normalizeState(payload?.state);
}

async function sendAppMessageViaServerTool(message, previewMessage, attachmentsList) {
  const result = await app.callServerTool({
    name: "xiaohaha_send_app_message",
    arguments: {
      message,
      preview_message: previewMessage || undefined,
      attachments: attachmentsList || undefined,
      instance_id: uiState.instanceId || undefined,
      conversation_id: uiState.conversationId || undefined,
      route_hint: uiState.routeHint || undefined,
      ...buildWorkspaceToolArgs(),
    },
  }, {
    timeout: LOCAL_SEND_TIMEOUT_MS,
  });
  const errorMessage = extractErrorMessage(result);
  if (errorMessage) throw new Error(errorMessage);
  return extractState(result);
}

/* ═══════════════════════════════════════════════════
   Render
   ═══════════════════════════════════════════════════ */

function render() {
  const showPreview = uiState.hydrated && Boolean(uiState.submittedMessage);
  const showComposer = uiState.pendingView || (uiState.hydrated && shouldShowComposer());
  const composerCollapsed = lastRenderedComposerVisible && !showComposer;
  composerLayer.hidden = !showComposer;
  composerForm.hidden = !showComposer;
  sentPreview.hidden = !showPreview;
  errorBanner.hidden = !uiState.error;
  errorBanner.textContent = uiState.error;
  messageInput.disabled = uiState.sending || uiState.pendingView || !isRoutingReady();
  messageInput.placeholder = uiState.pendingView
    ? "会话同步中，请稍候..."
    : isRoutingReady()
      ? "继续给 Agent 发消息... (/ 调出命令)"
      : "会话初始化中，请稍候...";

  const nextPreviewText = showPreview ? uiState.submittedMessage : "";
  if (nextPreviewText !== lastRenderedPreviewText) {
    sentPreview.innerHTML = nextPreviewText ? escapeHtml(nextPreviewText) : "";
    lastRenderedPreviewText = nextPreviewText;
  }

  updateFakeCaret();
  if (composerCollapsed) {
    scheduleCollapseSizeSyncBurst();
  } else {
    scheduleSizeSync();
  }
  lastRenderedComposerVisible = showComposer;
}

/* ═══════════════════════════════════════════════════
   Refresh State (poll)
   ═══════════════════════════════════════════════════ */

async function refreshState() {
  if (historicalViewFrozen) {
    return;
  }

  const wasPendingView = uiState.pendingView;
  let nextState = null;
  let localState = null;
  try {
    localState = await refreshStateFromLocalHttp();
  } catch {}

  const hasResolvedLocalState = hasResolvedChatState(localState);

  if (hasResolvedLocalState) {
    nextState = localState;
  } else {
    try {
      nextState = await refreshStateFromServerTool();
    } catch {
      nextState = localState;
    }
  }
  if (!nextState) throw new Error("Failed to parse chat state from MCP response.");

  const prevRenderState = {
    connected: uiState.connected,
    hydrated: uiState.hydrated,
    pendingView: uiState.pendingView,
    waiting: uiState.waiting,
    isCurrentView: uiState.isCurrentView,
    activeTool: uiState.activeTool,
    error: uiState.error,
    sending: uiState.sending,
    submittedMessage: uiState.submittedMessage,
    instanceId: uiState.instanceId,
    conversationId: uiState.conversationId,
    routeHint: uiState.routeHint,
  };
  const previewMessage = nextState.previewMessage.trim();
  uiState.connected = true;
  uiState.hydrated = true;
  uiState.pendingView = Boolean(
    wasPendingView
    && !nextState.isCurrentView
    && !previewMessage
    && !uiState.completedTool
  );
  uiState.conversationId = nextState.conversationId || uiState.conversationId;
  applyWorkspaceHints({ workspaceRoot: nextState.workspaceRoot });
  uiState.anyWaiting = nextState.anyWaiting;
  uiState.waiting = nextState.waiting && nextState.isCurrentView;
  uiState.isCurrentView = nextState.isCurrentView;
  uiState.activeTool = uiState.waiting;
  if (!uiState.isCurrentView) {
    uiState.waiting = false;
    uiState.sending = false;
    uiState.activeTool = false;
  }
  uiState.error = "";
  uiState.latestAiMessage = nextState.latestAiMessage || getLatestAiMessage(nextState.events);
  if (uiState.latestAiMessage) {
    uiState.routeHint = uiState.latestAiMessage;
  }

  if (previewMessage) {
    uiState.submittedMessage = previewMessage;
    uiState.completedTool = true;
  } else if (!uiState.completedTool || uiState.activeTool) {
    uiState.submittedMessage = "";
    uiState.submittedAt = "";
  }
  const nextRenderState = {
    connected: uiState.connected,
    hydrated: uiState.hydrated,
    pendingView: uiState.pendingView,
    waiting: uiState.waiting,
    isCurrentView: uiState.isCurrentView,
    activeTool: uiState.activeTool,
    error: uiState.error,
    sending: uiState.sending,
    submittedMessage: uiState.submittedMessage,
    instanceId: uiState.instanceId,
    conversationId: uiState.conversationId,
    routeHint: uiState.routeHint,
  };
  const shouldRender = Object.keys(nextRenderState).some((key) => nextRenderState[key] !== prevRenderState[key]);
  if (shouldRender) {
    render();
  }
  if (shouldStopBootstrapRefresh()) {
    stopBootstrapRefresh();
  }
  if (shouldFreezeHistoricalView()) {
    freezeHistoricalView("refresh_state");
    return;
  }
  maybeRequestHistoricalTeardown("refresh_state");
}

/* ═══════════════════════════════════════════════════
   Command Execution
   ═══════════════════════════════════════════════════ */

function executeCommand(cmdId) {
  mentionSearchSeq++;
  hideFileMentionPalette();
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

  switch (cmdId) {
    case "file":
      fileInput.click();
      break;
    case "image":
      imageInput.click();
      break;
    case "clear":
      mentions.clear();
      attachments.clear();
      uiState.error = "";
      render();
      break;
    case "help": {
      messageInput.value = [
        "📎  拖拽文件到输入框添加附件",
        "🖼️  Ctrl/Cmd+V 粘贴图片",
        "📋  从编辑器复制代码可保留文件名和行号",
        "@   搜索项目文件并插入路径",
        "/   输入 / 调出命令菜单",
        "⏎  Enter 发送  ⇧⏎ 换行",
      ].join("\n");
      autoResizeInput(true);
      messageInput.focus();
      messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
      break;
    }
  }
}

/* ═══════════════════════════════════════════════════
   Send Message
   ═══════════════════════════════════════════════════ */

async function sendMessage() {
  mentionSearchSeq++;
  hideFileMentionPalette();
  const rawText = mentions.buildMessageText();
  if (!rawText && attachments.length === 0) return;
  if (uiState.sending) return;
  if (!isRoutingReady()) {
    uiState.error = "会话初始化中，请稍后再试";
    render();
    return;
  }

  const previewText = attachments.buildPreviewText(mentions.buildPreviewText());

  uiState.sending = true;
  uiState.error = "";
    uiState.anyWaiting = false;
    uiState.waiting = false;
    uiState.isCurrentView = true;
    uiState.activeTool = false;
    uiState.completedTool = true;
    uiState.pendingView = false;
    uiState.submittedMessage = previewText;
  uiState.submittedAt = new Date().toLocaleTimeString();
  uiState.latestAiMessage = "";
  reportDiagnosticsEvent("ui_send_message_started", {
    previewText,
    attachmentCount: attachments.length,
  });
  render();

  try {
    let nextState = null;

    try {
      const attachmentRefs = await attachments.prepareAttachmentRefs(uploadLocalAttachment);
      nextState = await sendAppMessageViaLocalHttp(rawText, previewText, attachmentRefs)
        .catch(() => sendAppMessageViaServerTool(rawText, previewText, attachmentRefs));
    } catch {
      const legacyMessage = attachments.buildFullMessage(rawText);
      nextState = await sendAppMessageViaLocalHttp(legacyMessage, previewText)
        .catch(() => sendAppMessageViaServerTool(legacyMessage, previewText));
    }

    if (nextState) {
      uiState.conversationId = nextState.conversationId || uiState.conversationId;
      applyWorkspaceHints({ workspaceRoot: nextState.workspaceRoot });
      uiState.anyWaiting = nextState.anyWaiting;
      uiState.waiting = nextState.waiting && nextState.isCurrentView;
      uiState.isCurrentView = nextState.isCurrentView;
      uiState.latestAiMessage = nextState.latestAiMessage || getLatestAiMessage(nextState.events);
      const pm = nextState.previewMessage.trim();
      if (pm) {
        uiState.submittedMessage = pm;
        uiState.completedTool = true;
      }
      reportDiagnosticsEvent("ui_send_message_succeeded", {
        anyWaiting: nextState.anyWaiting,
        waiting: nextState.waiting,
        isCurrentView: nextState.isCurrentView,
      });
    }

    messageInput.value = "";
    attachments.clear();
    autoResizeInput();
    if (uiState.submittedMessage) {
      freezeSubmittedView("send_message_succeeded");
    }
  } catch (error) {
    uiState.anyWaiting = true;
    uiState.waiting = true;
    uiState.activeTool = true;
    uiState.completedTool = false;
    uiState.pendingView = false;
    uiState.submittedMessage = "";
    uiState.submittedAt = "";
    uiState.error = error instanceof Error ? error.message : "发送失败";
    reportDiagnosticsEvent("ui_send_message_failed", {
      message: error instanceof Error ? error.message : "发送失败",
    });
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

  if (e.key === "Escape" && isImageLightboxOpen()) {
    e.preventDefault();
    closeImageLightbox();
    return;
  }

  if (fileMentionPalette.visible) {
    if (e.key === "ArrowDown") { e.preventDefault(); fileMentionPalette.moveSelection(1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); fileMentionPalette.moveSelection(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const item = fileMentionPalette.getSelectedItem();
      if (item) {
        void attachMentionedProjectFile(item);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      mentionSearchSeq++;
      hideFileMentionPalette();
      return;
    }
  }

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
      if (label) {
        messageInput.value = label + " ";
        autoResizeInput(true);
        messageInput.focus();
        messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
      }
      return;
    }
  }

  if ((e.key === "Backspace" || e.key === "Delete")) {
    const direction = e.key === "Backspace" ? "backward" : "forward";
    if (mentions.handleDeleteKey(direction)) {
      e.preventDefault();
      autoResizeInput(true);
      updateFakeCaret();
      scheduleSizeSync();
      return;
    }
  }

  if (mentions.hasSelection() && (
    e.key.length === 1
    || ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  )) {
    mentions.clearSelection();
  }

  if (e.key === "Escape" && (attachments.length > 0 || mentions.length > 0)) {
    e.preventDefault();
    mentions.clear();
    attachments.clear();
    updateFakeCaret();
    scheduleSizeSync();
    return;
  }

  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    insertEditorText(messageInput, "\n");
    autoResizeInput(true);
    refreshInlinePalettes();
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

imageLightboxClose.addEventListener("click", () => {
  closeImageLightbox();
});

imageLightbox.addEventListener("click", (e) => {
  if (e.target === imageLightbox) {
    closeImageLightbox();
  }
});

imageLightboxImg.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setImageLightboxZoomed(!isImageLightboxZoomed);
});

imageLightboxImg.addEventListener("load", () => {
  applyImageLightboxLayout();
});

window.addEventListener("resize", () => {
  if (isImageLightboxOpen()) {
    applyImageLightboxLayout();
  }
  scheduleSizeSync();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isImageLightboxOpen()) {
    e.preventDefault();
    closeImageLightbox();
  }
});

messageInput.addEventListener("compositionstart", () => { isComposing = true; });
messageInput.addEventListener("compositionend", () => {
  isComposing = false;
  autoResizeInput(true);
  refreshInlinePalettes();
});
messageInput.addEventListener("input", () => {
  mentions.clearSelection();
  autoResizeInput();
  refreshInlinePalettes();
  updateFakeCaret();
});
messageInput.addEventListener("click", () => { refreshInlinePalettes(); });
messageInput.addEventListener("keyup", (e) => {
  if (fileMentionPalette.visible && ["ArrowUp", "ArrowDown"].includes(e.key)) {
    return;
  }
  if (cmdPalette.visible && ["ArrowUp", "ArrowDown"].includes(e.key)) {
    return;
  }
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    refreshInlinePalettes();
  }
});
messageInput.addEventListener("focus", () => { updateFakeCaret(); });
messageInput.addEventListener("blur", () => { updateFakeCaret(); });

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    recoverActiveView("visibilitychange");
    scheduleSizeSync();
  }
});

window.addEventListener("focus", () => {
  recoverActiveView("window_focus");
  scheduleSizeSync();
});

window.addEventListener("pageshow", () => {
  recoverActiveView("pageshow");
  scheduleSizeSync();
});

messageInput.addEventListener("paste", async (e) => {
  const cd = e.clipboardData;
  if (!cd) return;

  const items = cd.items ? [...cd.items] : [];
  const pastedFiles = cd.files ? [...cd.files].filter(Boolean) : [];
  const pastedImageFiles = pastedFiles.filter((file) => file.type.startsWith("image/"));
  const imageItems = items.filter((item) => item.type.startsWith("image/"));

  if (pastedImageFiles.length > 0 || imageItems.length > 0) {
    e.preventDefault();
    mentionSearchSeq++;
    hideFileMentionPalette();
    try {
      const directImageFiles = pastedImageFiles.length > 0
        ? pastedImageFiles
        : imageItems.map((item) => item.getAsFile()).filter(Boolean);

      if (directImageFiles.length > 1) {
        await attachments.processFiles(directImageFiles);
        updateFakeCaret();
        return;
      }

      if (directImageFiles.length === 1) {
        const primaryAttachment = await buildImageAttachmentFromFile(
          directImageFiles[0],
          pastedImageFiles.length > 0 ? "paste-file" : "paste-item"
        );
        let finalAttachment = primaryAttachment;
        try {
          const clipboardAttachment = await readClipboardImageFromLocalService();
          finalAttachment = choosePreferredImageAttachment(primaryAttachment, clipboardAttachment);
        } catch {}
        attachments.add(finalAttachment);
        updateFakeCaret();
        return;
      }

      attachments.add(await readClipboardImageFromLocalService());
    } catch {
      const fallbackFiles = pastedImageFiles.length > 0
        ? pastedImageFiles
        : imageItems.map((item) => item.getAsFile()).filter(Boolean);
      if (fallbackFiles.length > 0) {
        await attachments.processFiles(fallbackFiles);
      }
    }
    updateFakeCaret();
    return;
  }

  if (pastedFiles.length > 0) {
    const hasBinary = pastedFiles.some((file) => !file.type.startsWith("text/"));
    if (hasBinary) {
      e.preventDefault();
      mentionSearchSeq++;
      hideFileMentionPalette();
      await attachments.processFiles(pastedFiles);
      updateFakeCaret();
      return;
    }
  }

  const rawText = cd.getData("text/plain");
  const pasteSelection = getEditorSelectionOffsets(messageInput);

  const metaJson = cd.getData("application/vnd.code.copymetadata");
  if (metaJson && rawText) {
    e.preventDefault();
    mentionSearchSeq++;
    hideFileMentionPalette();
    const attId = attachments.processCodeMeta(metaJson, rawText, { inlineChip: true });
    if (attId > 0) {
      insertInlineSnippetAttachment(attId, pasteSelection);
    }
    return;
  }

  const metaItem = items.find(
    (item) => item.type === "application/vnd.code.copymetadata"
  );
  if (metaItem && rawText) {
    e.preventDefault();
    mentionSearchSeq++;
    hideFileMentionPalette();
    metaItem.getAsString((json) => {
      const attId = attachments.processCodeMeta(json, rawText, { inlineChip: true });
      if (attId > 0) {
        insertInlineSnippetAttachment(attId, pasteSelection);
      }
    });
    return;
  }

  const vsData = cd.getData("vscode-editor-data");
  if (vsData && rawText && (rawText.includes("\n") || rawText.length > 80)) {
    e.preventDefault();
    mentionSearchSeq++;
    hideFileMentionPalette();
    let lang = "text";
    try { lang = JSON.parse(vsData)?.mode || "text"; } catch {}

    const attId = attachments.add({
      type: "snippet",
      name: `snippet.${lang} ⏳`,
      content: rawText,
      mimeType: "text/plain",
      size: new TextEncoder().encode(rawText).length,
      filePath: "",
      lineRef: "",
      inlineChip: true,
    });

    if (attId > 0) {
      insertInlineSnippetAttachment(attId, pasteSelection);
      app.callServerTool({
        name: "xiaohaha_locate_code",
        arguments: {
          code_text: rawText,
          ...buildWorkspaceToolArgs(),
        },
      }).then((result) => {
        const loc = result?.structuredContent;
        if (loc?.found) {
          const fileName = loc.filePath.split("/").pop() || loc.filePath;
          const lineLabel = loc.startLine === loc.endLine
            ? `(${loc.startLine})`
            : `(${loc.startLine}-${loc.endLine})`;
          updateInlineSnippetAttachment(attId, {
            name: `${fileName} ${lineLabel}`,
            filePath: loc.filePath,
            lineRef: loc.startLine === loc.endLine
              ? `:${loc.startLine}`
              : `:${loc.startLine}-${loc.endLine}`,
          });
        } else {
          updateInlineSnippetAttachment(attId, { name: `snippet.${lang}` });
        }
      }).catch(() => {
        updateInlineSnippetAttachment(attId, { name: `snippet.${lang}` });
      });
    }
    return;
  }

  if (pastedFiles.length > 0) {
    const nonText = pastedFiles.filter((f) => !f.type.startsWith("text/"));
    if (nonText.length > 0) {
      e.preventDefault();
      mentionSearchSeq++;
      hideFileMentionPalette();
      await attachments.processFiles(pastedFiles);
      updateFakeCaret();
      return;
    }
  }

  if (rawText) {
    e.preventDefault();
    insertEditorText(messageInput, rawText);
    autoResizeInput(true);
    refreshInlinePalettes();
    updateFakeCaret();
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
  mentionSearchSeq++;
  hideFileMentionPalette();

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
      const prefix = messageInput.value ? (messageInput.value.endsWith("\n") ? "" : "\n") : "";
      insertEditorText(messageInput, `${prefix}${refs}`);
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
    mentionSearchSeq++;
    hideFileMentionPalette();
    const files = [...fileInput.files];
    fileInput.value = "";
    void attachments.processFiles(files).finally(() => updateFakeCaret());
  }
});
imageInput.addEventListener("change", () => {
  if (imageInput.files.length > 0) {
    mentionSearchSeq++;
    hideFileMentionPalette();
    const files = [...imageInput.files];
    imageInput.value = "";
    void attachments.processFiles(files).finally(() => updateFakeCaret());
  }
});

document.addEventListener("click", (e) => {
  if (!messageInput.contains(e.target)) {
    mentions.clearSelection();
  }
  if (fileMentionPalette.visible && !fileMentionPalette.contains(e.target) && !messageInput.contains(e.target)) {
    mentionSearchSeq++;
    hideFileMentionPalette();
  }
  if (cmdPalette.visible && !cmdPalette.el.contains(e.target) && !messageInput.contains(e.target)) {
    cmdPalette.hide();
  }
});

/* ═══════════════════════════════════════════════════
   App Lifecycle
   ═══════════════════════════════════════════════════ */

app.onteardown = async () => {
  teardownCompleted = true;
  stopBootstrapRefresh();
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  reportDiagnosticsEvent("ui_teardown", {
    conversationId: uiState.conversationId || "",
    instanceId: uiState.instanceId || "",
  });
  return {};
};

app.ontoolinputpartial = (params) => {
  if (historicalViewFrozen) {
    return;
  }

  const partialConversationId = extractConversationIdFromArgs(params?.arguments);
  const partialRouteHint = extractRouteHintFromArgs(params?.arguments);
  const partialWorkspaceRoot = extractWorkspaceRootFromArgs(params?.arguments);
  const partialWorkspaceFile = extractWorkspaceFileFromArgs(params?.arguments);
  let changed = false;

  if (partialConversationId && partialConversationId !== uiState.conversationId) {
    uiState.conversationId = partialConversationId;
    changed = true;
  }

  if (partialRouteHint && partialRouteHint !== uiState.routeHint) {
    uiState.routeHint = partialRouteHint;
    changed = true;
  }

  if (applyWorkspaceHints({
    workspaceRoot: partialWorkspaceRoot,
    workspaceFile: partialWorkspaceFile,
  })) {
    changed = true;
  }

  if (changed) {
    reportDiagnosticsEvent("ui_tool_input_partial", {
      hasConversationId: Boolean(uiState.conversationId),
      hasRouteHint: Boolean(uiState.routeHint),
    });
    ensureBootstrapRefresh("tool_input_partial");
  }
};

app.ontoolinput = (params) => {
  if (historicalViewFrozen) {
    return;
  }

  refreshHostContextForActiveView();
  const explicitConversationId = extractConversationIdFromArgs(params?.arguments);
  const explicitWorkspaceRoot = extractWorkspaceRootFromArgs(params?.arguments);
  const explicitWorkspaceFile = extractWorkspaceFileFromArgs(params?.arguments);
  const nextRouteHint = extractRouteHintFromArgs(params?.arguments) || uiState.latestAiMessage || uiState.routeHint;
  const isRepeatedToolInput = acceptedToolInputForInstance && uiState.completedTool;
  const isHistoricalProbe = uiState.completedTool && !explicitConversationId;
  uiState.conversationId = explicitConversationId || uiState.conversationId;
  uiState.routeHint = nextRouteHint;
  applyWorkspaceHints({
    workspaceRoot: explicitWorkspaceRoot,
    workspaceFile: explicitWorkspaceFile,
  });

  if (isHistoricalProbe) {
    uiState.pendingView = false;
    uiState.anyWaiting = false;
    uiState.waiting = false;
    uiState.isCurrentView = false;
    uiState.activeTool = false;
    uiState.sending = false;
    reportDiagnosticsEvent("ui_tool_input_ignored_historical", {
      toolName: app.getHostContext()?.toolInfo?.tool?.name || "",
      hasConversationId: false,
      hasRouteHint: Boolean(uiState.routeHint),
    });
    render();
    void refreshState().catch((err) => {
      uiState.error = err instanceof Error ? err.message : "刷新失败";
      reportDiagnosticsEvent("ui_refresh_failed", {
        source: "tool_input_ignored_historical",
        message: uiState.error,
      });
      render();
    });
    return;
  }

  if (isRepeatedToolInput) {
    uiState.pendingView = false;
    uiState.anyWaiting = false;
    uiState.waiting = false;
    uiState.isCurrentView = false;
    uiState.activeTool = false;
    uiState.sending = false;
    reportDiagnosticsEvent("ui_tool_input_ignored_duplicate", {
      toolName: app.getHostContext()?.toolInfo?.tool?.name || "",
      hasConversationId: Boolean(uiState.conversationId),
      hasRouteHint: Boolean(uiState.routeHint),
    });
    render();
    void refreshState().catch((err) => {
      uiState.error = err instanceof Error ? err.message : "刷新失败";
      reportDiagnosticsEvent("ui_refresh_failed", {
        source: "tool_input_ignored_duplicate",
        message: uiState.error,
      });
      render();
    });
    return;
  }

  acceptedToolInputForInstance = true;
  // 最新卡片先展示一个稳定的 pending shell，避免在 refreshState 返回前整块区域变成空白。
  enterPendingViewShell("tool_input");
  reportDiagnosticsEvent("ui_tool_input", {
    toolName: app.getHostContext()?.toolInfo?.tool?.name || "",
    hasConversationId: Boolean(uiState.conversationId),
    hasRouteHint: Boolean(uiState.routeHint),
  });
  render();
  void refreshState().catch((err) => {
    uiState.error = err instanceof Error ? err.message : "刷新失败";
    reportDiagnosticsEvent("ui_refresh_failed", {
      source: "tool_input",
      message: uiState.error,
    });
      render();
    });
  ensureBootstrapRefresh("tool_input");
};

app.ontoolresult = (result) => {
  if (historicalViewFrozen) {
    return;
  }

  refreshHostContextForActiveView();
  const stateFromResult = extractState(result);
  const nextState = extractPromptStateFromToolResult(result);
  if (stateFromResult) {
    const resultPreviewMessage = stateFromResult.previewMessage.trim();
    uiState.hydrated = true;
    uiState.pendingView = false;
    applyWorkspaceHints({ workspaceRoot: stateFromResult.workspaceRoot });
    uiState.anyWaiting = stateFromResult.anyWaiting;
    uiState.waiting = stateFromResult.waiting && stateFromResult.isCurrentView;
    uiState.isCurrentView = stateFromResult.isCurrentView;
    uiState.latestAiMessage = stateFromResult.latestAiMessage || getLatestAiMessage(stateFromResult.events) || uiState.latestAiMessage;
    if (resultPreviewMessage) {
      uiState.submittedMessage = resultPreviewMessage;
    }
    if (!uiState.isCurrentView) {
      uiState.waiting = false;
      uiState.sending = false;
      uiState.activeTool = false;
    }
  }
  uiState.conversationId = nextState.conversationId || uiState.conversationId;
  uiState.waiting = Boolean(stateFromResult?.waiting) && uiState.isCurrentView;
  uiState.activeTool = false;
  uiState.completedTool = true;
  reportDiagnosticsEvent("ui_tool_result", {
    toolName: app.getHostContext()?.toolInfo?.tool?.name || "",
    isError: Boolean(result?.isError),
    hasStructuredState: Boolean(stateFromResult),
    anyWaiting: uiState.anyWaiting,
    waiting: uiState.waiting,
    isCurrentView: uiState.isCurrentView,
  });
  render();
  void refreshState().catch((err) => {
    reportDiagnosticsEvent("ui_refresh_failed", {
      source: "tool_result",
      message: err instanceof Error ? err.message : "刷新失败",
    });
    render();
  });
  maybeRequestHistoricalTeardown("tool_result");
};

app.ontoolcancelled = () => {
  if (historicalViewFrozen) {
    return;
  }

  uiState.pendingView = false;
  uiState.anyWaiting = false; uiState.waiting = false; uiState.activeTool = false;
  reportDiagnosticsEvent("ui_tool_cancelled", {
    toolName: app.getHostContext()?.toolInfo?.tool?.name || "",
  });
  render();
};
app.onhostcontextchanged = (hostContext) => {
  if (historicalViewFrozen) {
    return;
  }

  const instanceChanged = syncHostContext(hostContext);
  reportDiagnosticsEvent("ui_host_context_changed", {
    toolName: hostContext?.toolInfo?.tool?.name || "",
    instanceChanged,
    instanceId: hostContext?.toolInfo?.id ?? "",
  });
  if (uiState.connected) {
    if (instanceChanged) {
      acceptedToolInputForInstance = false;
    }

    if (instanceChanged && isCheckMessagesToolContext(hostContext) && !uiState.sending) {
      // 宿主偶尔会先切换到新的 check_messages 实例，再晚一点才补上 tool_input。
      // 这里先乐观地拉起 pending shell，避免最新聊天面板在这段窗口里整块不显示。
      enterPendingViewShell("host_context_changed_instance", { resetRouting: true });
    }

    // 宿主切换上下文时，历史卡片会先收到一轮 host_context_changed。
    // 只有实例真的切换时才提前收起，避免当前等待中的卡片在普通上下文刷新时闪烁。
    if (instanceChanged && uiState.completedTool && !uiState.sending) {
      uiState.waiting = false;
      uiState.activeTool = false;
      uiState.isCurrentView = false;
    }

    if (instanceChanged || uiState.pendingView || !uiState.hydrated) {
      render();
    }
    void refreshState().catch((err) => {
      reportDiagnosticsEvent("ui_refresh_failed", {
        source: "host_context_changed",
        message: err instanceof Error ? err.message : "刷新失败",
      });
      render();
    });
    ensureBootstrapRefresh("host_context_changed");
    return;
  }

  render();
  maybeRequestHistoricalTeardown("host_context_changed");
};

/* ═══════════════════════════════════════════════════
   Start
   ═══════════════════════════════════════════════════ */

async function start() {
  reportDiagnosticsEvent("ui_boot", {
    location: window.location.href,
  });
  render();
  autoResizeInput(true);
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  syncHostContext(app.getHostContext());
  uiState.connected = true;
  reportDiagnosticsEvent("ui_connect_succeeded", {
    toolName: app.getHostContext()?.toolInfo?.tool?.name || "",
    instanceId: uiState.instanceId || "",
  });
  lastSyncedSize = { width: 0, height: 0 };
  render();
  await refreshState();
  ensureBootstrapRefresh("start");
  pollTimer = window.setInterval(() => {
    void refreshState().catch((err) => {
      uiState.connected = false; uiState.error = err instanceof Error ? err.message : "刷新失败"; render();
      reportDiagnosticsEvent("ui_poll_failed", {
        message: err instanceof Error ? err.message : "刷新失败",
      });
    });
  }, POLL_INTERVAL_MS);
}

start().catch((err) => {
  uiState.connected = false;
  uiState.error = err instanceof Error ? err.message : "MCP App 初始化失败";
  reportDiagnosticsEvent("ui_connect_failed", {
    message: err instanceof Error ? err.message : "MCP App 初始化失败",
  });
  render();
});
