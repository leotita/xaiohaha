import { MAX_FILE_SIZE_BYTES, MAX_IMAGE_SIZE_BYTES, MAX_ATTACHMENTS } from "./constants.js";
import { escapeHtml, formatFileSize, getFileExtension, isTextFile, isImageFile, readAsText, readAsDataUrl } from "./utils.js";

export class AttachmentManager {
  constructor(barEl) {
    this.barEl = barEl;
    this.list = [];
    this.nextId = 1;
    this.onError = null;
  }

  get length() {
    return this.list.length;
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

  renderBar() {
    if (this.list.length === 0) {
      this.barEl.hidden = true;
      this.barEl.innerHTML = "";
      return;
    }

    this.barEl.hidden = false;
    this.barEl.innerHTML = this.list
      .map((att) => {
        if (att.type === "image") {
          const src = att.content || att.objectUrl;
          return `<div class="xh-att-chip" data-att-id="${att.id}">
            <img class="xh-att-thumb" src="${escapeHtml(src)}" alt="">
            <span class="xh-att-name">${escapeHtml(att.name)}</span>
            <span class="xh-att-size">${formatFileSize(att.size)}</span>
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
          <span class="xh-att-name">${escapeHtml(att.name)}</span>
          <span class="xh-att-size">${formatFileSize(att.size)}</span>
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
  }

  processCodeMeta(metaJson, codeText) {
    try {
      const meta = JSON.parse(metaJson);
      const fileUri = meta?.source?.uri || meta?.uri || "";
      const range = meta?.source?.range || meta?.range || null;

      let fileName = fileUri
        ? fileUri.split("/").pop() || fileUri
        : "snippet";

      if (fileUri.startsWith("file://")) {
        try { fileName = decodeURIComponent(new URL(fileUri).pathname.split("/").pop()); } catch {}
      }

      const startLine = range?.startLineNumber ?? range?.start?.line ?? null;
      const endLine = range?.endLineNumber ?? range?.end?.line ?? null;
      const lineRef = (startLine !== null && endLine !== null)
        ? `:${startLine}-${endLine}`
        : startLine !== null ? `:${startLine}` : "";

      const label = fileName + lineRef;

      this.add({
        type: "snippet",
        name: label,
        content: codeText,
        mimeType: "text/plain",
        size: new TextEncoder().encode(codeText).length,
        filePath: fileUri ? (fileUri.startsWith("file://") ? (() => { try { return decodeURIComponent(new URL(fileUri).pathname); } catch { return ""; } })() : fileUri) : "",
        lineRef,
      });
    } catch {
      this.add({
        type: "snippet",
        name: "snippet",
        content: codeText,
        mimeType: "text/plain",
        size: new TextEncoder().encode(codeText).length,
        filePath: "",
        lineRef: "",
      });
    }
  }

  buildFullMessage(rawText) {
    if (this.list.length === 0) return rawText;

    let message = rawText;
    for (const att of this.list) {
      if (att.type === "image") {
        message += `\n\n[XIAOHAHA_IMG:${att.content}]`;
      } else if (att.type === "snippet") {
        const ref = att.filePath ? `${att.filePath}${att.lineRef}` : att.name;
        const baseName = att.name.replace(/\s*\([\d\-]+\)$/, "").split(":")[0];
        const ext = getFileExtension(baseName);
        message += `\n\n📋 \`${ref}\`:\n\`\`\`${ext}\n${att.content}\n\`\`\``;
      } else {
        const ext = getFileExtension(att.name);
        message += `\n\n📎 ${att.name}:\n\`\`\`${ext}\n${att.content}\n\`\`\``;
      }
    }
    return message;
  }

  buildPreviewText(rawText) {
    if (this.list.length === 0) return rawText;

    const parts = [];
    if (rawText) parts.push(rawText);

    const imageCount = this.list.filter((a) => a.type === "image").length;
    const fileCount = this.list.filter((a) => a.type === "file").length;
    const snippetCount = this.list.filter((a) => a.type === "snippet").length;
    const labels = [];
    if (imageCount > 0) labels.push(`🖼️ ${imageCount} 张图片`);
    if (fileCount > 0) labels.push(`📎 ${fileCount} 个文件`);
    if (snippetCount > 0) {
      const names = this.list.filter((a) => a.type === "snippet").map((a) => `\`${a.name}\``).join("  ");
      labels.push(`📋 ${names}`);
    }
    if (labels.length > 0) parts.push(labels.join("  "));

    return parts.join("\n\n");
  }
}
