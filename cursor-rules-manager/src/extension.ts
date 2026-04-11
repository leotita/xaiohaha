import * as vscode from 'vscode';
import * as path from 'path';
import { RulesManager } from './rulesManager';
import { RulesViewProvider } from './rulesViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const outputChannel = vscode.window.createOutputChannel('Cursor Rules Manager');
  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const rulesManager = new RulesManager(workspaceRoot);
  rulesManager.setGlobalState(context.globalState);
  rulesManager.setSharedStorageDbPath(path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb'));
  rulesManager.setOutputChannel(outputChannel);
  outputChannel.appendLine(`[${new Date().toISOString()}] Cursor Rules Manager activated.`);

  rulesManager.syncFromDisk();
  void rulesManager.reconcileUserRules();

  const provider = new RulesViewProvider(context.extensionUri, rulesManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RulesViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRulesManager.refresh', async () => {
      await rulesManager.reconcileUserRules();
      provider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRulesManager.createRule', () => {
      provider.openCreateEditor();
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolders[0], '.cursor/rules/*.mdc'),
  );
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidChange(() => provider.refresh());
  watcher.onDidDelete(() => provider.refresh());
  context.subscriptions.push(watcher);

  context.subscriptions.push(outputChannel);
  context.subscriptions.push(rulesManager);
}

export function deactivate() {}
