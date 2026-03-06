import type {
  ChatMessage,
  ChatImageAttachment,
  StreamChunk,
  ConnectionTestResult,
  CompactHistoryResult,
  RewindHistoryResult,
  PathAutocompleteItem,
} from './chat';
import type { ModelConfig, ModelProvidersConfig } from './model';
import type { Session, SessionMeta } from './session';
import type { ToolApprovalRequest, ToolApprovalResponse } from './tool';
import type { McpServerConfig, McpServerStatus, McpToolInfo, McpRefreshResult } from './mcp';
import type { RuntimeConfig, SkillInfo } from './runtime';

export { IPC_CHANNELS } from '../ipc-channels';

export interface ElectronAPI {
  sendMessage: (message: string, systemPrompt?: string, attachments?: ChatImageAttachment[]) => Promise<string>;
  sendMessageStream: (message: string, systemPrompt?: string, attachments?: ChatImageAttachment[]) => Promise<boolean>;
  onStreamChunk: (callback: (chunk: StreamChunk) => void) => void;
  removeStreamListener: () => void;
  setModelConfig: (config: Partial<ModelConfig>) => Promise<boolean>;
  testConnection: () => Promise<ConnectionTestResult>;
  abortStream: () => Promise<void>;
  encryptData: (data: string) => Promise<string>;
  decryptData: (encryptedData: string) => Promise<string>;
  clearHistory: () => Promise<void>;
  getHistory: () => Promise<ChatMessage[]>;
  compactHistory: () => Promise<CompactHistoryResult>;
  rewindLastTurn: () => Promise<RewindHistoryResult>;
  autocompletePaths: (partialPath: string) => Promise<PathAutocompleteItem[]>;

  sessionList: () => Promise<SessionMeta[]>;
  sessionGet: (id: string) => Promise<Session | null>;
  sessionCreate: (title?: string) => Promise<Session>;
  sessionDelete: (id: string) => Promise<boolean>;
  sessionSwitch: (id: string) => Promise<Session | null>;
  sessionRename: (id: string, title: string) => Promise<boolean>;

  configSave: (config: ModelProvidersConfig) => Promise<boolean>;
  configLoad: () => Promise<ModelProvidersConfig>;
  runtimeConfigSave: (config: RuntimeConfig) => Promise<boolean>;
  runtimeConfigLoad: () => Promise<RuntimeConfig>;

  mcpListServers: () => Promise<McpServerStatus[]>;
  mcpListTools: () => Promise<McpToolInfo[]>;
  mcpRefresh: () => Promise<McpRefreshResult>;
  mcpUpsertServer: (name: string, config: McpServerConfig) => Promise<McpRefreshResult>;
  mcpRemoveServer: (name: string) => Promise<McpRefreshResult>;
  skillList: () => Promise<SkillInfo[]>;

  onToolApprovalRequest: (callback: (request: ToolApprovalRequest) => void) => void;
  respondToolApproval: (response: ToolApprovalResponse) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
