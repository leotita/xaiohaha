import { MAX_FILE_SIZE_BYTES, MAX_IMAGE_SIZE_BYTES, MAX_ATTACHMENTS } from "./constants.js";
import { escapeHtml, formatFileSize, isTextFile, isImageFile, readAsText, readAsDataUrl } from "./utils.js";

const RUNTIME_WORKSPACE_MARKER = "/runtime/workspace/";

function normalizeAttachmentPath(filePath) {
  let normalized = String(filePath || "")
    .replaceAll("\\", "/")
    .trim();

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("file://")) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch {}
  }

  const markerIndex = normalized.lastIndexOf(RUNTIME_WORKSPACE_MARKER);
  if (markerIndex >= 0) {
    normalized = normalized.slice(markerIndex + RUNTIME_WORKSPACE_MARKER.length);
  }

  const workspaceRoot = String(globalThis?.__XIAOHAHA_WORKSPACE_ROOT || "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const normalizedLower = normalized.toLowerCase();
  const workspaceLower = workspaceRoot.toLowerCase();

  if (workspaceRoot && normalizedLower.startsWith(`${workspaceLower}/`)) {
    normalized = normalized.slice(workspaceRoot.length + 1);
  } else if (workspaceRoot && normalizedLower === workspaceLower) {
    normalized = "";
  }

  return normalized
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function getDisplaySnippetName(baseName, startLine, endLine) {
  const name = String(baseName || "snippet");
  if (!Number.isFinite(startLine)) {
    return name;
  }

  if (!Number.isFinite(endLine) || startLine === endLine) {
    return `${name} (${startLine})`;
  }

  return `${name} (${startLine}-${endLine})`;
}

export class AttachmentManager {
  constructor(barEl) {
    this.barEl = barEl;
    this.list = [];
    this.nextId = 1;
    this.onError = null;
    this.onPreview = null;
  }

  get length() {
    return this.list.length;
  }

  getById(id) {
    return this.list.find((item) => item.id === id) || null;
  }

  add(att) {
    if (this.list.length >= MAX_ATTACHMENTS) {
      this.onError?.(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
      return -1;
    }
    att.id = this.nextId++;
    this.list.push(att);
    this.renderBar();
    return att.id;
  }

  updateById(id, patch) {
    const att = this.list.find((a) => a.id === id);
    if (att) {
      Object.assign(att, patch);
      if (patch && ("content" in patch || "file" in patch || "filePath" in patch)) {
        delete att.uploadedRef;
      }
      this.renderBar();
    }
  }

  remove(id) {
    const index = this.list.findIndex((a) => a.id === id);
    if (index >= 0) {
      const att = this.list[index];
      if (att.objectUrl) URL.revokeObjectURL(att.objectUrl);
      this.list.splice(index, 1);
      this.renderBar();
    }
  }

  clear() {
    for (const att of this.list) {
      if (att.objectUrl) URL.revokeObjectURL(att.objectUrl);
    }
    this.list.length = 0;
    this.renderBar();
  }

  async processFiles(fileList) {
    const files = [...fileList];
    for (const file of files) {
      try {
        if (isImageFile(file)) {
          if (file.size > MAX_IMAGE_SIZE_BYTES) {
            this.onError?.(`图片 "${file.name}" 太大 (${formatFileSize(file.size)})，上限 5MB`);
            continue;
          }
          const dataUrl = await readAsDataUrl(file);
          this.add({
            type: "image",
            name: file.name || "image.png",
            content: dataUrl,
            mimeType: file.type,
            size: file.size,
          });
        } else if (isTextFile(file)) {
          if (file.size > MAX_FILE_SIZE_BYTES) {
            this.onError?.(`文件 "${file.name}" 太大 (${formatFileSize(file.size)})，上限 1MB`);
            continue;
          }
          const content = await readAsText(file);
          this.add({
            type: "file",
            name: file.name,
            content,
            mimeType: file.type || "text/plain",
            size: file.size,
          });
        } else {
          this.add({
            type: "file",
            name: file.name,
            content: `[二进制文件: ${file.name}, ${formatFileSize(file.size)}, ${file.type || "unknown"}]`,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
          });
        }
      } catch {
        this.onError?.(`读取 "${file.name}" 失败`);
      }
    }
  }

  addProjectFile(file) {
    if (!file || typeof file !== "object") return -1;
    const filePath = normalizeAttachmentPath(file.path || "");
    const type = file.type === "image" ? "image" : "file";
    const existing = this.list.find((att) => (
      att.type === type
      && normalizeAttachmentPath(att.filePath) === filePath
      && filePath
    ));
    if (existing) {
      return existing.id;
    }

    if (file.type === "image") {
      return this.add({
        type: "image",
        name: file.name || "image",
        filePath,
        content: file.content,
        mimeType: file.mimeType || "image/png",
        size: Number(file.size) || 0,
      });
    }

    return this.add({
      type: "file",
      name: file.name || "file",
      filePath,
      content: typeof file.content === "string" ? file.content : "",
      mimeType: file.mimeType || "text/plain",
      size: Number(file.size) || 0,
    });
  }

  renderBar() {
    const visibleList = this.list.filter((att) => !att.inlineChip);
    if (visibleList.length === 0) {
      this.barEl.hidden = true;
      this.barEl.innerHTML = "";
      return;
    }

    this.barEl.hidden = false;
    this.barEl.innerHTML = visibleList
      .map((att) => {
        const label = escapeHtml(att.filePath || att.name);
        if (att.type === "image") {
          const src = att.content || att.objectUrl;
          return `<div class="xh-att-chip" data-att-id="${att.id}">
            <button class="xh-att-preview" data-att-id="${att.id}" type="button" title="查看大图" aria-label="查看大图">
              <img class="xh-att-thumb" src="${escapeHtml(src)}" alt="">
            </button>
            <span class="xh-att-name">${label}</span>
            <button class="xh-att-remove" data-att-id="${att.id}" type="button" title="移除">×</button>
          </div>`;
        }
        if (att.type === "snippet") {
          return `<div class="xh-att-chip xh-att-chip--snippet" data-att-id="${att.id}">
            <span class="xh-att-icon">📋</span>
            <span class="xh-att-name" style="font-family:monospace;font-size:11px;">${escapeHtml(att.name)}</span>
            <button class="xh-att-remove" data-att-id="${att.id}" type="button" title="移除">×</button>
          </div>`;
        }
        return `<div class="xh-att-chip" data-att-id="${att.id}">
          <span class="xh-att-icon">📄</span>
          <span class="xh-att-name">${label}</span>
          <button class="xh-att-remove" data-att-id="${att.id}" type="button" title="移除">×</button>
        </div>`;
      })
      .join("");

    this.barEl.querySelectorAll(".xh-att-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.remove(Number(btn.dataset.attId));
      });
    });

    this.barEl.querySelectorAll(".xh-att-preview").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const attId = Number(btn.dataset.attId);
        const att = this.list.find((item) => item.id === attId);
        if (att) {
          this.onPreview?.(att);
        }
      });
    });
  }

  processCodeMeta(metaJson, codeText, options = {}) {
    let attachment = null;
    try {
      const meta = JSON.parse(metaJson);
      const fileUri = meta?.source?.uri || meta?.uri || "";
      const range = meta?.source?.range || meta?.range || null;
      const normalizedPath = normalizeAttachmentPath(fileUri);

      let fileName = fileUri
        ? fileUri.split("/").pop() || fileUri
        : "snippet";

      if (fileUri.startsWith("file://")) {
        try { fileName = decodeURIComponent(new URL(fileUri).pathname.split("/").pop()); } catch {}
      }
      if (normalizedPath) {
        fileName = normalizedPath.split("/").pop() || fileName;
      }

      const startLine = range?.startLineNumber ?? range?.start?.line ?? null;
      const endLine = range?.endLineNumber ?? range?.end?.line ?? null;
      const lineRef = (startLine !== null && endLine !== null)
        ? `:${startLine}-${endLine}`
        : startLine !== null ? `:${startLine}` : "";

      attachment = {
        type: "snippet",
        name: getDisplaySnippetName(fileName, startLine, endLine),
        content: codeText,
        mimeType: "text/plain",
        size: new TextEncoder().encode(codeText).length,
        filePath: normalizedPath,
        lineRef,
      };
    } catch {
      attachment = {
        type: "snippet",
        name: "snippet",
        content: codeText,
        mimeType: "text/plain",
        size: new TextEncoder().encode(codeText).length,
        filePath: "",
        lineRef: "",
      };
    }

    return this.add({
      ...attachment,
      inlineChip: Boolean(options.inlineChip),
    });
  }

  async prepareAttachmentRefs(uploadAttachment) {
    const refs = [];

    for (const att of this.list) {
      if (att.filePath) {
        refs.push({
          store: "project",
          type: att.type,
          path: att.filePath,
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          lineRef: att.lineRef || undefined,
        });
        continue;
      }

      if (att.uploadedRef) {
        refs.push(att.uploadedRef);
        continue;
      }

      let body = "";
      let mimeType = att.mimeType || "application/octet-stream";
      let encoding = "";
      if (att.type === "image") {
        body = typeof att.content === "string" ? att.content : "";
        encoding = "data_url";
      } else {
        body = typeof att.content === "string" ? att.content : "";
      }

      const uploadedRef = await uploadAttachment({
        type: att.type,
        name: att.name,
        mimeType,
        size: att.size,
        path: att.filePath || "",
        lineRef: att.lineRef || "",
        encoding,
        body,
      });

      att.uploadedRef = uploadedRef;
      refs.push(uploadedRef);
    }

    return refs;
  }

  buildFullMessage(rawText) {
    if (this.list.length === 0) return rawText;

    let message = rawText;
    for (const att of this.list) {
      if (att.type === "image") {
        if (typeof att.content === "string" && att.content) {
          message += `\n\n[XIAOHAHA_IMG:${att.content}]`;
        }
      } else if (att.type === "snippet") {
        const ref = att.filePath ? `${att.filePath}${att.lineRef || ""}` : att.name;
        message += `\n\n📋 \`${ref}\`:\n\`\`\`\n${att.content || ""}\n\`\`\``;
      } else {
        const ref = att.filePath || att.name;
        message += `\n\n📎 ${ref}:\n\`\`\`\n${att.content || ""}\n\`\`\``;
      }
    }

    return message;
  }

  buildPreviewText(rawText) {
    if (this.list.length === 0) return rawText;

    const parts = [];
    if (rawText) parts.push(rawText);

    const imageCount = this.list.filter((a) => a.type === "image").length;
    const labels = this.list.map((att) => {
      if (att.type === "image") return null;
      if (att.type === "snippet") return `📋 ${att.name}`;
      return `📎 ${att.filePath || att.name}`;
    }).filter(Boolean);

    if (labels.length > 0) {
      parts.push(labels.join("\n"));
    }
    if (imageCount > 0) {
      parts.push(`🖼️ ${imageCount} 张图片`);
    }

    return parts.join("\n\n");
  }
}
