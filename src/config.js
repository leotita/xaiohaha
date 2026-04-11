import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
export const SERVER_ENTRY_PATH = fileURLToPath(new URL("../server.js", import.meta.url));
export const BUNDLE_PATH = fileURLToPath(new URL("../app/dist/mcp-chat-ui.bundle.js", import.meta.url));

const DATA_ROOT = process.env.XIAOHAHA_HOME
  ? path.resolve(process.env.XIAOHAHA_HOME)
  : PROJECT_ROOT;

export const LEGACY_STATE_FILE_URL = pathToFileURL(path.join(DATA_ROOT, ".xiaohaha-state.json"));
export const STATE_DB_PATH = path.join(DATA_ROOT, ".xiaohaha-state.sqlite");

export const HOST = process.env.XIAOHAHA_MCP_HOST || "127.0.0.1";
export const PORT = parseInt(process.env.XIAOHAHA_MCP_PORT || "13456", 10);
export const MCP_PATH = process.env.XIAOHAHA_MCP_PATH || "/mcp";

export const DEBUG_LOG = process.env.XIAOHAHA_DEBUG === "1";
export const DEV_MODE = process.env.XIAOHAHA_DEV === "1";

export const CHAT_APP_URI = "ui://xiaohaha/chat-ui-v3.html";
export const SERVICE_LABEL = "com.xiaohaha.mcp";

export function buildLocalUrl(pathname = "/") {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `http://${HOST}:${PORT}${normalizedPath}`;
}

export const BASE_URL = buildLocalUrl("/");
export const MCP_ENDPOINT_URL = buildLocalUrl(MCP_PATH);
