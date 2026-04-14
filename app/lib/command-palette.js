import { SLASH_COMMANDS } from "./constants.js";
import { escapeHtml } from "./utils.js";

export class CommandPalette {
  constructor(paletteEl) {
    this.el = paletteEl;
    this.anchorEl = null;
    this.visible = false;
    this.filter = "";
    this.selectedIndex = -1;
    this.filtered = [];
    this.onExecute = null;
  }

  setAnchorEl(anchorEl) {
    this.anchorEl = anchorEl;
  }

  getFilteredCommands(filter) {
    if (!filter) return [...SLASH_COMMANDS];
    const lower = filter.toLowerCase();
    return SLASH_COMMANDS.filter(
      (cmd) => cmd.id.includes(lower) || cmd.label.includes(lower) || cmd.desc.includes(lower)
    );
  }

  show(filter = "") {
    const filtered = this.getFilteredCommands(filter);
    if (filtered.length === 0) {
      this.hide();
      return;
    }

    this.visible = true;
    this.filter = filter;
    this.filtered = filtered;
    this.selectedIndex = 0;

    this.el.hidden = false;
    this.renderItems();
  }

  hide() {
    this.visible = false;
    this.filter = "";
    this.selectedIndex = -1;
    this.filtered = [];
    this.el.hidden = true;
    this.el.innerHTML = "";
  }

  renderItems() {
    this.updatePlacement();
    this.el.innerHTML = this.filtered
      .map(
        (cmd, i) => `
      <div class="xh-cmd-item${i === this.selectedIndex ? " active" : ""}" data-cmd-index="${i}" data-cmd-id="${cmd.id}">
        <span class="xh-cmd-icon">${cmd.icon}</span>
        <div class="xh-cmd-info">
          <div class="xh-cmd-name">${escapeHtml(cmd.label)}</div>
          <div class="xh-cmd-desc">${escapeHtml(cmd.desc)}</div>
        </div>
      </div>`
      )
      .join("");

    this.el.querySelectorAll(".xh-cmd-item").forEach((el) => {
      el.addEventListener("click", () => this.onExecute?.(el.dataset.cmdId));
      el.addEventListener("mouseenter", () => {
        this.selectedIndex = Number(el.dataset.cmdIndex);
        this.syncActiveItem();
      });
    });

    this.syncActiveItem();
  }

  moveSelection(delta) {
    if (!this.visible || this.filtered.length === 0) return;
    if (this.selectedIndex < 0) {
      this.selectedIndex = delta > 0 ? 0 : this.filtered.length - 1;
    } else {
      this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
    }
    this.syncActiveItem();
  }

  getSelectedCommandId() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.filtered.length) return null;
    return this.filtered[this.selectedIndex]?.id || null;
  }

  getSelectedLabel() {
    if (this.selectedIndex < 0) return "";
    return this.filtered[this.selectedIndex]?.label || "";
  }

  handleInputChange(text) {
    if (text.startsWith("/")) {
      this.show(text.slice(1).trim());
    } else if (this.visible) {
      this.hide();
    }
  }

  updatePlacement() {
    const anchor = this.anchorEl;
    if (!anchor || typeof anchor.getBoundingClientRect !== "function") {
      this.el.classList.remove("xh-palette-above");
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const estimatedHeight = Math.min(240, Math.max(120, (this.filtered.length || 4) * 44 + 12));
    const spaceAbove = rect.top;
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom);
    const placeAbove = spaceAbove > spaceBelow && spaceAbove >= Math.min(estimatedHeight, 180);

    this.el.classList.toggle("xh-palette-above", placeAbove);
  }

  syncActiveItem() {
    this.el.querySelectorAll(".xh-cmd-item").forEach((item, idx) => {
      const isActive = idx === this.selectedIndex;
      item.classList.toggle("active", isActive);
      if (isActive) {
        item.scrollIntoView({ block: "nearest" });
      }
    });
  }
}
