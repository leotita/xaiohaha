import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { DEBUG_LOG, HTTP_PID_FILE_PATH, SERVER_DIR_PATH, SERVER_ENTRY_PATH } from "./config.js";

let shuttingDown = false;

export function debugLog(...args) {
  if (DEBUG_LOG) {
    console.error(...args);
  }
}

function readHttpPidRecord() {
  try {
    const raw = readFileSync(HTTP_PID_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed.pid !== "number") {
      return null;
    }

    return {
      pid: parsed.pid,
      port: typeof parsed.port === "number" ? parsed.port : null,
      entryPath: typeof parsed.entryPath === "string" ? parsed.entryPath : "",
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      debugLog("[xiaohaha-mcp] Failed to read pid record", error);
    }
    return null;
  }
}

function writeHttpPidRecord(port) {
  try {
    writeFileSync(
      HTTP_PID_FILE_PATH,
      JSON.stringify(
        {
          pid: process.pid,
          port,
          entryPath: SERVER_ENTRY_PATH,
          startedAt: Date.now(),
        },
        null,
        2
      )
    );
  } catch (error) {
    debugLog("[xiaohaha-mcp] Failed to write pid record", error);
  }
}

function removeHttpPidRecordIfOwned() {
  try {
    const record = readHttpPidRecord();
    if (record?.pid === process.pid) {
      unlinkSync(HTTP_PID_FILE_PATH);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      debugLog("[xiaohaha-mcp] Failed to remove pid record", error);
    }
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function getProcessCommand(pid) {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });

  if (result.error) {
    debugLog("[xiaohaha-mcp] Failed to inspect process command", result.error);
    return "";
  }

  if (result.status !== 0) {
    return "";
  }

  return result.stdout.trim();
}

function getProcessWorkingDirectory(pid) {
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });

  if (result.error) {
    debugLog("[xiaohaha-mcp] Failed to inspect process working directory", result.error);
    return "";
  }

  if (result.status !== 0) {
    return "";
  }

  const cwdLine = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("n"));

  return cwdLine ? cwdLine.slice(1) : "";
}

function isOwnedXiaohahaProcess(pid) {
  if (!pid || pid === process.pid) {
    return false;
  }

  const command = getProcessCommand(pid);
  if (command.includes(SERVER_ENTRY_PATH)) {
    return true;
  }

  if (!/\bserver\.js\b/.test(command)) {
    return false;
  }

  return getProcessWorkingDirectory(pid) === SERVER_DIR_PATH;
}

function getListeningPids(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });

  if (result.error) {
    debugLog("[xiaohaha-mcp] Failed to inspect listening port owners", result.error);
    return [];
  }

  if (result.status !== 0 && !result.stdout.trim()) {
    return [];
  }

  return [...new Set(result.stdout.split(/\s+/).map((value) => parseInt(value, 10)).filter(Number.isInteger))];
}

async function waitForProcessExit(pid, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return !isProcessRunning(pid);
}

async function terminateOwnedXiaohahaProcess(pid, reason) {
  if (!isOwnedXiaohahaProcess(pid)) {
    return false;
  }

  // 只有确认是同一个项目的旧实例，才尝试抢占端口，避免误杀其他本地服务。
  debugLog(`[xiaohaha-mcp] Reclaiming pid ${pid} (${reason})`);

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      debugLog(`[xiaohaha-mcp] Failed to SIGTERM pid ${pid}`, error);
      return false;
    }
  }

  if (await waitForProcessExit(pid)) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      debugLog(`[xiaohaha-mcp] Failed to SIGKILL pid ${pid}`, error);
      return false;
    }
  }

  return waitForProcessExit(pid, 500);
}

async function reclaimPortFromPreviousXiaohahaProcess(port) {
  const candidatePids = new Set(getListeningPids(port));
  const pidRecord = readHttpPidRecord();

  if (pidRecord?.port === port && pidRecord.pid !== process.pid) {
    candidatePids.add(pidRecord.pid);
  }

  for (const pid of candidatePids) {
    if (await terminateOwnedXiaohahaProcess(pid, `port ${port} already in use`)) {
      return true;
    }
  }

  return false;
}

export function registerShutdownHandlers(server) {
  const cleanup = () => {
    removeHttpPidRecordIfOwned();
  };

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    cleanup();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 500).unref();
    debugLog(`[xiaohaha-mcp] Received ${signal}, shutting down`);
  };

  process.once("exit", cleanup);
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGHUP", () => shutdown("SIGHUP"));
}

export async function listenHttpServerWithFallback(server, startPort, maxAttempts = 20) {
  let currentPort = startPort;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
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
        server.listen(currentPort);
      });

      writeHttpPidRecord(currentPort);
      debugLog(`[xiaohaha-mcp] Chat UI ready: http://localhost:${currentPort}`);
      return currentPort;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") {
        console.error("[xiaohaha-mcp] HTTP error:", error);
        throw error;
      }

      const reclaimed = await reclaimPortFromPreviousXiaohahaProcess(currentPort);
      if (reclaimed) {
        debugLog(`[xiaohaha-mcp] Reclaimed port ${currentPort}, retrying same port`);
        continue;
      }

      const nextPort = currentPort + 1;
      debugLog(`[xiaohaha-mcp] Port ${currentPort} in use, trying ${nextPort}`);
      currentPort = nextPort;
    }
  }

  throw new Error(`Unable to bind chat UI server after ${maxAttempts} attempts starting at port ${startPort}`);
}
