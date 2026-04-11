"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RulesViewProvider = void 0;
const vscode = __importStar(require("vscode"));
class RulesViewProvider {
    constructor(extensionUri, rulesManager) {
        this.extensionUri = extensionUri;
        this.rulesManager = rulesManager;
        rulesManager.onDidChangeRules(() => this.refresh());
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        const msgDisposable = webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'toggle':
                    await this.rulesManager.toggleRule(msg.id);
                    this.refresh();
                    break;
                case 'delete': {
                    const rule = this.rulesManager.getRule(msg.id);
                    if (rule) {
                        const deleteMessage = rule.scope === 'user'
                            ? `Delete rule "${rule.name}"? This will also delete the matching rule from Cursor User Rules.`
                            : `Delete rule "${rule.name}"?`;
                        const choice = await vscode.window.showWarningMessage(deleteMessage, { modal: true }, 'Delete');
                        if (choice === 'Delete') {
                            await this.rulesManager.deleteRule(msg.id);
                            this.refresh();
                        }
                    }
                    break;
                }
                case 'save':
                    if (msg.ruleId) {
                        await this.rulesManager.updateRule(msg.ruleId, {
                            name: msg.name,
                            description: msg.description,
                            content: msg.content,
                            globs: msg.globs,
                            alwaysApply: msg.alwaysApply,
                        });
                    }
                    else {
                        await this.rulesManager.createRule(msg.name, msg.description, msg.content, msg.globs, msg.alwaysApply, msg.scope || 'project');
                    }
                    this.refresh();
                    break;
                case 'applyTemplate': {
                    const rule = this.rulesManager.getRule(msg.id);
                    if (!rule) {
                        break;
                    }
                    const target = await vscode.window.showQuickPick([
                        {
                            label: 'User Rule',
                            description: 'Create a Cursor user rule from this template',
                            scope: 'user',
                        },
                        {
                            label: 'Project Rule',
                            description: 'Create a workspace rule from this template',
                            scope: 'project',
                        },
                    ], { placeHolder: `Use "${rule.name}" as...` });
                    if (target) {
                        const created = await this.rulesManager.cloneRule(msg.id, target.scope);
                        if (created) {
                            vscode.window.showInformationMessage(`Created ${target.label.toLowerCase()} "${created.name}".`);
                            this.refresh();
                        }
                    }
                    break;
                }
                case 'favoriteRule': {
                    const sourceRule = this.rulesManager.getRule(msg.id);
                    if (!sourceRule) {
                        break;
                    }
                    const result = await this.rulesManager.toggleFavoriteRule(msg.id);
                    if (result?.favorited) {
                        vscode.window.showInformationMessage(`Saved "${sourceRule.name}" to common templates.`);
                        this.refresh();
                    }
                    else if (result) {
                        vscode.window.showInformationMessage(`Removed "${sourceRule.name}" from common templates.`);
                        this.refresh();
                    }
                    break;
                }
                case 'getRule': {
                    const r = this.rulesManager.getRule(msg.id);
                    if (r) {
                        const editableRule = r.scope === 'common' && r.favoriteSourceId
                            ? this.rulesManager.getRule(r.favoriteSourceId) || r
                            : r;
                        webviewView.webview.postMessage({ type: 'ruleData', rule: editableRule });
                    }
                    break;
                }
                case 'getRules':
                    this.sendRules();
                    break;
                case 'refreshRules':
                    await this.rulesManager.reconcileUserRules();
                    this.refresh();
                    break;
            }
        });
        webviewView.onDidDispose(() => {
            msgDisposable.dispose();
        });
    }
    openCreateEditor() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'openCreate' });
        }
    }
    refresh() {
        if (this._view) {
            this.sendRules();
        }
    }
    sendRules() {
        if (this._view) {
            const rules = this.rulesManager.getRules();
            this._view.webview.postMessage({ type: 'rulesUpdate', rules });
        }
    }
    getHtml(webview) {
        const nonce = getNonce();
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root {
      --radius: 6px;
      --transition: 150ms ease;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: transparent;
      padding: 0 8px 8px;
      overflow-x: hidden;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0 8px;
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      z-index: 100;
    }
    .header h2 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      opacity: 0.9;
    }
    .header-actions { display: flex; gap: 4px; }

    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity var(--transition), background var(--transition);
    }
    .icon-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }
    .icon-btn svg { width: 16px; height: 16px; }

    /* Section */
    .section { margin-bottom: 4px; }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 4px 4px;
      cursor: pointer;
      user-select: none;
    }
    .section-header:hover {
      background: var(--vscode-list-hoverBackground, rgba(90,93,94,0.12));
      border-radius: 4px;
    }
    .section-title {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    }
    .section-title .chevron {
      width: 14px; height: 14px;
      transition: transform var(--transition);
    }
    .section-title .chevron.collapsed { transform: rotate(-90deg); }
    .section-count {
      font-size: 10px;
      padding: 0 5px;
      border-radius: 8px;
      background: var(--vscode-badge-background, rgba(77,77,77,0.5));
      color: var(--vscode-badge-foreground, #ccc);
      line-height: 1.6;
    }
    .section-body { display: flex; flex-direction: column; gap: 2px; }
    .section-body.collapsed { display: none; }

    /* Empty */
    .empty-state {
      text-align: center;
      padding: 40px 16px;
      opacity: 0.6;
    }
    .empty-state svg { width: 48px; height: 48px; margin-bottom: 12px; opacity: 0.4; }
    .empty-state p { font-size: 12px; line-height: 1.5; }
    .empty-state .hint { font-size: 11px; margin-top: 8px; opacity: 0.7; }
    .section-empty {
      font-size: 11px;
      padding: 8px 24px;
      opacity: 0.5;
      font-style: italic;
    }

    /* Rule Card */
    .rule-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: var(--radius);
      background: transparent;
      transition: background var(--transition);
    }
    .rule-card:hover {
      background: var(--vscode-list-hoverBackground, rgba(90,93,94,0.12));
    }
    .rule-card.disabled { opacity: 0.45; }
    .rule-card.common {
      padding-right: 8px;
    }

    /* Toggle */
    .toggle {
      position: relative;
      width: 32px;
      min-width: 32px;
      height: 18px;
      cursor: pointer;
      flex-shrink: 0;
      align-self: center;
    }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .toggle-track {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--vscode-input-background, #3c3c3c);
      border-radius: 9px;
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
      transition: background var(--transition), border-color var(--transition);
    }
    .toggle-thumb {
      position: absolute;
      top: 2px; left: 2px;
      width: 12px; height: 12px;
      background: var(--vscode-foreground);
      border-radius: 50%;
      transition: transform var(--transition);
      opacity: 0.6;
    }
    .toggle input:checked + .toggle-track {
      background: var(--vscode-button-background, #0078d4);
      border-color: var(--vscode-button-background, #0078d4);
    }
    .toggle input:checked + .toggle-track .toggle-thumb {
      transform: translateX(14px);
      opacity: 1;
      background: var(--vscode-button-foreground, #fff);
    }

    .rule-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .rule-head {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .rule-name {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rule-desc {
      font-size: 11px;
      line-height: 1.3;
      color: var(--vscode-descriptionForeground, rgba(204,204,204,0.7));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rule-badges { display: flex; gap: 4px; flex-wrap: wrap; }
    .badge {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background, rgba(77,77,77,0.5));
      color: var(--vscode-badge-foreground, #ccc);
      line-height: 1.4;
    }
    .badge.active {
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
    }

    .rule-tail {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
      flex-shrink: 0;
    }
    .favorite-btn {
      opacity: 0.72;
    }
    .favorite-btn.active {
      opacity: 1;
      color: var(--vscode-button-background, #0078d4);
      background: var(--vscode-list-activeSelectionBackground, rgba(0,120,212,0.16));
    }
    .favorite-btn.active:hover {
      background: var(--vscode-list-activeSelectionBackground, rgba(0,120,212,0.22));
    }
    .mini-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 20px;
      padding: 0 7px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 999px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      font-size: 10px;
      line-height: 1;
      cursor: pointer;
      opacity: 0.92;
      transition: opacity var(--transition), background var(--transition);
    }
    .mini-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }
    .rule-actions {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }
    .rule-actions .icon-btn {
      width: 18px;
      height: 18px;
    }
    .rule-actions .icon-btn svg {
      width: 13px;
      height: 13px;
    }
    .rule-actions .icon-btn,
    .favorite-btn {
      flex-shrink: 0;
    }

    /* Editor Overlay */
    .editor-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--vscode-sideBar-background, #252526);
      z-index: 200;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .editor-overlay.hidden { display: none; }

    .editor-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(204,204,204,0.12));
    }
    .editor-header h3 { font-size: 12px; font-weight: 600; }

    .editor-body {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .form-group { display: flex; flex-direction: column; gap: 4px; }
    .form-label {
      font-size: 11px;
      font-weight: 500;
      opacity: 0.85;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .form-hint {
      font-size: 11px;
      line-height: 1.4;
      color: var(--vscode-descriptionForeground, rgba(204,204,204,0.72));
      opacity: 0.88;
    }
    .form-input,
    .form-textarea,
    .form-select {
      width: 100%;
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family, 'Menlo', monospace);
      font-size: 12px;
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      background: var(--vscode-input-background, #3c3c3c);
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
      border-radius: 4px;
      outline: none;
      transition: border-color var(--transition);
    }
    .form-select {
      appearance: auto;
      cursor: pointer;
    }
    .form-input:focus,
    .form-textarea:focus,
    .form-select:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .form-textarea {
      resize: vertical;
      min-height: 120px;
      line-height: 1.5;
    }

    .form-row { display: flex; align-items: center; gap: 8px; }
    .form-checkbox {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .form-checkbox input[type="checkbox"] {
      width: 14px; height: 14px;
      accent-color: var(--vscode-button-background, #0078d4);
      cursor: pointer;
    }

    .editor-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(204,204,204,0.12));
    }

    .btn {
      padding: 5px 12px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      border-radius: 4px;
      border: none;
      cursor: pointer;
      transition: opacity var(--transition);
    }
    .btn:hover { opacity: 0.9; }
    .btn-primary {
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4));
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.7));
    }
  </style>
</head>
<body>

  <div id="mainView">
    <div class="header">
      <h2>Cursor Rules</h2>
      <div class="header-actions">
        <button class="icon-btn" id="btnRefresh" title="Refresh">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.28-3.52"/>
            <polyline points="12 1 14 4 11 5"/>
          </svg>
        </button>
        <button class="icon-btn" id="btnAdd" title="Create Rule">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="8" y1="3" x2="8" y2="13"/>
            <line x1="3" y1="8" x2="13" y2="8"/>
          </svg>
        </button>
      </div>
    </div>

    <div id="emptyState" class="empty-state" style="display:none;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <p>No rules yet</p>
      <p class="hint">Click + to create your first rule or template</p>
    </div>

    <div id="sectionsContainer">
      <div class="section" id="commonSection">
        <div class="section-header" data-section="common">
          <div class="section-title">
            <svg class="chevron" viewBox="0 0 16 16" fill="currentColor"><path d="M5.7 13.7L5 13l4.6-5L5 3l.7-.7L10.4 8z"/></svg>
            Common Templates
          </div>
          <span class="section-count" id="commonCount">0</span>
        </div>
        <div class="section-body" id="commonRuleList"></div>
      </div>
      <div class="section" id="userSection">
        <div class="section-header" data-section="user">
          <div class="section-title">
            <svg class="chevron" viewBox="0 0 16 16" fill="currentColor"><path d="M5.7 13.7L5 13l4.6-5L5 3l.7-.7L10.4 8z"/></svg>
            User Rules
          </div>
          <span class="section-count" id="userCount">0</span>
        </div>
        <div class="section-body" id="userRuleList"></div>
      </div>
      <div class="section" id="projectSection">
        <div class="section-header" data-section="project">
          <div class="section-title">
            <svg class="chevron" viewBox="0 0 16 16" fill="currentColor"><path d="M5.7 13.7L5 13l4.6-5L5 3l.7-.7L10.4 8z"/></svg>
            Project Rules
          </div>
          <span class="section-count" id="projectCount">0</span>
        </div>
        <div class="section-body" id="projectRuleList"></div>
      </div>
    </div>
  </div>

  <div id="editorPanel" class="editor-overlay hidden">
    <div class="editor-header">
      <h3 id="editorTitle">Create Rule</h3>
      <button class="icon-btn" id="btnCloseEditor" title="Close">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="4" y1="4" x2="12" y2="12"/>
          <line x1="12" y1="4" x2="4" y2="12"/>
        </svg>
      </button>
    </div>
    <div class="editor-body">
      <div class="form-group">
        <label class="form-label" for="ruleScope">Scope</label>
        <select class="form-select" id="ruleScope">
          <option value="common">Common Template</option>
          <option value="user">User Rule (Cursor)</option>
          <option value="project">Project Rule (workspace)</option>
        </select>
        <div class="form-hint" id="scopeHint"></div>
      </div>
      <div class="form-group">
        <label class="form-label" for="ruleName">Name</label>
        <input class="form-input" id="ruleName" type="text" placeholder="my-rule"/>
      </div>
      <div class="form-group">
        <label class="form-label" for="ruleDesc">Description</label>
        <input class="form-input" id="ruleDesc" type="text" placeholder="What this rule does..."/>
      </div>
      <div class="form-group">
        <label class="form-label" for="ruleGlobs">Globs</label>
        <input class="form-input" id="ruleGlobs" type="text" placeholder="**/*.ts, **/*.js"/>
      </div>
      <div class="form-row">
        <label class="form-checkbox">
          <input type="checkbox" id="ruleAlwaysApply"/>
          Always Apply
        </label>
      </div>
      <div class="form-group">
        <label class="form-label" for="ruleContent">Rule Content</label>
        <textarea class="form-textarea" id="ruleContent" placeholder="Write your rule here..."></textarea>
      </div>
    </div>
    <div class="editor-footer">
      <button class="btn btn-secondary" id="btnCancel">Cancel</button>
      <button class="btn btn-primary" id="btnSave">Save</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentEditId = null;
    let currentEditScope = null;
    const collapsedSections = { common: true };

    const $ = (sel) => document.querySelector(sel);
    const emptyStateEl = $('#emptyState');
    const sectionsEl = $('#sectionsContainer');
    const editorPanel = $('#editorPanel');
    const editorTitle = $('#editorTitle');
    const scopeSelect = $('#ruleScope');
    const scopeHint = $('#scopeHint');

    function updateScopeHint() {
      if (scopeSelect.value === 'user') {
        scopeHint.textContent = 'Synced to Cursor Settings > Rules > User in real time. Globs are kept here for reference and are not enforced there.';
        return;
      }
      if (scopeSelect.value === 'project') {
        scopeHint.textContent = 'Saved to workspace .cursor/rules/*.mdc and applied as project rules.';
        return;
      }
      scopeHint.textContent = 'Stored inside the extension as a reusable template.';
    }

    function renderRuleCard(rule, favoriteRuleIds) {
      const isCommon = rule.scope === 'common';
      const isFavorited = !isCommon && favoriteRuleIds.has(rule.id);
      const badges = [];
      if (rule.alwaysApply) badges.push('<span class="badge active">Always</span>');
      if (rule.globs) badges.push('<span class="badge">' + escHtml(rule.globs) + '</span>');

      const leadingToggle = isCommon ? '' : ''
        + '<label class="toggle" title="' + (rule.enabled ? 'Disable rule' : 'Enable rule') + '">'
        + '  <input type="checkbox" ' + (rule.enabled ? 'checked' : '') + ' data-toggle="' + rule.id + '"/>'
        + '  <div class="toggle-track"><div class="toggle-thumb"></div></div>'
        + '</label>';
      const trailingPrimary = isCommon
        ? '<button class="mini-btn" data-apply="' + rule.id + '" title="Create a rule from this template">Use</button>'
        : '<button class="icon-btn favorite-btn' + (isFavorited ? ' active' : '') + '" data-favorite="' + rule.id + '" title="'
          + (isFavorited ? 'Remove from common templates' : 'Save as common template') + '">'
        + '  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">'
        + '    <path d="M8 1.9l1.8 3.65 4.02.59-2.91 2.83.69 4-3.6-1.89-3.6 1.89.69-4-2.91-2.83 4.02-.59z"/>'
        + '  </svg>'
        + '</button>';

      return '<div class="rule-card' + (rule.enabled ? '' : ' disabled') + (isCommon ? ' common' : '') + '" data-id="' + rule.id + '">'
        + leadingToggle
        + '<div class="rule-info">'
        + '  <div class="rule-head">'
        + '    <div class="rule-name">' + escHtml(rule.name) + '</div>'
        + '  </div>'
        + (rule.description ? '  <div class="rule-desc">' + escHtml(rule.description) + '</div>' : '')
        + (badges.length ? '  <div class="rule-badges">' + badges.join('') + '</div>' : '')
        + '</div>'
        + '<div class="rule-tail">'
        + trailingPrimary
        + '  <div class="rule-actions">'
        + '    <button class="icon-btn" data-edit="' + rule.id + '" title="Edit">'
        + '      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11.5 1.5l3 3L5 14H2v-3z"/></svg>'
        + '    </button>'
        + '    <button class="icon-btn" data-delete="' + rule.id + '" title="Delete">'
        + '      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 13 6"/><path d="M5 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M4 6l1 8h6l1-8"/></svg>'
        + '    </button>'
        + '  </div>'
        + '</div>'
        + '</div>';
    }

    function renderRules(rules) {
      const commonRules = rules.filter(r => r.scope === 'common');
      const userRules = rules.filter(r => r.scope === 'user');
      const projectRules = rules.filter(r => r.scope === 'project');
      const favoriteRuleIds = new Set(commonRules.filter(r => r.favoriteSourceId).map(r => r.favoriteSourceId));

      if (rules.length === 0) {
        sectionsEl.style.display = 'none';
        emptyStateEl.style.display = 'block';
        return;
      }
      sectionsEl.style.display = 'block';
      emptyStateEl.style.display = 'none';

      $('#commonCount').textContent = commonRules.length;
      $('#userCount').textContent = userRules.length;
      $('#projectCount').textContent = projectRules.length;

      if (commonRules.length === 0) {
        collapsedSections.common = true;
      } else if (collapsedSections.common === undefined) {
        collapsedSections.common = true;
      }
      if (userRules.length === 0) {
        collapsedSections.user = true;
      } else if (collapsedSections.user === undefined) {
        collapsedSections.user = false;
      }
      if (projectRules.length === 0) {
        collapsedSections.project = true;
      } else if (collapsedSections.project === undefined) {
        collapsedSections.project = false;
      }

      const commonList = $('#commonRuleList');
      const userList = $('#userRuleList');
      const projectList = $('#projectRuleList');

      commonList.innerHTML = commonRules.length
        ? commonRules.map(rule => renderRuleCard(rule, favoriteRuleIds)).join('')
        : '<div class="section-empty">No common templates</div>';

      userList.innerHTML = userRules.length
        ? userRules.map(rule => renderRuleCard(rule, favoriteRuleIds)).join('')
        : '<div class="section-empty">No Cursor user rules</div>';

      projectList.innerHTML = projectRules.length
        ? projectRules.map(rule => renderRuleCard(rule, favoriteRuleIds)).join('')
        : '<div class="section-empty">No project rules</div>';

      updateChevrons();
    }

    function updateChevrons() {
      document.querySelectorAll('.section-header').forEach(h => {
        const key = h.dataset.section;
        const chevron = h.querySelector('.chevron');
        const body = h.nextElementSibling;
        if (collapsedSections[key]) {
          chevron.classList.add('collapsed');
          body.classList.add('collapsed');
        } else {
          chevron.classList.remove('collapsed');
          body.classList.remove('collapsed');
        }
      });
    }

    function escHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function openEditor(rule) {
      currentEditId = rule ? rule.id : null;
      currentEditScope = rule ? rule.scope : null;
      editorTitle.textContent = rule ? 'Edit Rule' : 'Create Rule';
      scopeSelect.value = rule ? rule.scope : 'project';
      scopeSelect.disabled = !!rule;
      updateScopeHint();
      $('#ruleName').value = rule ? rule.name : '';
      $('#ruleDesc').value = rule ? rule.description : '';
      $('#ruleGlobs').value = rule ? rule.globs : '';
      $('#ruleAlwaysApply').checked = rule ? rule.alwaysApply : false;
      $('#ruleContent').value = rule ? rule.content : '';
      editorPanel.classList.remove('hidden');
      $('#ruleName').focus();
    }

    function closeEditor() {
      editorPanel.classList.add('hidden');
      currentEditId = null;
      currentEditScope = null;
    }

    function saveRule() {
      const name = $('#ruleName').value.trim();
      if (!name) {
        $('#ruleName').style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f44)';
        $('#ruleName').focus();
        return;
      }
      vscode.postMessage({
        type: 'save',
        ruleId: currentEditId,
        name,
        description: $('#ruleDesc').value.trim(),
        content: $('#ruleContent').value,
        globs: $('#ruleGlobs').value.trim(),
        alwaysApply: $('#ruleAlwaysApply').checked,
        scope: scopeSelect.value,
      });
      closeEditor();
    }

    // Section collapse toggle
    document.querySelectorAll('.section-header').forEach(h => {
      h.addEventListener('click', () => {
        const key = h.dataset.section;
        collapsedSections[key] = !collapsedSections[key];
        updateChevrons();
      });
    });

    // Event delegation on both lists
    sectionsEl.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.toggle) {
        vscode.postMessage({ type: 'toggle', id: t.dataset.toggle });
      }
    });

    sectionsEl.addEventListener('click', (e) => {
      const apply = e.target.closest('[data-apply]');
      if (apply) {
        vscode.postMessage({ type: 'applyTemplate', id: apply.dataset.apply });
        return;
      }
      const favorite = e.target.closest('[data-favorite]');
      if (favorite) {
        vscode.postMessage({ type: 'favoriteRule', id: favorite.dataset.favorite });
        return;
      }
      const btn = e.target.closest('[data-edit]');
      if (btn) {
        vscode.postMessage({ type: 'getRule', id: btn.dataset.edit });
        return;
      }
      const del = e.target.closest('[data-delete]');
      if (del) {
        vscode.postMessage({ type: 'delete', id: del.dataset.delete });
      }
    });

    $('#btnAdd').addEventListener('click', () => openEditor(null));
    $('#btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshRules' }));
    $('#btnCloseEditor').addEventListener('click', closeEditor);
    $('#btnCancel').addEventListener('click', closeEditor);
    $('#btnSave').addEventListener('click', saveRule);
    scopeSelect.addEventListener('change', updateScopeHint);

    $('#ruleName').addEventListener('input', (e) => { e.target.style.borderColor = ''; });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !editorPanel.classList.contains('hidden')) closeEditor();
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && !editorPanel.classList.contains('hidden')) {
        e.preventDefault();
        saveRule();
      }
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'rulesUpdate') renderRules(msg.rules);
      else if (msg.type === 'ruleData') openEditor(msg.rule);
      else if (msg.type === 'openCreate') openEditor(null);
    });

    vscode.postMessage({ type: 'getRules' });
    updateScopeHint();
  </script>
</body>
</html>`;
    }
}
exports.RulesViewProvider = RulesViewProvider;
RulesViewProvider.viewType = 'cursorRulesManager.rulesPanel';
function getNonce() {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
//# sourceMappingURL=rulesViewProvider.js.map