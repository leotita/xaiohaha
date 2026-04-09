import fs from "node:fs/promises";

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import { CHAT_APP_URI } from "./config.js";

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
      <form class="xh-form" id="composerForm">
        <div class="xh-input-shell">
          <textarea
            class="xh-input"
            id="messageInput"
            rows="1"
            placeholder="继续给 Agent 发消息..."
          ></textarea>
        </div>
      </form>
      <div class="xh-error" id="errorBanner" hidden></div>
    </div>
  </div>
  <script>${escapeInlineScript(bundle)}</script>
</body>
</html>`;
}

function buildCheckMessagesPrompt(message, conversationId) {
  return {
    content: [
      {
        type: "text",
        text:
          `当前会话 conversation_id: ${conversationId}\n\n` +
          `用户发来新消息:\n\n${message}\n\n` +
          `请根据上述消息继续工作。先在正常聊天流里直接回复用户，再调用 check_messages 工具，并保持传入同一个 conversation_id（${conversationId}）。调用 check_messages 时，将你刚刚已经回复给用户的同一份最终回复文本传入 ai_response 参数，不要只把回复放进 ai_response 而不在聊天中输出。`,
      },
    ],
  };
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

      if (ai_response?.trim()) {
        sessionService.recordAiResponse(session, ai_response.trim());
      }

      const queuedMessage = sessionService.dequeuePendingMessage(session);
      if (queuedMessage) {
        sessionService.rememberToolPreview(session, instanceId, queuedMessage);
        return buildCheckMessagesPrompt(queuedMessage, session.conversationId);
      }

      const message = await sessionService.waitForNextMessage(session, instanceId);
      return buildCheckMessagesPrompt(message, session.conversationId);
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
    async ({ instance_id, conversation_id }) => {
      const state = sessionService.getChatState({
        conversationId: conversation_id,
        instanceId: instance_id,
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
    async ({ message, instance_id, conversation_id }) => {
      const session = sessionService.resolveSession({
        conversationId: conversation_id,
        instanceId: instance_id,
      });

      if (!session) {
        const state = sessionService.getChatState({
          conversationId: conversation_id,
          instanceId: instance_id,
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
      sessionService.rememberToolPreview(session, instance_id, message);

      if (!sessionService.enqueueUserMessage(session, message)) {
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
}
