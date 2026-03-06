import type {
  ChatMessage,
  ChatImageAttachment,
  CompactHistoryResult,
  ConnectionTestResult,
  ElectronAPI,
  McpRefreshResult,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
  ModelConfig,
  ModelProvidersConfig,
  PathAutocompleteItem,
  RewindHistoryResult,
  RuntimeConfig,
  Session,
  SessionMeta,
  SkillInfo,
  StreamChunk,
  ToolApprovalRequest,
  ToolApprovalResponse,
} from '../../types';

let missingApiWarningPrinted = false;

function hasApiBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electronAPI);
}

function getApiOrNull(): ElectronAPI | null {
  if (hasApiBridge()) {
    return window.electronAPI;
  }

  if (!missingApiWarningPrinted) {
    console.error('[renderer] window.electronAPI is unavailable. preload bridge may have failed to load.');
    missingApiWarningPrinted = true;
  }

  return null;
}

function rejectUnavailable<T>(method: string): Promise<T> {
  return Promise.reject(new Error(`[renderer] Electron API unavailable: ${method}`));
}

export const electronApiClient = {
  isAvailable: () => hasApiBridge(),

  sendMessage: (message: string, systemPrompt?: string, attachments?: ChatImageAttachment[]) => {
    const api = getApiOrNull();
    return api ? api.sendMessage(message, systemPrompt, attachments) : rejectUnavailable('sendMessage');
  },

  sendMessageStream: (message: string, systemPrompt?: string, attachments?: ChatImageAttachment[]) => {
    const api = getApiOrNull();
    return api ? api.sendMessageStream(message, systemPrompt, attachments) : rejectUnavailable('sendMessageStream');
  },

  onStreamChunk: (callback: (chunk: StreamChunk) => void) => {
    const api = getApiOrNull();
    if (!api) return;
    api.onStreamChunk(callback);
  },

  removeStreamListener: () => {
    const api = getApiOrNull();
    if (!api) return;
    api.removeStreamListener();
  },

  setModelConfig: (config: Partial<ModelConfig>) => {
    const api = getApiOrNull();
    return api ? api.setModelConfig(config) : Promise.resolve(false);
  },

  testConnection: (): Promise<ConnectionTestResult> => {
    const api = getApiOrNull();
    if (!api) {
      return Promise.resolve({
        success: false,
        message: 'Electron API unavailable',
      });
    }
    return api.testConnection();
  },

  abortStream: () => {
    const api = getApiOrNull();
    return api ? api.abortStream() : Promise.resolve();
  },

  encryptData: (data: string): Promise<string> => {
    const api = getApiOrNull();
    return api ? api.encryptData(data) : rejectUnavailable('encryptData');
  },

  decryptData: (encryptedData: string) => {
    const api = getApiOrNull();
    if (!api) {
      return Promise.resolve(
        encryptedData.startsWith('plain:') ? encryptedData.slice(6) : encryptedData,
      );
    }
    return api.decryptData(encryptedData);
  },

  clearHistory: () => {
    const api = getApiOrNull();
    return api ? api.clearHistory() : Promise.resolve();
  },

  getHistory: (): Promise<ChatMessage[]> => {
    const api = getApiOrNull();
    return api ? api.getHistory() : Promise.resolve([]);
  },

  compactHistory: (): Promise<CompactHistoryResult> => {
    const api = getApiOrNull();
    return api ? api.compactHistory() : rejectUnavailable('compactHistory');
  },

  rewindLastTurn: (): Promise<RewindHistoryResult> => {
    const api = getApiOrNull();
    return api ? api.rewindLastTurn() : rejectUnavailable('rewindLastTurn');
  },

  autocompletePaths: (partialPath: string): Promise<PathAutocompleteItem[]> => {
    const api = getApiOrNull();
    return api ? api.autocompletePaths(partialPath) : Promise.resolve([]);
  },

  sessionList: (): Promise<SessionMeta[]> => {
    const api = getApiOrNull();
    return api ? api.sessionList() : Promise.resolve([]);
  },

  sessionGet: (id: string): Promise<Session | null> => {
    const api = getApiOrNull();
    return api ? api.sessionGet(id) : Promise.resolve(null);
  },

  sessionCreate: (title?: string): Promise<Session> => {
    const api = getApiOrNull();
    return api ? api.sessionCreate(title) : rejectUnavailable('sessionCreate');
  },

  sessionDelete: (id: string): Promise<boolean> => {
    const api = getApiOrNull();
    return api ? api.sessionDelete(id) : Promise.resolve(false);
  },

  sessionSwitch: (id: string): Promise<Session | null> => {
    const api = getApiOrNull();
    return api ? api.sessionSwitch(id) : Promise.resolve(null);
  },

  sessionRename: (id: string, title: string): Promise<boolean> => {
    const api = getApiOrNull();
    return api ? api.sessionRename(id, title) : Promise.resolve(false);
  },

  configSave: (config: ModelProvidersConfig): Promise<boolean> => {
    const api = getApiOrNull();
    return api ? api.configSave(config) : Promise.resolve(false);
  },

  configLoad: (): Promise<ModelProvidersConfig> => {
    const api = getApiOrNull();
    return api ? api.configLoad() : Promise.resolve({ activeProviderId: null, activeModelId: null, providers: [] });
  },

  runtimeConfigSave: (config: RuntimeConfig): Promise<boolean> => {
    const api = getApiOrNull();
    return api ? api.runtimeConfigSave(config) : Promise.resolve(false);
  },

  runtimeConfigLoad: (): Promise<RuntimeConfig> => {
    const api = getApiOrNull();
    return api
      ? api.runtimeConfigLoad()
      : Promise.resolve({
        sandbox: {
          mode: 'local',
          sandboxSettings: {
            enabled: false,
            allowUnsandboxedCommands: false,
          },
        },
        enabledSkillIds: [],
      });
  },

  mcpListServers: (): Promise<McpServerStatus[]> => {
    const api = getApiOrNull();
    return api ? api.mcpListServers() : Promise.resolve([]);
  },

  mcpListTools: (): Promise<McpToolInfo[]> => {
    const api = getApiOrNull();
    return api ? api.mcpListTools() : Promise.resolve([]);
  },

  mcpRefresh: (): Promise<McpRefreshResult> => {
    const api = getApiOrNull();
    return api ? api.mcpRefresh() : rejectUnavailable('mcpRefresh');
  },

  mcpUpsertServer: (name: string, config: McpServerConfig): Promise<McpRefreshResult> => {
    const api = getApiOrNull();
    return api ? api.mcpUpsertServer(name, config) : rejectUnavailable('mcpUpsertServer');
  },

  mcpRemoveServer: (name: string): Promise<McpRefreshResult> => {
    const api = getApiOrNull();
    return api ? api.mcpRemoveServer(name) : rejectUnavailable('mcpRemoveServer');
  },

  skillList: (): Promise<SkillInfo[]> => {
    const api = getApiOrNull();
    return api ? api.skillList() : Promise.resolve([]);
  },

  onToolApprovalRequest: (callback: (request: ToolApprovalRequest) => void) => {
    const api = getApiOrNull();
    if (!api) return;
    api.onToolApprovalRequest(callback);
  },

  respondToolApproval: (response: ToolApprovalResponse) => {
    const api = getApiOrNull();
    if (!api) return;
    api.respondToolApproval(response);
  },
};
