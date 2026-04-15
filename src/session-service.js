import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { LEGACY_STATE_FILE_URL, STATE_DB_PATH } from "./config.js";

function getTimestamp() {
  return new Date().toLocaleTimeString();
}

function normalizeInstanceId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return String(value);
}

function normalizeConversationId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return String(value);
}

function normalizeResourceUri(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return String(value).trim() || null;
}

function createConversationId() {
  return `conversation_${randomUUID()}`;
}

function buildPreviewText(text, maxLength = 48) {
  const normalized = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!normalized) {
    return "";
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
    : normalized;
}

function normalizeRouteHint(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function normalizeAttachmentRef(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const store = item.store === "upload" || item.store === "project" ? item.store : "";
  const type = item.type === "image" || item.type === "file" || item.type === "snippet" ? item.type : "";
  if (!store || !type) {
    return null;
  }

  const ref = { store, type };
  if (store === "upload") {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) {
      return null;
    }
    ref.id = id;
  } else {
    const filePath = typeof item.path === "string" ? item.path.trim() : "";
    if (!filePath) {
      return null;
    }
    ref.path = filePath;
  }

  if (typeof item.name === "string" && item.name.trim()) {
    ref.name = item.name.trim();
  }
  if (typeof item.mimeType === "string" && item.mimeType.trim()) {
    ref.mimeType = item.mimeType.trim();
  }
  if (typeof item.path === "string" && item.path.trim()) {
    ref.path = item.path.trim();
  }
  if (typeof item.lineRef === "string" && item.lineRef.trim()) {
    ref.lineRef = item.lineRef.trim();
  }
  if (Number.isFinite(item.size) && item.size >= 0) {
    ref.size = Math.floor(item.size);
  }

  return ref;
}

function normalizeQueuedMessageEntry(item) {
  if (typeof item === "string") {
    const message = item.trim();
    return message ? { message, preview: "", attachments: [] } : null;
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  const message = typeof item.message === "string" ? item.message.trim() : "";
  const attachments = Array.isArray(item.attachments)
    ? item.attachments.map((attachment) => normalizeAttachmentRef(attachment)).filter(Boolean)
    : [];
  if (!message && attachments.length === 0) {
    return null;
  }

  return {
    message,
    preview: typeof item.preview === "string" ? item.preview.trim() : "",
    attachments,
  };
}

export const WAIT_RESOLUTIONS = Object.freeze({
  SESSION_CLOSED: Symbol("session_closed"),
  REQUEST_ABORTED: Symbol("request_aborted"),
});
const BROWSER_SESSION_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const BROWSER_SESSION_MAX_COUNT = 50;

function createSessionState(conversationId) {
  return {
    conversationId,
    waitingResolve: null,
    waitingClientSessionId: null,
    waitingToolInstanceId: null,
    waitingResourceUri: null,
    waitingRouteHint: null,
    currentAppInstanceId: null,
    messageQueue: [],
    aiResponses: [],
    chatEvents: [],
    lastChatEventId: 0,
    toolPreviewByInstanceId: new Map(),
    updatedAt: Date.now(),
    contextSummary: "",
    pendingCompact: false,
  };
}

function getSessionLatestAiMessage(session) {
  const latestAiResponse = Array.isArray(session?.aiResponses) && session.aiResponses.length > 0
    ? session.aiResponses[session.aiResponses.length - 1]
    : null;
  if (typeof latestAiResponse?.text === "string" && latestAiResponse.text.trim()) {
    return latestAiResponse.text.trim();
  }

  if (!Array.isArray(session?.chatEvents)) {
    return "";
  }

  for (let index = session.chatEvents.length - 1; index >= 0; index -= 1) {
    const event = session.chatEvents[index];
    if (event?.role === "ai" && typeof event.text === "string" && event.text.trim()) {
      return event.text.trim();
    }
  }

  return "";
}

function createSql(db) {
  return {
    upsertSession: db.prepare(`
      INSERT INTO sessions (conversation_id, last_chat_event_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_chat_event_id = excluded.last_chat_event_id,
        updated_at = excluded.updated_at
    `),
    deleteMessageQueue: db.prepare(`DELETE FROM message_queue WHERE conversation_id = ?`),
    insertMessageQueue: db.prepare(`
      INSERT INTO message_queue (conversation_id, queue_index, message, preview, attachments_json)
      VALUES (?, ?, ?, ?, ?)
    `),
    upsertAiResponse: db.prepare(`
      INSERT INTO ai_responses (conversation_id, response_id, text, time)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id, response_id) DO UPDATE SET
        text = excluded.text,
        time = excluded.time
    `),
    upsertChatEvent: db.prepare(`
      INSERT INTO chat_events (conversation_id, event_id, role, text, time)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, event_id) DO UPDATE SET
        role = excluded.role,
        text = excluded.text,
        time = excluded.time
    `),
    upsertToolPreview: db.prepare(`
      INSERT INTO tool_previews (conversation_id, instance_id, message)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id, instance_id) DO UPDATE SET
        message = excluded.message
    `),
    upsertToolInstanceIndex: db.prepare(`
      INSERT INTO tool_instance_index (instance_id, conversation_id)
      VALUES (?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        conversation_id = excluded.conversation_id
    `),
    selectSessions: db.prepare(`
      SELECT conversation_id, last_chat_event_id, updated_at
      FROM sessions
      ORDER BY updated_at ASC
    `),
    selectMessageQueue: db.prepare(`
      SELECT message, preview, attachments_json
      FROM message_queue
      WHERE conversation_id = ?
      ORDER BY queue_index ASC
    `),
    selectAiResponses: db.prepare(`
      SELECT response_id, text, time
      FROM ai_responses
      WHERE conversation_id = ?
      ORDER BY response_id ASC
    `),
    selectChatEvents: db.prepare(`
      SELECT event_id, role, text, time
      FROM chat_events
      WHERE conversation_id = ?
      ORDER BY event_id ASC
    `),
    selectToolPreviews: db.prepare(`
      SELECT instance_id, message
      FROM tool_previews
      WHERE conversation_id = ?
    `),
    selectToolInstanceIndex: db.prepare(`
      SELECT instance_id, conversation_id
      FROM tool_instance_index
    `),
    countSessions: db.prepare(`SELECT COUNT(*) AS count FROM sessions`),
  };
}

function runInTransaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function deserializeLegacySession(rawSession) {
  const conversationId = normalizeConversationId(rawSession?.conversationId);
  if (!conversationId) {
    return null;
  }

  const session = createSessionState(conversationId);
  session.messageQueue = Array.isArray(rawSession?.messageQueue)
    ? rawSession.messageQueue.map((item) => normalizeQueuedMessageEntry(item)).filter(Boolean)
    : [];
  session.aiResponses = Array.isArray(rawSession?.aiResponses)
    ? rawSession.aiResponses.filter(
        (item) =>
          item &&
          typeof item.id === "number" &&
          typeof item.text === "string" &&
          typeof item.time === "string"
      )
    : [];
  session.chatEvents = Array.isArray(rawSession?.chatEvents)
    ? rawSession.chatEvents.filter(
        (item) =>
          item &&
          typeof item.id === "number" &&
          typeof item.role === "string" &&
          typeof item.text === "string" &&
          typeof item.time === "string"
      )
    : [];
  session.lastChatEventId =
    typeof rawSession?.lastChatEventId === "number"
      ? rawSession.lastChatEventId
      : session.chatEvents.reduce((maxId, event) => Math.max(maxId, event.id), 0);
  session.toolPreviewByInstanceId = new Map(
    Array.isArray(rawSession?.toolPreviewByInstanceId)
      ? rawSession.toolPreviewByInstanceId.filter(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string"
        )
      : []
  );
  session.updatedAt = typeof rawSession?.updatedAt === "number" ? rawSession.updatedAt : Date.now();
  return session;
}

export class SessionService {
  constructor() {
    this.sessions = new Map();
    this.toolInstanceToConversationId = new Map();
    this.clientSessionToConversationId = new Map();
    this.db = new DatabaseSync(STATE_DB_PATH);

    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS sessions (
        conversation_id TEXT PRIMARY KEY,
        last_chat_event_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_queue (
        conversation_id TEXT NOT NULL,
        queue_index INTEGER NOT NULL,
        message TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (conversation_id, queue_index)
      );

      CREATE TABLE IF NOT EXISTS ai_responses (
        conversation_id TEXT NOT NULL,
        response_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        time TEXT NOT NULL,
        PRIMARY KEY (conversation_id, response_id)
      );

      CREATE TABLE IF NOT EXISTS chat_events (
        conversation_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        time TEXT NOT NULL,
        PRIMARY KEY (conversation_id, event_id)
      );

      CREATE TABLE IF NOT EXISTS tool_previews (
        conversation_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY (conversation_id, instance_id)
      );

      CREATE TABLE IF NOT EXISTS tool_instance_index (
        instance_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
      );
    `);

    try {
      this.db.exec(`ALTER TABLE message_queue ADD COLUMN preview TEXT NOT NULL DEFAULT ''`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE message_queue ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`);
    } catch {}

    this.sql = createSql(this.db);
  }

  async initialize() {
    await this.maybeMigrateLegacyJsonState();
    this.loadSessionsFromDatabase();
  }

  persistSessionMetadata(session) {
    this.sql.upsertSession.run(session.conversationId, session.lastChatEventId, session.updatedAt);
  }

  persistMessageQueue(session) {
    runInTransaction(this.db, () => {
      this.sql.deleteMessageQueue.run(session.conversationId);
      session.messageQueue.forEach((entry, index) => {
        this.sql.insertMessageQueue.run(
          session.conversationId,
          index,
          entry.message,
          entry.preview || "",
          JSON.stringify(entry.attachments || [])
        );
      });
      this.persistSessionMetadata(session);
    });
  }

  persistChatEvent(session, event) {
    this.sql.upsertChatEvent.run(session.conversationId, event.id, event.role, event.text, event.time);
    this.persistSessionMetadata(session);
  }

  persistAiResponse(session, response) {
    this.sql.upsertAiResponse.run(session.conversationId, response.id, response.text, response.time);
  }

  persistToolPreview(session, instanceId, message) {
    this.sql.upsertToolPreview.run(session.conversationId, instanceId, message);
    this.persistSessionMetadata(session);
  }

  persistToolInstanceBinding(instanceId, conversationId) {
    this.sql.upsertToolInstanceIndex.run(instanceId, conversationId);
  }

  loadSessionsFromDatabase() {
    this.sessions.clear();
    this.toolInstanceToConversationId.clear();

    for (const row of this.sql.selectSessions.all()) {
      const session = createSessionState(row.conversation_id);
      session.lastChatEventId = row.last_chat_event_id;
      session.updatedAt = row.updated_at;
      session.messageQueue = this.sql.selectMessageQueue
        .all(session.conversationId)
        .map((item) => normalizeQueuedMessageEntry({
          message: item.message,
          preview: item.preview,
          attachments: (() => {
            try {
              return JSON.parse(item.attachments_json || "[]");
            } catch {
              return [];
            }
          })(),
        }))
        .filter(Boolean);
      session.aiResponses = this.sql.selectAiResponses.all(session.conversationId).map((item) => ({
        id: item.response_id,
        text: item.text,
        time: item.time,
      }));
      session.chatEvents = this.sql.selectChatEvents.all(session.conversationId).map((item) => ({
        id: item.event_id,
        role: item.role,
        text: item.text,
        time: item.time,
      }));
      session.toolPreviewByInstanceId = new Map(
        this.sql.selectToolPreviews.all(session.conversationId).map((item) => [item.instance_id, item.message])
      );
      this.sessions.set(session.conversationId, session);
    }

    for (const row of this.sql.selectToolInstanceIndex.all()) {
      this.toolInstanceToConversationId.set(row.instance_id, row.conversation_id);
    }
  }

  importSessionIntoDatabase(session) {
    runInTransaction(this.db, () => {
      this.persistSessionMetadata(session);
      this.sql.deleteMessageQueue.run(session.conversationId);
      session.messageQueue.forEach((entry, index) => {
        this.sql.insertMessageQueue.run(
          session.conversationId,
          index,
          entry.message,
          entry.preview || "",
          JSON.stringify(entry.attachments || [])
        );
      });
      session.chatEvents.forEach((event) => {
        this.sql.upsertChatEvent.run(session.conversationId, event.id, event.role, event.text, event.time);
      });
      session.aiResponses.forEach((response) => {
        this.sql.upsertAiResponse.run(session.conversationId, response.id, response.text, response.time);
      });
      for (const [instanceId, message] of session.toolPreviewByInstanceId.entries()) {
        this.sql.upsertToolPreview.run(session.conversationId, instanceId, message);
      }
    });
  }

  async maybeMigrateLegacyJsonState() {
    const countRow = this.sql.countSessions.get();
    if ((countRow?.count || 0) > 0) {
      return;
    }

    try {
      const rawText = await fs.readFile(LEGACY_STATE_FILE_URL, "utf8");
      const parsed = JSON.parse(rawText);

      // 只在 SQLite 还是空库时迁移，避免重复导入同一批历史会话。
      if (Array.isArray(parsed?.sessions)) {
        for (const rawSession of parsed.sessions) {
          const session = deserializeLegacySession(rawSession);
          if (session) {
            this.importSessionIntoDatabase(session);
          }
        }
      }

      if (Array.isArray(parsed?.toolInstanceToConversationId)) {
        for (const entry of parsed.toolInstanceToConversationId) {
          if (
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string"
          ) {
            this.sql.upsertToolInstanceIndex.run(entry[0], entry[1]);
          }
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.error("[xiaohaha-mcp] Failed to migrate legacy JSON state", error);
      }
    }
  }

  touchSession(session) {
    session.updatedAt = Date.now();
  }

  takeWaitingState(session) {
    if (!session) {
      return null;
    }

    if (!session.waitingResolve) {
      session.waitingClientSessionId = null;
      session.waitingToolInstanceId = null;
      session.waitingResourceUri = null;
      session.waitingRouteHint = null;
      return null;
    }

    const waitingState = {
      resolve: session.waitingResolve,
      activeInstanceId: session.waitingToolInstanceId,
      resourceUri: session.waitingResourceUri,
      routeHint: session.waitingRouteHint,
    };

    session.waitingResolve = null;
    session.waitingClientSessionId = null;
    session.waitingToolInstanceId = null;
    session.waitingResourceUri = null;
    session.waitingRouteHint = null;

    return waitingState;
  }

  resolveWaitingState(session, value = WAIT_RESOLUTIONS.SESSION_CLOSED) {
    const waitingState = this.takeWaitingState(session);
    if (!waitingState) {
      return false;
    }

    waitingState.resolve(value);
    this.touchSession(session);
    return true;
  }

  getSession(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId) {
      return null;
    }

    return this.sessions.get(normalizedConversationId) || null;
  }

  getOrCreateSession(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId) || createConversationId();
    let session = this.sessions.get(normalizedConversationId);

    if (!session) {
      session = createSessionState(normalizedConversationId);
      this.sessions.set(normalizedConversationId, session);
      this.persistSessionMetadata(session);
    }

    this.touchSession(session);
    return session;
  }

  bindToolInstanceToConversation(instanceId, conversationId) {
    const normalizedInstanceId = normalizeInstanceId(instanceId);
    const normalizedConversationId = normalizeConversationId(conversationId);

    if (!normalizedInstanceId || !normalizedConversationId) {
      return;
    }

    this.toolInstanceToConversationId.set(normalizedInstanceId, normalizedConversationId);
    this.persistToolInstanceBinding(normalizedInstanceId, normalizedConversationId);
  }

  bindClientSessionToConversation(clientSessionId, conversationId) {
    const normalizedClientSessionId = normalizeInstanceId(clientSessionId);
    const normalizedConversationId = normalizeConversationId(conversationId);

    if (!normalizedClientSessionId || !normalizedConversationId) {
      return;
    }

    this.clientSessionToConversationId.set(normalizedClientSessionId, normalizedConversationId);
  }

  bindAppInstanceToSession(session, instanceId, options = {}) {
    const normalizedInstanceId = normalizeInstanceId(instanceId);
    const normalizedResourceUri = normalizeResourceUri(options.resourceUri);
    const normalizedRouteHint = normalizeRouteHint(options.routeHint);
    if (!session || !normalizedInstanceId) {
      return false;
    }

    if (
      session.waitingResolve !== null
      && normalizedRouteHint
      && session.waitingRouteHint
      && session.waitingRouteHint !== normalizedRouteHint
    ) {
      return false;
    }

    if (
      session.waitingResolve !== null
      && normalizedResourceUri
      && session.waitingResourceUri
      && session.waitingResourceUri !== normalizedResourceUri
    ) {
      return false;
    }

    // 只有匹配当前这轮 check_messages 资源地址的 iframe，才能接管等待中的输入框。
    if (
      session.waitingResolve !== null
      && normalizedResourceUri
      && session.waitingResourceUri === normalizedResourceUri
    ) {
      session.waitingToolInstanceId = normalizedInstanceId;
    } else if (
      session.waitingResolve !== null
      && !session.waitingResourceUri
      && typeof session.waitingToolInstanceId === "string"
      && !session.waitingToolInstanceId.startsWith("tool_")
    ) {
      // 兼容没有资源地址的旧状态，至少把 requestId 升级成真实的 tool_xxx。
      session.waitingToolInstanceId = normalizedInstanceId;
    }

    session.currentAppInstanceId = normalizedInstanceId;
    this.touchSession(session);
    this.bindToolInstanceToConversation(normalizedInstanceId, session.conversationId);
    return true;
  }

  resolveConversationIdForInstance(instanceId) {
    const normalizedInstanceId = normalizeInstanceId(instanceId);
    if (!normalizedInstanceId) {
      return null;
    }

    return this.toolInstanceToConversationId.get(normalizedInstanceId) || null;
  }

  resolveConversationIdForClientSession(clientSessionId) {
    const normalizedClientSessionId = normalizeInstanceId(clientSessionId);
    if (!normalizedClientSessionId) {
      return null;
    }

    return this.clientSessionToConversationId.get(normalizedClientSessionId) || null;
  }

  resolveConversationIdForAiResponseHint(aiResponseHint) {
    const normalizedHint = normalizeRouteHint(aiResponseHint);
    if (!normalizedHint) {
      return null;
    }

    const matches = [...this.sessions.values()].filter((session) => {
      if (session.waitingResolve === null) {
        return false;
      }

      for (let i = session.chatEvents.length - 1; i >= 0; i -= 1) {
        const event = session.chatEvents[i];
        if (event?.role !== "ai") {
          continue;
        }

        return normalizeRouteHint(event.text) === normalizedHint;
      }

      return false;
    });

    return matches.length === 1 ? matches[0].conversationId : null;
  }

  getSingleWaitingSession() {
    const waitingSessions = [...this.sessions.values()].filter((session) => session.waitingResolve !== null);
    return waitingSessions.length === 1 ? waitingSessions[0] : null;
  }

  resolveSession({
    conversationId,
    instanceId,
    clientSessionId,
    aiResponseHint,
    createIfMissing = false,
    allowClientSessionFallback = true,
  } = {}) {
    const explicitConversationId = normalizeConversationId(conversationId);
    const normalizedInstanceId = normalizeInstanceId(instanceId);
    const normalizedClientSessionId = allowClientSessionFallback
      ? normalizeInstanceId(clientSessionId)
      : null;

    const resolvedConversationId =
      explicitConversationId
      || this.resolveConversationIdForInstance(normalizedInstanceId)
      || this.resolveConversationIdForAiResponseHint(aiResponseHint)
      || (normalizedClientSessionId ? this.resolveConversationIdForClientSession(normalizedClientSessionId) : null);

    if (resolvedConversationId) {
      return createIfMissing
        ? this.getOrCreateSession(resolvedConversationId)
        : this.getSession(resolvedConversationId);
    }

    // 浏览器老入口可能没有 conversationId，这里保留“只有一个等待中会话时自动命中”的旧行为。
    if (!createIfMissing) {
      const waitingSession = this.getSingleWaitingSession();
      if (waitingSession) {
        return waitingSession;
      }
    }

    return createIfMissing ? this.getOrCreateSession(null) : null;
  }

  rememberToolPreview(session, instanceId, message) {
    const normalizedInstanceId = normalizeInstanceId(instanceId);
    const text = message?.trim();

    if (!session || !normalizedInstanceId || !text) {
      return;
    }

    session.toolPreviewByInstanceId.set(normalizedInstanceId, text);
    this.touchSession(session);
    this.persistToolPreview(session, normalizedInstanceId, text);
  }

  rememberToolPreviewForCurrentView(session, fallbackInstanceId, message) {
    this.rememberToolPreview(session, fallbackInstanceId, message);

    // 当前展示中的 app 实例可能和发消息的工具实例不是同一个，需要双写预览才能在刷新时恢复最近一条输入。
    if (session?.currentAppInstanceId && normalizeInstanceId(fallbackInstanceId) !== session.currentAppInstanceId) {
      this.rememberToolPreview(session, session.currentAppInstanceId, message);
    }
  }

  recordChatEvent(session, role, text) {
    session.lastChatEventId += 1;
    const event = {
      id: session.lastChatEventId,
      role,
      text,
      time: getTimestamp(),
    };
    session.chatEvents.push(event);
    this.touchSession(session);
    this.persistChatEvent(session, event);
    return event;
  }

  recordAiResponse(session, text, { dedupe = false } = {}) {
    const normalizedText = typeof text === "string" ? text.trim() : "";
    if (!session || !normalizedText) {
      return null;
    }

    if (session.pendingCompact) {
      session.contextSummary = normalizedText;
      session.pendingCompact = false;
    }

    const lastEvent = session.chatEvents[session.chatEvents.length - 1] || null;
    if (dedupe && lastEvent?.role === "ai" && lastEvent.text === normalizedText) {
      this.touchSession(session);
      this.persistSessionMetadata(session);
      return lastEvent;
    }

    const event = this.recordChatEvent(session, "ai", normalizedText);
    session.aiResponses.push({
      id: event.id,
      text: event.text,
      time: event.time,
    });
    this.persistAiResponse(session, session.aiResponses[session.aiResponses.length - 1]);
    return event;
  }

  waitForNextMessage(session, instanceId, clientSessionId, resourceUri, routeHint) {
    if (session.waitingResolve) {
      this.resolveWaitingState(session, WAIT_RESOLUTIONS.REQUEST_ABORTED);
    }

    session.waitingToolInstanceId = normalizeInstanceId(instanceId);
    session.waitingClientSessionId = normalizeInstanceId(clientSessionId);
    session.waitingResourceUri = normalizeResourceUri(resourceUri);
    session.waitingRouteHint = normalizeRouteHint(routeHint);
    this.touchSession(session);

    // MCP 侧会在这里挂起，直到浏览器输入到达；这样可以保持“回复后立即继续等待下一条指令”的交互模式。
    return new Promise((resolve) => {
      session.waitingResolve = resolve;
    });
  }

  dequeuePendingMessage(session) {
    if (!session || session.messageQueue.length === 0) {
      return null;
    }

    const entry = normalizeQueuedMessageEntry(session.messageQueue.shift());
    this.touchSession(session);
    this.persistMessageQueue(session);
    return entry;
  }

  enqueueUserMessage(session, rawMessage, previewText) {
    return this.enqueueUserMessageWithAttachments(session, rawMessage, previewText, []);
  }

  enqueueUserMessageWithAttachments(session, rawMessage, previewText, rawAttachments = []) {
    const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
    const attachments = Array.isArray(rawAttachments)
      ? rawAttachments.map((attachment) => normalizeAttachmentRef(attachment)).filter(Boolean)
      : [];
    if (!session || (!message && attachments.length === 0)) {
      return false;
    }

    if (message.includes("【系统指令 /compact】")) {
      session.pendingCompact = true;
    }

    const preview = previewText?.trim() || message;
    this.recordChatEvent(session, "user", preview);

    if (session.waitingResolve) {
      const waitingState = this.takeWaitingState(session);
      const activeInstanceId = waitingState?.activeInstanceId || null;
      this.rememberToolPreviewForCurrentView(session, activeInstanceId, preview);
      waitingState?.resolve({ message, preview, attachments });
    } else {
      session.messageQueue.push({ message, preview, attachments });
      this.touchSession(session);
      this.persistMessageQueue(session);
    }
    return true;
  }

  cancelPendingWaitsForClientSession(clientSessionId) {
    const normalizedClientSessionId = normalizeInstanceId(clientSessionId);
    if (!normalizedClientSessionId) {
      return 0;
    }

    let cleared = 0;

    for (const session of this.sessions.values()) {
      if (session.waitingClientSessionId !== normalizedClientSessionId) {
        continue;
      }

      if (this.resolveWaitingState(session, WAIT_RESOLUTIONS.SESSION_CLOSED)) {
        cleared += 1;
      }
    }

    return cleared;
  }

  getDiagnostics() {
    const sessions = [...this.sessions.values()];
    const waitingSessions = sessions.filter((session) => session.waitingResolve !== null).length;
    const queuedMessages = sessions.reduce((total, session) => total + session.messageQueue.length, 0);

    return {
      sessions: sessions.length,
      waitingSessions,
      queuedMessages,
    };
  }

  getChatState({
    conversationId,
    instanceId,
    clientSessionId,
    aiResponseHint,
    resourceUri,
    allowClientSessionFallback = true,
    bindInstance = false,
    includeEvents = false,
  } = {}) {
    const session = this.resolveSession({
      conversationId,
      instanceId,
      clientSessionId,
      aiResponseHint,
      allowClientSessionFallback,
    });
    const normalizedInstanceId = normalizeInstanceId(instanceId);

    if (!session) {
      return {
        conversationId: "",
        anyWaiting: false,
        waiting: false,
        isCurrentView: false,
        queueLength: 0,
        eventCount: 0,
        latestAiMessage: "",
        events: [],
        previewMessage: "",
      };
    }

    if (bindInstance && normalizedInstanceId) {
      this.bindAppInstanceToSession(session, normalizedInstanceId, {
        resourceUri,
        routeHint: aiResponseHint,
      });
    }

    const isCurrentInstanceWaiting =
      session.waitingResolve !== null
      && normalizedInstanceId !== null
      && session.waitingToolInstanceId === normalizedInstanceId;
    const isCurrentView =
      normalizedInstanceId !== null
      && session.currentAppInstanceId === normalizedInstanceId;

    return {
      conversationId: session.conversationId,
      anyWaiting: session.waitingResolve !== null,
      waiting: isCurrentInstanceWaiting,
      isCurrentView,
      queueLength: session.messageQueue.length,
      eventCount: session.chatEvents.length,
      latestAiMessage: getSessionLatestAiMessage(session),
      events: includeEvents ? session.chatEvents : [],
      previewMessage: normalizedInstanceId ? session.toolPreviewByInstanceId.get(normalizedInstanceId) || "" : "",
    };
  }

  getBrowserSessionSnapshot(conversationId) {
    const session = this.getSession(conversationId);
    if (!session) {
      return null;
    }

    return {
      conversationId: session.conversationId,
      waiting: session.waitingResolve !== null,
      queueLength: session.messageQueue.length,
      updatedAt: session.updatedAt,
      events: session.chatEvents,
    };
  }

  listBrowserSessions() {
    const now = Date.now();

    return [...this.sessions.values()]
      .filter((session) =>
        session.waitingResolve !== null
        || session.messageQueue.length > 0
        || (now - session.updatedAt) <= BROWSER_SESSION_RECENT_WINDOW_MS
      )
      .sort((left, right) => {
        const waitingDelta = Number(right.waitingResolve !== null) - Number(left.waitingResolve !== null);
        if (waitingDelta !== 0) {
          return waitingDelta;
        }
        return right.updatedAt - left.updatedAt;
      })
      .slice(0, BROWSER_SESSION_MAX_COUNT)
      .map((session) => {
        const lastEvent = session.chatEvents[session.chatEvents.length - 1] || null;
        return {
          conversationId: session.conversationId,
          waiting: session.waitingResolve !== null,
          queueLength: session.messageQueue.length,
          updatedAt: session.updatedAt,
          lastRole: lastEvent?.role || "",
          preview: buildPreviewText(lastEvent?.text || ""),
        };
      });
  }

  resolveBrowserSession(conversationId) {
    const explicitSession = this.getSession(conversationId);
    if (explicitSession) {
      return { session: explicitSession, error: null };
    }

    if (normalizeConversationId(conversationId)) {
      return { session: null, error: "conversation not found" };
    }

    if (this.sessions.size === 1) {
      return { session: this.sessions.values().next().value, error: null };
    }

    const waitingSessions = [...this.sessions.values()].filter((session) => session.waitingResolve !== null);

    if (waitingSessions.length === 1) {
      return { session: waitingSessions[0], error: null };
    }

    if (waitingSessions.length > 1) {
      return { session: null, error: "multiple active conversations" };
    }

    return { session: null, error: "no active conversation" };
  }
}
