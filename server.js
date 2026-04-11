import http from "node:http";

import { BASE_URL, HOST, MCP_ENDPOINT_URL, PORT } from "./src/config.js";
import { createChatHttpServer } from "./src/http-server.js";
import { debugLog, registerShutdownHandlers } from "./src/process-manager.js";
import { SessionService } from "./src/session-service.js";

async function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    const handleListening = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      server.off("error", handleError);
      server.off("listening", handleListening);
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
}

async function start() {
  const sessionService = new SessionService();
  await sessionService.initialize();

  const runtime = createChatHttpServer({ sessionService });
  const httpServer = http.createServer(runtime.app);

  registerShutdownHandlers(async () => {
    await runtime.close();
    await new Promise((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  await listen(httpServer, PORT, HOST);
  debugLog(`[xiaohaha-mcp] Service ready at ${BASE_URL}`);
  debugLog(`[xiaohaha-mcp] MCP endpoint ${MCP_ENDPOINT_URL}`);
  console.log(`[xiaohaha-mcp] Listening on ${BASE_URL}`);
}

await start();
