import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { BUNDLE_PATH, HOST, MCP_PATH, PORT } from "./config.js";
import { CHAT_PAGE_HTML } from "./http-chat-page.js";
import { createMcpServer } from "./mcp-server.js";
import { debugLog } from "./process-manager.js";

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

export function createChatHttpServer({ sessionService }) {
  const app = createMcpExpressApp({ host: HOST });
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
    const server = createMcpServer(sessionService);

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

  app.post("/send", (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const conversationId = payload.conversationId || payload.conversation_id;
    const { session, error } = sessionService.resolveBrowserSession(conversationId);

    if (!session) {
      res.status(409).json({ ok: false, error });
      return;
    }

    if (sessionService.enqueueUserMessage(session, payload.message)) {
      res.json({ ok: true, conversationId: session.conversationId });
      return;
    }

    res.status(400).json({ ok: false, error: "empty" });
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
