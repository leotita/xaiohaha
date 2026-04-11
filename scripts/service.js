import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HOST,
  MCP_ENDPOINT_URL,
  PORT,
  PROJECT_ROOT,
  SERVER_ENTRY_PATH,
  SERVICE_LABEL,
  buildLocalUrl,
} from "../src/config.js";

const command = process.argv[2];

if (process.platform !== "darwin") {
  console.error("[xiaohaha-mcp] launchd management is only supported on macOS.");
  process.exit(1);
}

const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const logsDir = path.join(os.homedir(), "Library", "Logs");
const serviceRoot = path.join(os.homedir(), ".xiaohaha-mcp");
const runtimeDir = path.join(serviceRoot, "runtime");
const dataDir = path.join(serviceRoot, "data");
const plistPath = path.join(launchAgentsDir, `${SERVICE_LABEL}.plist`);
const stdoutPath = path.join(logsDir, "xiaohaha-mcp.out.log");
const stderrPath = path.join(logsDir, "xiaohaha-mcp.err.log");
const launchDomain = `gui/${process.getuid()}`;
const launchTarget = `${launchDomain}/${SERVICE_LABEL}`;
const runtimeServerEntryPath = path.join(runtimeDir, "server.js");
const runtimeSources = ["server.js", "package.json", "src", "app", "node_modules"];

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
  });

  if (result.status !== 0 && !allowFailure) {
    const stderr = result.stderr?.trim() || result.stdout?.trim() || "Unknown launchctl error";
    throw new Error(stderr);
  }

  return result;
}

function isServiceLoaded() {
  const result = runLaunchctl(["print", launchTarget], { allowFailure: true });
  return result.status === 0;
}

function findPortListener() {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return null;
  }

  const lines = result.stdout.trim().split("\n");
  return lines.length > 1 ? lines[1].trim() : null;
}

function ensureNoConflictingListener() {
  if (isServiceLoaded()) {
    return;
  }

  const listener = findPortListener();
  if (!listener) {
    return;
  }

  throw new Error(`Port ${PORT} is already in use: ${listener}`);
}

function buildPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(SERVICE_LABEL)}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(process.execPath)}</string>
      <string>${xmlEscape(runtimeServerEntryPath)}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${xmlEscape(runtimeDir)}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xmlEscape(process.env.PATH || "")}</string>
      <key>XIAOHAHA_MCP_HOST</key>
      <string>${xmlEscape(HOST)}</string>
      <key>XIAOHAHA_MCP_PORT</key>
      <string>${xmlEscape(PORT)}</string>
      <key>XIAOHAHA_HOME</key>
      <string>${xmlEscape(dataDir)}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${xmlEscape(stdoutPath)}</string>

    <key>StandardErrorPath</key>
    <string>${xmlEscape(stderrPath)}</string>
  </dict>
</plist>
`;
}

function ensureDirectories() {
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(serviceRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
}

function writePlist() {
  ensureDirectories();
  fs.writeFileSync(plistPath, buildPlist(), "utf8");
}

function syncRuntimeFiles() {
  ensureDirectories();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  for (const name of runtimeSources) {
    fs.cpSync(path.join(PROJECT_ROOT, name), path.join(runtimeDir, name), {
      recursive: true,
    });
  }
}

function copyIfMissing(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
    return;
  }

  fs.copyFileSync(sourcePath, targetPath);
}

function migrateStateFilesIfNeeded() {
  copyIfMissing(path.join(PROJECT_ROOT, ".xiaohaha-state.json"), path.join(dataDir, ".xiaohaha-state.json"));
  copyIfMissing(path.join(PROJECT_ROOT, ".xiaohaha-state.sqlite"), path.join(dataDir, ".xiaohaha-state.sqlite"));
  copyIfMissing(path.join(PROJECT_ROOT, ".xiaohaha-state.sqlite-shm"), path.join(dataDir, ".xiaohaha-state.sqlite-shm"));
  copyIfMissing(path.join(PROJECT_ROOT, ".xiaohaha-state.sqlite-wal"), path.join(dataDir, ".xiaohaha-state.sqlite-wal"));
}

function ensureInstalled() {
  if (!fs.existsSync(plistPath)) {
    throw new Error(`Service is not installed. Run: npm run service:install`);
  }
}

function install() {
  ensureNoConflictingListener();
  syncRuntimeFiles();
  migrateStateFilesIfNeeded();
  writePlist();
  runLaunchctl(["bootout", launchDomain, plistPath], { allowFailure: true });
  runLaunchctl(["bootstrap", launchDomain, plistPath]);
  runLaunchctl(["enable", launchTarget], { allowFailure: true });
  runLaunchctl(["kickstart", "-k", launchTarget]);

  console.log(`[xiaohaha-mcp] Installed launchd service: ${SERVICE_LABEL}`);
  console.log(`[xiaohaha-mcp] MCP endpoint: ${MCP_ENDPOINT_URL}`);
  console.log(`[xiaohaha-mcp] Logs: ${stdoutPath} / ${stderrPath}`);
  console.log(`[xiaohaha-mcp] Runtime: ${runtimeDir}`);
  console.log(`[xiaohaha-mcp] Data: ${dataDir}`);
}

function start() {
  ensureInstalled();
  ensureNoConflictingListener();
  syncRuntimeFiles();

  if (!isServiceLoaded()) {
    runLaunchctl(["bootstrap", launchDomain, plistPath]);
  }

  runLaunchctl(["kickstart", "-k", launchTarget]);
  console.log(`[xiaohaha-mcp] Service started: ${SERVICE_LABEL}`);
}

function stop() {
  ensureInstalled();

  if (!isServiceLoaded()) {
    console.log(`[xiaohaha-mcp] Service is already stopped: ${SERVICE_LABEL}`);
    return;
  }

  runLaunchctl(["bootout", launchDomain, plistPath]);
  console.log(`[xiaohaha-mcp] Service stopped: ${SERVICE_LABEL}`);
}

function restart() {
  ensureInstalled();

  if (isServiceLoaded()) {
    runLaunchctl(["bootout", launchDomain, plistPath], { allowFailure: true });
  }

  ensureNoConflictingListener();
  syncRuntimeFiles();
  runLaunchctl(["bootstrap", launchDomain, plistPath]);
  runLaunchctl(["kickstart", "-k", launchTarget]);
  console.log(`[xiaohaha-mcp] Service restarted: ${SERVICE_LABEL}`);
}

function uninstall() {
  if (isServiceLoaded()) {
    runLaunchctl(["bootout", launchDomain, plistPath], { allowFailure: true });
  }

  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
  }

  console.log(`[xiaohaha-mcp] Service uninstalled: ${SERVICE_LABEL}`);
}

async function status() {
  const loaded = isServiceLoaded();
  const listener = findPortListener();

  let health = null;
  let runtimeStatus = null;

  try {
    const response = await fetch(buildLocalUrl("/healthz"), {
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      health = await response.json();
    }
  } catch {}

  try {
    const response = await fetch(buildLocalUrl("/status"), {
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      runtimeStatus = await response.json();
    }
  } catch {}

  console.log(`[xiaohaha-mcp] launchd loaded: ${loaded ? "yes" : "no"}`);
  if (!loaded && listener) {
    console.log(`[xiaohaha-mcp] port listener: ${listener}`);
  }
  console.log(`[xiaohaha-mcp] health endpoint: ${health?.ok ? "ok" : "unreachable"}`);
  console.log(`[xiaohaha-mcp] endpoint: ${MCP_ENDPOINT_URL}`);

  if (runtimeStatus) {
    console.log(`[xiaohaha-mcp] uptime: ${runtimeStatus.uptimeSeconds}s`);
    console.log(`[xiaohaha-mcp] mcp sessions: ${runtimeStatus.mcpSessions}`);
    console.log(
      `[xiaohaha-mcp] chat sessions: ${runtimeStatus.chat.sessions}, waiting: ${runtimeStatus.chat.waitingSessions}, queued: ${runtimeStatus.chat.queuedMessages}`
    );
  }

  console.log(`[xiaohaha-mcp] logs: ${stdoutPath} / ${stderrPath}`);
  console.log(`[xiaohaha-mcp] runtime: ${runtimeDir}`);
  console.log(`[xiaohaha-mcp] data: ${dataDir}`);
}

const handlers = {
  install,
  start,
  stop,
  restart,
  uninstall,
  status,
};

if (!command || !handlers[command]) {
  console.error("Usage: node scripts/service.js <install|start|stop|restart|status|uninstall>");
  process.exit(1);
}

try {
  await handlers[command]();
} catch (error) {
  console.error(`[xiaohaha-mcp] ${error.message}`);
  process.exit(1);
}
