/**
 * MainProcessContext — holds runtime objects for the main process.
 *
 * After the Agent SDK migration, this context manages:
 * - AgentService (replaces ClaudeService)
 * - SessionStorage (config only, SDK handles messages)
 * - ToolApprovalCoordinator (bridges SDK canUseTool to renderer)
 * - McpManager (config only, SDK handles connections)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { AgentService } from '../agent-service';
import { SessionStorage } from '../session-storage';
import type {
  McpRefreshResult,
  RuntimeConfig,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
  PathAutocompleteItem,
  SkillInfo,
} from '../types';
import { ServiceNotInitializedError } from '../utils/errors';
import { ToolApprovalCoordinator } from './tool-approval-coordinator';
import { FileReferenceResolver, type ResolvedUserMessage } from './chat-input/file-reference-resolver';
import { PathAutocompleteService } from './chat-input/path-autocomplete';
import { McpManager } from './mcp/mcp-manager';
import { SkillManager } from './skills/skill-manager';
import { DEFAULT_RUNTIME_CONFIG, normalizeRuntimeConfig } from '../runtime-config';

function hasPackageJson(targetPath: string): boolean {
  return fs.existsSync(path.join(targetPath, 'package.json'));
}

function resolveWorkspaceRoot(): string {
  let appPath: string | undefined;
  try {
    appPath = app?.getAppPath();
  } catch {
    // app.getAppPath() may throw if called before app is ready in some contexts
  }

  const candidates = [
    process.env.INIT_CWD,
    process.cwd(),
    appPath,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));

  for (const candidate of candidates) {
    if (hasPackageJson(candidate)) {
      if (path.basename(candidate) === 'dist') {
        const parent = path.dirname(candidate);
        if (hasPackageJson(parent)) return parent;
      }
      return candidate;
    }
  }

  return path.resolve(process.cwd());
}

export class MainProcessContext {
  private mainWindow: BrowserWindow | null = null;
  private agentService: AgentService | null = null;
  private sessionStorage: SessionStorage | null = null;
  private readonly workspaceRoot = resolveWorkspaceRoot();
  private readonly fileReferenceResolver = new FileReferenceResolver(this.workspaceRoot);
  private readonly pathAutocompleteService = new PathAutocompleteService(this.workspaceRoot);
  private readonly mcpManager = new McpManager(this.workspaceRoot);
  private readonly skillManager = new SkillManager(this.workspaceRoot);
  private runtimeConfig: RuntimeConfig = normalizeRuntimeConfig(DEFAULT_RUNTIME_CONFIG);

  readonly toolApproval = new ToolApprovalCoordinator(() => this.mainWindow);

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  async initializeServices(): Promise<void> {
    this.sessionStorage = new SessionStorage();
    this.agentService = new AgentService();
    this.agentService.setWorkingDirectory(this.workspaceRoot);

    this.agentService.setCanUseTool(async (toolName, input, options) => {
      return this.toolApproval.requestApproval(toolName, input, options);
    });

    this.agentService.setOnSessionInit((sessionId) => {
      try {
        this.sessionStorage?.registerSession(sessionId);
      } catch (err) {
        console.error('[main-process] Failed to register session:', err);
      }
    });

    await this.initializeMcp();

    const config = this.sessionStorage.loadConfig();
    this.runtimeConfig = this.sessionStorage.loadRuntimeConfig();
    this.agentService.setSandboxConfig(this.runtimeConfig.sandbox);
    if (config.provider && config.apiKey) {
      this.agentService.setConfig({
        provider: config.provider,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model || 'claude-sonnet-4-6',
      });
    }
  }

  async cleanup(): Promise<void> {
    this.toolApproval.dispose();
    this.mcpManager.dispose();
    await this.agentService?.cleanup();
    this.agentService = null;
    this.sessionStorage?.close();
    this.sessionStorage = null;
    this.mainWindow = null;
  }

  getAgentServiceOrThrow(): AgentService {
    if (!this.agentService) {
      throw new ServiceNotInitializedError('Agent service');
    }
    return this.agentService;
  }

  getSessionStorageOrThrow(): SessionStorage {
    if (!this.sessionStorage) {
      throw new ServiceNotInitializedError('Session storage');
    }
    return this.sessionStorage;
  }

  resolveUserMessage(message: string): ResolvedUserMessage {
    return this.fileReferenceResolver.resolve(message);
  }

  autocompletePaths(partialPath: string): PathAutocompleteItem[] {
    return this.pathAutocompleteService.suggest(partialPath);
  }

  // Runtime config and skills

  getRuntimeConfig(): RuntimeConfig {
    return normalizeRuntimeConfig(this.runtimeConfig);
  }

  setRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
    const normalized = normalizeRuntimeConfig(config);
    this.runtimeConfig = normalized;
    this.agentService?.setSandboxConfig(normalized.sandbox);
    const storage = this.getSessionStorageOrThrow();
    storage.saveRuntimeConfig(normalized);
    return this.getRuntimeConfig();
  }

  listSkills(): SkillInfo[] {
    return this.skillManager.listSkills();
  }

  buildSystemPrompt(basePrompt?: string): string | undefined {
    const skillPrompt = this.skillManager.buildSystemPrompt(this.runtimeConfig.enabledSkillIds);
    const base = basePrompt?.trim() ?? '';
    const extra = skillPrompt.trim();
    if (!base && !extra) return undefined;
    if (!base) return extra;
    if (!extra) return base;
    return `${base}\n\n${extra}`;
  }

  // MCP operations

  listMcpServers(): McpServerStatus[] {
    return this.mcpManager.listServerStatus();
  }

  listMcpTools(): McpToolInfo[] {
    return this.mcpManager.listToolInfo();
  }

  async refreshMcp(): Promise<McpRefreshResult> {
    return this.mcpManager.refresh();
  }

  async upsertMcpServer(name: string, config: McpServerConfig): Promise<McpRefreshResult> {
    const storage = this.getSessionStorageOrThrow();
    this.mcpManager.upsertServer(name, config);
    const allConfig = this.mcpManager.getServerConfig();
    storage.saveMcpServers(allConfig);
    this.syncMcpToAgent();
    return this.mcpManager.refresh();
  }

  async removeMcpServer(name: string): Promise<McpRefreshResult> {
    const storage = this.getSessionStorageOrThrow();
    this.mcpManager.removeServer(name);
    const allConfig = this.mcpManager.getServerConfig();
    storage.saveMcpServers(allConfig);
    this.syncMcpToAgent();
    return this.mcpManager.refresh();
  }

  private async initializeMcp(): Promise<void> {
    const storage = this.getSessionStorageOrThrow();
    const configuredServers = storage.loadMcpServers();
    this.mcpManager.setServers(configuredServers);
    this.syncMcpToAgent();
  }

  private syncMcpToAgent(): void {
    const service = this.getAgentServiceOrThrow();
    service.setMcpServers(this.mcpManager.getServerConfig());
  }
}
