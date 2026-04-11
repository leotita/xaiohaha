import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export type RuleScope = 'user' | 'project' | 'common';
const FAVORITE_RULE_ID_PREFIX = 'favorite:';
const CURSOR_ACCESS_TOKEN_KEYS = ['cursor.accessToken', 'cursorAuth/accessToken'] as const;
const CURSOR_APPLICATION_USER_STORAGE_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
const CURSOR_DEFAULT_BACKEND_URL = 'https://api2.cursor.sh';
const CURSOR_CONNECT_PROTOCOL_VERSION = '1';
const CURSOR_KNOWLEDGE_BASE_SERVICE_PATH = 'aiserver.v1.AiService';
const CURSOR_KNOWLEDGE_BASE_LIMIT = 100;
const CURSOR_UNTITLED_RULE_TITLE = '[Untitled]';
const CURSOR_AUTH_REFRESH_SETTLE_DELAY_MS = 250;
const CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS = 3;
const CURSOR_KNOWLEDGE_BASE_RETRY_DELAYS_MS = [250, 800] as const;

type SqliteRow = { value?: string | Buffer };
type SqliteDatabase = {
  get(sql: string, params: unknown[], callback: (err: Error | null, row?: SqliteRow) => void): void;
  run(sql: string, params: unknown[], callback?: (err: Error | null) => void): void;
  close(callback?: (err: Error | null) => void): void;
};
type SqliteModule = {
  Database: new (file: string, callback?: (err: Error | null) => void) => SqliteDatabase;
};
type FetchRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};
type FetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};
type FetchFn = (input: string, init?: FetchRequestInit) => Promise<FetchResponse>;

interface CursorKnowledgeBaseItem {
  id: string;
  title: string;
  knowledge: string;
  createdAt?: string;
  isGenerated?: boolean;
}

interface CursorKnowledgeBaseListResponse {
  success?: boolean;
  allResults?: Array<Partial<CursorKnowledgeBaseItem>>;
}

interface CursorKnowledgeBaseAddResponse {
  success?: boolean;
  id?: string;
}

interface CursorKnowledgeBaseMutationResponse {
  success?: boolean;
}

interface CursorReactiveStorageSnapshot {
  cursorCreds?: {
    backendUrl?: string;
  };
}

export interface CursorRule {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  globs: string;
  alwaysApply: boolean;
  scope: RuleScope;
  favoriteSourceId?: string;
  cursorKnowledgeBaseId?: string;
}

interface RulesConfig {
  rules: CursorRule[];
}

interface UserRuleSyncResult {
  rules: CursorRule[];
  didMutateRemote: boolean;
}

export class RulesManager {
  private rulesDir: string;
  private configPath: string;
  private _onDidChangeRules = new vscode.EventEmitter<void>();
  readonly onDidChangeRules = this._onDidChangeRules.event;
  private globalState: vscode.Memento | undefined;
  private sharedStorageDbPath: string | undefined;
  private outputChannel: vscode.OutputChannel | undefined;
  private hasShownUserRuleSyncFailure = false;
  private cursorUiRefreshChain: Promise<void> = Promise.resolve();
  private cursorWindowReloadRequested = false;

  constructor(private workspaceRoot: string) {
    this.rulesDir = path.join(workspaceRoot, '.cursor', 'rules');
    this.configPath = path.join(workspaceRoot, '.cursor', 'rules-manager.json');
  }

  setGlobalState(state: vscode.Memento): void {
    this.globalState = state;
  }

  setSharedStorageDbPath(dbPath: string): void {
    this.sharedStorageDbPath = dbPath;
  }

  setOutputChannel(outputChannel: vscode.OutputChannel): void {
    this.outputChannel = outputChannel;
  }

  private ensureDirectories(): void {
    const cursorDir = path.join(this.workspaceRoot, '.cursor');
    if (!fs.existsSync(cursorDir)) {
      fs.mkdirSync(cursorDir, { recursive: true });
    }
    if (!fs.existsSync(this.rulesDir)) {
      fs.mkdirSync(this.rulesDir, { recursive: true });
    }
  }

  private loadProjectConfig(): RulesConfig {
    if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const config: RulesConfig = JSON.parse(raw);
        config.rules = config.rules.map(r => ({ ...r, scope: 'project' as RuleScope }));
        return config;
      } catch {
        return { rules: [] };
      }
    }
    return { rules: [] };
  }

  private saveProjectConfig(config: RulesConfig): void {
    this.ensureDirectories();
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  private loadUserRules(): CursorRule[] {
    if (!this.globalState) { return []; }
    const rules = this.globalState.get<CursorRule[]>('cursorRulesManager.userRules', []);
    return rules.map(r => ({ ...r, scope: 'user' as RuleScope }));
  }

  private async saveUserRules(rules: CursorRule[]): Promise<void> {
    if (!this.globalState) { return; }
    let normalizedRules = rules;
    let didMutateRemote = false;

    try {
      const syncResult = await this.syncUserRulesToCursorKnowledgeBase(rules);
      normalizedRules = syncResult.rules;
      didMutateRemote = syncResult.didMutateRemote;
    } catch (error) {
      console.error('[cursor-rules-manager] Failed to sync user rules to Cursor knowledge base', error);
      this.appendLogLine(`Failed to sync user rules to Cursor knowledge base: ${this.formatError(error)}`);
      await this.showUserRuleSyncFailureMessage(error);
    }

    await this.globalState.update('cursorRulesManager.userRules', normalizedRules);

    if (didMutateRemote) {
      try {
        await this.triggerCursorRulesSettingsRefresh(true, 'user-rule-save');
      } catch (error) {
        console.error('[cursor-rules-manager] Failed to refresh built-in Cursor rules page', error);
        this.appendLogLine(`Failed to refresh built-in Cursor rules page: ${this.formatError(error)}`);
      }
    }
  }

  private getStoredCommonRules(): CursorRule[] {
    if (!this.globalState) { return []; }
    const rules = this.globalState.get<CursorRule[]>('cursorRulesManager.commonRules', []);
    return rules.map(r => ({ ...r, scope: 'common' as RuleScope, enabled: true }));
  }

  private loadCommonRules(): CursorRule[] {
    return this.getStoredCommonRules().filter(r => !r.favoriteSourceId);
  }

  private async saveCommonRules(rules: CursorRule[]): Promise<void> {
    if (!this.globalState) { return; }
    const normalizedRules = rules.map(r => ({ ...r, scope: 'common' as RuleScope, enabled: true }));
    await this.globalState.update('cursorRulesManager.commonRules', normalizedRules);
  }

  private loadFavoriteRuleIds(): string[] {
    if (!this.globalState) { return []; }
    const storedFavoriteIds = this.globalState.get<string[]>('cursorRulesManager.favoriteRuleIds', []);
    const legacyFavoriteIds = this.getStoredCommonRules()
      .map(r => r.favoriteSourceId)
      .filter((id): id is string => Boolean(id));
    return Array.from(new Set([...storedFavoriteIds, ...legacyFavoriteIds]));
  }

  private async saveFavoriteRuleIds(ruleIds: string[]): Promise<void> {
    if (!this.globalState) { return; }
    const uniqueRuleIds = Array.from(new Set(ruleIds));
    await this.globalState.update('cursorRulesManager.favoriteRuleIds', uniqueRuleIds);
    await this.saveCommonRules(this.loadCommonRules());
  }

  private buildFavoriteRuleView(sourceRule: CursorRule): CursorRule {
    return {
      ...sourceRule,
      id: `${FAVORITE_RULE_ID_PREFIX}${sourceRule.id}`,
      scope: 'common',
      enabled: true,
      favoriteSourceId: sourceRule.id,
    };
  }

  private parseFavoriteRuleId(ruleId: string): string | undefined {
    if (!ruleId.startsWith(FAVORITE_RULE_ID_PREFIX)) {
      return undefined;
    }
    return ruleId.slice(FAVORITE_RULE_ID_PREFIX.length);
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }

  sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  private buildMdcContent(rule: CursorRule): string {
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

  private normalizeSharedStorageValue(value: string | Buffer | undefined): string {
    if (value === undefined) {
      return '';
    }
    return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value);
  }

  private getBundledSqliteModule(): SqliteModule | undefined {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (!resourcesPath) {
      return undefined;
    }

    const modulePath = path.join(resourcesPath, 'app', 'node_modules', '@vscode', 'sqlite3');
    if (!fs.existsSync(modulePath)) {
      return undefined;
    }
    return require(modulePath) as SqliteModule;
  }

  private async openSharedStorageDb(): Promise<SqliteDatabase | undefined> {
    if (!this.sharedStorageDbPath || !fs.existsSync(this.sharedStorageDbPath)) {
      return undefined;
    }

    const sqlite = this.getBundledSqliteModule();
    if (!sqlite) {
      return undefined;
    }

    return new Promise((resolve, reject) => {
      const db = new sqlite.Database(this.sharedStorageDbPath!, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(db);
      });
    });
  }

  private async closeSharedStorageDb(db: SqliteDatabase): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      db.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async getSharedStorageValue(key: string): Promise<string> {
    const db = await this.openSharedStorageDb();
    if (!db) {
      return '';
    }

    try {
      const row = await new Promise<SqliteRow | undefined>((resolve, reject) => {
        db.get(
          'SELECT value FROM ItemTable WHERE key = ?',
          [key],
          (err, result) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(result);
          },
        );
      });
      return this.normalizeSharedStorageValue(row?.value);
    } finally {
      await this.closeSharedStorageDb(db);
    }
  }

  private appendLogLine(message: string): void {
    if (!this.outputChannel) {
      return;
    }
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause !== undefined) {
        return `${error.name}: ${error.message}; cause=${this.formatError(cause)}`;
      }
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }

  private isRetryableCursorKnowledgeBaseTransportError(error: unknown): boolean {
    const detail = this.formatError(error).toLowerCase();
    return [
      'fetch failed',
      'client network socket disconnected',
      'tls',
      'etimedout',
      'econnreset',
      'ecanceled',
      'eai_again',
      'socket hang up',
      'networkerror',
    ].some(fragment => detail.includes(fragment));
  }

  private isRetryableCursorKnowledgeBaseStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  private getCursorKnowledgeBaseRetryDelay(attempt: number): number {
    return CURSOR_KNOWLEDGE_BASE_RETRY_DELAYS_MS[attempt - 1] ?? CURSOR_KNOWLEDGE_BASE_RETRY_DELAYS_MS[CURSOR_KNOWLEDGE_BASE_RETRY_DELAYS_MS.length - 1];
  }

  private showLogs(): void {
    this.outputChannel?.show(true);
  }

  private async showUserRuleSyncFailureMessage(error: unknown): Promise<void> {
    if (this.hasShownUserRuleSyncFailure) {
      return;
    }

    this.hasShownUserRuleSyncFailure = true;
    const message = error instanceof Error ? error.message : String(error);
    const selection = await vscode.window.showWarningMessage(
      `Failed to sync Cursor User Rules: ${message}`,
      'Show Logs',
    );
    if (selection === 'Show Logs') {
      this.showLogs();
    }
  }

  private getFetch(): FetchFn {
    const fetchFn = (globalThis as { fetch?: FetchFn }).fetch;
    if (!fetchFn) {
      throw new Error('Global fetch is unavailable in this Cursor version.');
    }
    return (input, init) => fetchFn(input, init);
  }

  private buildCursorRequestId(): string {
    return `cursor-rules-manager-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private async getCursorBackendUrl(): Promise<string> {
    const raw = await this.getSharedStorageValue(CURSOR_APPLICATION_USER_STORAGE_KEY);
    if (!raw) {
      return CURSOR_DEFAULT_BACKEND_URL;
    }

    try {
      const snapshot = JSON.parse(raw) as CursorReactiveStorageSnapshot;
      return snapshot.cursorCreds?.backendUrl?.trim() || CURSOR_DEFAULT_BACKEND_URL;
    } catch {
      return CURSOR_DEFAULT_BACKEND_URL;
    }
  }

  private async getCursorAccessToken(): Promise<string> {
    for (const key of CURSOR_ACCESS_TOKEN_KEYS) {
      const value = (await this.getSharedStorageValue(key)).trim();
      if (value) {
        return value;
      }
    }
    throw new Error('Cursor access token is unavailable. Please sign in to Cursor.');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async refreshCursorRulesSettingsViaTokenRefresh(): Promise<void> {
    let beforeAccessToken = '';
    try {
      beforeAccessToken = await this.getCursorAccessToken();
    } catch {
      beforeAccessToken = '';
    }

    this.appendLogLine('Requesting Cursor auth token refresh to invalidate built-in rules cache.');
    await vscode.commands.executeCommand('cursorAuth.triggerTokenRefresh', true);
    await this.delay(CURSOR_AUTH_REFRESH_SETTLE_DELAY_MS);

    let afterAccessToken = '';
    try {
      afterAccessToken = await this.getCursorAccessToken();
    } catch {
      afterAccessToken = '';
    }

    const tokenChanged = Boolean(afterAccessToken) && beforeAccessToken !== afterAccessToken;
    this.appendLogLine(
      tokenChanged
        ? 'Cursor auth token refresh updated access token; built-in rules refresh was requested.'
        : 'Cursor auth token refresh completed without access token rotation; built-in rules refresh was still requested.',
    );
  }

  private async reloadCursorWindowForRulesRefresh(source: string): Promise<void> {
    if (this.cursorWindowReloadRequested) {
      return;
    }

    this.cursorWindowReloadRequested = true;
    this.appendLogLine(`Reloading Cursor window to refresh built-in Rules page (${source}).`);
    try {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      this.cursorWindowReloadRequested = false;
      throw error;
    }
  }

  private async triggerCursorRulesSettingsRefresh(allowWindowReload: boolean, source: string): Promise<void> {
    const nextRefresh = this.cursorUiRefreshChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.refreshCursorRulesSettingsViaTokenRefresh();
          return;
        } catch (error) {
          this.appendLogLine(
            `Cursor auth refresh command failed while refreshing built-in rules page: ${this.formatError(error)}`,
          );
        }

        if (allowWindowReload) {
          await this.reloadCursorWindowForRulesRefresh(source);
        }
      });

    this.cursorUiRefreshChain = nextRefresh.catch(() => undefined);
    await nextRefresh;
  }

  private async callCursorKnowledgeBase<TResponse>(method: string, payload: Record<string, unknown>): Promise<TResponse> {
    const backendUrl = (await this.getCursorBackendUrl()).replace(/\/+$/, '');
    const accessToken = await this.getCursorAccessToken();
    const requestUrl = `${backendUrl}/${CURSOR_KNOWLEDGE_BASE_SERVICE_PATH}/${method}`;
    const requestBody = JSON.stringify(payload);
    const fetchFn = this.getFetch();

    for (let attempt = 1; attempt <= CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS; attempt += 1) {
      const requestId = this.buildCursorRequestId();
      let response: FetchResponse;

      this.appendLogLine(
        `Cursor knowledge base request started: ${method} ${requestUrl} requestId=${requestId} attempt=${attempt}/${CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS}`,
      );

      try {
        response = await fetchFn(requestUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': CURSOR_CONNECT_PROTOCOL_VERSION,
            'X-Request-ID': requestId,
          },
          body: requestBody,
        });
      } catch (error) {
        const detail = this.formatError(error);
        const canRetry = attempt < CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS
          && this.isRetryableCursorKnowledgeBaseTransportError(error);
        this.appendLogLine(
          `Cursor knowledge base request transport failure: ${method} ${requestUrl} requestId=${requestId} attempt=${attempt}/${CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS} detail=${detail}`,
        );
        if (canRetry) {
          const retryDelay = this.getCursorKnowledgeBaseRetryDelay(attempt);
          this.appendLogLine(
            `Retrying Cursor knowledge base request after transport failure: ${method} requestId=${requestId} nextAttempt=${attempt + 1} delayMs=${retryDelay}`,
          );
          await this.delay(retryDelay);
          continue;
        }
        throw new Error(`Cursor knowledge base request failed (${method} ${requestUrl}): ${detail}`);
      }

      let text = '';
      try {
        text = await response.text();
      } catch (error) {
        const detail = this.formatError(error);
        const canRetry = attempt < CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS
          && this.isRetryableCursorKnowledgeBaseTransportError(error);
        this.appendLogLine(
          `Cursor knowledge base response read failure: ${method} ${requestUrl} requestId=${requestId} attempt=${attempt}/${CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS} detail=${detail}`,
        );
        if (canRetry) {
          const retryDelay = this.getCursorKnowledgeBaseRetryDelay(attempt);
          this.appendLogLine(
            `Retrying Cursor knowledge base request after response read failure: ${method} requestId=${requestId} nextAttempt=${attempt + 1} delayMs=${retryDelay}`,
          );
          await this.delay(retryDelay);
          continue;
        }
        throw new Error(`Cursor knowledge base response read failed (${method} ${requestUrl}): ${detail}`);
      }

      if (!response.ok) {
        const detail = text.trim() || `HTTP ${response.status}`;
        const canRetry = attempt < CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS
          && this.isRetryableCursorKnowledgeBaseStatus(response.status);
        this.appendLogLine(
          `Cursor knowledge base request failed: ${method} ${requestUrl} requestId=${requestId} attempt=${attempt}/${CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS} status=${response.status} detail=${detail.slice(0, 500)}`,
        );
        if (canRetry) {
          const retryDelay = this.getCursorKnowledgeBaseRetryDelay(attempt);
          this.appendLogLine(
            `Retrying Cursor knowledge base request after HTTP failure: ${method} requestId=${requestId} status=${response.status} nextAttempt=${attempt + 1} delayMs=${retryDelay}`,
          );
          await this.delay(retryDelay);
          continue;
        }
        throw new Error(`Cursor knowledge base request failed (${method} ${requestUrl}) [HTTP ${response.status}]: ${detail}`);
      }

      this.appendLogLine(
        `Cursor knowledge base request completed: ${method} ${requestUrl} requestId=${requestId} attempt=${attempt}/${CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS} status=${response.status}`,
      );

      if (!text.trim()) {
        return {} as TResponse;
      }

      try {
        return JSON.parse(text) as TResponse;
      } catch (error) {
        const detail = this.formatError(error);
        this.appendLogLine(
          `Cursor knowledge base response parse failure: ${method} ${requestUrl} requestId=${requestId} attempt=${attempt}/${CURSOR_KNOWLEDGE_BASE_MAX_ATTEMPTS} detail=${detail} body=${text.slice(0, 500)}`,
        );
        throw new Error(`Cursor knowledge base returned invalid JSON (${method} ${requestUrl}): ${detail}`);
      }
    }

    throw new Error(`Cursor knowledge base request exhausted retries (${method} ${requestUrl}).`);
  }

  private buildUserRuleKnowledge(rule: CursorRule): string {
    const content = rule.content.trim();
    if (content) {
      return content;
    }
    const description = rule.description.trim();
    if (description) {
      return description;
    }
    return rule.name.trim();
  }

  private buildUserRuleTitle(rule: CursorRule): string {
    return rule.name.trim() || CURSOR_UNTITLED_RULE_TITLE;
  }

  private getUniqueImportedUserRuleName(baseName: string, existingRules: CursorRule[]): string {
    const normalizedBaseName = baseName.trim() || CURSOR_UNTITLED_RULE_TITLE;
    const existingNames = new Set(existingRules.map(rule => rule.name));
    if (!existingNames.has(normalizedBaseName)) {
      return normalizedBaseName;
    }

    const firstCopyName = `${normalizedBaseName} copy`;
    if (!existingNames.has(firstCopyName)) {
      return firstCopyName;
    }

    let index = 2;
    let candidate = `${firstCopyName} ${index}`;
    while (existingNames.has(candidate)) {
      index += 1;
      candidate = `${firstCopyName} ${index}`;
    }
    return candidate;
  }

  private mergeUserRulesWithCursorKnowledgeBase(
    localRules: CursorRule[],
    remoteItems: CursorKnowledgeBaseItem[],
  ): CursorRule[] {
    const usedRemoteIds = new Set<string>();
    const mergedRules = localRules.map((rule) => {
      const nextRule = { ...rule, scope: 'user' as RuleScope };
      let remoteItem = nextRule.cursorKnowledgeBaseId
        ? remoteItems.find(item => item.id === nextRule.cursorKnowledgeBaseId)
        : undefined;

      if (!remoteItem) {
        remoteItem = this.findMatchingCursorKnowledgeBaseItem(nextRule, remoteItems, usedRemoteIds);
      }

      if (remoteItem) {
        usedRemoteIds.add(remoteItem.id);
        nextRule.name = remoteItem.title || CURSOR_UNTITLED_RULE_TITLE;
        nextRule.content = remoteItem.knowledge ?? '';
        nextRule.enabled = true;
        nextRule.cursorKnowledgeBaseId = remoteItem.id;
        return nextRule;
      }

      if (nextRule.cursorKnowledgeBaseId && nextRule.enabled) {
        this.appendLogLine(
          `Cursor user rule no longer exists remotely; disabling local mirror "${nextRule.name}" (${nextRule.cursorKnowledgeBaseId}).`,
        );
        nextRule.enabled = false;
        delete nextRule.cursorKnowledgeBaseId;
      }

      return nextRule;
    });

    for (const remoteItem of remoteItems) {
      if (usedRemoteIds.has(remoteItem.id)) {
        continue;
      }

      const importedRule: CursorRule = {
        id: this.generateId(),
        name: this.getUniqueImportedUserRuleName(remoteItem.title || CURSOR_UNTITLED_RULE_TITLE, mergedRules),
        description: '',
        content: remoteItem.knowledge ?? '',
        enabled: true,
        globs: '',
        alwaysApply: true,
        scope: 'user',
        cursorKnowledgeBaseId: remoteItem.id,
      };
      mergedRules.push(importedRule);
      this.appendLogLine(`Imported Cursor user rule into plugin: "${importedRule.name}" (${remoteItem.id}).`);
    }

    return mergedRules;
  }

  private async listCursorKnowledgeBaseItems(): Promise<CursorKnowledgeBaseItem[]> {
    const response = await this.callCursorKnowledgeBase<CursorKnowledgeBaseListResponse>(
      'KnowledgeBaseList',
      { limit: CURSOR_KNOWLEDGE_BASE_LIMIT },
    );
    return (response.allResults ?? []).map(item => ({
      id: item.id ?? '',
      title: item.title ?? CURSOR_UNTITLED_RULE_TITLE,
      knowledge: item.knowledge ?? '',
      createdAt: item.createdAt,
      isGenerated: item.isGenerated ?? false,
    }));
  }

  private async addCursorKnowledgeBaseItem(title: string, knowledge: string): Promise<string> {
    const response = await this.callCursorKnowledgeBase<CursorKnowledgeBaseAddResponse>(
      'KnowledgeBaseAdd',
      { title, knowledge },
    );
    if (!response.id) {
      throw new Error('Cursor knowledge base did not return an item id.');
    }
    return response.id;
  }

  private async updateCursorKnowledgeBaseItem(id: string, title: string, knowledge: string): Promise<void> {
    const response = await this.callCursorKnowledgeBase<CursorKnowledgeBaseMutationResponse>(
      'KnowledgeBaseUpdate',
      { id, title, knowledge },
    );
    if (response.success === false) {
      throw new Error(`Cursor knowledge base rejected the update for item ${id}.`);
    }
  }

  private async removeCursorKnowledgeBaseItem(id: string): Promise<void> {
    const response = await this.callCursorKnowledgeBase<CursorKnowledgeBaseMutationResponse>(
      'KnowledgeBaseRemove',
      { id },
    );
    if (response.success === false) {
      throw new Error(`Cursor knowledge base rejected the deletion for item ${id}.`);
    }
  }

  private findMatchingCursorKnowledgeBaseItem(
    rule: CursorRule,
    items: CursorKnowledgeBaseItem[],
    usedItemIds: Set<string>,
  ): CursorKnowledgeBaseItem | undefined {
    const desiredKnowledge = this.buildUserRuleKnowledge(rule);
    const desiredTitle = this.buildUserRuleTitle(rule);
    const knowledgeMatches = items.filter(item => !usedItemIds.has(item.id) && item.knowledge === desiredKnowledge);
    if (knowledgeMatches.length === 0) {
      return undefined;
    }

    const exactTitleMatch = knowledgeMatches.find(item => item.title === desiredTitle);
    if (exactTitleMatch) {
      return exactTitleMatch;
    }

    if (knowledgeMatches.length === 1) {
      return knowledgeMatches[0];
    }

    const untitledMatches = knowledgeMatches
      .filter(item => !item.title || item.title === CURSOR_UNTITLED_RULE_TITLE);
    if (untitledMatches.length === 1) {
      return untitledMatches[0];
    }

    return undefined;
  }

  private async syncUserRulesToCursorKnowledgeBase(
    rules: CursorRule[],
    remoteItems?: CursorKnowledgeBaseItem[],
  ): Promise<UserRuleSyncResult> {
    if (!this.sharedStorageDbPath) {
      return { rules, didMutateRemote: false };
    }

    const effectiveRemoteItems = remoteItems ?? await this.listCursorKnowledgeBaseItems();
    const remoteItemsById = new Map(effectiveRemoteItems.map(item => [item.id, item]));
    const usedItemIds = new Set<string>();
    let didMutateRemote = false;

    const normalizedRules = await Promise.all(rules.map(async (rule) => {
      const nextRule = { ...rule };
      const desiredKnowledge = this.buildUserRuleKnowledge(nextRule);
      const desiredTitle = this.buildUserRuleTitle(nextRule);

      let remoteItem = nextRule.cursorKnowledgeBaseId
        ? remoteItemsById.get(nextRule.cursorKnowledgeBaseId)
        : undefined;

      if (!remoteItem) {
        remoteItem = this.findMatchingCursorKnowledgeBaseItem(nextRule, effectiveRemoteItems, usedItemIds);
      }

      if (remoteItem) {
        usedItemIds.add(remoteItem.id);
      }

      if (!nextRule.enabled) {
        if (remoteItem) {
          await this.removeCursorKnowledgeBaseItem(remoteItem.id);
          remoteItemsById.delete(remoteItem.id);
          didMutateRemote = true;
        }
        delete nextRule.cursorKnowledgeBaseId;
        return nextRule;
      }

      if (remoteItem) {
        nextRule.cursorKnowledgeBaseId = remoteItem.id;
        if (remoteItem.title !== desiredTitle || remoteItem.knowledge !== desiredKnowledge) {
          await this.updateCursorKnowledgeBaseItem(remoteItem.id, desiredTitle, desiredKnowledge);
          didMutateRemote = true;
        }
        return nextRule;
      }

      nextRule.cursorKnowledgeBaseId = await this.addCursorKnowledgeBaseItem(desiredTitle, desiredKnowledge);
      didMutateRemote = true;
      return nextRule;
    }));

    return {
      rules: normalizedRules,
      didMutateRemote,
    };
  }

  async reconcileUserRules(): Promise<void> {
    if (!this.globalState) {
      return;
    }
    try {
      const localRules = this.loadUserRules();
      const remoteItems = await this.listCursorKnowledgeBaseItems();
      const mergedRules = this.mergeUserRulesWithCursorKnowledgeBase(localRules, remoteItems);
      const syncResult = await this.syncUserRulesToCursorKnowledgeBase(mergedRules, remoteItems);
      await this.globalState.update('cursorRulesManager.userRules', syncResult.rules);
    } catch (error) {
      console.error('[cursor-rules-manager] Failed to reconcile Cursor user rules', error);
      this.appendLogLine(`Failed to reconcile Cursor user rules: ${this.formatError(error)}`);
      await this.showUserRuleSyncFailureMessage(error);
    }
  }

  private parseMdcContent(raw: string): { description: string; globs: string; alwaysApply: boolean; content: string } {
    const result = { description: '', globs: '', alwaysApply: false, content: raw };
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) { return result; }

    const frontmatter = fmMatch[1];
    result.content = (fmMatch[2] || '').trim();

    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) { continue; }
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      if (key === 'description') { result.description = value; }
      else if (key === 'globs') { result.globs = value; }
      else if (key === 'alwaysApply') { result.alwaysApply = value === 'true'; }
    }
    return result;
  }

  private getMdcFilePath(rule: CursorRule): string {
    const filename = this.sanitizeFilename(rule.name) || rule.id;
    return path.join(this.rulesDir, `${filename}.mdc`);
  }

  private hasProjectRuleFilename(filename: string): boolean {
    return this.loadProjectConfig().rules.some(rule => (this.sanitizeFilename(rule.name) || rule.id) === filename);
  }

  private writeMdcFile(rule: CursorRule): void {
    this.ensureDirectories();
    const filePath = this.getMdcFilePath(rule);
    fs.writeFileSync(filePath, this.buildMdcContent(rule), 'utf-8');
  }

  private removeMdcFile(rule: CursorRule): void {
    const filePath = this.getMdcFilePath(rule);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  private removeLegacyUserRuleFileIfManaged(rule: CursorRule): void {
    const filename = this.sanitizeFilename(rule.name) || rule.id;
    if (this.hasProjectRuleFilename(filename)) {
      return;
    }

    const filePath = path.join(this.rulesDir, `${filename}.mdc`);
    if (!fs.existsSync(filePath)) {
      return;
    }

    try {
      const diskContent = fs.readFileSync(filePath, 'utf-8');
      if (diskContent === this.buildMdcContent(rule)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn('[cursor-rules-manager] Failed to remove legacy user rule file', error);
    }
  }

  syncFromDisk(): void {
    this.ensureDirectories();
    const config = this.loadProjectConfig();
    const userRules = this.loadUserRules();
    for (const rule of userRules) {
      this.removeLegacyUserRuleFileIfManaged(rule);
    }
    const allKnownNames = new Set(config.rules.map(r => this.sanitizeFilename(r.name) || r.id));

    let changed = false;
    const diskFiles = new Set<string>();

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

        if (allKnownNames.has(baseName)) { continue; }

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

  getRules(): CursorRule[] {
    this.syncFromDisk();
    const projectRules = this.loadProjectConfig().rules;
    const userRules = this.loadUserRules();
    const sourceRules = [...userRules, ...projectRules];
    const sourceRuleMap = new Map(sourceRules.map(rule => [rule.id, rule]));
    const favoriteRules = this.loadFavoriteRuleIds()
      .map(ruleId => sourceRuleMap.get(ruleId))
      .filter((rule): rule is CursorRule => Boolean(rule))
      .map(rule => this.buildFavoriteRuleView(rule));
    const commonRules = this.loadCommonRules();
    return [...commonRules, ...favoriteRules, ...userRules, ...projectRules];
  }

  getRule(id: string): CursorRule | undefined {
    return this.getRules().find(r => r.id === id);
  }

  private getRulesForScope(scope: RuleScope): CursorRule[] {
    if (scope === 'common') { return this.loadCommonRules(); }
    if (scope === 'user') { return this.loadUserRules(); }
    return this.loadProjectConfig().rules;
  }

  private isFilenameAvailable(name: string, scope: RuleScope, excludeId?: string): boolean {
    const sanitized = this.sanitizeFilename(name);
    const all = this.getRulesForScope(scope);
    return !all.some(r => r.id !== excludeId && (this.sanitizeFilename(r.name) || r.id) === sanitized);
  }

  private getUniqueName(baseName: string, scope: RuleScope, excludeId?: string): string {
    if (this.isFilenameAvailable(baseName, scope, excludeId)) {
      return baseName;
    }

    const firstCopyName = `${baseName} copy`;
    if (this.isFilenameAvailable(firstCopyName, scope, excludeId)) {
      return firstCopyName;
    }

    let index = 2;
    while (!this.isFilenameAvailable(`${firstCopyName} ${index}`, scope, excludeId)) {
      index += 1;
    }
    return `${firstCopyName} ${index}`;
  }

  async createRule(
    name: string,
    description: string,
    content: string,
    globs: string,
    alwaysApply: boolean,
    scope: RuleScope,
  ): Promise<CursorRule | null> {
    if (!this.isFilenameAvailable(name, scope)) {
      vscode.window.showErrorMessage(`Rule name "${name}" conflicts with an existing rule.`);
      return null;
    }

    const rule: CursorRule = {
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
    } else if (scope === 'common') {
      const commonRules = this.loadCommonRules();
      commonRules.push(rule);
      await this.saveCommonRules(commonRules);
    } else {
      const config = this.loadProjectConfig();
      config.rules.push(rule);
      this.saveProjectConfig(config);
    }

    if (scope === 'project') {
      this.writeMdcFile(rule);
    }
    this._onDidChangeRules.fire();
    return rule;
  }

  async updateRule(id: string, updates: Partial<Omit<CursorRule, 'id' | 'scope'>>): Promise<CursorRule | undefined> {
    const commonRules = this.loadCommonRules();
    const commonIdx = commonRules.findIndex(r => r.id === id);
    if (commonIdx !== -1) {
      const oldRule = commonRules[commonIdx];
      if (updates.name && updates.name !== oldRule.name) {
        if (!this.isFilenameAvailable(updates.name, 'common', id)) {
          vscode.window.showErrorMessage(`Rule name "${updates.name}" conflicts with an existing common rule.`);
          return undefined;
        }
      }
      const updatedRule = { ...oldRule, ...updates, enabled: true, scope: 'common' as RuleScope };
      commonRules[commonIdx] = updatedRule;
      await this.saveCommonRules(commonRules);
      this._onDidChangeRules.fire();
      return updatedRule;
    }

    const userRules = this.loadUserRules();
    const userIdx = userRules.findIndex(r => r.id === id);

    if (userIdx !== -1) {
      const oldRule = userRules[userIdx];
      if (updates.name && updates.name !== oldRule.name) {
        if (!this.isFilenameAvailable(updates.name, 'user', id)) {
          vscode.window.showErrorMessage(`Rule name "${updates.name}" conflicts with an existing rule.`);
          return undefined;
        }
      }
      this.removeLegacyUserRuleFileIfManaged(oldRule);
      const updatedRule = { ...oldRule, ...updates };
      userRules[userIdx] = updatedRule;
      await this.saveUserRules(userRules);
      this._onDidChangeRules.fire();
      return updatedRule;
    }

    const config = this.loadProjectConfig();
    const projIdx = config.rules.findIndex(r => r.id === id);
    if (projIdx === -1) { return undefined; }

    const oldRule = config.rules[projIdx];
    if (updates.name && updates.name !== oldRule.name) {
      if (!this.isFilenameAvailable(updates.name, 'project', id)) {
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
    } else {
      this.removeMdcFile(updatedRule);
    }
    this._onDidChangeRules.fire();
    return updatedRule;
  }

  async toggleRule(id: string): Promise<CursorRule | undefined> {
    const rule = this.getRule(id);
    if (!rule || rule.scope === 'common') { return undefined; }
    return this.updateRule(id, { enabled: !rule.enabled });
  }

  async deleteRule(id: string): Promise<boolean> {
    const favoriteSourceId = this.parseFavoriteRuleId(id);
    if (favoriteSourceId) {
      const favoriteRuleIds = this.loadFavoriteRuleIds().filter(ruleId => ruleId !== favoriteSourceId);
      await this.saveFavoriteRuleIds(favoriteRuleIds);
      this._onDidChangeRules.fire();
      return true;
    }

    const commonRules = this.loadCommonRules();
    const commonIdx = commonRules.findIndex(r => r.id === id);
    if (commonIdx !== -1) {
      commonRules.splice(commonIdx, 1);
      await this.saveCommonRules(commonRules);
      this._onDidChangeRules.fire();
      return true;
    }

    const userRules = this.loadUserRules();
    const userIdx = userRules.findIndex(r => r.id === id);
    if (userIdx !== -1) {
      this.removeLegacyUserRuleFileIfManaged(userRules[userIdx]);
      userRules.splice(userIdx, 1);
      await this.saveUserRules(userRules);
      this._onDidChangeRules.fire();
      return true;
    }

    const config = this.loadProjectConfig();
    const idx = config.rules.findIndex(r => r.id === id);
    if (idx === -1) { return false; }

    this.removeMdcFile(config.rules[idx]);
    config.rules.splice(idx, 1);
    this.saveProjectConfig(config);
    this._onDidChangeRules.fire();
    return true;
  }

  async cloneRule(id: string, targetScope: RuleScope): Promise<CursorRule | null> {
    const sourceRule = this.getRule(id);
    if (!sourceRule) { return null; }

    const name = this.getUniqueName(sourceRule.name, targetScope);
    return this.createRule(
      name,
      sourceRule.description,
      sourceRule.content,
      sourceRule.globs,
      sourceRule.alwaysApply,
      targetScope,
    );
  }

  async toggleFavoriteRule(id: string): Promise<{ favorited: boolean } | undefined> {
    const favoriteSourceId = this.parseFavoriteRuleId(id);
    const sourceRuleId = favoriteSourceId || id;
    const sourceRule = this.getRule(sourceRuleId);
    if (!sourceRule || sourceRule.scope === 'common') {
      return undefined;
    }

    const favoriteRuleIds = this.loadFavoriteRuleIds();
    if (favoriteRuleIds.includes(sourceRuleId)) {
      await this.saveFavoriteRuleIds(favoriteRuleIds.filter(ruleId => ruleId !== sourceRuleId));
      this._onDidChangeRules.fire();
      return { favorited: false };
    }

    await this.saveFavoriteRuleIds([...favoriteRuleIds, sourceRuleId]);
    this._onDidChangeRules.fire();
    return { favorited: true };
  }

  dispose(): void {
    this._onDidChangeRules.dispose();
  }
}
