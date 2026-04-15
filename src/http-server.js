import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { BUNDLE_PATH, HOST, MCP_PATH, PORT, WORKSPACE_ROOT } from "./config.js";
import { CHAT_PAGE_HTML } from "./http-chat-page.js";
import { DiagnosticsBuffer } from "./diagnostics.js";
import { buildPreviewFromInput, readProjectFile, searchProjectFiles } from "./mcp-app.js";
import { createMcpServer } from "./mcp-server.js";
import { debugLog } from "./process-manager.js";
import { MAX_ATTACHMENT_UPLOAD_BYTES } from "./attachment-store.js";

const HTTP_JSON_LIMIT = "16mb";
const execFileAsync = promisify(execFile);
const CLIPBOARD_IMAGE_SWIFT_PATH = fileURLToPath(new URL("./clipboard-image.swift", import.meta.url));

/** Host header check to mitigate DNS rebinding. */
function localhostHostValidation() {
  const allowed = new Set(["127.0.0.1", "localhost", "::1"]);
  return (req, res, next) => {
    const hostname = req.hostname || "";
    if (allowed.has(hostname)) {
      next();
      return;
    }
    res.status(403).send("Forbidden: invalid Host header");
  };
}

function hostHeaderValidation(allowedHosts) {
  const normalized = new Set(allowedHosts.map((h) => String(h).toLowerCase()));
  return (req, res, next) => {
    const hostname = (req.hostname || "").toLowerCase();
    if (normalized.has(hostname)) {
      next();
      return;
    }
    res.status(403).send("Forbidden: invalid Host header");
  };
}

function getHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0] || "";
  }

  return typeof value === "string" ? value : "";
}

function sendJsonRpcError(res, statusCode, message) {
  res.status(statusCode).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message,
    },
    id: null,
  });
}

function summarizeJsonRpcRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const detail = {
    jsonrpcMethod: typeof body.method === "string" ? body.method : "",
    requestId: body.id ?? null,
  };
  const params = body.params && typeof body.params === "object" ? body.params : null;

  if (detail.jsonrpcMethod === "tools/call" && params) {
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    detail.toolName = typeof params.name === "string" ? params.name : "";
    detail.conversationId = typeof args.conversation_id === "string" ? args.conversation_id : "";
    detail.instanceId = typeof args.instance_id === "string" ? args.instance_id : "";
    detail.hasAiResponse = typeof args.ai_response === "string" && args.ai_response.trim().length > 0;
    detail.messageLength = typeof args.message === "string" ? args.message.trim().length : 0;
    detail.attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
  } else if (detail.jsonrpcMethod === "resources/read" && params) {
    detail.resourceUri = typeof params.uri === "string" ? params.uri : "";
  }

  return detail;
}

function createHttpApp() {
  const app = express();
  app.use(express.json({ limit: HTTP_JSON_LIMIT }));

  const localhostHosts = ["127.0.0.1", "localhost", "::1"];
  if (localhostHosts.includes(HOST)) {
    app.use(localhostHostValidation());
  } else if (HOST === "0.0.0.0" || HOST === "::") {
    console.warn(
      `Warning: Server is binding to ${HOST} without DNS rebinding protection. ` +
      "Consider restricting allowed hosts or using authentication."
    );
  } else {
    app.use(hostHeaderValidation([HOST]));
  }

  return app;
}

async function readSystemClipboardImage() {
  const { stdout } = await execFileAsync("/usr/bin/swift", [CLIPBOARD_IMAGE_SWIFT_PATH], {
    maxBuffer: 12 * 1024 * 1024,
  });
  const payload = JSON.parse(stdout);
  if (!payload?.ok || typeof payload?.base64 !== "string") {
    throw new Error("clipboard image unavailable");
  }
  return payload;
}

async function readRawRequestBody(req, maxBytes) {
  const declaredLength = Number.parseInt(getHeaderValue(req.headers["content-length"]), 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error("request entity too large");
    error.statusCode = 413;
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > maxBytes) {
      const error = new Error("request entity too large");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks, total);
}

function decodeAttachmentUploadBuffer(buffer, encoding) {
  const normalizedEncoding = typeof encoding === "string" ? encoding.trim().toLowerCase() : "";
  if (normalizedEncoding !== "data_url") {
    return buffer;
  }

  const text = buffer.toString("utf8");
  const match = text.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) {
    const error = new Error("invalid data url payload");
    error.statusCode = 400;
    throw error;
  }

  return Buffer.from(match[2], "base64");
}

function normalizeProjectPath(filePath) {
  let normalized = String(filePath || "")
    .replaceAll("\\", "/")
    .trim();

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("file://")) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch {}
  }

  const runtimeMarker = "/runtime/workspace/";
  const markerIndex = normalized.lastIndexOf(runtimeMarker);
  if (markerIndex >= 0) {
    normalized = normalized.slice(markerIndex + runtimeMarker.length);
  }

  const workspaceRoot = String(WORKSPACE_ROOT || "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const normalizedLower = normalized.toLowerCase();
  const workspaceLower = workspaceRoot.toLowerCase();

  if (workspaceRoot && normalizedLower.startsWith(`${workspaceLower}/`)) {
    normalized = normalized.slice(workspaceRoot.length + 1);
  } else if (workspaceRoot && normalizedLower === workspaceLower) {
    normalized = "";
  }

  return normalized
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function isPathInsideWorkspace(workspaceRoot, targetPath) {
  const relativePath = path.relative(workspaceRoot, targetPath);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function resolveWorkspaceFilePath(filePath) {
  const normalizedPath = normalizeProjectPath(filePath);
  if (!normalizedPath) {
    throw new Error("文件路径不能为空");
  }

  const fullPath = path.resolve(WORKSPACE_ROOT, normalizedPath);
  if (!isPathInsideWorkspace(WORKSPACE_ROOT, fullPath)) {
    throw new Error("只能打开当前项目内的文件");
  }

  const stat = await fs.stat(fullPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error("未找到文件");
  }

  return {
    fullPath,
    relativePath: normalizedPath,
  };
}

export function createChatHttpServer({ sessionService, attachmentStore }) {
  const app = createHttpApp();
  const mcpSessions = new Map();
  const startedAt = Date.now();
  const diagnostics = new DiagnosticsBuffer();

  function recordDiagnostic(type, detail = {}) {
    const entry = diagnostics.record(type, detail);
    debugLog(`[xiaohaha-mcp][diag] ${entry.type}`, entry.detail);
    return entry;
  }

  function getRuntimeStatus() {
    return {
      ok: true,
      host: HOST,
      port: PORT,
      mcpPath: MCP_PATH,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      mcpSessions: mcpSessions.size,
      chat: sessionService.getDiagnostics(),
      diagnostics: {
        count: diagnostics.count,
      },
    };
  }

  async function closeMcpSession(sessionId) {
    const entry = mcpSessions.get(sessionId);
    if (!entry) {
      return false;
    }

    mcpSessions.delete(sessionId);
    sessionService.cancelPendingWaitsForClientSession(sessionId);

    await Promise.allSettled([
      entry.server.close(),
      entry.transport.close(),
    ]);

    debugLog(`[xiaohaha-mcp] Closed MCP HTTP session ${sessionId}`);
    recordDiagnostic("mcp_session_closed", { mcpSessionId: sessionId });
    return true;
  }

  async function ensureMcpSession(req, res) {
    const sessionId = getHeaderValue(req.headers["mcp-session-id"]);

    if (sessionId) {
      const entry = mcpSessions.get(sessionId);

      if (!entry) {
        sendJsonRpcError(res, 404, "Session not found");
        return null;
      }

      return entry;
    }

    if (!isInitializeRequest(req.body)) {
      sendJsonRpcError(res, 400, "Bad Request: initialize must be sent without MCP-Session-Id");
      return null;
    }

    let entry = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (transportSessionId) => {
        entry = {
          sessionId: transportSessionId,
          transport,
          server,
        };
        mcpSessions.set(transportSessionId, entry);
        debugLog(`[xiaohaha-mcp] Opened MCP HTTP session ${transportSessionId}`);
        recordDiagnostic("mcp_session_opened", { mcpSessionId: transportSessionId });
      },
    });
    const server = createMcpServer(sessionService, attachmentStore, {
      record: recordDiagnostic,
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        void closeMcpSession(transport.sessionId);
      }
    };

    await server.connect(transport);
    return entry || { sessionId: null, transport, server };
  }

  async function handleMcpRequest(req, res) {
    try {
      const entry = await ensureMcpSession(req, res);
      if (!entry) {
        return;
      }

      recordDiagnostic("mcp_request", {
        mcpSessionId: entry.sessionId || entry.transport?.sessionId || "",
        ...summarizeJsonRpcRequest(req.body),
      });

      await entry.transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[xiaohaha-mcp] MCP request failed", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, "Internal server error");
      }
    }
  }

  app.get("/", (_req, res) => {
    res.type("html").send(CHAT_PAGE_HTML);
  });

  app.get("/poll", (req, res) => {
    const afterId = parseInt(String(req.query.after || "0"), 10);
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    const { session, error } = sessionService.resolveBrowserSession(conversationId);

    if (!session) {
      res.json({
        waiting: false,
        queueLength: 0,
        responses: [],
        error,
      });
      return;
    }

    const newResponses = session.aiResponses.filter((response) => response.id > afterId);
    res.json({
      conversationId: session.conversationId,
      waiting: session.waitingResolve !== null,
      queueLength: session.messageQueue.length,
      responses: newResponses,
    });
  });

  app.get("/conversations", (_req, res) => {
    const { session, error } = sessionService.resolveBrowserSession("");
    res.json({
      ok: true,
      selectedConversationId: session?.conversationId || "",
      error,
      sessions: sessionService.listBrowserSessions(),
    });
  });

  app.get("/conversation", (req, res) => {
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    const resolved = conversationId ? null : sessionService.resolveBrowserSession("");
    const snapshot = conversationId
      ? sessionService.getBrowserSessionSnapshot(conversationId)
      : resolved?.session
        ? sessionService.getBrowserSessionSnapshot(resolved.session.conversationId)
        : null;

    if (!snapshot) {
      res.status(404).json({ ok: false, error: conversationId ? "conversation not found" : "no active conversation" });
      return;
    }

    res.json({
      ok: true,
      ...snapshot,
    });
  });

  app.get("/diagnostics", (req, res) => {
    const parsedLimit = Number.parseInt(String(req.query.limit || ""), 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(3000, parsedLimit))
      : 100;
    const typeQuery = typeof req.query.type === "string" ? req.query.type.trim() : "";
    const conversationIdQuery = typeof req.query.conversationId === "string"
      ? req.query.conversationId.trim()
      : typeof req.query.conversation_id === "string"
        ? req.query.conversation_id.trim()
        : "";
    const instanceIdQuery = typeof req.query.instanceId === "string"
      ? req.query.instanceId.trim()
      : typeof req.query.instance_id === "string"
        ? req.query.instance_id.trim()
        : "";

    let entries = diagnostics.list(3000);

    if (typeQuery) {
      entries = entries.filter((entry) => entry.type.includes(typeQuery));
    }

    if (conversationIdQuery) {
      entries = entries.filter((entry) =>
        entry.detail?.conversationId === conversationIdQuery
        || entry.detail?.conversation_id === conversationIdQuery
      );
    }

    if (instanceIdQuery) {
      entries = entries.filter((entry) =>
        entry.detail?.instanceId === instanceIdQuery
        || entry.detail?.instance_id === instanceIdQuery
      );
    }

    res.json({
      ok: true,
      entries: entries.slice(-limit),
    });
  });

  app.post("/app/log", (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const event = typeof payload.event === "string" ? payload.event : "unknown";
    const conversationId = payload.conversationId || payload.conversation_id || "";
    const instanceId = payload.instanceId || payload.instance_id || "";
    const routeHint = typeof payload.routeHint === "string"
      ? payload.routeHint
      : typeof payload.route_hint === "string"
        ? payload.route_hint
        : "";
    const resourceUri = typeof payload.resourceUri === "string"
      ? payload.resourceUri
      : typeof payload.resource_uri === "string"
        ? payload.resource_uri
        : "";
    recordDiagnostic("app_view_event", {
      event,
      conversationId,
      instanceId,
      routeHint,
      resourceUri,
      detail: payload.detail && typeof payload.detail === "object" ? payload.detail : {},
    });

    if (event === "ui_tool_input" && instanceId) {
      const session = sessionService.resolveSession({
        conversationId,
        instanceId,
        aiResponseHint: routeHint,
        allowClientSessionFallback: false,
      });
      if (session) {
        sessionService.bindAppInstanceToSession(session, instanceId, {
          resourceUri,
          routeHint,
        });
        recordDiagnostic("app_view_bound_from_http_log", {
          event,
          conversationId: session.conversationId,
          instanceId,
          resourceUri,
        });
      }
    }

    res.json({ ok: true });
  });

  app.post("/app/attachments", async (req, res) => {
    try {
      const type = typeof req.query.type === "string" ? req.query.type.trim() : "";
      if (!["image", "file", "snippet"].includes(type)) {
        res.status(400).json({ ok: false, error: "invalid attachment type" });
        return;
      }

      const rawBuffer = await readRawRequestBody(req, MAX_ATTACHMENT_UPLOAD_BYTES);
      const buffer = decodeAttachmentUploadBuffer(
        rawBuffer,
        typeof req.query.encoding === "string" ? req.query.encoding : ""
      );
      const parsedSize = Number.parseInt(String(req.query.size || ""), 10);
      const attachment = await attachmentStore.saveAttachment({
        type,
        name: typeof req.query.name === "string" ? req.query.name : "",
        mimeType: typeof req.query.mimeType === "string" ? req.query.mimeType : getHeaderValue(req.headers["content-type"]),
        size: Number.isFinite(parsedSize) ? parsedSize : buffer.length,
        path: typeof req.query.path === "string" ? req.query.path : "",
        lineRef: typeof req.query.lineRef === "string" ? req.query.lineRef : "",
        buffer,
      });

      res.json({
        ok: true,
        attachment,
      });
    } catch (error) {
      const statusCode = error?.statusCode === 413 ? 413 : 500;
      const errorMessage = error instanceof Error ? error.message : "上传附件失败";
      res.status(statusCode).json({
        ok: false,
        error: statusCode === 413
          ? "附件过大，超过 8MB 上传上限"
          : statusCode === 400 ? errorMessage : errorMessage,
      });
    }
  });

  app.get("/app/clipboard-image", async (_req, res) => {
    try {
      const image = await readSystemClipboardImage();
      res.json({
        ok: true,
        image,
      });
    } catch (error) {
      res.status(404).json({
        ok: false,
        error: error instanceof Error ? error.message : "剪贴板中没有图片",
      });
    }
  });

  app.post("/send", (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const conversationId = payload.conversationId || payload.conversation_id;
    const instanceId = payload.instanceId || payload.instance_id;
    const routeHint = typeof payload.routeHint === "string"
      ? payload.routeHint
      : typeof payload.route_hint === "string"
        ? payload.route_hint
        : "";
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const previewMessage = typeof payload.previewMessage === "string" && payload.previewMessage.trim()
      ? payload.previewMessage.trim()
      : typeof payload.preview_message === "string" && payload.preview_message.trim()
        ? payload.preview_message.trim()
        : buildPreviewFromInput(String(payload.message || ""), attachments);

    recordDiagnostic("app_send_http", {
      conversationId: conversationId || "",
      instanceId: instanceId || "",
      routeHint,
      attachmentCount: attachments.length,
      previewMessage,
      hasMessage: typeof payload.message === "string" && payload.message.trim().length > 0,
    });

    if (instanceId || conversationId || routeHint) {
      const session = sessionService.resolveSession({
        conversationId,
        instanceId,
        aiResponseHint: routeHint,
      });

      if (!session) {
        recordDiagnostic("app_send_http_failed", {
          conversationId: conversationId || "",
          instanceId: instanceId || "",
          routeHint,
          reason: "conversation_not_found",
        });
        res.status(409).json({ ok: false, error: "conversation not found" });
        return;
      }

      sessionService.bindAppInstanceToSession(session, instanceId);
      sessionService.rememberToolPreview(session, instanceId || session.currentAppInstanceId, previewMessage);

      if (sessionService.enqueueUserMessageWithAttachments(session, payload.message, previewMessage, attachments)) {
        const state = sessionService.getChatState({
          conversationId: session.conversationId,
          instanceId,
          aiResponseHint: routeHint,
          bindInstance: false,
        });
        recordDiagnostic("app_send_http_enqueued", {
          conversationId: session.conversationId,
          instanceId: instanceId || session.currentAppInstanceId || "",
          anyWaiting: state.anyWaiting,
          waiting: state.waiting,
          isCurrentView: state.isCurrentView,
        });
        res.json({ ok: true, conversationId: session.conversationId, state });
        return;
      }

      recordDiagnostic("app_send_http_failed", {
        conversationId: session.conversationId,
        instanceId: instanceId || session.currentAppInstanceId || "",
        reason: "empty_message",
      });
      res.status(400).json({ ok: false, error: "empty" });
      return;
    }

    const { session, error } = sessionService.resolveBrowserSession(conversationId);

    if (!session) {
      recordDiagnostic("browser_send_failed", {
        conversationId: conversationId || "",
        reason: error || "conversation_not_found",
      });
      res.status(409).json({ ok: false, error });
      return;
    }

    if (sessionService.enqueueUserMessageWithAttachments(session, payload.message, previewMessage, attachments)) {
      recordDiagnostic("browser_send_enqueued", {
        conversationId: session.conversationId,
        attachmentCount: attachments.length,
      });
      res.json({ ok: true, conversationId: session.conversationId });
      return;
    }

    recordDiagnostic("browser_send_failed", {
      conversationId: session.conversationId,
      reason: "empty_message",
    });
    res.status(400).json({ ok: false, error: "empty" });
  });

  app.get("/app/state", (req, res) => {
    const conversationId = typeof req.query.conversationId === "string"
      ? req.query.conversationId
      : typeof req.query.conversation_id === "string"
        ? req.query.conversation_id
        : "";
    const instanceId = typeof req.query.instanceId === "string"
      ? req.query.instanceId
      : typeof req.query.instance_id === "string"
        ? req.query.instance_id
        : "";
    const routeHint = typeof req.query.routeHint === "string"
      ? req.query.routeHint
      : typeof req.query.route_hint === "string"
        ? req.query.route_hint
        : "";
    const resourceUri = typeof req.query.resourceUri === "string"
      ? req.query.resourceUri
      : typeof req.query.resource_uri === "string"
        ? req.query.resource_uri
        : "";
    const bindInstance = String(
      typeof req.query.bindInstance === "string"
        ? req.query.bindInstance
        : typeof req.query.bind_instance === "string"
          ? req.query.bind_instance
          : ""
    ) === "1";

    const state = sessionService.getChatState({
      conversationId,
      instanceId,
      aiResponseHint: routeHint,
      resourceUri,
      allowClientSessionFallback: false,
      bindInstance,
    });

    recordDiagnostic("app_state_query", {
      conversationId,
      instanceId,
      routeHint,
      resourceUri,
      bindInstance,
      anyWaiting: state.anyWaiting,
      waiting: state.waiting,
      isCurrentView: state.isCurrentView,
      queueLength: state.queueLength,
    });

    res.json({
      ok: true,
      state,
    });
  });

  app.get("/app/project-files", async (req, res) => {
    try {
      const query = typeof req.query.query === "string" ? req.query.query : "";
      const parsedLimit = Number.parseInt(String(req.query.limit || ""), 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(20, parsedLimit))
        : 20;
      const items = await searchProjectFiles(query, limit);
      res.json({ ok: true, items });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "搜索项目文件失败",
      });
    }
  });

  app.get("/app/project-file", async (req, res) => {
    try {
      const filePath = typeof req.query.path === "string" ? req.query.path : "";
      const file = await readProjectFile(filePath);
      res.json(file);
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "读取文件失败",
      });
    }
  });

  app.post("/app/open-project-file", async (req, res) => {
    try {
      const payload = req.body && typeof req.body === "object" ? req.body : {};
      const { fullPath, relativePath } = await resolveWorkspaceFilePath(payload.path);

      try {
        await execFileAsync("/usr/bin/open", ["-a", "Cursor", fullPath]);
      } catch {
        await execFileAsync("/usr/bin/open", [fullPath]);
      }

      res.json({
        ok: true,
        path: relativePath,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "打开文件失败",
      });
    }
  });

  app.post("/app/context", (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const conversationId = payload.conversationId || payload.conversation_id;
    const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
    const session = sessionService.resolveSession({
      conversationId,
      createIfMissing: true,
    });

    if (!session) {
      res.status(404).json({ ok: false, error: "conversation not found" });
      return;
    }

    session.contextSummary = summary;
    session.pendingCompact = false;

    res.json({
      ok: true,
      hasContext: Boolean(session.contextSummary),
      conversationId: session.conversationId,
    });
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: getRuntimeStatus().uptimeSeconds,
    });
  });

  app.get("/status", (_req, res) => {
    res.json(getRuntimeStatus());
  });

  app.get("/dev/bundle-mtime", async (_req, res) => {
    try {
      const stat = await fs.stat(BUNDLE_PATH);
      res.json({ mtime: stat.mtimeMs });
    } catch {
      res.json({ mtime: 0 });
    }
  });

  app.post(MCP_PATH, (req, res) => {
    void handleMcpRequest(req, res);
  });

  app.get(MCP_PATH, (req, res) => {
    const sessionId = getHeaderValue(req.headers["mcp-session-id"]);
    if (!sessionId) {
      sendJsonRpcError(res, 400, "Bad Request: MCP-Session-Id header is required");
      return;
    }

    if (!mcpSessions.has(sessionId)) {
      sendJsonRpcError(res, 404, "Session not found");
      return;
    }

    void handleMcpRequest(req, res);
  });

  app.delete(MCP_PATH, (req, res) => {
    const sessionId = getHeaderValue(req.headers["mcp-session-id"]);
    if (!sessionId) {
      sendJsonRpcError(res, 400, "Bad Request: MCP-Session-Id header is required");
      return;
    }

    if (!mcpSessions.has(sessionId)) {
      sendJsonRpcError(res, 404, "Session not found");
      return;
    }

    void handleMcpRequest(req, res);
  });

  app.use((_req, res) => {
    res.status(404).send("Not Found");
  });

  return {
    app,
    async close() {
      const sessionIds = [...mcpSessions.keys()];
      await Promise.allSettled(sessionIds.map((sessionId) => closeMcpSession(sessionId)));
    },
    getRuntimeStatus,
  };
}
