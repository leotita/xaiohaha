import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { BUNDLE_PATH, HOST, MCP_PATH, PORT } from "./config.js";
import { CHAT_PAGE_HTML } from "./http-chat-page.js";
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

export function createChatHttpServer({ sessionService, attachmentStore }) {
  const app = createHttpApp();
  const mcpSessions = new Map();
  const startedAt = Date.now();

  function getRuntimeStatus() {
    return {
      ok: true,
      host: HOST,
      port: PORT,
      mcpPath: MCP_PATH,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      mcpSessions: mcpSessions.size,
      chat: sessionService.getDiagnostics(),
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
      },
    });
    const server = createMcpServer(sessionService, attachmentStore);

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
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const previewMessage = typeof payload.previewMessage === "string" && payload.previewMessage.trim()
      ? payload.previewMessage.trim()
      : typeof payload.preview_message === "string" && payload.preview_message.trim()
        ? payload.preview_message.trim()
        : buildPreviewFromInput(String(payload.message || ""), attachments);

    if (instanceId) {
      const session = sessionService.resolveSession({
        conversationId,
        instanceId,
      });

      if (!session) {
        res.status(409).json({ ok: false, error: "conversation not found" });
        return;
      }

      sessionService.bindAppInstanceToSession(session, instanceId);
      sessionService.rememberToolPreview(session, instanceId, previewMessage);

      if (sessionService.enqueueUserMessageWithAttachments(session, payload.message, previewMessage, attachments)) {
        const state = sessionService.getChatState({
          conversationId: session.conversationId,
          instanceId,
        });
        res.json({ ok: true, conversationId: session.conversationId, state });
        return;
      }

      res.status(400).json({ ok: false, error: "empty" });
      return;
    }

    const { session, error } = sessionService.resolveBrowserSession(conversationId);

    if (!session) {
      res.status(409).json({ ok: false, error });
      return;
    }

    if (sessionService.enqueueUserMessageWithAttachments(session, payload.message, previewMessage, attachments)) {
      res.json({ ok: true, conversationId: session.conversationId });
      return;
    }

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

    const state = sessionService.getChatState({
      conversationId,
      instanceId,
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
