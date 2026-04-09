import http from "node:http";

import { CHAT_PAGE_HTML } from "./http-chat-page.js";

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function handleSendRequest(req, res, sessionService) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      const { message, conversationId, conversation_id } = JSON.parse(body);

      // 同时兼容驼峰和下划线字段，避免旧页面和新工具之间的请求格式不一致。
      const { session, error } = sessionService.resolveBrowserSession(conversationId || conversation_id);

      if (!session) {
        sendJson(res, 409, { ok: false, error });
        return;
      }

      if (sessionService.enqueueUserMessage(session, message)) {
        sendJson(res, 200, { ok: true, conversationId: session.conversationId });
      } else {
        sendJson(res, 400, { ok: false, error: "empty" });
      }
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid json" });
    }
  });
}

export function createChatHttpServer({ port, sessionService }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(CHAT_PAGE_HTML);
      return;
    }

    if (req.method === "GET" && url.pathname === "/poll") {
      const afterId = parseInt(url.searchParams.get("after") || "0", 10);
      const conversationId = url.searchParams.get("conversationId");
      const { session, error } = sessionService.resolveBrowserSession(conversationId);

      if (!session) {
        sendJson(res, 200, {
          waiting: false,
          queueLength: 0,
          responses: [],
          error,
        });
        return;
      }

      const newResponses = session.aiResponses.filter((response) => response.id > afterId);
      sendJson(res, 200, {
        conversationId: session.conversationId,
        waiting: session.waitingResolve !== null,
        queueLength: session.messageQueue.length,
        responses: newResponses,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/send") {
      handleSendRequest(req, res, sessionService);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });
}
