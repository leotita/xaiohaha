import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import { BASE_ORIGIN, BASE_URL, CHAT_APP_URI, DEV_MODE, WORKSPACE_ROOT } from "./config.js";
import { WAIT_RESOLUTIONS } from "./session-service.js";

const execFileAsync = promisify(execFile);
const CHECK_MESSAGES_PROGRESS_MS = 15_000;
const PROJECT_TEXT_FILE_MAX_BYTES = 1024 * 1024;
const PROJECT_IMAGE_FILE_MAX_BYTES = 5 * 1024 * 1024;
const PROJECT_FILE_SEARCH_LIMIT = 20;
const PROJECT_FILE_CACHE_TTL_MS = 10_000;
const PROJECT_FILE_QUERY_CACHE_TTL_MS = 5_000;

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next", "build", "coverage",
  "__pycache__", ".cache", ".turbo", "vendor", ".output",
]);
const SKIP_BASENAMES = new Set([
  ".DS_Store",
]);
const SKIP_PREFIXES = [
  ".xiaohaha-state.",
  ".xiaohaha-http.",
];
const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "md", "js", "ts", "jsx", "tsx", "json", "xml", "html", "css", "scss",
  "less", "py", "rb", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs",
  "swift", "kt", "sh", "bash", "zsh", "yml", "yaml", "toml", "ini", "cfg",
  "conf", "env", "sql", "graphql", "vue", "svelte", "astro", "php", "pl",
  "r", "lua", "vim", "dockerfile", "makefile", "gitignore", "editorconfig",
  "prettierrc", "eslintrc", "log", "csv", "tsv", "svg",
]);
const TEXT_FILE_BASENAMES = new Set([
  "dockerfile", "makefile", ".gitignore", ".editorconfig", ".prettierrc", ".eslintrc", ".env",
]);
const IMAGE_MIME_BY_EXT = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["bmp", "image/bmp"],
]);

let projectFileCache = {
  expiresAt: 0,
  entries: [],
};

let projectFileSearchCache = {
  expiresAt: 0,
  query: "",
  entries: [],
};

function normalizeProjectPath(relPath) {
  return String(relPath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function shouldSkipRelativePath(relPath) {
  const normalizedPath = normalizeProjectPath(relPath);
  const segments = normalizedPath.split("/").filter(Boolean);
  const baseName = path.posix.basename(normalizedPath);
  if (SKIP_BASENAMES.has(baseName)) return true;
  if (SKIP_PREFIXES.some((prefix) => baseName.startsWith(prefix))) return true;
  return segments.some((segment) => SKIP_DIRS.has(segment));
}

function getProjectFileBasename(relPath) {
  return path.posix.basename(normalizeProjectPath(relPath));
}

function buildProjectFileEntry(relPath) {
  const normalizedPath = normalizeProjectPath(relPath);
  const name = getProjectFileBasename(normalizedPath);
  return {
    path: normalizedPath,
    name,
    lowerPath: normalizedPath.toLowerCase(),
    lowerName: name.toLowerCase(),
    length: normalizedPath.length,
  };
}

function getProjectFileExtension(relPath) {
  const normalized = normalizeProjectPath(relPath);
  const baseName = getProjectFileBasename(normalized).toLowerCase();
  if (TEXT_FILE_BASENAMES.has(baseName)) {
    return baseName.replace(/^\./, "");
  }
  const ext = path.posix.extname(baseName).replace(/^\./, "");
  return ext || "";
}

function isPathInsideProject(projectRoot, fullPath) {
  const relativePath = path.relative(projectRoot, fullPath);
  return relativePath !== ""
    && !relativePath.startsWith("..")
    && !path.isAbsolute(relativePath);
}

async function listProjectFilesWithRipgrep(projectRoot) {
  try {
    const args = ["--files", "--hidden"];
    for (const dir of SKIP_DIRS) {
      args.push("-g", `!${dir}/**`);
      args.push("-g", `!**/${dir}/**`);
    }
    for (const baseName of SKIP_BASENAMES) {
      args.push("-g", `!${baseName}`);
      args.push("-g", `!**/${baseName}`);
    }
    for (const prefix of SKIP_PREFIXES) {
      args.push("-g", `!${prefix}*`);
      args.push("-g", `!**/${prefix}*`);
    }

    const { stdout } = await execFileAsync(
      "rg",
      args,
      { cwd: projectRoot, timeout: 3000, maxBuffer: 1024 * 1024 },
    );

    return stdout
      .split("\n")
      .map((line) => normalizeProjectPath(line))
      .filter(Boolean)
      .filter((relPath) => !shouldSkipRelativePath(relPath));
  } catch {
    return null;
  }
}

async function listProjectFilesWithNodeFs(projectRoot) {
  const files = [];

  async function walk(dir, prefix = "") {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (shouldSkipRelativePath(relPath)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;

      files.push(normalizeProjectPath(relPath));
    }
  }

  await walk(projectRoot);
  return files;
}

async function getProjectFileIndex(projectRoot) {
  if (projectFileCache.expiresAt > Date.now() && Array.isArray(projectFileCache.entries) && projectFileCache.entries.length > 0) {
    return projectFileCache.entries;
  }

  const files = await listProjectFilesWithRipgrep(projectRoot) || await listProjectFilesWithNodeFs(projectRoot);
  const entries = [...new Set(files || [])]
    .sort((a, b) => {
      const lengthDiff = a.length - b.length;
      return lengthDiff !== 0 ? lengthDiff : a.localeCompare(b);
    })
    .map((relPath) => buildProjectFileEntry(relPath));

  projectFileCache = {
    expiresAt: Date.now() + PROJECT_FILE_CACHE_TTL_MS,
    entries,
  };
  projectFileSearchCache = {
    expiresAt: 0,
    query: "",
    entries: [],
  };

  return entries;
}

function scoreProjectFile(entry, rawQuery) {
  const normalizedQuery = normalizeProjectPath(rawQuery).toLowerCase();
  const lowerPath = entry.lowerPath;
  const baseName = entry.lowerName;

  if (!normalizedQuery) {
    return 1000 - entry.length;
  }
  if (lowerPath === normalizedQuery) {
    return 20_000;
  }
  if (baseName === normalizedQuery) {
    return 18_000 - entry.length;
  }
  if (lowerPath.endsWith(`/${normalizedQuery}`)) {
    return 16_000 - entry.length;
  }
  if (baseName.startsWith(normalizedQuery)) {
    return 14_000 - entry.length - baseName.indexOf(normalizedQuery);
  }
  if (lowerPath.includes(`/${normalizedQuery}`)) {
    return 12_000 - lowerPath.indexOf(`/${normalizedQuery}`) - entry.length;
  }
  if (lowerPath.includes(normalizedQuery)) {
    return 10_000 - lowerPath.indexOf(normalizedQuery) - entry.length;
  }

  const queryParts = normalizedQuery.split("/").filter(Boolean);
  if (queryParts.length > 1 && queryParts.every((part) => lowerPath.includes(part))) {
    return 8_000 - entry.length;
  }

  return -1;
}

function getSearchSourceEntries(entries, normalizedQuery) {
  if (!normalizedQuery) {
    return entries;
  }

  if (
    projectFileSearchCache.expiresAt > Date.now()
    && projectFileSearchCache.query
    && normalizedQuery.startsWith(projectFileSearchCache.query)
    && Array.isArray(projectFileSearchCache.entries)
    && projectFileSearchCache.entries.length > 0
  ) {
    return projectFileSearchCache.entries;
  }

  return entries;
}

export async function searchProjectFiles(query, limit = PROJECT_FILE_SEARCH_LIMIT) {
  const projectRoot = WORKSPACE_ROOT;
  const entries = await getProjectFileIndex(projectRoot);
  const normalizedQuery = normalizeProjectPath(query).toLowerCase();
  const sourceEntries = getSearchSourceEntries(entries, normalizedQuery);
  const matchedEntries = sourceEntries.filter((entry) => scoreProjectFile(entry, normalizedQuery) >= 0);

  projectFileSearchCache = {
    expiresAt: Date.now() + PROJECT_FILE_QUERY_CACHE_TTL_MS,
    query: normalizedQuery,
    entries: matchedEntries,
  };

  return matchedEntries
    .map((entry) => ({
      path: entry.path,
      name: entry.name,
      score: scoreProjectFile(entry, normalizedQuery),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(({ score, ...item }) => item);
}

function isProbablyTextBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  let suspiciousBytes = 0;

  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32)) suspiciousBytes++;
  }

  return sample.length === 0 || suspiciousBytes / sample.length < 0.1;
}

export async function readProjectFile(filePath) {
  const projectRoot = WORKSPACE_ROOT;
  const normalizedPath = normalizeProjectPath(filePath);
  if (!normalizedPath) {
    throw new Error("文件路径不能为空");
  }

  const fullPath = path.resolve(projectRoot, normalizedPath);
  if (!isPathInsideProject(projectRoot, fullPath)) {
    throw new Error("只能读取当前项目内的文件");
  }

  const stat = await fs.stat(fullPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error("未找到文件");
  }

  if (stat.size > PROJECT_IMAGE_FILE_MAX_BYTES) {
    throw new Error("文件太大，超过 5MB");
  }

  const buffer = await fs.readFile(fullPath);
  const ext = getProjectFileExtension(normalizedPath);
  const imageMimeType = IMAGE_MIME_BY_EXT.get(ext);

  if (imageMimeType) {
    return {
      ok: true,
      type: "image",
      path: normalizedPath,
      name: getProjectFileBasename(normalizedPath),
      mimeType: imageMimeType,
      size: stat.size,
      content: `data:${imageMimeType};base64,${buffer.toString("base64")}`,
    };
  }

  if (stat.size <= PROJECT_TEXT_FILE_MAX_BYTES && (TEXT_FILE_EXTENSIONS.has(ext) || TEXT_FILE_BASENAMES.has(getProjectFileBasename(normalizedPath).toLowerCase()) || isProbablyTextBuffer(buffer))) {
    return {
      ok: true,
      type: "file",
      path: normalizedPath,
      name: getProjectFileBasename(normalizedPath),
      mimeType: "text/plain",
      size: stat.size,
      content: buffer.toString("utf8"),
    };
  }

  return {
    ok: true,
    type: "file",
    path: normalizedPath,
    name: getProjectFileBasename(normalizedPath),
    mimeType: "application/octet-stream",
    size: stat.size,
    content: `[二进制文件: ${normalizedPath}, ${(stat.size / 1024).toFixed(1)} KB]`,
  };
}

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
  const projectRoot = WORKSPACE_ROOT;
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
      <div class="xh-composer-layer" id="composerLayer">
        <form class="xh-form" id="composerForm">
          <div class="xh-input-shell" id="inputShell">
            <div class="xh-cmd-palette xh-file-palette" id="fileMentionPalette" hidden></div>
            <div class="xh-cmd-palette" id="cmdPalette" hidden></div>
            <div class="xh-attachments" id="attachmentBar" hidden></div>
            <div class="xh-fake-caret" id="fakeCaret" hidden></div>
            <textarea
              class="xh-input"
              id="messageInput"
              rows="1"
              placeholder="继续给 Agent 发消息... (/ 调出命令)"
            ></textarea>
            <div class="xh-input-actions">
              <button class="xh-action-btn" id="openBrowserBtn" type="button" title="在浏览器继续输入">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>
              </button>
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
      </div>
      <input type="file" id="fileInput" multiple hidden>
      <input type="file" id="imageInput" accept="image/*" multiple hidden>
      <div class="xh-error" id="errorBanner" hidden></div>
      <div class="xh-lightbox" id="imageLightbox" hidden>
        <div class="xh-lightbox-panel">
          <button class="xh-lightbox-close" id="imageLightboxClose" type="button" aria-label="关闭预览">×</button>
          <div class="xh-lightbox-frame">
            <img class="xh-lightbox-img" id="imageLightboxImg" alt="">
          </div>
          <div class="xh-lightbox-caption" id="imageLightboxCaption"></div>
        </div>
      </div>
    </div>
  </div>
  <script>window.__XIAOHAHA_BROWSER_CHAT_URL = ${JSON.stringify(BASE_URL)};</script>
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
const ATTACHMENT_BLOCK_RE = /(^|\n\n)((?:📎|📋) [^\n]+:)(?:\n[\s\S]*?)(?=(?:\n\n(?:📎|📋) [^\n]+:)|$)/g;
const UPLOAD_ATTACHMENT_SCHEMA = z.object({
  store: z.enum(["upload", "project"]),
  type: z.enum(["image", "file", "snippet"]),
  id: z.string().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  lineRef: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.store === "upload" && !value.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "upload attachment requires id" });
  }
  if (value.store === "project" && !value.path) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "project attachment requires path" });
  }
});

function buildAttachmentPreviewLabel(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  if (attachment.type === "image") {
    return null;
  }

  if (attachment.type === "snippet") {
    const ref = attachment.path
      ? `${attachment.path}${attachment.lineRef || ""}`
      : attachment.name || "snippet";
    return `📋 ${ref}`;
  }

  return `📎 ${attachment.path || attachment.name || "attachment"}`;
}

export function buildPreviewFromMessage(message) {
  const re = new RegExp(IMAGE_MARKER_RE.source, IMAGE_MARKER_RE.flags);
  const imageMatches = [...message.matchAll(re)];
  const imageCount = imageMatches.length;

  let preview = message
    .replace(ATTACHMENT_BLOCK_RE, (_match, prefix, header) => `${prefix}${header.replace(/:$/, "")}`)
    .replace(new RegExp(IMAGE_MARKER_RE.source, IMAGE_MARKER_RE.flags), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (imageCount > 0) {
    const suffix = `🖼️ ${imageCount} 张图片`;
    preview = preview ? `${preview}\n\n${suffix}` : suffix;
  }

  return preview || message.slice(0, 200);
}

export function buildPreviewFromInput(message, attachments = []) {
  const parts = [];
  const preview = buildPreviewFromMessage(message || "");
  if (preview) {
    parts.push(preview);
  }

  const imageCount = attachments.filter((attachment) => attachment?.type === "image").length;
  const labels = attachments
    .map((attachment) => buildAttachmentPreviewLabel(attachment))
    .filter(Boolean);

  if (labels.length > 0) {
    parts.push(labels.join("\n"));
  }
  if (imageCount > 0) {
    parts.push(`🖼️ ${imageCount} 张图片`);
  }

  return parts.join("\n\n").trim() || preview;
}

function normalizePromptEntry(entry) {
  if (typeof entry === "string") {
    return {
      message: entry,
      attachments: [],
    };
  }

  return {
    message: typeof entry?.message === "string" ? entry.message : "",
    attachments: Array.isArray(entry?.attachments) ? entry.attachments : [],
  };
}

function extractImagePayloadFromDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function buildAttachmentReferenceLabel(attachment) {
  return attachment.path
    ? `${attachment.path}${attachment.lineRef || ""}`
    : attachment.name || "attachment";
}

function formatTextAttachmentForPrompt(attachment) {
  const ref = buildAttachmentReferenceLabel(attachment);

  if (attachment.type === "snippet") {
    const baseName = (attachment.name || ref).replace(/\s*\([\d\-]+\)$/, "").split(":")[0];
    const ext = getProjectFileExtension(baseName);
    return `📋 \`${ref}\`:\n\`\`\`${ext}\n${attachment.text}\n\`\`\``;
  }

  const ext = getProjectFileExtension(attachment.path || attachment.name || ref);
  return `📎 ${ref}:\n\`\`\`${ext}\n${attachment.text}\n\`\`\``;
}

async function resolveAttachmentForPrompt(attachment, attachmentStore) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  if (attachment.store === "project" && attachment.path) {
    const projectFile = await readProjectFile(attachment.path).catch(() => null);
    if (!projectFile?.ok) {
      return null;
    }

    if (attachment.type === "image" || projectFile.type === "image") {
      const image = extractImagePayloadFromDataUrl(projectFile.content);
      if (!image) {
        return null;
      }

      return {
        type: "image",
        mimeType: attachment.mimeType || image.mimeType,
        data: image.data,
      };
    }

    return {
      type: attachment.type === "snippet" ? "snippet" : "file",
      text: typeof projectFile.content === "string" ? projectFile.content : "",
      name: attachment.name || projectFile.name || "",
      path: attachment.path,
      lineRef: attachment.lineRef || "",
    };
  }

  if (attachment.store === "upload" && attachment.id && attachmentStore) {
    const stored = await attachmentStore.readAttachment(attachment.id).catch(() => null);
    if (!stored) {
      return null;
    }

    const meta = stored.meta || {};
    if (meta.type === "image") {
      return {
        type: "image",
        mimeType: meta.mimeType || attachment.mimeType || "image/png",
        data: stored.buffer.toString("base64"),
      };
    }

    return {
      type: meta.type === "snippet" ? "snippet" : "file",
      text: stored.buffer.toString("utf8"),
      name: meta.name || attachment.name || "",
      path: meta.path || attachment.path || "",
      lineRef: meta.lineRef || attachment.lineRef || "",
    };
  }

  return null;
}

async function buildCheckMessagesPrompt(entry, conversationId, contextSummary, attachmentStore) {
  const normalized = normalizePromptEntry(entry);
  const images = [];
  let match;
  const re = new RegExp(IMAGE_MARKER_RE.source, IMAGE_MARKER_RE.flags);
  while ((match = re.exec(normalized.message)) !== null) {
    images.push({ mimeType: match[2], data: match[3] });
  }

  const cleanText = normalized.message.replace(IMAGE_MARKER_RE, "").trim();
  const resolvedAttachments = await Promise.all(
    normalized.attachments.map((attachment) => resolveAttachmentForPrompt(attachment, attachmentStore))
  );
  const textAttachmentBlocks = [];

  for (const attachment of resolvedAttachments) {
    if (!attachment) {
      continue;
    }

    if (attachment.type === "image") {
      images.push(attachment);
      continue;
    }

    textAttachmentBlocks.push(formatTextAttachmentForPrompt(attachment));
  }

  const userMessageSections = [];
  if (cleanText) {
    userMessageSections.push(cleanText);
  }
  if (textAttachmentBlocks.length > 0) {
    userMessageSections.push(textAttachmentBlocks.join("\n\n"));
  }
  const renderedUserMessage = userMessageSections.join("\n\n").trim() || "(本条消息未包含文字，仅附带附件)";

  const contextBlock = contextSummary
    ? `上下文摘要（由之前的 /compact 生成）:\n${contextSummary}\n\n---\n\n`
    : "";

  const content = [
    {
      type: "text",
      text:
        `当前会话 conversation_id: ${conversationId}\n\n` +
        contextBlock +
        `用户发来新消息:\n\n${renderedUserMessage}\n\n` +
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

function startCheckMessagesProgress(extra) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || progressToken === null) {
    return () => {};
  }

  const timer = setInterval(() => {
    void extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: 0,
        total: 1,
        message: "Waiting for the next Xiaohaha message...",
      },
    }).catch(() => {});
  }, CHECK_MESSAGES_PROGRESS_MS);

  return () => {
    clearInterval(timer);
  };
}

export function registerChatAppIntegration(mcpServer, sessionService, attachmentStore) {
  registerAppResource(
    mcpServer,
    "Xiaohaha Chat UI",
    CHAT_APP_URI,
    {
      description: "Embedded Xiaohaha follow-up chat UI.",
      _meta: {
        ui: {
          prefersBorder: false,
          csp: {
            connectDomains: [BASE_ORIGIN],
          },
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
                csp: {
                  connectDomains: [BASE_ORIGIN],
                },
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
        const queuedPreview = queuedMessage.preview || buildPreviewFromInput(queuedMessage.message, queuedMessage.attachments);
        sessionService.rememberToolPreview(session, instanceId, queuedPreview);
        return await buildCheckMessagesPrompt(queuedMessage, session.conversationId, session.contextSummary, attachmentStore);
      }

      let abortListener = null;
      const stopProgress = startCheckMessagesProgress(extra);

      try {
        const message = await Promise.race([
          sessionService.waitForNextMessage(session, instanceId, extra.sessionId),
          new Promise((resolve) => {
            abortListener = () => {
              sessionService.resolveWaitingState(session, WAIT_RESOLUTIONS.REQUEST_ABORTED);
              resolve(WAIT_RESOLUTIONS.REQUEST_ABORTED);
            };

            if (extra.signal.aborted) {
              abortListener();
              return;
            }

            extra.signal.addEventListener("abort", abortListener, { once: true });
          }),
        ]);

        if (message === WAIT_RESOLUTIONS.REQUEST_ABORTED) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Cursor cancelled check_messages while waiting for the next message.",
              },
            ],
          };
        }

        if (message === WAIT_RESOLUTIONS.SESSION_CLOSED || !message) {
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

        return await buildCheckMessagesPrompt(message, session.conversationId, session.contextSummary, attachmentStore);
      } finally {
        stopProgress();
        if (abortListener) {
          extra.signal.removeEventListener("abort", abortListener);
        }
      }
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
        preview_message: z
          .string()
          .optional()
          .describe("Preview text shown in the embedded chat history for this message."),
        attachments: z
          .array(UPLOAD_ATTACHMENT_SCHEMA)
          .max(20)
          .optional()
          .describe("Attachment references already uploaded to the local Xiaohaha service."),
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
    async ({ message, preview_message, attachments = [], instance_id, conversation_id }, extra) => {
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
      const previewMessage = typeof preview_message === "string" && preview_message.trim()
        ? preview_message.trim()
        : buildPreviewFromInput(message, attachments);
      sessionService.rememberToolPreview(session, instance_id, previewMessage);

      if (!sessionService.enqueueUserMessageWithAttachments(session, message, previewMessage, attachments)) {
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
    "xiaohaha_search_project_files",
    {
      description: "Search files in the current project for the embedded Xiaohaha chat mention picker.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Partial project-relative file path after typing @."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of file candidates to return."),
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async ({ query, limit }) => {
      const items = await searchProjectFiles(query || "", limit || PROJECT_FILE_SEARCH_LIMIT);
      return {
        content: [{ type: "text", text: JSON.stringify({ items }) }],
        structuredContent: { items },
      };
    }
  );

  registerAppTool(
    mcpServer,
    "xiaohaha_read_project_file",
    {
      description: "Read a selected project file for the embedded Xiaohaha chat mention picker.",
      inputSchema: {
        file_path: z.string().describe("Project-relative file path selected from the mention picker."),
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async ({ file_path }) => {
      try {
        const file = await readProjectFile(file_path);
        return {
          content: [{ type: "text", text: JSON.stringify(file) }],
          structuredContent: file,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取文件失败";
        return {
          isError: true,
          content: [{ type: "text", text: message }],
          structuredContent: { ok: false, error: message },
        };
      }
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
