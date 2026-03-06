export const IPC_CHANNELS = {
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
