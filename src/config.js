import { fileURLToPath } from "node:url";

export const SERVER_ENTRY_PATH = fileURLToPath(new URL("../server.js", import.meta.url));
export const SERVER_DIR_PATH = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
export const HTTP_PID_FILE_PATH = fileURLToPath(new URL("../.xiaohaha-http.pid", import.meta.url));
export const LEGACY_STATE_FILE_URL = new URL("../.xiaohaha-state.json", import.meta.url);
export const STATE_DB_PATH = fileURLToPath(new URL("../.xiaohaha-state.sqlite", import.meta.url));

export const PORT = parseInt(process.env.XIAOHAHA_MCP_PORT || "13456", 10);
export const DEBUG_LOG = process.env.XIAOHAHA_DEBUG === "1";
export const DEV_MODE = process.env.XIAOHAHA_DEV === "1";

export const CHAT_APP_URI = "ui://xiaohaha/chat-ui-v3.html";
export const BUNDLE_PATH = fileURLToPath(new URL("../app/dist/mcp-chat-ui.bundle.js", import.meta.url));
