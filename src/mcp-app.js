import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import { BASE_URL, CHAT_APP_URI, DEV_MODE } from "./config.js";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next", "build", "coverage",
  "__pycache__", ".cache", ".turbo", "vendor", ".output",
]);

function verifyMultilineMatch(fileLines, startIdx, pastedLines) {
  let end = startIdx;
  for (let j = 0; j < pastedLines.length; j++) {
    if (startIdx + j >= fileLines.length) return null;
    if (pastedLines[j].trim() && fileLines[startIdx + j].trim() !== pastedLines[j].trim()) return null;
    end = startIdx + j;
  }
  return end;
}

async function locateWithRipgrep(projectRoot, needle, pastedLines) {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--fixed-strings", "--line-number", "--no-heading",
        "--max-count", "5", "--max-filesize", "1M",
        "--glob", "!node_modules", "--glob", "!.git",
        "--glob", "!dist", "--glob", "!build",
        "--glob", "!coverage", "--glob", "!__pycache__",
        needle, ".",
      ],
      { cwd: projectRoot, timeout: 3000, maxBuffer: 256 * 1024 },
    );

    for (const hit of stdout.split("\n").filter(Boolean)) {
      const m = hit.match(/^(.+?):(\d+):/);
      if (!m) continue;
      const filePath = m[1].replace(/^\.\//, "");
      const startLine = parseInt(m[2], 10);

      try {
        const content = await fs.readFile(path.join(projectRoot, filePath), "utf8");
        const end = verifyMultilineMatch(content.split("\n"), startLine - 1, pastedLines);
        if (end !== null) {
          return { found: true, filePath, startLine, endLine: end + 1 };
        }
      } catch { continue; }
    }
  } catch { /* rg not installed or no results */ }
  return null;
}

async function locateWithNodeFs(projectRoot, needle, pastedLines) {
  const MAX_FILES = 300;
  const MAX_SIZE = 512 * 1024;
  let count = 0;

  async function walk(dir) {
    if (count >= MAX_FILES) return null;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return null; }

    for (const entry of entries) {
      if (count >= MAX_FILES) return null;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        const r = await walk(full);
        if (r) return r;
        continue;
      }
      if (!entry.isFile()) continue;
      count++;

      try {
        const stat = await fs.stat(full);
        if (stat.size > MAX_SIZE) continue;
        const content = await fs.readFile(full, "utf8");
        if (content.includes("\0") || !content.includes(needle)) continue;

        const fileLines = content.split("\n");
        for (let i = 0; i < fileLines.length; i++) {
          if (fileLines[i].trim() !== needle) continue;
          const end = verifyMultilineMatch(fileLines, i, pastedLines);
          if (end !== null) {
            return { found: true, filePath: path.relative(projectRoot, full), startLine: i + 1, endLine: end + 1 };
          }
        }
      } catch { continue; }
    }
    return null;
  }

  return walk(projectRoot);
}

async function locateCodeInProject(codeText) {
  const projectRoot = process.cwd();
  const lines = codeText.split("\n");
  const firstNonEmpty = lines.find((l) => l.trim());
  if (!firstNonEmpty) return { found: false };

  const needle = firstNonEmpty.trim();

  const result = await locateWithRipgrep(projectRoot, needle, lines)
    || await locateWithNodeFs(projectRoot, needle, lines);

  return result || { found: false };
}

function escapeInlineScript(code) {
  return code.replace(/<\/script/gi, "<\\/script");
}

async function loadChatAppBundle() {
  try {
    return await fs.readFile(new URL("../app/dist/mcp-chat-ui.bundle.js", import.meta.url), "utf8");
  } catch (error) {
    console.error("[xiaohaha-mcp] MCP App bundle missing. Run `npm run build:app`.", error);
    return `
      document.body.innerHTML =
        '<div style="padding:16px;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
        '<strong>Xiaohaha App bundle missing.</strong><br>Run <code>npm run build:app</code> and reload Cursor.' +
        '</div>';
    `;
  }
}

function buildChatAppHtml(bundle) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Xiaohaha Chat App</title>
  <style>
    html, body, #app {
      margin: 0;
      width: 100%;
      background: transparent !important;
      background-color: transparent !important;
    }
  </style>
</head>
<body>
  <div id="app">
    <div class="xh-root">
      <div class="xh-preview" id="sentPreview" hidden></div>
      <div class="xh-cmd-palette" id="cmdPalette" hidden></div>
      <form class="xh-form" id="composerForm">
        <div class="xh-input-shell" id="inputShell">
          <div class="xh-attachments" id="attachmentBar" hidden></div>
          <textarea
            class="xh-input"
            id="messageInput"
            rows="1"
            placeholder="继续给 Agent 发消息... (/ 调出命令)"
          ></textarea>
          <div class="xh-input-actions">
            <button class="xh-action-btn" id="attachFileBtn" type="button" title="添加文件">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <button class="xh-action-btn" id="attachImageBtn" type="button" title="添加图片">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </button>
          </div>
          <div class="xh-drag-overlay" id="dragOverlay" hidden>
            <div class="xh-drag-label">释放以添加文件</div>
          </div>
        </div>
      </form>
      <input type="file" id="fileInput" multiple hidden>
      <input type="file" id="imageInput" accept="image/*" multiple hidden>
      <div class="xh-error" id="errorBanner" hidden></div>
    </div>
  </div>
  <script>${escapeInlineScript(bundle)}</script>
${DEV_MODE ? `  <script>
    (function(){
      var mtime = null;
      setInterval(function(){
        fetch("${BASE_URL}dev/bundle-mtime").then(function(r){ return r.json(); }).then(function(d){
          if(mtime === null){ mtime = d.mtime; return; }
          if(d.mtime !== mtime){ location.reload(); }
        }).catch(function(){});
      }, 1500);
    })();
  </script>` : ""}
</body>
</html>`;
}

const IMAGE_MARKER_RE = /\[XIAOHAHA_IMG:(data:([^;]+);base64,([^\]]+))\]/g;
const FILE_BLOCK_RE = /📎 [^\n]+:\n```[^\n]*\n[\s\S]*?```/g;

function buildPreviewFromMessage(message) {
  const re = new RegExp(IMAGE_MARKER_RE.source, IMAGE_MARKER_RE.flags);
  const imageMatches = [...message.matchAll(re)];
  const imageCount = imageMatches.length;

  let preview = message
    .replace(FILE_BLOCK_RE, (match) => {
      const firstLine = match.split("\n")[0];
      return firstLine;
    })
    .replace(new RegExp(IMAGE_MARKER_RE.source, IMAGE_MARKER_RE.flags), "")
    .trim();

  if (imageCount > 0) {
    const suffix = `🖼️ ${imageCount} 张图片`;
    preview = preview ? `${preview}\n\n${suffix}` : suffix;
  }

  return preview || message.slice(0, 200);
}

function buildCheckMessagesPrompt(message, conversationId, contextSummary) {
  const images = [];
  let match;
  const re = new RegExp(IMAGE_MARKER_RE.source, IMAGE_MARKER_RE.flags);
  while ((match = re.exec(message)) !== null) {
    images.push({ mimeType: match[2], data: match[3] });
  }

  const cleanText = message.replace(IMAGE_MARKER_RE, "").trim();

  const contextBlock = contextSummary
    ? `上下文摘要（由之前的 /compact 生成）:\n${contextSummary}\n\n---\n\n`
    : "";

  const content = [
    {
      type: "text",
      text:
        `当前会话 conversation_id: ${conversationId}\n\n` +
        contextBlock +
        `用户发来新消息:\n\n${cleanText}\n\n` +
        (images.length > 0 ? `(用户同时附加了 ${images.length} 张图片，见下方)\n\n` : "") +
        `请根据上述消息继续工作。先在正常聊天流里直接回复用户，再调用 check_messages 工具，并保持传入同一个 conversation_id（${conversationId}）。调用 check_messages 时，将你刚刚已经回复给用户的同一份最终回复文本传入 ai_response 参数，不要只把回复放进 ai_response 而不在聊天中输出。`,
    },
  ];

  for (const img of images) {
    content.push({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    });
  }

  return { content };
}

export function registerChatAppIntegration(mcpServer, sessionService) {
  registerAppResource(
    mcpServer,
    "Xiaohaha Chat UI",
    CHAT_APP_URI,
    {
      description: "Embedded Xiaohaha follow-up chat UI.",
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => {
      const bundle = await loadChatAppBundle();

      return {
        contents: [
          {
            uri: CHAT_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: buildChatAppHtml(bundle),
            _meta: {
              ui: {
                prefersBorder: false,
              },
            },
          },
        ],
      };
    }
  );

  registerAppTool(
    mcpServer,
    "check_messages",
    {
      description:
        "Check for new user messages from Xiaohaha Chat. Call this after completing every response to wait for the next user instruction.",
      inputSchema: {
        ai_response: z
          .string()
          .optional()
          .describe("Your response text to display in the chat UI before waiting for the next message"),
        conversation_id: z
          .string()
          .optional()
          .describe("Stable logical conversation id. Reuse the same value on every follow-up check_messages call in the same chat thread."),
      },
      _meta: {
        ui: {
          resourceUri: CHAT_APP_URI,
          visibility: ["model"],
        },
      },
    },
    async ({ ai_response, conversation_id }, extra) => {
      const session = sessionService.getOrCreateSession(conversation_id);
      const instanceId = extra.requestId;

      sessionService.bindToolInstanceToConversation(instanceId, session.conversationId);
      sessionService.bindClientSessionToConversation(extra.sessionId, session.conversationId);

      if (ai_response?.trim()) {
        sessionService.recordAiResponse(session, ai_response.trim());
      }

      const queuedMessage = sessionService.dequeuePendingMessage(session);
      if (queuedMessage) {
        sessionService.rememberToolPreview(session, instanceId, buildPreviewFromMessage(queuedMessage));
        return buildCheckMessagesPrompt(queuedMessage, session.conversationId, session.contextSummary);
      }

      const message = await sessionService.waitForNextMessage(session, instanceId, extra.sessionId);
      if (!message) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Cursor MCP session closed while waiting for the next message.",
            },
          ],
        };
      }

      return buildCheckMessagesPrompt(message, session.conversationId, session.contextSummary);
    }
  );

  registerAppTool(
    mcpServer,
    "xiaohaha_get_chat_state",
    {
      description: "Get the current Xiaohaha embedded chat state for the app UI.",
      inputSchema: {
        instance_id: z
          .string()
          .optional()
          .describe("Current MCP App tool instance id used for scoped preview recovery."),
        conversation_id: z
          .string()
          .optional()
          .describe("Logical conversation id for resolving the correct session when available."),
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async ({ instance_id, conversation_id }, extra) => {
      const state = sessionService.getChatState({
        conversationId: conversation_id,
        instanceId: instance_id,
        clientSessionId: extra.sessionId,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ state }),
          },
        ],
        structuredContent: {
          state,
        },
      };
    }
  );

  registerAppTool(
    mcpServer,
    "xiaohaha_send_app_message",
    {
      description: "Send a follow-up message from the Xiaohaha embedded chat UI.",
      inputSchema: {
        message: z.string().describe("Follow-up message text to send to the waiting Xiaohaha queue."),
        instance_id: z
          .string()
          .optional()
          .describe("Current MCP App tool instance id used for scoped preview recovery."),
        conversation_id: z
          .string()
          .optional()
          .describe("Logical conversation id for resolving the correct session when available."),
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async ({ message, instance_id, conversation_id }, extra) => {
      const session = sessionService.resolveSession({
        conversationId: conversation_id,
        instanceId: instance_id,
        clientSessionId: extra.sessionId,
      });

      if (!session) {
        const state = sessionService.getChatState({
          conversationId: conversation_id,
          instanceId: instance_id,
          clientSessionId: extra.sessionId,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "未找到对应会话",
            },
          ],
          structuredContent: {
            error: "未找到对应会话",
            state,
          },
        };
      }

      sessionService.bindAppInstanceToSession(session, instance_id);
      const previewMessage = buildPreviewFromMessage(message);
      sessionService.rememberToolPreview(session, instance_id, previewMessage);

      if (!sessionService.enqueueUserMessage(session, message, previewMessage)) {
        const state = sessionService.getChatState({
          conversationId: conversation_id,
          instanceId: instance_id,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "消息不能为空",
            },
          ],
          structuredContent: {
            error: "消息不能为空",
            state,
          },
        };
      }

      const state = sessionService.getChatState({
        conversationId: conversation_id,
        instanceId: instance_id,
        clientSessionId: extra.sessionId,
      });

      return {
        content: [
          {
            type: "text",
            text: "ok",
          },
        ],
        structuredContent: {
          ok: true,
          state,
        },
      };
    }
  );

  registerAppTool(
    mcpServer,
    "xiaohaha_set_context",
    {
      description: "Set or clear the session's context summary. Included as a prefix in future check_messages prompts.",
      inputSchema: {
        summary: z.string().describe("Context summary text. Send empty string to clear."),
        conversation_id: z
          .string()
          .optional()
          .describe("Logical conversation id."),
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async ({ summary, conversation_id }) => {
      const session = sessionService.resolveSession({
        conversationId: conversation_id,
        createIfMissing: true,
      });

      if (!session) {
        return {
          isError: true,
          content: [{ type: "text", text: "未找到会话" }],
          structuredContent: { ok: false, error: "未找到会话" },
        };
      }

      session.contextSummary = summary?.trim() || "";
      session.pendingCompact = false;

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, hasContext: Boolean(session.contextSummary) }) }],
        structuredContent: { ok: true, hasContext: Boolean(session.contextSummary) },
      };
    }
  );

  registerAppTool(
    mcpServer,
    "xiaohaha_locate_code",
    {
      description: "Locate a code snippet in the project files. Returns the file path and line range.",
      inputSchema: {
        code_text: z.string().describe("The code text to locate."),
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async ({ code_text }) => {
      const result = await locateCodeInProject(code_text);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
  );
}
