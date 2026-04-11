import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerChatAppIntegration } from "./mcp-app.js";

export function createMcpServer(sessionService) {
  const mcpServer = new McpServer({
    name: "xiaohaha-mcp",
    version: "1.0.0",
  });

  registerChatAppIntegration(mcpServer, sessionService);
  return mcpServer;
}
