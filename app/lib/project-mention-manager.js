const CHIP_SELECTOR = "[data-xh-chip-kind]";
const SELECTED_CLASS = "xh-mention-chip-selected";
const RUNTIME_WORKSPACE_MARKER = "/runtime/workspace/";
const CHIP_KIND_MENTION = "mention";
const CHIP_KIND_SNIPPET = "snippet";
const INLINE_ATTACHMENT_SENTINEL = "\uFFFC";

function normalizeMentionPath(filePath) {
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

function formatChipTooltipPath(filePath, fallbackLabel = "") {
  const normalized = normalizeMentionPath(filePath);
  if (!normalized) {
    return String(fallbackLabel || "");
  }
  return normalized.startsWith("./") ? normalized : `./${normalized}`;
}

function getChipKind(node) {
  return String(node?.dataset?.xhChipKind || "");
}

function getChipSerializedText(node) {
  if (!node?.dataset) {
    return "";
  }

  if (typeof node.dataset.xhChipText === "string" && node.dataset.xhChipText.length > 0) {
    return node.dataset.xhChipText;
  }

  if (getChipKind(node) === CHIP_KIND_MENTION) {
    return normalizeMentionPath(node.dataset.xhMentionPath || "");
  }

  return "";
}

function getChipLength(node) {
  return getChipSerializedText(node).length;
}

function getNodeIndex(node) {
  return node?.parentNode ? Array.prototype.indexOf.call(node.parentNode.childNodes, node) : -1;
}

function serializeNode(node) {
  if (!node) {
    return "";
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return String(node.textContent || "").replaceAll("\u00A0", " ");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  if (node.matches?.(CHIP_SELECTOR)) {
    return getChipSerializedText(node);
  }

  if (node.tagName === "BR") {
    return "\n";
  }

  return Array.from(node.childNodes).map((child) => serializeNode(child)).join("");
}

function measureNode(node) {
  return serializeNode(node).length;
}

function measureChildren(node, count) {
  let total = 0;
  const limit = Math.min(Number(count) || 0, node?.childNodes?.length || 0);
  for (let i = 0; i < limit; i += 1) {
    total += measureNode(node.childNodes[i]);
  }
  return total;
}

function calculatePointOffset(root, targetNode, targetOffset) {
  let total = 0;
  let found = false;

  function walk(node) {
    if (!node || found) {
      return;
    }

    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        total += Math.min(Number(targetOffset) || 0, String(node.textContent || "").length);
        found = true;
        return;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        total += measureChildren(node, targetOffset);
        found = true;
      }
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      total += String(node.textContent || "").length;
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    if (node.matches?.(CHIP_SELECTOR)) {
      total += getChipLength(node);
      return;
    }

    if (node.tagName === "BR") {
      total += 1;
      return;
    }

    Array.from(node.childNodes).forEach((child) => walk(child));
  }

  walk(root);
  return total;
}

function resolveOffset(root, targetOffset) {
  let remaining = Math.max(0, Number(targetOffset) || 0);
  let resolved = null;

  function walk(node) {
    if (!node || resolved) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const length = String(node.textContent || "").length;
      if (remaining <= length) {
        resolved = { node, offset: remaining };
        return;
      }
      remaining -= length;
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    if (node.matches?.(CHIP_SELECTOR)) {
      const length = getChipLength(node);
      const index = getNodeIndex(node);
      const parent = node.parentNode || root;

      if (remaining === 0) {
        resolved = { node: parent, offset: Math.max(index, 0) };
        return;
      }
      if (remaining <= length) {
        resolved = { node: parent, offset: Math.max(index, 0) + 1 };
        return;
      }
      remaining -= length;
      return;
    }

    if (node.tagName === "BR") {
      const index = getNodeIndex(node);
      const parent = node.parentNode || root;
      if (remaining === 0) {
        resolved = { node: parent, offset: Math.max(index, 0) };
        return;
      }
      if (remaining <= 1) {
        resolved = { node: parent, offset: Math.max(index, 0) + 1 };
        return;
      }
      remaining -= 1;
      return;
    }

    Array.from(node.childNodes).forEach((child) => walk(child));
  }

  walk(root);

  if (resolved) {
    return resolved;
  }

  return {
    node: root,
    offset: root.childNodes.length,
  };
}

export function serializeEditorText(root) {
  return Array.from(root?.childNodes || []).map((node) => serializeNode(node)).join("");
}

function stripInlineAttachmentSentinel(text) {
  return String(text || "").split(INLINE_ATTACHMENT_SENTINEL).join("");
}

export function getEditorSelectionOffsets(root) {
  const selection = window.getSelection();
  const fallback = serializeEditorText(root).length;
  if (!selection || selection.rangeCount === 0) {
    return { start: fallback, end: fallback };
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return { start: fallback, end: fallback };
  }

  return {
    start: calculatePointOffset(root, range.startContainer, range.startOffset),
    end: calculatePointOffset(root, range.endContainer, range.endOffset),
  };
}

export function setEditorSelectionRange(root, start, end = start) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const startPoint = resolveOffset(root, start);
  const endPoint = resolveOffset(root, end);
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function setEditorText(root, text) {
  root.innerHTML = "";
  const value = String(text || "");
  if (!value) {
    return;
  }
  root.appendChild(document.createTextNode(value));
}

export function insertEditorText(root, text) {
  const value = String(text || "");
  if (!value) {
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
    root.focus();
    setEditorSelectionRange(root, serializeEditorText(root).length);
  }

  const activeSelection = window.getSelection();
  if (!activeSelection || activeSelection.rangeCount === 0) {
    return;
  }

  const range = activeSelection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(value);
  range.insertNode(textNode);
  range.setStart(textNode, textNode.textContent.length);
  range.collapse(true);
  activeSelection.removeAllRanges();
  activeSelection.addRange(range);
  root.normalize();
}

function createChip({
  kind,
  label,
  path = "",
  serializedText = "",
  attachmentId = null,
  iconText = "i",
}) {
  const normalizedPath = normalizeMentionPath(path);
  const chipLabel = String(label || normalizedPath.split("/").pop() || "");
  const tooltipPath = formatChipTooltipPath(normalizedPath, chipLabel);
  const chip = document.createElement("span");
  chip.className = kind === CHIP_KIND_SNIPPET
    ? "xh-mention-chip xh-mention-chip--snippet"
    : "xh-mention-chip";
  chip.contentEditable = "false";
  chip.dataset.xhChipKind = kind;
  chip.dataset.xhChipText = serializedText;
  chip.dataset.xhChipName = chipLabel;
  chip.dataset.xhChipPath = normalizedPath;
  chip.dataset.xhChipTooltip = tooltipPath;
  chip.title = tooltipPath;

  if (kind === CHIP_KIND_MENTION) {
    chip.dataset.xhMentionPath = normalizedPath;
    chip.dataset.xhMentionName = chipLabel;
  }

  if (attachmentId !== null && attachmentId !== undefined) {
    chip.dataset.xhChipAttachmentId = String(attachmentId);
  }

  const open = document.createElement("span");
  open.className = "xh-mention-open";
  open.title = tooltipPath;

  const leading = document.createElement("span");
  leading.className = "xh-mention-leading";
  leading.title = tooltipPath;

  const icon = document.createElement("span");
  icon.className = "xh-mention-icon";
  icon.textContent = iconText;
  icon.title = tooltipPath;

  const text = document.createElement("span");
  text.className = "xh-mention-label";
  text.textContent = chipLabel;
  text.title = tooltipPath;

  const remove = document.createElement("button");
  remove.className = "xh-mention-remove";
  remove.type = "button";
  remove.dataset.xhMentionAction = "remove";
  remove.setAttribute("aria-label", `删除 ${chipLabel}`);
  remove.title = tooltipPath;
  remove.textContent = "×";

  leading.appendChild(icon);
  leading.appendChild(remove);
  open.appendChild(leading);
  open.appendChild(text);
  chip.appendChild(open);
  return chip;
}

function createMentionChip(item) {
  const path = normalizeMentionPath(item?.path || "");
  const label = item?.name || path.split("/").pop() || path;
  return createChip({
    kind: CHIP_KIND_MENTION,
    label,
    path,
    serializedText: path,
    iconText: "i",
  });
}

function createSnippetChip(item) {
  return createChip({
    kind: CHIP_KIND_SNIPPET,
    label: item?.name || "snippet",
    path: item?.path || "",
    serializedText: INLINE_ATTACHMENT_SENTINEL,
    attachmentId: item?.attachmentId ?? null,
    iconText: "#",
  });
}

function getChipPayload(chip) {
  const attachmentId = Number(chip?.dataset?.xhChipAttachmentId || "");
  return {
    kind: getChipKind(chip),
    path: normalizeMentionPath(chip?.dataset?.xhChipPath || chip?.dataset?.xhMentionPath || ""),
    name: String(chip?.dataset?.xhChipName || chip?.dataset?.xhMentionName || ""),
    attachmentId: Number.isFinite(attachmentId) && attachmentId > 0 ? attachmentId : null,
  };
}

function getChipStartOffset(root, chip) {
  const index = getNodeIndex(chip);
  const parent = chip?.parentNode || root;
  return calculatePointOffset(root, parent, index);
}

function trimLeadingSpace(text) {
  return String(text || "").startsWith(" ") ? String(text).slice(1) : String(text || "");
}

function trimTrailingSpace(text) {
  return String(text || "").endsWith(" ") ? String(text).slice(0, -1) : String(text || "");
}

function getLeadingSerializableChar(node) {
  if (!node) {
    return "";
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return String(node.textContent || "").charAt(0);
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  if (node.matches?.(CHIP_SELECTOR)) {
    return getChipSerializedText(node).charAt(0);
  }

  if (node.tagName === "BR") {
    return "\n";
  }

  for (const child of node.childNodes) {
    const nextChar = getLeadingSerializableChar(child);
    if (nextChar) {
      return nextChar;
    }
  }

  return "";
}

function shouldInsertTrailingSpace(nextNode) {
  if (!nextNode) {
    return true;
  }

  const nextChar = getLeadingSerializableChar(nextNode);
  if (!nextChar) {
    return true;
  }

  if (/\s/.test(nextChar)) {
    return false;
  }

  if (/[,.;:!?)\]}>，。；：！？、）】》]/.test(nextChar)) {
    return false;
  }

  return true;
}

function insertTrailingSpaceAfterChip(chip) {
  if (!chip?.parentNode) {
    return 0;
  }

  const nextNode = chip.nextSibling;
  if (!shouldInsertTrailingSpace(nextNode)) {
    return 0;
  }

  if (nextNode?.nodeType === Node.TEXT_NODE) {
    nextNode.textContent = ` ${nextNode.textContent || ""}`;
    return 1;
  }

  chip.after(document.createTextNode(" "));
  return 1;
}

export class ProjectMentionManager {
  constructor(editorEl) {
    this.editorEl = editorEl;
    this.onOpen = null;
    this.onChange = null;
    this.onRemove = null;
    this.tooltipEl = null;
    this.hoveredChip = null;

    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleMouseOver = this.handleMouseOver.bind(this);
    this.handleMouseOut = this.handleMouseOut.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleViewportChange = this.handleViewportChange.bind(this);

    this.editorEl.addEventListener("mousedown", this.handleMouseDown);
    this.editorEl.addEventListener("click", this.handleClick);
    this.editorEl.addEventListener("mouseover", this.handleMouseOver);
    this.editorEl.addEventListener("mouseout", this.handleMouseOut);
    this.editorEl.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("resize", this.handleViewportChange);
    window.addEventListener("scroll", this.handleViewportChange, true);
  }

  get length() {
    return this.editorEl.querySelectorAll(CHIP_SELECTOR).length;
  }

  getSelectedChip() {
    return this.editorEl.querySelector(`.${SELECTED_CLASS}`);
  }

  hasSelection() {
    return Boolean(this.getSelectedChip());
  }

  getText() {
    return serializeEditorText(this.editorEl);
  }

  buildMessageText() {
    return stripInlineAttachmentSentinel(this.getText()).trim();
  }

  buildPreviewText() {
    return this.buildMessageText();
  }

  findInlineAttachmentChip(attachmentId) {
    if (!attachmentId) {
      return null;
    }
    return this.editorEl.querySelector(
      `[data-xh-chip-kind="${CHIP_KIND_SNIPPET}"][data-xh-chip-attachment-id="${attachmentId}"]`
    );
  }

  insertChip(chip, startOffset = null, endOffset = startOffset, options = {}) {
    if (!chip) {
      return null;
    }

    const ensureTrailingSpace = Boolean(options?.ensureTrailingSpace);

    if (startOffset === null || endOffset === null) {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || !this.editorEl.contains(selection.anchorNode)) {
        this.editorEl.focus();
        setEditorSelectionRange(this.editorEl, serializeEditorText(this.editorEl).length);
      }

      const activeSelection = window.getSelection();
      if (!activeSelection || activeSelection.rangeCount === 0) {
        return null;
      }

      const range = activeSelection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(chip);
    } else {
      const startPoint = resolveOffset(this.editorEl, startOffset);
      const endPoint = resolveOffset(this.editorEl, endOffset);
      const range = document.createRange();
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset);
      range.deleteContents();
      range.insertNode(chip);
    }

    this.editorEl.normalize();
    this.editorEl.focus();

    const chipStart = getChipStartOffset(this.editorEl, chip);
    const trailingOffset = ensureTrailingSpace ? insertTrailingSpaceAfterChip(chip) : 0;
    setEditorSelectionRange(this.editorEl, chipStart + getChipLength(chip) + trailingOffset);
    this.onChange?.();
    return chip;
  }

  add(item, mention) {
    const path = normalizeMentionPath(item?.path || "");
    if (!path) {
      return;
    }

    const chip = createMentionChip(item);
    const startOffset = Math.max(0, Number(mention?.tokenStart) || 0);
    const endOffset = Math.max(startOffset, Number(mention?.tokenEnd) || startOffset);
    this.insertChip(chip, startOffset, endOffset, { ensureTrailingSpace: true });
  }

  addInlineAttachment(item, selectionRange = null) {
    const chip = createSnippetChip(item);
    if (selectionRange) {
      const start = Math.max(0, Number(selectionRange.start) || 0);
      const end = Math.max(start, Number(selectionRange.end) || start);
      return this.insertChip(chip, start, end);
    }
    return this.insertChip(chip);
  }

  updateInlineAttachment(attachmentId, patch = {}) {
    const chip = this.findInlineAttachmentChip(attachmentId);
    if (!chip) {
      return false;
    }

    const nextName = String(patch.name || chip.dataset.xhChipName || "snippet");
    const nextPath = normalizeMentionPath(
      "path" in patch
        ? patch.path
        : (chip.dataset.xhChipPath || "")
    );
    const nextTitle = nextPath || nextName;

    chip.dataset.xhChipName = nextName;
    chip.dataset.xhChipPath = nextPath;
    chip.title = nextTitle;

    const open = chip.querySelector(".xh-mention-open");
    if (open) {
      open.title = nextTitle;
    }

    const leading = chip.querySelector(".xh-mention-leading");
    if (leading) {
      leading.title = nextTitle;
    }

    const icon = chip.querySelector(".xh-mention-icon");
    if (icon) {
      icon.title = nextTitle;
    }

    const label = chip.querySelector(".xh-mention-label");
    if (label) {
      label.textContent = nextName;
      label.title = nextTitle;
    }

    const remove = chip.querySelector(".xh-mention-remove");
    if (remove) {
      remove.setAttribute("aria-label", `删除 ${nextName}`);
      remove.title = nextTitle;
    }

    return true;
  }

  clearSelection() {
    const selected = this.getSelectedChip();
    if (!selected) {
      return false;
    }
    selected.classList.remove(SELECTED_CLASS);
    return true;
  }

  selectChip(chip, focus = true) {
    if (!chip || !this.editorEl.contains(chip)) {
      return false;
    }

    const current = this.getSelectedChip();
    if (current && current !== chip) {
      current.classList.remove(SELECTED_CLASS);
    }
    chip.classList.add(SELECTED_CLASS);

    if (focus) {
      this.editorEl.focus();
      const startOffset = getChipStartOffset(this.editorEl, chip);
      setEditorSelectionRange(this.editorEl, startOffset + getChipLength(chip));
    }

    return true;
  }

  ensureTooltipEl() {
    if (this.tooltipEl?.isConnected) {
      return this.tooltipEl;
    }

    const tooltip = document.createElement("div");
    tooltip.className = "xh-mention-tooltip";
    tooltip.hidden = true;
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);
    this.tooltipEl = tooltip;
    return tooltip;
  }

  getTooltipText(chip) {
    return String(chip?.dataset?.xhChipTooltip || "").trim();
  }

  positionTooltip(chip = this.hoveredChip) {
    const tooltip = this.tooltipEl;
    if (!tooltip || tooltip.hidden || !chip || !chip.isConnected) {
      return;
    }

    const rect = chip.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const horizontalPadding = 12;
    const gap = 8;

    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    tooltip.style.maxWidth = `${Math.max(180, Math.min(560, viewportWidth - horizontalPadding * 2))}px`;

    const tooltipRect = tooltip.getBoundingClientRect();
    let left = rect.left;
    if (left + tooltipRect.width > viewportWidth - horizontalPadding) {
      left = viewportWidth - horizontalPadding - tooltipRect.width;
    }
    left = Math.max(horizontalPadding, left);

    let top = rect.top - tooltipRect.height - gap;
    if (top < horizontalPadding) {
      top = rect.bottom + gap;
    }
    if (top + tooltipRect.height > viewportHeight - horizontalPadding) {
      top = Math.max(horizontalPadding, rect.top - tooltipRect.height - gap);
    }

    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  showTooltip(chip) {
    const tooltipText = this.getTooltipText(chip);
    if (!tooltipText) {
      this.hideTooltip();
      return;
    }

    const tooltip = this.ensureTooltipEl();
    tooltip.textContent = tooltipText;
    tooltip.hidden = false;
    this.hoveredChip = chip;
    this.positionTooltip(chip);
  }

  hideTooltip() {
    this.hoveredChip = null;
    if (this.tooltipEl) {
      this.tooltipEl.hidden = true;
    }
  }

  removeChip(chip, focus = true, notify = true, emitRemove = true) {
    if (!chip?.parentNode || !this.editorEl.contains(chip)) {
      return;
    }

    if (this.hoveredChip === chip) {
      this.hideTooltip();
    }

    const chipPayload = getChipPayload(chip);
    const startOffset = getChipStartOffset(this.editorEl, chip);
    const prevNode = chip.previousSibling;
    const nextNode = chip.nextSibling;

    chip.remove();

    if (nextNode?.nodeType === Node.TEXT_NODE) {
      nextNode.textContent = trimLeadingSpace(nextNode.textContent);
    }
    if (prevNode?.nodeType === Node.TEXT_NODE && nextNode?.nodeType === Node.TEXT_NODE) {
      prevNode.textContent = trimTrailingSpace(prevNode.textContent);
      if (prevNode.textContent && nextNode.textContent) {
        prevNode.textContent = `${prevNode.textContent} ${nextNode.textContent}`;
        nextNode.remove();
      }
    }

    this.editorEl.normalize();
    if (focus) {
      this.editorEl.focus();
      setEditorSelectionRange(this.editorEl, startOffset);
    }
    if (emitRemove) {
      this.onRemove?.(chipPayload);
    }
    if (notify) {
      this.onChange?.();
    }
  }

  clear() {
    const chips = Array.from(this.editorEl.querySelectorAll(CHIP_SELECTOR));
    if (chips.length === 0) {
      return;
    }

    this.hideTooltip();
    chips.forEach((chip) => this.removeChip(chip, false, false, true));
    this.editorEl.normalize();
    this.onChange?.();
  }

  contains(target) {
    return this.editorEl.contains(target);
  }

  removeSelectedChip() {
    const chip = this.getSelectedChip();
    if (!chip) {
      return false;
    }
    this.removeChip(chip, true, true, true);
    return true;
  }

  getAdjacentChip(direction) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return null;
    }

    const anchorNode = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;
    if (!anchorNode || !this.editorEl.contains(anchorNode)) {
      return null;
    }

    if (anchorNode.nodeType === Node.TEXT_NODE) {
      const text = String(anchorNode.textContent || "");
      if (direction === "backward" && anchorOffset > 0) {
        return null;
      }
      if (direction === "forward" && anchorOffset < text.length) {
        return null;
      }
      let sibling = direction === "backward" ? anchorNode.previousSibling : anchorNode.nextSibling;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.matches?.(CHIP_SELECTOR)) {
          return sibling;
        }
        if (sibling.nodeType === Node.TEXT_NODE && String(sibling.textContent || "").length > 0) {
          return null;
        }
        sibling = direction === "backward" ? sibling.previousSibling : sibling.nextSibling;
      }
      return null;
    }

    if (anchorNode.nodeType === Node.ELEMENT_NODE) {
      const sibling = direction === "backward"
        ? anchorNode.childNodes[anchorOffset - 1]
        : anchorNode.childNodes[anchorOffset];

      if (sibling?.nodeType === Node.ELEMENT_NODE && sibling.matches?.(CHIP_SELECTOR)) {
        return sibling;
      }
    }

    return null;
  }

  handleDeleteKey(direction) {
    if (this.removeSelectedChip()) {
      return true;
    }

    const adjacentChip = this.getAdjacentChip(direction);
    if (!adjacentChip) {
      return false;
    }

    this.removeChip(adjacentChip, true, true, true);
    return true;
  }

  handleMouseDown(event) {
    const chip = event.target?.closest?.(CHIP_SELECTOR);
    if (!chip || !this.editorEl.contains(chip)) {
      return;
    }

    event.preventDefault();
  }

  handleMouseOver(event) {
    const chip = event.target?.closest?.(CHIP_SELECTOR);
    if (!chip || !this.editorEl.contains(chip)) {
      return;
    }
    this.showTooltip(chip);
  }

  handleMouseOut(event) {
    const chip = event.target?.closest?.(CHIP_SELECTOR);
    if (!chip || !this.editorEl.contains(chip)) {
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && chip.contains(relatedTarget)) {
      return;
    }

    if (this.hoveredChip === chip) {
      this.hideTooltip();
    }
  }

  handleMouseMove(event) {
    const chip = event.target?.closest?.(CHIP_SELECTOR);
    if (!chip || !this.editorEl.contains(chip)) {
      return;
    }

    if (this.hoveredChip !== chip) {
      this.showTooltip(chip);
      return;
    }

    this.positionTooltip(chip);
  }

  handleViewportChange() {
    if (this.hoveredChip) {
      this.positionTooltip(this.hoveredChip);
    }
  }

  handleClick(event) {
    const chip = event.target?.closest?.(CHIP_SELECTOR);
    if (!chip || !this.editorEl.contains(chip)) {
      this.hideTooltip();
      this.clearSelection();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const action = event.target?.closest?.("[data-xh-mention-action]")?.dataset?.xhMentionAction;
    if (action === "remove") {
      this.hideTooltip();
      this.removeChip(chip, true, true, true);
      return;
    }

    this.hideTooltip();
    this.selectChip(chip, true);
    const chipPayload = getChipPayload(chip);
    if (chipPayload.path) {
      this.onOpen?.(chipPayload);
    }
  }
}
