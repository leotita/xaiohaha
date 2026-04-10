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
exports.RulesManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
class RulesManager {
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this._onDidChangeRules = new vscode.EventEmitter();
        this.onDidChangeRules = this._onDidChangeRules.event;
        this.rulesDir = path.join(workspaceRoot, '.cursor', 'rules');
        this.configPath = path.join(workspaceRoot, '.cursor', 'rules-manager.json');
    }
    setGlobalState(state) {
        this.globalState = state;
    }
    ensureDirectories() {
        const cursorDir = path.join(this.workspaceRoot, '.cursor');
        if (!fs.existsSync(cursorDir)) {
            fs.mkdirSync(cursorDir, { recursive: true });
        }
        if (!fs.existsSync(this.rulesDir)) {
            fs.mkdirSync(this.rulesDir, { recursive: true });
        }
    }
    loadProjectConfig() {
        if (fs.existsSync(this.configPath)) {
            try {
                const raw = fs.readFileSync(this.configPath, 'utf-8');
                const config = JSON.parse(raw);
                config.rules = config.rules.map(r => ({ ...r, scope: r.scope || 'project' }));
                return config;
            }
            catch {
                return { rules: [] };
            }
        }
        return { rules: [] };
    }
    saveProjectConfig(config) {
        this.ensureDirectories();
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    }
    loadUserRules() {
        if (!this.globalState) {
            return [];
        }
        const rules = this.globalState.get('cursorRulesManager.userRules', []);
        return rules.map(r => ({ ...r, scope: 'user' }));
    }
    async saveUserRules(rules) {
        if (!this.globalState) {
            return;
        }
        await this.globalState.update('cursorRulesManager.userRules', rules);
    }
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }
    sanitizeFilename(name) {
        return name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }
    buildMdcContent(rule) {
        const lines = ['---'];
        if (rule.description) {
            lines.push(`description: ${rule.description}`);
        }
        if (rule.globs) {
            lines.push(`globs: ${rule.globs}`);
        }
        lines.push(`alwaysApply: ${rule.alwaysApply}`);
        lines.push('---');
        lines.push('');
        lines.push(rule.content);
        return lines.join('\n');
    }
    parseMdcContent(raw) {
        const result = { description: '', globs: '', alwaysApply: false, content: raw };
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!fmMatch) {
            return result;
        }
        const frontmatter = fmMatch[1];
        result.content = (fmMatch[2] || '').trim();
        for (const line of frontmatter.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) {
                continue;
            }
            const key = line.substring(0, colonIdx).trim();
            const value = line.substring(colonIdx + 1).trim();
            if (key === 'description') {
                result.description = value;
            }
            else if (key === 'globs') {
                result.globs = value;
            }
            else if (key === 'alwaysApply') {
                result.alwaysApply = value === 'true';
            }
        }
        return result;
    }
    getMdcFilePath(rule) {
        const filename = this.sanitizeFilename(rule.name) || rule.id;
        return path.join(this.rulesDir, `${filename}.mdc`);
    }
    writeMdcFile(rule) {
        this.ensureDirectories();
        const filePath = this.getMdcFilePath(rule);
        fs.writeFileSync(filePath, this.buildMdcContent(rule), 'utf-8');
    }
    removeMdcFile(rule) {
        const filePath = this.getMdcFilePath(rule);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
    syncFromDisk() {
        this.ensureDirectories();
        const config = this.loadProjectConfig();
        const userRules = this.loadUserRules();
        const allKnownNames = new Set([
            ...config.rules.map(r => this.sanitizeFilename(r.name) || r.id),
            ...userRules.map(r => this.sanitizeFilename(r.name) || r.id),
        ]);
        let changed = false;
        const diskFiles = new Set();
        if (fs.existsSync(this.rulesDir)) {
            const files = fs.readdirSync(this.rulesDir).filter(f => f.endsWith('.mdc'));
            for (const file of files) {
                const baseName = file.replace(/\.mdc$/, '');
                diskFiles.add(baseName);
                const existingProject = config.rules.find(r => (this.sanitizeFilename(r.name) || r.id) === baseName);
                if (existingProject && existingProject.enabled) {
                    const diskContent = fs.readFileSync(path.join(this.rulesDir, file), 'utf-8');
                    const parsed = this.parseMdcContent(diskContent);
                    if (existingProject.content !== parsed.content || existingProject.description !== parsed.description
                        || existingProject.globs !== parsed.globs || existingProject.alwaysApply !== parsed.alwaysApply) {
                        existingProject.content = parsed.content;
                        existingProject.description = parsed.description;
                        existingProject.globs = parsed.globs;
                        existingProject.alwaysApply = parsed.alwaysApply;
                        changed = true;
                    }
                    continue;
                }
                if (allKnownNames.has(baseName)) {
                    continue;
                }
                const raw = fs.readFileSync(path.join(this.rulesDir, file), 'utf-8');
                const parsed = this.parseMdcContent(raw);
                config.rules.push({
                    id: this.generateId(),
                    name: baseName,
                    description: parsed.description,
                    content: parsed.content,
                    enabled: true,
                    globs: parsed.globs,
                    alwaysApply: parsed.alwaysApply,
                    scope: 'project',
                });
                allKnownNames.add(baseName);
                changed = true;
            }
        }
        for (const rule of config.rules) {
            if (rule.enabled) {
                const expectedName = this.sanitizeFilename(rule.name) || rule.id;
                if (!diskFiles.has(expectedName)) {
                    this.writeMdcFile(rule);
                }
            }
        }
        for (const rule of userRules) {
            if (rule.enabled) {
                const expectedName = this.sanitizeFilename(rule.name) || rule.id;
                if (!diskFiles.has(expectedName)) {
                    this.writeMdcFile(rule);
                }
            }
        }
        const legacyFile = path.join(this.workspaceRoot, '.cursorrules');
        if (fs.existsSync(legacyFile) && !allKnownNames.has('cursorrules-legacy')) {
            const raw = fs.readFileSync(legacyFile, 'utf-8').trim();
            if (raw) {
                config.rules.push({
                    id: this.generateId(),
                    name: 'cursorrules-legacy',
                    description: 'Imported from .cursorrules file',
                    content: raw,
                    enabled: true,
                    globs: '',
                    alwaysApply: true,
                    scope: 'project',
                });
                changed = true;
            }
        }
        if (changed) {
            this.saveProjectConfig(config);
        }
    }
    getRules() {
        this.syncFromDisk();
        const projectRules = this.loadProjectConfig().rules;
        const userRules = this.loadUserRules();
        return [...userRules, ...projectRules];
    }
    getRule(id) {
        return this.getRules().find(r => r.id === id);
    }
    isFilenameAvailable(name, excludeId) {
        const sanitized = this.sanitizeFilename(name);
        const all = this.getRules();
        return !all.some(r => r.id !== excludeId && (this.sanitizeFilename(r.name) || r.id) === sanitized);
    }
    async createRule(name, description, content, globs, alwaysApply, scope) {
        if (!this.isFilenameAvailable(name)) {
            vscode.window.showErrorMessage(`Rule name "${name}" conflicts with an existing rule.`);
            return null;
        }
        const rule = {
            id: this.generateId(),
            name,
            description,
            content,
            enabled: true,
            globs,
            alwaysApply,
            scope,
        };
        if (scope === 'user') {
            const userRules = this.loadUserRules();
            userRules.push(rule);
            await this.saveUserRules(userRules);
        }
        else {
            const config = this.loadProjectConfig();
            config.rules.push(rule);
            this.saveProjectConfig(config);
        }
        this.writeMdcFile(rule);
        this._onDidChangeRules.fire();
        return rule;
    }
    async updateRule(id, updates) {
        const userRules = this.loadUserRules();
        const userIdx = userRules.findIndex(r => r.id === id);
        if (userIdx !== -1) {
            const oldRule = userRules[userIdx];
            if (updates.name && updates.name !== oldRule.name) {
                if (!this.isFilenameAvailable(updates.name, id)) {
                    vscode.window.showErrorMessage(`Rule name "${updates.name}" conflicts with an existing rule.`);
                    return undefined;
                }
                this.removeMdcFile(oldRule);
            }
            const updatedRule = { ...oldRule, ...updates };
            userRules[userIdx] = updatedRule;
            await this.saveUserRules(userRules);
            if (updatedRule.enabled) {
                this.writeMdcFile(updatedRule);
            }
            else {
                this.removeMdcFile(updatedRule);
            }
            this._onDidChangeRules.fire();
            return updatedRule;
        }
        const config = this.loadProjectConfig();
        const projIdx = config.rules.findIndex(r => r.id === id);
        if (projIdx === -1) {
            return undefined;
        }
        const oldRule = config.rules[projIdx];
        if (updates.name && updates.name !== oldRule.name) {
            if (!this.isFilenameAvailable(updates.name, id)) {
                vscode.window.showErrorMessage(`Rule name "${updates.name}" conflicts with an existing rule.`);
                return undefined;
            }
            this.removeMdcFile(oldRule);
        }
        const updatedRule = { ...oldRule, ...updates };
        config.rules[projIdx] = updatedRule;
        this.saveProjectConfig(config);
        if (updatedRule.enabled) {
            this.writeMdcFile(updatedRule);
        }
        else {
            this.removeMdcFile(updatedRule);
        }
        this._onDidChangeRules.fire();
        return updatedRule;
    }
    async toggleRule(id) {
        const rule = this.getRule(id);
        if (!rule) {
            return undefined;
        }
        return this.updateRule(id, { enabled: !rule.enabled });
    }
    async deleteRule(id) {
        const userRules = this.loadUserRules();
        const userIdx = userRules.findIndex(r => r.id === id);
        if (userIdx !== -1) {
            this.removeMdcFile(userRules[userIdx]);
            userRules.splice(userIdx, 1);
            await this.saveUserRules(userRules);
            this._onDidChangeRules.fire();
            return true;
        }
        const config = this.loadProjectConfig();
        const idx = config.rules.findIndex(r => r.id === id);
        if (idx === -1) {
            return false;
        }
        this.removeMdcFile(config.rules[idx]);
        config.rules.splice(idx, 1);
        this.saveProjectConfig(config);
        this._onDidChangeRules.fire();
        return true;
    }
    dispose() {
        this._onDidChangeRules.dispose();
    }
}
exports.RulesManager = RulesManager;
//# sourceMappingURL=rulesManager.js.map