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

function createConversationId() {
  return `conversation_${randomUUID()}`;
}

function createSessionState(conversationId) {
  return {
    conversationId,
    waitingResolve: null,
    waitingToolInstanceId: null,
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
      INSERT INTO message_queue (conversation_id, queue_index, message)
      VALUES (?, ?, ?)
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
      SELECT message
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
    ? rawSession.messageQueue.filter((item) => typeof item === "string")
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
      session.messageQueue.forEach((message, index) => {
        this.sql.insertMessageQueue.run(session.conversationId, index, message);
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
        .map((item) => item.message);
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
      session.messageQueue.forEach((message, index) => {
        this.sql.insertMessageQueue.run(session.conversationId, index, message);
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

  bindAppInstanceToSession(session, instanceId) {
    const normalizedInstanceId = normalizeInstanceId(instanceId);
    if (!session || !normalizedInstanceId) {
      return;
    }

    session.currentAppInstanceId = normalizedInstanceId;
    this.touchSession(session);
    this.bindToolInstanceToConversation(normalizedInstanceId, session.conversationId);
  }

  resolveConversationIdForInstance(instanceId) {
    const normalizedInstanceId = normalizeInstanceId(instanceId);
    if (!normalizedInstanceId) {
      return null;
    }

    return this.toolInstanceToConversationId.get(normalizedInstanceId) || null;
  }

  getSingleWaitingSession() {
    const waitingSessions = [...this.sessions.values()].filter((session) => session.waitingResolve !== null);
    return waitingSessions.length === 1 ? waitingSessions[0] : null;
  }

  resolveSession({ conversationId, instanceId, createIfMissing = false } = {}) {
    const normalizedConversationId =
      normalizeConversationId(conversationId) || this.resolveConversationIdForInstance(instanceId);

    if (normalizedConversationId) {
      return createIfMissing
        ? this.getOrCreateSession(normalizedConversationId)
        : this.getSession(normalizedConversationId);
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

  recordAiResponse(session, text) {
    if (session.pendingCompact) {
      session.contextSummary = text;
      session.pendingCompact = false;
    }

    const event = this.recordChatEvent(session, "ai", text);
    session.aiResponses.push({
      id: event.id,
      text: event.text,
      time: event.time,
    });
    this.persistAiResponse(session, session.aiResponses[session.aiResponses.length - 1]);
  }

  waitForNextMessage(session, instanceId) {
    session.waitingToolInstanceId = normalizeInstanceId(instanceId);
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

    const message = session.messageQueue.shift();
    this.touchSession(session);
    this.persistMessageQueue(session);
    return message;
  }

  enqueueUserMessage(session, rawMessage, previewText) {
    const message = rawMessage?.trim();
    if (!session || !message) {
      return false;
    }

    if (message.includes("【系统指令 /compact】")) {
      session.pendingCompact = true;
    }

    const preview = previewText?.trim() || message;
    this.recordChatEvent(session, "user", preview);

    if (session.waitingResolve) {
      const resolve = session.waitingResolve;
      const activeInstanceId = session.waitingToolInstanceId;
      session.waitingResolve = null;
      session.waitingToolInstanceId = null;
      this.rememberToolPreviewForCurrentView(session, activeInstanceId, preview);
      resolve(message);
    } else {
      session.messageQueue.push(message);
      this.touchSession(session);
      this.persistMessageQueue(session);
    }
    return true;
  }

  getChatState({ conversationId, instanceId } = {}) {
    const session = this.resolveSession({ conversationId, instanceId });
    const normalizedInstanceId = normalizeInstanceId(instanceId);

    if (!session) {
      return {
        conversationId: normalizeConversationId(conversationId) || "",
        anyWaiting: false,
        waiting: false,
        queueLength: 0,
        events: [],
        previewMessage: "",
      };
    }

    if (normalizedInstanceId) {
      this.bindAppInstanceToSession(session, normalizedInstanceId);
    }

    return {
      conversationId: session.conversationId,
      anyWaiting: session.waitingResolve !== null,
      waiting: session.waitingResolve !== null,
      queueLength: session.messageQueue.length,
      events: session.chatEvents,
      previewMessage: normalizedInstanceId ? session.toolPreviewByInstanceId.get(normalizedInstanceId) || "" : "",
    };
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
