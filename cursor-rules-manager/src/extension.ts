import * as vscode from 'vscode';
import { RulesManager } from './rulesManager';
import { RulesViewProvider } from './rulesViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const rulesManager = new RulesManager(workspaceRoot);
  rulesManager.setGlobalState(context.globalState);

  rulesManager.syncFromDisk();

  const provider = new RulesViewProvider(context.extensionUri, rulesManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RulesViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRulesManager.refresh', () => {
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

  context.subscriptions.push(rulesManager);
}

export function deactivate() {}
