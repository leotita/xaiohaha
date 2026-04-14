import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { STATE_DB_PATH } from "./config.js";

const ATTACHMENTS_DIR = path.join(path.dirname(STATE_DB_PATH), ".xiaohaha-attachments");
const CONTENT_SUFFIX = ".bin";
const META_SUFFIX = ".json";
const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_ATTACHMENT_UPLOAD_BYTES = 8 * 1024 * 1024;

function buildStoredRef(meta) {
  const ref = {
    store: "upload",
    id: meta.id,
    type: meta.type,
  };

  if (meta.name) ref.name = meta.name;
  if (meta.mimeType) ref.mimeType = meta.mimeType;
  if (Number.isFinite(meta.size)) ref.size = meta.size;
  if (meta.path) ref.path = meta.path;
  if (meta.lineRef) ref.lineRef = meta.lineRef;

  return ref;
}

export class AttachmentStore {
  constructor() {
    this.rootDir = ATTACHMENTS_DIR;
    this.initPromise = null;
  }

  async initialize() {
    if (!this.initPromise) {
      this.initPromise = this.ensureReady();
    }
    return this.initPromise;
  }

  async ensureReady() {
    await fs.mkdir(this.rootDir, { recursive: true });
    await this.cleanupExpiredFiles();
  }

  getContentPath(id) {
    return path.join(this.rootDir, `${id}${CONTENT_SUFFIX}`);
  }

  getMetaPath(id) {
    return path.join(this.rootDir, `${id}${META_SUFFIX}`);
  }

  async cleanupExpiredFiles() {
    const cutoff = Date.now() - ATTACHMENT_RETENTION_MS;
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }

      const fullPath = path.join(this.rootDir, entry.name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat || stat.mtimeMs >= cutoff) {
        return;
      }

      await fs.unlink(fullPath).catch(() => {});
    }));
  }

  async saveAttachment({ type, name, mimeType, size, path: sourcePath, lineRef, buffer }) {
    await this.initialize();

    const id = randomUUID();
    const meta = {
      id,
      type,
      name: typeof name === "string" ? name.trim() : "",
      mimeType: typeof mimeType === "string" ? mimeType.trim() : "",
      size: Number.isFinite(size) ? size : buffer.length,
      path: typeof sourcePath === "string" ? sourcePath.trim() : "",
      lineRef: typeof lineRef === "string" ? lineRef.trim() : "",
      createdAt: Date.now(),
    };

    await fs.writeFile(this.getContentPath(id), buffer);
    await fs.writeFile(this.getMetaPath(id), JSON.stringify(meta), "utf8");
    return buildStoredRef(meta);
  }

  async readAttachment(refOrId) {
    await this.initialize();

    const id = typeof refOrId === "string" ? refOrId.trim() : refOrId?.id?.trim();
    if (!id) {
      return null;
    }

    const [metaText, buffer] = await Promise.all([
      fs.readFile(this.getMetaPath(id), "utf8").catch(() => null),
      fs.readFile(this.getContentPath(id)).catch(() => null),
    ]);

    if (!metaText || !buffer) {
      return null;
    }

    let meta = null;
    try {
      meta = JSON.parse(metaText);
    } catch {
      return null;
    }

    if (!meta || typeof meta !== "object") {
      return null;
    }

    return {
      ref: buildStoredRef(meta),
      meta,
      buffer,
    };
  }
}
