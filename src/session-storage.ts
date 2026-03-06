/**
 * SessionStorage — SQLite-based storage for app configuration.
 *
 * After the Agent SDK migration, message persistence is handled by the SDK.
 * This module retains:
 * - Model provider configuration (providers, active selection)
 * - MCP server configuration
 * - Session metadata (custom titles for SDK sessions)
 */

import { app } from 'electron';
import * as path from 'path';
import Database from 'better-sqlite3';
import type {
  ModelConfig,
  ModelProvider,
  ModelProvidersConfig,
  McpServersConfig,
  Provider,
  RuntimeConfig,
} from './types';
import { DEFAULT_RUNTIME_CONFIG, normalizeRuntimeConfig } from './runtime-config';

const ACTIVE_PROVIDER_ID_KEY = 'activeProviderId';
const ACTIVE_MODEL_ID_KEY = 'activeModelId';
const ACTIVE_MODEL_INSTANCE_ID_KEY = 'activeModelInstanceId';
const RUNTIME_CONFIG_KEY = 'runtimeConfig';

function createProviderId(): string {
  return `provider_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createModelInstanceId(): string {
  return `model_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getDefaultModel(provider: Provider): string {
  return provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o';
}

function normalizeProvider(raw: string | undefined): Provider {
  return raw === 'anthropic' ? 'anthropic' : 'openai';
}

export class SessionStorage {
  private db: Database.Database;

  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'sessions.db');
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        protocol TEXT NOT NULL DEFAULT 'openai',
        base_url TEXT,
        api_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (provider_id) REFERENCES model_providers(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_metadata (
        sdk_session_id TEXT PRIMARY KEY,
        custom_title TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url TEXT,
        api_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_provider_models_provider_id ON provider_models(provider_id)
    `);

    this.migrateLegacySingleConfig();
    this.migrateModelInstancesToProviders();

    this.db.pragma('foreign_keys = ON');
  }

  // ==================== Session Metadata ====================

  /**
   * Register a session ID as belonging to this app.
   * Called when the SDK `init` system message provides a session_id.
   */
  registerSession(sdkSessionId: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO session_metadata (sdk_session_id, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sdk_session_id) DO NOTHING
    `).run(sdkSessionId, now, now);
  }

  /**
   * Check if a session was created by this app (exists in our metadata table).
   */
  isKnownSession(sdkSessionId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM session_metadata WHERE sdk_session_id = ?')
      .get(sdkSessionId);
    return row !== undefined;
  }

  getSessionTitle(sdkSessionId: string): string | null {
    const row = this.db
      .prepare('SELECT custom_title FROM session_metadata WHERE sdk_session_id = ? AND deleted = 0')
      .get(sdkSessionId) as { custom_title: string | null } | undefined;
    return row?.custom_title ?? null;
  }

  setSessionTitle(sdkSessionId: string, title: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO session_metadata (sdk_session_id, custom_title, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sdk_session_id) DO UPDATE SET custom_title = excluded.custom_title, updated_at = excluded.updated_at
    `).run(sdkSessionId, title, now, now);
  }

  markSessionDeleted(sdkSessionId: string): void {
    this.db.prepare('UPDATE session_metadata SET deleted = 1, updated_at = ? WHERE sdk_session_id = ?')
      .run(Date.now(), sdkSessionId);
  }

  isSessionDeleted(sdkSessionId: string): boolean {
    const row = this.db
      .prepare('SELECT deleted FROM session_metadata WHERE sdk_session_id = ?')
      .get(sdkSessionId) as { deleted: number } | undefined;
    return row?.deleted === 1;
  }

  // ==================== Provider Config ====================

  saveModelProvidersConfig(config: ModelProvidersConfig): void {
    const now = Date.now();

    const existingProviderRows = this.db.prepare('SELECT id FROM model_providers').all() as Array<{ id: string }>;
    const existingProviderIds = new Set(existingProviderRows.map((r) => r.id));

    const upsertProviderStmt = this.db.prepare(`
      INSERT INTO model_providers (id, name, description, protocol, base_url, api_key, created_at, updated_at)
      VALUES (@id, @name, @description, @protocol, @baseURL, @apiKey, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        protocol = excluded.protocol,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        updated_at = excluded.updated_at
    `);
    const deleteProviderStmt = this.db.prepare('DELETE FROM model_providers WHERE id = ?');
    const deleteModelsStmt = this.db.prepare('DELETE FROM provider_models WHERE provider_id = ?');
    const insertModelStmt = this.db.prepare(
      'INSERT INTO provider_models (provider_id, model_id, created_at) VALUES (?, ?, ?)',
    );
    const upsertConfigStmt = this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');

    const nextProviderIds = new Set(config.providers.map((p) => p.id));

    const transaction = this.db.transaction(() => {
      for (const provider of config.providers) {
        upsertProviderStmt.run({
          id: provider.id,
          name: provider.name,
          description: provider.description || '',
          protocol: provider.protocol,
          baseURL: provider.baseURL ?? null,
          apiKey: provider.apiKey || '',
          createdAt: now,
          updatedAt: now,
        });

        deleteModelsStmt.run(provider.id);
        for (const modelId of provider.models) {
          if (modelId.trim()) {
            insertModelStmt.run(provider.id, modelId.trim(), now);
          }
        }
      }

      for (const existingId of existingProviderIds) {
        if (!nextProviderIds.has(existingId)) {
          deleteModelsStmt.run(existingId);
          deleteProviderStmt.run(existingId);
        }
      }

      const activeProviderId =
        config.activeProviderId && nextProviderIds.has(config.activeProviderId)
          ? config.activeProviderId
          : config.providers[0]?.id ?? null;

      upsertConfigStmt.run(ACTIVE_PROVIDER_ID_KEY, activeProviderId ?? '');
      upsertConfigStmt.run(ACTIVE_MODEL_ID_KEY, config.activeModelId ?? '');
    });

    transaction();
  }

  loadModelProvidersConfig(): ModelProvidersConfig {
    const providerRows = this.db
      .prepare(`
        SELECT id, name, description, protocol, base_url as baseURL, api_key as apiKey
        FROM model_providers
        ORDER BY updated_at DESC, created_at ASC
      `)
      .all() as Array<{
      id: string;
      name: string;
      description: string;
      protocol: string;
      baseURL: string | null;
      apiKey: string | null;
    }>;

    const providers: ModelProvider[] = providerRows.map((row) => {
      const modelRows = this.db
        .prepare('SELECT model_id FROM provider_models WHERE provider_id = ? ORDER BY created_at ASC')
        .all(row.id) as Array<{ model_id: string }>;

      return {
        id: row.id,
        name: row.name,
        description: row.description || '',
        protocol: normalizeProvider(row.protocol),
        baseURL: row.baseURL || undefined,
        apiKey: row.apiKey || '',
        models: modelRows.map((m) => m.model_id),
      };
    });

    const activeProviderRow = this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(ACTIVE_PROVIDER_ID_KEY) as { value: string } | undefined;
    const activeModelRow = this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(ACTIVE_MODEL_ID_KEY) as { value: string } | undefined;

    const activeProviderId =
      activeProviderRow?.value && providers.some((p) => p.id === activeProviderRow.value)
        ? activeProviderRow.value
        : providers[0]?.id ?? null;

    return {
      activeProviderId,
      activeModelId: activeModelRow?.value || null,
      providers,
    };
  }

  saveConfig(config: Partial<ModelConfig>): void {
    const current = this.loadModelProvidersConfig();
    const activeProvider = current.providers.find((p) => p.id === current.activeProviderId);

    if (!activeProvider) {
      const provider = normalizeProvider(config.provider);
      const newId = createProviderId();
      this.saveModelProvidersConfig({
        activeProviderId: newId,
        activeModelId: config.model || getDefaultModel(provider),
        providers: [
          {
            id: newId,
            name: '默认 Provider',
            description: '',
            protocol: provider,
            baseURL: config.baseURL,
            apiKey: config.apiKey || '',
            models: [config.model || getDefaultModel(provider)],
          },
        ],
      });
      return;
    }

    const merged: ModelProvider = {
      ...activeProvider,
      protocol: config.provider ? normalizeProvider(config.provider) : activeProvider.protocol,
      apiKey: config.apiKey ?? activeProvider.apiKey,
      baseURL:
        config.baseURL === undefined
          ? activeProvider.baseURL
          : config.baseURL.trim() || undefined,
    };

    this.saveModelProvidersConfig({
      activeProviderId: merged.id,
      activeModelId: config.model || current.activeModelId,
      providers: current.providers.map((p) => (p.id === merged.id ? merged : p)),
    });
  }

  loadConfig(): Partial<ModelConfig> {
    const current = this.loadModelProvidersConfig();
    const activeProvider = current.providers.find((p) => p.id === current.activeProviderId);

    if (!activeProvider) return {};

    return {
      provider: activeProvider.protocol,
      model: current.activeModelId || activeProvider.models[0] || getDefaultModel(activeProvider.protocol),
      baseURL: activeProvider.baseURL,
      apiKey: activeProvider.apiKey,
    };
  }

  // ==================== MCP Config ====================

  saveMcpServers(config: McpServersConfig): void {
    const payload = JSON.stringify(config);
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('mcpServers', payload);
  }

  loadMcpServers(): McpServersConfig {
    const row = this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get('mcpServers') as { value: string } | undefined;

    if (!row?.value) return {};

    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as McpServersConfig;
    } catch {
      return {};
    }
  }

  // ==================== Runtime Config ====================

  saveRuntimeConfig(config: RuntimeConfig): void {
    const normalized = normalizeRuntimeConfig(config);
    const payload = JSON.stringify(normalized);
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(RUNTIME_CONFIG_KEY, payload);
  }

  loadRuntimeConfig(): RuntimeConfig {
    const row = this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(RUNTIME_CONFIG_KEY) as { value: string } | undefined;

    if (!row?.value) {
      return {
        sandbox: { ...DEFAULT_RUNTIME_CONFIG.sandbox },
        enabledSkillIds: [...DEFAULT_RUNTIME_CONFIG.enabledSkillIds],
      };
    }

    try {
      const parsed = JSON.parse(row.value) as unknown;
      return normalizeRuntimeConfig(parsed);
    } catch {
      return {
        sandbox: { ...DEFAULT_RUNTIME_CONFIG.sandbox },
        enabledSkillIds: [...DEFAULT_RUNTIME_CONFIG.enabledSkillIds],
      };
    }
  }

  // ==================== Lifecycle ====================

  close(): void {
    this.db.close();
  }

  // ==================== Migration helpers ====================

  private migrateLegacySingleConfig(): void {
    const existingRow = this.db
      .prepare('SELECT COUNT(1) as count FROM model_instances')
      .get() as { count: number };

    if (existingRow.count > 0) return;

    const rows = this.db
      .prepare('SELECT key, value FROM config WHERE key IN (\'provider\', \'model\', \'baseURL\', \'apiKey\')')
      .all() as Array<{ key: string; value: string }>;

    if (rows.length === 0) return;

    const legacyConfig: Partial<ModelConfig> = {};
    for (const row of rows) {
      if (row.key === 'provider') legacyConfig.provider = normalizeProvider(row.value);
      else if (row.key === 'model') legacyConfig.model = row.value;
      else if (row.key === 'baseURL') legacyConfig.baseURL = row.value;
      else if (row.key === 'apiKey') legacyConfig.apiKey = row.value;
    }

    const provider = normalizeProvider(legacyConfig.provider);
    const model = legacyConfig.model?.trim() || getDefaultModel(provider);
    const now = Date.now();
    const migratedId = createModelInstanceId();

    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO model_instances (id, name, provider, model, base_url, api_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(migratedId, provider === 'anthropic' ? 'Anthropic 默认实例' : 'OpenAI 默认实例',
        provider, model, legacyConfig.baseURL || null, legacyConfig.apiKey || '', now, now);
      this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(ACTIVE_MODEL_INSTANCE_ID_KEY, migratedId);
    });

    transaction();
  }

  private migrateModelInstancesToProviders(): void {
    const existingProviders = this.db
      .prepare('SELECT COUNT(1) as count FROM model_providers')
      .get() as { count: number };

    if (existingProviders.count > 0) return;

    const instances = this.db
      .prepare('SELECT id, name, provider, model, base_url, api_key FROM model_instances ORDER BY updated_at DESC')
      .all() as Array<{
      id: string;
      name: string;
      provider: string;
      model: string;
      base_url: string | null;
      api_key: string | null;
    }>;

    if (instances.length === 0) return;

    const now = Date.now();
    const insertProviderStmt = this.db.prepare(`
      INSERT INTO model_providers (id, name, description, protocol, base_url, api_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertModelStmt = this.db.prepare('INSERT INTO provider_models (provider_id, model_id, created_at) VALUES (?, ?, ?)');
    const upsertConfigStmt = this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');

    const activeIdRow = this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(ACTIVE_MODEL_INSTANCE_ID_KEY) as { value: string } | undefined;

    let firstProviderId: string | null = null;
    let activeProviderId: string | null = null;
    let activeModelId: string | null = null;

    const transaction = this.db.transaction(() => {
      for (const instance of instances) {
        const providerId = createProviderId();
        const protocol = normalizeProvider(instance.provider);

        if (!firstProviderId) firstProviderId = providerId;
        if (activeIdRow?.value === instance.id) {
          activeProviderId = providerId;
          activeModelId = instance.model;
        }

        insertProviderStmt.run(providerId, instance.name, '', protocol, instance.base_url, instance.api_key || '', now, now);
        if (instance.model?.trim()) {
          insertModelStmt.run(providerId, instance.model.trim(), now);
        }
      }

      if (!activeProviderId && firstProviderId) {
        activeProviderId = firstProviderId;
        activeModelId = instances[0]?.model || null;
      }

      if (activeProviderId) upsertConfigStmt.run(ACTIVE_PROVIDER_ID_KEY, activeProviderId);
      if (activeModelId) upsertConfigStmt.run(ACTIVE_MODEL_ID_KEY, activeModelId);
    });

    transaction();
  }
}
