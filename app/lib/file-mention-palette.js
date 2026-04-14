import { escapeHtml, formatFileSize } from "./utils.js";

export class FileMentionPalette {
  constructor(el) {
    this.el = el;
    this.anchorEl = null;
    this.visible = false;
    this.loading = false;
    this.query = "";
    this.items = [];
    this.selectedIndex = -1;
    this.onSelect = null;
  }

  contains(target) {
    return this.el.contains(target);
  }

  setAnchorEl(anchorEl) {
    this.anchorEl = anchorEl;
  }

  showLoading(query = "") {
    this.visible = true;
    this.loading = true;
    this.query = query;
    this.items = [];
    this.selectedIndex = -1;
    this.el.hidden = false;
    this.render();
  }

  showItems(items, query = "") {
    this.visible = true;
    this.loading = false;
    this.query = query;
    this.items = Array.isArray(items) ? items : [];
    this.selectedIndex = this.items.length > 0 ? 0 : -1;
    this.el.hidden = false;
    this.render();
  }

  hide() {
    this.visible = false;
    this.loading = false;
    this.query = "";
    this.items = [];
    this.selectedIndex = -1;
    this.el.hidden = true;
    this.el.innerHTML = "";
  }

  getSelectedItem() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.items.length) return null;
    return this.items[this.selectedIndex] || null;
  }

  moveSelection(delta) {
    if (!this.visible || this.loading || this.items.length === 0) return;
    this.selectedIndex = this.selectedIndex < 0
      ? 0
      : (this.selectedIndex + delta + this.items.length) % this.items.length;
    this.syncActiveItem();
  }

  render() {
    if (!this.visible) {
      this.el.hidden = true;
      this.el.innerHTML = "";
      return;
    }

    this.updatePlacement();

    if (this.loading) {
      this.el.innerHTML = `<div class="xh-file-empty">搜索项目文件...</div>`;
      return;
    }

    if (this.items.length === 0) {
      const suffix = this.query ? `“${escapeHtml(this.query)}”` : "";
      this.el.innerHTML = `<div class="xh-file-empty">未找到匹配文件 ${suffix}</div>`;
      return;
    }

    this.el.innerHTML = this.items
      .map((item, index) => {
        const meta = typeof item.size === "number" ? formatFileSize(item.size) : "项目文件";
        const pathLabel = this.formatPathLabel(item.path || "");
        const fullLabel = [item.name || item.path || "", pathLabel].filter(Boolean).join("\n");
        return `<button class="xh-file-item${index === this.selectedIndex ? " active" : ""}" data-file-index="${index}" type="button" title="${escapeHtml(fullLabel)}">
          <span class="xh-file-icon">@</span>
          <span class="xh-file-body">
            <span class="xh-file-name" title="${escapeHtml(item.name || item.path || "")}">${escapeHtml(item.name || item.path || "")}</span>
            <span class="xh-file-path" title="${escapeHtml(pathLabel)}">${escapeHtml(pathLabel)}</span>
          </span>
          <span class="xh-file-meta">${escapeHtml(meta)}</span>
        </button>`;
      })
      .join("");

    this.el.querySelectorAll(".xh-file-item").forEach((itemEl) => {
      itemEl.addEventListener("mouseenter", () => {
        this.selectedIndex = Number(itemEl.dataset.fileIndex);
        this.syncActiveItem();
      });
      itemEl.addEventListener("click", () => {
        const index = Number(itemEl.dataset.fileIndex);
        const item = this.items[index];
        if (item) this.onSelect?.(item);
      });
    });

    this.syncActiveItem();
  }

  updatePlacement() {
    const anchor = this.anchorEl;
    if (!anchor || typeof anchor.getBoundingClientRect !== "function") {
      this.el.classList.remove("xh-palette-above");
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const estimatedHeight = Math.min(280, Math.max(120, (this.items.length || 4) * 44 + 12));
    const spaceAbove = rect.top;
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom);
    const placeAbove = spaceAbove > spaceBelow && spaceAbove >= Math.min(estimatedHeight, 180);

    this.el.classList.toggle("xh-palette-above", placeAbove);
  }

  formatPathLabel(rawPath) {
    if (!rawPath) return "";
    return rawPath.includes("/") ? rawPath : `./${rawPath}`;
  }

  syncActiveItem() {
    const nodes = this.el.querySelectorAll(".xh-file-item");
    nodes.forEach((item, index) => {
      const isActive = index === this.selectedIndex;
      item.classList.toggle("active", isActive);
      if (isActive) {
        item.scrollIntoView({ block: "nearest" });
      }
    });
  }
}
