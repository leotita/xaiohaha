import { DEBUG_LOG } from "./config.js";

let shuttingDown = false;

export function debugLog(...args) {
  if (DEBUG_LOG) {
    console.error(...args);
  }
}

export function registerShutdownHandlers(close) {
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    debugLog(`[xiaohaha-mcp] Received ${signal}, shutting down`);

    try {
      await close(signal);
      process.exit(0);
    } catch (error) {
      console.error("[xiaohaha-mcp] Failed to shut down cleanly", error);
      process.exit(1);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGHUP", () => void shutdown("SIGHUP"));
}
