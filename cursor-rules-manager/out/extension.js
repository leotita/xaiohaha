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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const rulesManager_1 = require("./rulesManager");
const rulesViewProvider_1 = require("./rulesViewProvider");
function activate(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }
    const outputChannel = vscode.window.createOutputChannel('Cursor Rules Manager');
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const rulesManager = new rulesManager_1.RulesManager(workspaceRoot);
    rulesManager.setGlobalState(context.globalState);
    rulesManager.setSharedStorageDbPath(path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb'));
    rulesManager.setOutputChannel(outputChannel);
    outputChannel.appendLine(`[${new Date().toISOString()}] Cursor Rules Manager activated.`);
    rulesManager.syncFromDisk();
    void rulesManager.reconcileUserRules();
    const provider = new rulesViewProvider_1.RulesViewProvider(context.extensionUri, rulesManager);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(rulesViewProvider_1.RulesViewProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    context.subscriptions.push(vscode.commands.registerCommand('cursorRulesManager.refresh', async () => {
        await rulesManager.reconcileUserRules();
        provider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('cursorRulesManager.createRule', () => {
        provider.openCreateEditor();
    }));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolders[0], '.cursor/rules/*.mdc'));
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    context.subscriptions.push(watcher);
    context.subscriptions.push(outputChannel);
    context.subscriptions.push(rulesManager);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map