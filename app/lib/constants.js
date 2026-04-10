export const POLL_INTERVAL_MS = 1500;
export const INPUT_MIN_HEIGHT_PX = 60;
export const INPUT_MAX_HEIGHT_PX = 180;
export const MAX_FILE_SIZE_BYTES = 1024 * 1024;
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export const TEXT_EXTENSIONS = new Set([
  "txt", "md", "js", "ts", "jsx", "tsx", "json", "xml", "html", "css", "scss",
  "less", "py", "rb", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs",
  "swift", "kt", "sh", "bash", "zsh", "yml", "yaml", "toml", "ini", "cfg",
  "conf", "env", "sql", "graphql", "vue", "svelte", "astro", "php", "pl",
  "r", "lua", "vim", "dockerfile", "makefile", "gitignore", "editorconfig",
  "prettierrc", "eslintrc", "log", "csv", "tsv", "svg",
]);

export const SLASH_COMMANDS = [
  { id: "file",     label: "/file",     desc: "添加文件附件",              icon: "📎" },
  { id: "image",    label: "/image",    desc: "粘贴或选择图片",            icon: "🖼️" },
  { id: "compact",  label: "/compact",  desc: "触发 Cursor 压缩上下文",     icon: "📦", hostCommand: "/compact" },
  { id: "context",  label: "/context",  desc: "手动设置上下文摘要",        icon: "✏️" },
  { id: "clearctx", label: "/clearctx", desc: "清除上下文摘要",            icon: "🧹" },
  { id: "reset",    label: "/reset",    desc: "重新开始，忘记历史",         icon: "🔄", hostCommand: "/new task" },
  { id: "summarize",label: "/summarize",desc: "总结当前进展和待办事项",     icon: "📝" },
  { id: "undo",     label: "/undo",     desc: "撤销上一步",                icon: "↩️" },
  { id: "clear",    label: "/clear",    desc: "清除所有附件",              icon: "🗑️" },
  { id: "help",     label: "/help",     desc: "查看快捷操作帮助",          icon: "💡" },
];
