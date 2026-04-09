import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PORT } from "./src/config.js";
import { createChatHttpServer } from "./src/http-server.js";
import { registerChatAppIntegration } from "./src/mcp-app.js";
import { debugLog, listenHttpServerWithFallback, registerShutdownHandlers } from "./src/process-manager.js";
import { SessionService } from "./src/session-service.js";

async function start() {
  // 入口文件只负责组装依赖和启动顺序，具体实现下沉到独立模块，避免再次膨胀。
  const sessionService = new SessionService();
  await sessionService.initialize();

  const mcpServer = new McpServer({
    name: "xiaohaha-message",
    version: "1.0.0",
  });

  registerChatAppIntegration(mcpServer, sessionService);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  debugLog("[xiaohaha-mcp] MCP server connected");

  const httpServer = createChatHttpServer({
    port: PORT,
    sessionService,
  });

  registerShutdownHandlers(httpServer);
  await listenHttpServerWithFallback(httpServer, PORT);
}

await start();
