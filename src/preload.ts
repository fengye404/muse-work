import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChatImageAttachment,
  CompactHistoryResult,
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
  SkillInfo,
  StreamChunk,
  ToolApprovalRequest,
  ToolApprovalResponse,
} from './types';

let streamChunkListener: ((_event: Electron.IpcRendererEvent, chunk: unknown) => void) | null = null;
let toolApprovalListener: ((_event: Electron.IpcRendererEvent, request: unknown) => void) | null = null;

// NOTE: Keep channel names local in preload to avoid runtime local-module imports
// under Electron sandboxed preload environment.
const IPC_CHANNELS = {
  // Renderer -> Main
  SEND_MESSAGE: 'send-message',
  SEND_MESSAGE_STREAM: 'send-message-stream',
  SET_MODEL_CONFIG: 'set-model-config',
  TEST_CONNECTION: 'test-connection',
  ABORT_STREAM: 'abort-stream',
  ENCRYPT_DATA: 'encrypt-data',
  DECRYPT_DATA: 'decrypt-data',
  CLEAR_HISTORY: 'clear-history',
  GET_HISTORY: 'get-history',
  COMPACT_HISTORY: 'compact-history',
  REWIND_LAST_TURN: 'rewind-last-turn',
  AUTOCOMPLETE_PATHS: 'autocomplete-paths',

  // Session management
  SESSION_LIST: 'session-list',
  SESSION_GET: 'session-get',
  SESSION_CREATE: 'session-create',
  SESSION_DELETE: 'session-delete',
  SESSION_SWITCH: 'session-switch',
  SESSION_RENAME: 'session-rename',

  // Config management
  CONFIG_SAVE: 'config-save',
  CONFIG_LOAD: 'config-load',
  RUNTIME_CONFIG_SAVE: 'runtime-config-save',
  RUNTIME_CONFIG_LOAD: 'runtime-config-load',

  // MCP management
  MCP_LIST_SERVERS: 'mcp-list-servers',
  MCP_LIST_TOOLS: 'mcp-list-tools',
  MCP_REFRESH: 'mcp-refresh',
  MCP_UPSERT_SERVER: 'mcp-upsert-server',
  MCP_REMOVE_SERVER: 'mcp-remove-server',

  // Skills
  SKILL_LIST: 'skill-list',

  // Tool system
  TOOL_APPROVAL_REQUEST: 'tool-approval-request',
  TOOL_APPROVAL_RESPONSE: 'tool-approval-response',

  // Main -> Renderer
  STREAM_CHUNK: 'stream-chunk',
} as const;

function replaceListener(
  channel: string,
  currentListener: ((_event: Electron.IpcRendererEvent, payload: unknown) => void) | null,
  nextListener: (_event: Electron.IpcRendererEvent, payload: unknown) => void,
): (_event: Electron.IpcRendererEvent, payload: unknown) => void {
  if (currentListener) {
    ipcRenderer.removeListener(channel, currentListener);
  }
  ipcRenderer.on(channel, nextListener);
  return nextListener;
}

const electronAPI: ElectronAPI = {
  sendMessage: (message: string, systemPrompt?: string, attachments?: ChatImageAttachment[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEND_MESSAGE, message, systemPrompt, attachments),

  sendMessageStream: (message: string, systemPrompt?: string, attachments?: ChatImageAttachment[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEND_MESSAGE_STREAM, message, systemPrompt, attachments),

  onStreamChunk: (callback: (chunk: StreamChunk) => void) => {
    streamChunkListener = replaceListener(
      IPC_CHANNELS.STREAM_CHUNK,
      streamChunkListener,
      (_event, chunk) => callback(chunk as StreamChunk),
    );
  },

  removeStreamListener: () => {
    if (!streamChunkListener) return;
    ipcRenderer.removeListener(IPC_CHANNELS.STREAM_CHUNK, streamChunkListener);
    streamChunkListener = null;
  },

  setModelConfig: (config: Partial<ModelConfig>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_MODEL_CONFIG, config),

  testConnection: () =>
    ipcRenderer.invoke(IPC_CHANNELS.TEST_CONNECTION),

  abortStream: () =>
    ipcRenderer.invoke(IPC_CHANNELS.ABORT_STREAM),

  encryptData: (data: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ENCRYPT_DATA, data),

  decryptData: (encryptedData: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DECRYPT_DATA, encryptedData),

  clearHistory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEAR_HISTORY),

  getHistory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_HISTORY),

  compactHistory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPACT_HISTORY) as Promise<CompactHistoryResult>,

  rewindLastTurn: () =>
    ipcRenderer.invoke(IPC_CHANNELS.REWIND_LAST_TURN) as Promise<RewindHistoryResult>,

  autocompletePaths: (partialPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOCOMPLETE_PATHS, partialPath) as Promise<PathAutocompleteItem[]>,

  sessionList: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),

  sessionGet: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, id),

  sessionCreate: (title?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, title),

  sessionDelete: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, id),

  sessionSwitch: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_SWITCH, id),

  sessionRename: (id: string, title: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_RENAME, id, title),

  configSave: (config: ModelProvidersConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SAVE, config),

  configLoad: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIG_LOAD) as Promise<ModelProvidersConfig>,

  runtimeConfigSave: (config: RuntimeConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_CONFIG_SAVE, config),

  runtimeConfigLoad: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_CONFIG_LOAD) as Promise<RuntimeConfig>,

  mcpListServers: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_SERVERS) as Promise<McpServerStatus[]>,

  mcpListTools: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_TOOLS) as Promise<McpToolInfo[]>,

  mcpRefresh: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REFRESH) as Promise<McpRefreshResult>,

  mcpUpsertServer: (name: string, config: McpServerConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_UPSERT_SERVER, name, config) as Promise<McpRefreshResult>,

  mcpRemoveServer: (name: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, name) as Promise<McpRefreshResult>,

  skillList: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST) as Promise<SkillInfo[]>,

  onToolApprovalRequest: (callback: (request: ToolApprovalRequest) => void) => {
    toolApprovalListener = replaceListener(
      IPC_CHANNELS.TOOL_APPROVAL_REQUEST,
      toolApprovalListener,
      (_event, request) => callback(request as ToolApprovalRequest),
    );
  },

  respondToolApproval: (response: ToolApprovalResponse) =>
    ipcRenderer.send(IPC_CHANNELS.TOOL_APPROVAL_RESPONSE, response),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
