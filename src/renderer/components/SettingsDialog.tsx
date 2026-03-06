import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Settings2,
  Check,
  AlertCircle,
  Zap,
  Wrench,
  Server,
  RefreshCw,
  Plus,
  Trash2,
  PlugZap,
  Layers3,
  SlidersHorizontal,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import type {
  McpServerStatus,
  McpServerTransport,
  McpToolInfo,
  Provider,
  ModelProvider,
  RuntimeConfig,
  SkillInfo,
} from '../../types';
import { useConfigStore, ALL_TOOLS } from '@/stores/config-store';
import { cn } from '@/lib/utils';
import { electronApiClient } from '@/services/electron-api-client';

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read_file: '读取项目中的文件内容',
  write_file: '写入新文件或覆盖已有文件',
  edit_file: '对已有文件做局部修改',
  list_directory: '浏览目录结构与文件列表',
  search_files: '按名称快速查找文件',
  grep_search: '按内容检索代码与文本',
  run_command: '在终端执行命令',
  web_fetch: '抓取并读取网页内容',
  get_system_info: '读取运行环境与系统信息',
};

type PrimaryMenuKey = 'general' | 'tools' | 'sandbox' | 'skills' | 'mcp';
type GeneralSubMenuKey = 'providers' | 'connection';
type ToolsSubMenuKey = 'permissions';
type McpSubMenuKey = 'servers' | 'loadedTools';

interface PrimaryMenuItem {
  key: PrimaryMenuKey;
  label: string;
  description: string;
  icon: typeof Settings2;
}

interface SubMenuItem<T extends string> {
  key: T;
  label: string;
}

const PRIMARY_MENU_ITEMS: PrimaryMenuItem[] = [
  {
    key: 'general',
    label: '基础设置',
    description: '供应商与模型',
    icon: SlidersHorizontal,
  },
  {
    key: 'tools',
    label: '工具权限',
    description: '工具执行策略',
    icon: Wrench,
  },
  {
    key: 'sandbox',
    label: '沙箱环境',
    description: '命令隔离执行',
    icon: Wrench,
  },
  {
    key: 'skills',
    label: 'Skill 管理',
    description: '技能启用与检索',
    icon: Layers3,
  },
  {
    key: 'mcp',
    label: 'MCP 管理',
    description: '服务器与工具',
    icon: Server,
  },
];

const GENERAL_SUB_MENUS: SubMenuItem<GeneralSubMenuKey>[] = [
  { key: 'providers', label: '模型供应商' },
  { key: 'connection', label: '连接状态' },
];

const TOOLS_SUB_MENUS: SubMenuItem<ToolsSubMenuKey>[] = [
  { key: 'permissions', label: '自动执行' },
];

const MCP_SUB_MENUS: SubMenuItem<McpSubMenuKey>[] = [
  { key: 'servers', label: '服务器管理' },
  { key: 'loadedTools', label: '已加载工具' },
];

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  sandbox: {
    mode: 'local',
    sandboxSettings: {
      enabled: false,
      allowUnsandboxedCommands: false,
    },
  },
  enabledSkillIds: [],
};

function parseLineList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function formatLineList(items?: string[]): string {
  if (!items || items.length === 0) return '';
  return items.join('\n');
}

function renderServerTarget(server: McpServerStatus): string {
  if (server.transport === 'stdio') {
    const commandText = server.command?.trim() || '(no command)';
    const argsText = (server.args ?? []).join(' ').trim();
    return argsText ? `${commandText} ${argsText}` : commandText;
  }
  return server.url || '(no url)';
}

function parseHeadersInput(rawHeaders: string): { headers: Record<string, string>; error?: string } {
  const lines = rawHeaders.split(/\r?\n/);
  const headers: Record<string, string> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]?.trim();
    if (!rawLine) continue;

    const separatorIndex = rawLine.indexOf(':');
    if (separatorIndex <= 0) {
      return {
        headers: {},
        error: `Header 第 ${index + 1} 行格式错误，请使用 "Key: Value"`,
      };
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    const value = rawLine.slice(separatorIndex + 1).trim();

    if (!key) {
      return {
        headers: {},
        error: `Header 第 ${index + 1} 行缺少 key`,
      };
    }

    headers[key] = value;
  }

  return { headers };
}

function SecondaryMenu<T extends string>({
  items,
  active,
  onChange,
}: {
  items: SubMenuItem<T>[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="inline-flex w-full rounded-xl border border-border/60 bg-secondary/35 p-1 sm:w-auto">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          aria-pressed={item.key === active}
          className={cn(
            'flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all duration-200 sm:flex-none',
            item.key === active
              ? 'border-primary/52 bg-[linear-gradient(135deg,hsl(var(--primary)/0.58),hsl(var(--cool-accent)/0.44))] text-primary-foreground shadow-[0_5px_12px_hsl(var(--background)/0.24)]'
              : 'border-transparent text-muted-foreground hover:bg-secondary/65 hover:text-foreground',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function createProviderId(): string {
  return `provider_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ProviderCard({
  provider,
  isExpanded,
  onToggleExpand,
  onUpdate,
  onRemove,
  onAddModel,
  onRemoveModel,
}: {
  provider: ModelProvider;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onUpdate: (patch: Partial<Omit<ModelProvider, 'id'>>) => void;
  onRemove: () => void;
  onAddModel: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
}) {
  const [newModelId, setNewModelId] = useState('');
  const fieldClassName =
    'border-border/70 bg-[hsl(var(--background)/0.55)] placeholder:text-muted-foreground/70 focus-visible:border-primary/55 focus-visible:ring-primary/35';
  const selectClassName =
    'h-9 w-full rounded-lg border border-border/70 bg-[hsl(var(--background)/0.55)] px-3 text-sm transition-all focus:outline-none focus:ring-2 focus:ring-primary/35 focus:border-primary/55';

  const handleAddModel = () => {
    const trimmed = newModelId.trim();
    if (!trimmed) return;
    onAddModel(trimmed);
    setNewModelId('');
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-[linear-gradient(165deg,hsl(var(--secondary)/0.35),hsl(var(--background)/0.4))] overflow-hidden">
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          {isExpanded
            ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          }
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground/95 truncate">{provider.name}</p>
            {provider.description && (
              <p className="text-[11px] text-muted-foreground truncate">{provider.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="rounded-full border border-border/55 bg-background/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {provider.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}
          </span>
          <span className="rounded-full border border-border/55 bg-background/40 px-2 py-0.5 text-[10px] text-muted-foreground">
            {provider.models.length} 个模型
          </span>
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-border/50 px-4 py-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground/90">名称</label>
              <Input
                value={provider.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                placeholder="例如: 硅基流动"
                className={cn('h-9', fieldClassName)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground/90">协议类型</label>
              <select
                value={provider.protocol}
                onChange={(e) => onUpdate({ protocol: e.target.value as Provider })}
                className={selectClassName}
              >
                <option value="openai">OpenAI 规范</option>
                <option value="anthropic">Anthropic 规范</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/90">描述 <span className="font-normal text-muted-foreground">(可选)</span></label>
            <Input
              value={provider.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
              placeholder="简短描述此供应商"
              className={cn('h-9', fieldClassName)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/90">Base URL</label>
            <Input
              value={provider.baseURL || ''}
              onChange={(e) => onUpdate({ baseURL: e.target.value || undefined })}
              placeholder="例如: https://api.siliconflow.cn/v1/chat/completions"
              className={cn('h-9', fieldClassName)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/90">API Key</label>
            <Input
              type="password"
              value={provider.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
              placeholder="输入你的 API Key"
              className={cn('h-9', fieldClassName)}
            />
            <p className="text-[11px] text-muted-foreground">密钥仅保存在本机，使用系统安全存储加密。</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground/90">模型列表</label>
            </div>

            {provider.models.length > 0 && (
              <div className="space-y-1.5">
                {provider.models.map((modelId) => (
                  <div
                    key={modelId}
                    className="flex items-center justify-between rounded-lg border border-border/55 bg-background/35 px-3 py-2"
                  >
                    <code className="text-sm text-foreground/90">{modelId}</code>
                    <button
                      type="button"
                      onClick={() => onRemoveModel(modelId)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      title="移除模型"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Input
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddModel();
                  }
                }}
                placeholder="输入模型 ID，例如: deepseek-ai/DeepSeek-R1"
                className={cn('h-9 flex-1', fieldClassName)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddModel}
                disabled={!newModelId.trim()}
                className="h-9 gap-1 border-border/65 bg-background/40 hover:bg-secondary/65 shrink-0"
              >
                <Plus className="h-3.5 w-3.5" />
                添加
              </Button>
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemove}
              className="gap-1.5 text-destructive/80 hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除此供应商
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const {
    providers,
    activeProviderId,
    activeModelId,
    addProvider,
    updateProvider,
    removeProvider,
    addModelToProvider,
    removeModelFromProvider,
    isSettingsOpen,
    setSettingsOpen,
    model,
    apiKey,
    allowedTools,
    toggleTool,
    connectionStatus,
    saveConfig,
    testConnection,
  } = useConfigStore();

  const [activePrimary, setActivePrimary] = useState<PrimaryMenuKey>('general');
  const [activeGeneralSubMenu, setActiveGeneralSubMenu] = useState<GeneralSubMenuKey>('providers');
  const [activeToolsSubMenu, setActiveToolsSubMenu] = useState<ToolsSubMenuKey>('permissions');
  const [activeMcpSubMenu, setActiveMcpSubMenu] = useState<McpSubMenuKey>('servers');
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);

  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolInfo[]>([]);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpMessage, setMcpMessage] = useState('');
  const [mcpName, setMcpName] = useState('');
  const [mcpTransport, setMcpTransport] = useState<McpServerTransport>('stdio');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpHeadersText, setMcpHeadersText] = useState('');
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(DEFAULT_RUNTIME_CONFIG);
  const [runtimeLoaded, setRuntimeLoaded] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState('');
  const [skillItems, setSkillItems] = useState<SkillInfo[]>([]);
  const [skillQuery, setSkillQuery] = useState('');

  const loadMcpSnapshot = useCallback(async () => {
    try {
      const [servers, tools] = await Promise.all([
        electronApiClient.mcpListServers(),
        electronApiClient.mcpListTools(),
      ]);
      setMcpServers(servers);
      setMcpTools(tools);
      setMcpMessage('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMcpMessage(`读取 MCP 配置失败：${message}`);
    }
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) return;
    if (activePrimary !== 'mcp') return;
    void loadMcpSnapshot();
  }, [isSettingsOpen, activePrimary, loadMcpSnapshot]);

  const loadRuntimeSnapshot = useCallback(async () => {
    try {
      const config = await electronApiClient.runtimeConfigLoad();
      setRuntimeConfig(config);
      setRuntimeLoaded(true);
      setRuntimeMessage('');
    } catch (error) {
      setRuntimeLoaded(false);
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeMessage(`读取运行时设置失败：${message}`);
    }
  }, []);

  const loadSkillSnapshot = useCallback(async () => {
    try {
      const skills = await electronApiClient.skillList();
      setSkillItems(skills);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeMessage(`读取技能列表失败：${message}`);
    }
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) return;
    void loadRuntimeSnapshot();
    void loadSkillSnapshot();
  }, [isSettingsOpen, loadRuntimeSnapshot, loadSkillSnapshot]);

  useEffect(() => {
    if (!isSettingsOpen) return;
    setActivePrimary('general');
    setActiveGeneralSubMenu('providers');
    setActiveToolsSubMenu('permissions');
    setActiveMcpSubMenu('servers');
    setExpandedProviderId(null);
    setRuntimeMessage('');
    setSkillQuery('');
  }, [isSettingsOpen]);

  const handleRefreshMcp = useCallback(async () => {
    setMcpBusy(true);
    try {
      const result = await electronApiClient.mcpRefresh();
      setMcpServers(result.servers);
      setMcpTools(result.tools);
      const connectedCount = result.servers.filter((server) => server.connected).length;
      const enabledCount = result.servers.filter((server) => server.enabled).length;
      setMcpMessage(`刷新完成：已连接 ${connectedCount}/${enabledCount}，工具 ${result.tools.length} 个`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMcpMessage(`刷新失败：${message}`);
    } finally {
      setMcpBusy(false);
    }
  }, []);

  const handleSaveMcpServer = useCallback(async () => {
    const serverName = mcpName.trim();
    if (!serverName) {
      setMcpMessage('请输入 MCP 服务器名称');
      return;
    }

    const { headers, error: headersError } = parseHeadersInput(mcpHeadersText);
    if (headersError) {
      setMcpMessage(headersError);
      return;
    }

    const config =
      mcpTransport === 'stdio'
        ? {
          transport: 'stdio' as const,
          command: mcpCommand.trim(),
          args: mcpArgs.split(/\s+/).filter(Boolean),
          enabled: true,
        }
        : {
          transport: mcpTransport,
          url: mcpUrl.trim(),
          headers,
          enabled: true,
        };

    if (config.transport === 'stdio' && !config.command) {
      setMcpMessage('stdio 模式需要填写 command');
      return;
    }

    if (config.transport !== 'stdio' && !config.url) {
      setMcpMessage('URL 模式需要填写 url');
      return;
    }

    setMcpBusy(true);
    try {
      const result = await electronApiClient.mcpUpsertServer(serverName, config);
      setMcpServers(result.servers);
      setMcpTools(result.tools);
      setMcpMessage(`MCP 服务器 ${serverName} 已保存`);
      setMcpName('');
      setMcpCommand('');
      setMcpArgs('');
      setMcpUrl('');
      setMcpHeadersText('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMcpMessage(`保存失败：${message}`);
    } finally {
      setMcpBusy(false);
    }
  }, [mcpName, mcpTransport, mcpCommand, mcpArgs, mcpUrl, mcpHeadersText]);

  const handleRemoveMcpServer = useCallback(async (name: string) => {
    setMcpBusy(true);
    try {
      const result = await electronApiClient.mcpRemoveServer(name);
      setMcpServers(result.servers);
      setMcpTools(result.tools);
      setMcpMessage(`MCP 服务器 ${name} 已移除`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMcpMessage(`移除失败：${message}`);
    } finally {
      setMcpBusy(false);
    }
  }, []);

  const handleAddProvider = useCallback(() => {
    const newProvider: ModelProvider = {
      id: createProviderId(),
      name: '',
      description: '',
      protocol: 'openai',
      apiKey: '',
      models: [],
    };
    addProvider(newProvider);
    setExpandedProviderId(newProvider.id);
  }, [addProvider]);

  const activePrimaryItem = useMemo(
    () => PRIMARY_MENU_ITEMS.find((item) => item.key === activePrimary),
    [activePrimary],
  );

  const enabledMcpServers = useMemo(
    () => mcpServers.filter((server) => server.enabled).length,
    [mcpServers],
  );
  const connectedMcpServers = useMemo(
    () => mcpServers.filter((server) => server.connected).length,
    [mcpServers],
  );
  const hasModelCredentials = Boolean(model.trim() && apiKey.trim());
  const mcpMessageIsError = /失败|错误/.test(mcpMessage);
  const fieldClassName =
    'border-border/70 bg-[hsl(var(--background)/0.55)] placeholder:text-muted-foreground/70 focus-visible:border-primary/55 focus-visible:ring-primary/35';
  const selectClassName =
    'h-10 w-full rounded-lg border border-border/70 bg-[hsl(var(--background)/0.55)] px-3.5 text-sm transition-all focus:outline-none focus:ring-2 focus:ring-primary/35 focus:border-primary/55';

  const showTestConnectionButton = activePrimary === 'general' && activeGeneralSubMenu === 'connection';
  const activeSubMenuLabel = useMemo(() => {
    if (activePrimary === 'general') {
      return GENERAL_SUB_MENUS.find((item) => item.key === activeGeneralSubMenu)?.label ?? '';
    }
    if (activePrimary === 'tools' && TOOLS_SUB_MENUS.length > 1) {
      return TOOLS_SUB_MENUS.find((item) => item.key === activeToolsSubMenu)?.label ?? '';
    }
    if (activePrimary === 'mcp') {
      return MCP_SUB_MENUS.find((item) => item.key === activeMcpSubMenu)?.label ?? '';
    }
    return '';
  }, [activePrimary, activeGeneralSubMenu, activeToolsSubMenu, activeMcpSubMenu]);

  const activeProviderName = useMemo(() => {
    const p = providers.find((item) => item.id === activeProviderId);
    return p?.name || '未选择';
  }, [providers, activeProviderId]);

  const enabledSkillCount = useMemo(() => {
    return new Set(runtimeConfig.enabledSkillIds).size;
  }, [runtimeConfig.enabledSkillIds]);

  const filteredSkillItems = useMemo(() => {
    const query = skillQuery.trim().toLowerCase();
    if (!query) return skillItems;
    return skillItems.filter((skill) =>
      skill.id.toLowerCase().includes(query) ||
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query),
    );
  }, [skillItems, skillQuery]);

  const updateSandboxConfig = useCallback((patch: Partial<RuntimeConfig['sandbox']>) => {
    setRuntimeConfig((prev) => ({
      ...prev,
      sandbox: {
        ...prev.sandbox,
        ...patch,
      },
    }));
  }, []);

  const updateSandboxSettings = useCallback((patch: Partial<RuntimeConfig['sandbox']['sandboxSettings']>) => {
    setRuntimeConfig((prev) => ({
      ...prev,
      sandbox: {
        ...prev.sandbox,
        sandboxSettings: {
          ...prev.sandbox.sandboxSettings,
          ...patch,
        },
      },
    }));
  }, []);

  const updateSandboxNetwork = useCallback((patch: Partial<NonNullable<RuntimeConfig['sandbox']['sandboxSettings']['network']>>) => {
    setRuntimeConfig((prev) => ({
      ...prev,
      sandbox: {
        ...prev.sandbox,
        sandboxSettings: {
          ...prev.sandbox.sandboxSettings,
          network: {
            ...(prev.sandbox.sandboxSettings.network ?? {}),
            ...patch,
          },
        },
      },
    }));
  }, []);

  const updateSandboxFilesystem = useCallback((patch: Partial<NonNullable<RuntimeConfig['sandbox']['sandboxSettings']['filesystem']>>) => {
    setRuntimeConfig((prev) => ({
      ...prev,
      sandbox: {
        ...prev.sandbox,
        sandboxSettings: {
          ...prev.sandbox.sandboxSettings,
          filesystem: {
            ...(prev.sandbox.sandboxSettings.filesystem ?? {}),
            ...patch,
          },
        },
      },
    }));
  }, []);

  const toggleSkill = useCallback((skillId: string) => {
    setRuntimeConfig((prev) => {
      const enabled = new Set(prev.enabledSkillIds);
      if (enabled.has(skillId)) enabled.delete(skillId);
      else enabled.add(skillId);
      return {
        ...prev,
        enabledSkillIds: Array.from(enabled),
      };
    });
  }, []);

  const handleRefreshSkills = useCallback(async () => {
    setRuntimeBusy(true);
    try {
      await loadSkillSnapshot();
      setRuntimeMessage('技能列表已刷新');
    } catch {
      // message handled in loader
    } finally {
      setRuntimeBusy(false);
    }
  }, [loadSkillSnapshot]);

  const handleSaveAllSettings = useCallback(async () => {
    if (!runtimeLoaded) {
      setRuntimeMessage('运行时配置尚未加载完成，请稍后再试。');
      return;
    }

    try {
      setRuntimeBusy(true);
      setRuntimeMessage('');
      await electronApiClient.runtimeConfigSave(runtimeConfig);
      await saveConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeMessage(`保存运行时设置失败：${message}`);
    } finally {
      setRuntimeBusy(false);
    }
  }, [runtimeConfig, runtimeLoaded, saveConfig]);

  return (
    <Dialog open={isSettingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="w-[min(1080px,96vw)] border-border/70 bg-[linear-gradient(165deg,hsl(var(--card)/0.98),hsl(223_18%_7%/0.98))] p-0 sm:max-w-[1080px]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,hsl(var(--primary)/0.1),transparent_36%),radial-gradient(circle_at_88%_85%,hsl(var(--cool-accent)/0.12),transparent_38%)] opacity-68" />

        <DialogHeader className="relative border-b border-border/55 bg-[linear-gradient(180deg,hsl(var(--secondary)/0.5),hsl(var(--background)/0.22))] pb-5 pt-6">
          <div className="flex flex-wrap items-start justify-between gap-4 pr-12">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-primary/35 bg-[linear-gradient(145deg,hsl(var(--primary)/0.26),hsl(var(--cool-accent)/0.2))] shadow-[0_8px_18px_hsl(var(--background)/0.3)]">
                <Settings2 className="h-5 w-5 text-foreground" />
              </div>
              <div>
                <DialogTitle className="text-xl">设置中心</DialogTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  更清晰的配置分层，覆盖模型供应商、权限和 MCP 管理。
                </p>
              </div>
            </div>
            <div className="shrink-0 rounded-full border border-border/60 bg-secondary/40 px-3 py-1 text-xs text-muted-foreground">
              本地持久化配置
            </div>
          </div>
        </DialogHeader>

        <div className="relative grid min-h-[560px] max-h-[70vh] grid-cols-1 md:grid-cols-[252px_minmax(0,1fr)]">
          <aside className="border-b border-border/55 bg-[linear-gradient(165deg,hsl(var(--secondary)/0.4),hsl(var(--background)/0.68))] p-4 md:border-b-0 md:border-r">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 md:grid-cols-1">
              {PRIMARY_MENU_ITEMS.map((item) => {
                const Icon = item.icon;
                const selected = item.key === activePrimary;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setActivePrimary(item.key)}
                    className={cn(
                      'w-full rounded-xl border px-3 py-3 text-left transition-all duration-200',
                      selected
                        ? 'border-primary/56 bg-[linear-gradient(138deg,hsl(var(--primary)/0.3),hsl(var(--cool-accent)/0.18))] shadow-[0_10px_20px_hsl(var(--background)/0.28)] ring-1 ring-primary/28'
                        : 'border-border/55 bg-secondary/25 hover:border-border/80 hover:bg-secondary/50',
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <div
                        className={cn(
                          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
                          selected
                            ? 'border-primary/70 bg-primary text-primary-foreground shadow-[inset_0_1px_0_hsl(0_0%_100%/0.25)]'
                            : 'border-border/60 bg-background/35 text-muted-foreground',
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className={cn('text-sm font-semibold', selected ? 'text-primary-foreground' : 'text-foreground/95')}>
                          {item.label}
                        </p>
                        <p className={cn('mt-0.5 text-[11px]', selected ? 'text-primary-foreground/78' : 'text-muted-foreground/85')}>
                          {item.description}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="overflow-y-scroll px-4 py-4 [scrollbar-gutter:stable] sm:px-6 sm:py-5">
            <div className="mb-5 rounded-xl border border-border/55 bg-secondary/28 px-3 py-2.5 sm:px-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-border/65 bg-secondary/45">
                    <Layers3 className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground/95">{activePrimaryItem?.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{activePrimaryItem?.description}</p>
                    {!!activeSubMenuLabel && (
                      <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-primary/45 bg-primary/15 px-2.5 py-0.5 text-[11px] font-medium text-foreground/92">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                        当前：{activeSubMenuLabel}
                      </div>
                    )}
                  </div>
                </div>

                {activePrimary === 'general' && (
                  <SecondaryMenu
                    items={GENERAL_SUB_MENUS}
                    active={activeGeneralSubMenu}
                    onChange={setActiveGeneralSubMenu}
                  />
                )}
                {activePrimary === 'tools' && TOOLS_SUB_MENUS.length > 1 && (
                  <SecondaryMenu
                    items={TOOLS_SUB_MENUS}
                    active={activeToolsSubMenu}
                    onChange={setActiveToolsSubMenu}
                  />
                )}
                {activePrimary === 'mcp' && (
                  <SecondaryMenu
                    items={MCP_SUB_MENUS}
                    active={activeMcpSubMenu}
                    onChange={setActiveMcpSubMenu}
                  />
                )}
              </div>
            </div>

            <div className="space-y-4 pb-2">
              {activePrimary === 'general' && (
                <>
                  <div
                    aria-hidden={activeGeneralSubMenu !== 'providers'}
                    className={cn('settings-panel-enter', activeGeneralSubMenu === 'providers' ? 'block' : 'hidden')}
                  >
                    <div className="space-y-3">
                      <div className="rounded-2xl border border-border/60 bg-[linear-gradient(165deg,hsl(var(--secondary)/0.4),hsl(var(--background)/0.42))] p-4 sm:p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-foreground/95">模型供应商管理</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              添加模型供应商，配置协议类型和 API 凭证，然后在供应商下添加模型。
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="rounded-full border border-border/65 bg-background/50 px-3 py-1 text-xs text-muted-foreground">
                              {providers.length} 个供应商
                            </span>
                          </div>
                        </div>
                      </div>

                      {providers.map((provider) => (
                        <ProviderCard
                          key={provider.id}
                          provider={provider}
                          isExpanded={expandedProviderId === provider.id}
                          onToggleExpand={() => setExpandedProviderId(
                            expandedProviderId === provider.id ? null : provider.id
                          )}
                          onUpdate={(patch) => updateProvider(provider.id, patch)}
                          onRemove={() => {
                            removeProvider(provider.id);
                            if (expandedProviderId === provider.id) {
                              setExpandedProviderId(null);
                            }
                          }}
                          onAddModel={(modelId) => addModelToProvider(provider.id, modelId)}
                          onRemoveModel={(modelId) => removeModelFromProvider(provider.id, modelId)}
                        />
                      ))}

                      <button
                        type="button"
                        onClick={handleAddProvider}
                        className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/55 bg-secondary/15 px-4 py-4 text-sm text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/8 hover:text-foreground"
                      >
                        <Plus className="h-4 w-4" />
                        添加模型供应商
                      </button>
                    </div>
                  </div>

                  <div
                    aria-hidden={activeGeneralSubMenu !== 'connection'}
                    className={cn('settings-panel-enter space-y-3', activeGeneralSubMenu === 'connection' ? 'block' : 'hidden')}
                  >
                    <div
                      className={cn(
                        'rounded-2xl border px-4 py-4 sm:p-5',
                        connectionStatus.connected
                          ? 'border-[hsl(var(--cool-accent)/0.42)] bg-[hsl(var(--cool-accent)/0.1)]'
                          : 'border-primary/35 bg-primary/10',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                            connectionStatus.connected
                              ? 'border-[hsl(var(--cool-accent)/0.45)] bg-[hsl(var(--cool-accent)/0.2)] text-[hsl(var(--cool-accent))]'
                              : 'border-primary/45 bg-primary/18 text-primary',
                          )}
                        >
                          {connectionStatus.connected ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <AlertCircle className="h-4 w-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground/95">连接诊断</p>
                          <p
                            className={cn(
                              'mt-1 text-sm font-medium break-words',
                              connectionStatus.connected ? 'text-[hsl(var(--cool-accent))]' : 'text-primary',
                            )}
                          >
                            {connectionStatus.message}
                          </p>
                          <p className="mt-2 text-xs text-muted-foreground">
                            先保存模型配置，再执行"测试连接"，结果会更准确。
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-2.5 sm:grid-cols-2">
                      <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">当前供应商</p>
                        <p className="mt-1 text-sm font-medium text-foreground/92">
                          {activeProviderName}
                        </p>
                      </div>
                      <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">配置完整度</p>
                        <p className={cn('mt-1 text-sm font-medium', hasModelCredentials ? 'text-[hsl(var(--cool-accent))]' : 'text-primary')}>
                          {hasModelCredentials ? '模型与凭证已填写' : '缺少模型或 API Key'}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">当前模型</p>
                      <p className="mt-1 text-sm font-medium text-foreground/92">
                        {activeModelId || '未选择'}
                      </p>
                    </div>
                  </div>
                </>
              )}

              {activePrimary === 'tools' && activeToolsSubMenu === 'permissions' && (
                <div className="settings-panel-enter space-y-3">
                  <div className="rounded-2xl border border-border/60 bg-[linear-gradient(168deg,hsl(var(--secondary)/0.42),hsl(var(--background)/0.36))] p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Wrench className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm font-semibold text-foreground/95">工具自动执行</p>
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/45 px-3 py-1 text-xs text-muted-foreground">
                        已启用 {allowedTools.length}/{ALL_TOOLS.length}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      启用后，该工具会默认自动执行。建议仅开启你信任的能力，修改后点击"保存设置"持久化。
                    </p>
                  </div>

                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {ALL_TOOLS.map((tool) => {
                      const enabled = allowedTools.includes(tool.name);
                      return (
                        <button
                          key={tool.name}
                          type="button"
                          onClick={() => toggleTool(tool.name)}
                          aria-pressed={enabled}
                          className={cn(
                            'group w-full rounded-xl border px-3 py-3 text-left transition-all duration-200',
                            enabled
                              ? 'border-primary/38 bg-[linear-gradient(140deg,hsl(var(--primary)/0.2),hsl(var(--cool-accent)/0.1))] shadow-[inset_0_1px_0_hsl(0_0%_100%/0.06)]'
                              : 'border-border/55 bg-secondary/30 hover:border-border/80 hover:bg-secondary/52',
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={cn(
                                'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
                                enabled
                                  ? 'border-primary/45 bg-primary/18 text-primary'
                                  : 'border-border/60 bg-background/35 text-muted-foreground',
                              )}
                            >
                              {enabled ? <Check className="h-4 w-4" /> : <Wrench className="h-4 w-4" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-foreground/92">{tool.label}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground/80">
                                {TOOL_DESCRIPTIONS[tool.name]}
                              </p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {activePrimary === 'sandbox' && (
                <div className="settings-panel-enter space-y-3">
                  <div className="rounded-2xl border border-border/60 bg-[linear-gradient(168deg,hsl(var(--secondary)/0.42),hsl(var(--background)/0.36))] p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Wrench className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm font-semibold text-foreground/95">沙箱执行环境</p>
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/45 px-3 py-1 text-xs text-muted-foreground">
                        模式: {runtimeConfig.sandbox.mode === 'sandbox' ? 'Sandbox' : 'Local'}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      通过 Claude Agent SDK `options.sandbox` 控制沙箱。应用层不再包装 Docker 命令。
                    </p>
                  </div>

                  <div className="inline-flex w-full rounded-xl border border-border/60 bg-secondary/35 p-1">
                    <button
                      type="button"
                      onClick={() => {
                        updateSandboxConfig({ mode: 'local' });
                        updateSandboxSettings({ enabled: false });
                      }}
                      aria-pressed={runtimeConfig.sandbox.mode === 'local'}
                      className={cn(
                        'flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all duration-200',
                        runtimeConfig.sandbox.mode === 'local'
                          ? 'border-primary/52 bg-[linear-gradient(135deg,hsl(var(--primary)/0.58),hsl(var(--cool-accent)/0.44))] text-primary-foreground'
                          : 'border-transparent text-muted-foreground hover:bg-secondary/65 hover:text-foreground',
                      )}
                    >
                      本地模式
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        updateSandboxConfig({ mode: 'sandbox' });
                        updateSandboxSettings({ enabled: true });
                      }}
                      aria-pressed={runtimeConfig.sandbox.mode === 'sandbox'}
                      className={cn(
                        'flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all duration-200',
                        runtimeConfig.sandbox.mode === 'sandbox'
                          ? 'border-primary/52 bg-[linear-gradient(135deg,hsl(var(--primary)/0.58),hsl(var(--cool-accent)/0.44))] text-primary-foreground'
                          : 'border-transparent text-muted-foreground hover:bg-secondary/65 hover:text-foreground',
                      )}
                    >
                      沙箱模式（SDK）
                    </button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-foreground/90">sandboxSettings.enabled</label>
                      <button
                        type="button"
                        onClick={() => updateSandboxSettings({
                          enabled: runtimeConfig.sandbox.sandboxSettings.enabled !== true,
                        })}
                        aria-pressed={runtimeConfig.sandbox.sandboxSettings.enabled === true}
                        className={cn(
                          'flex h-10 w-full items-center justify-between rounded-lg border px-3 text-sm transition-all',
                          runtimeConfig.sandbox.sandboxSettings.enabled
                            ? 'border-primary/45 bg-primary/15 text-foreground'
                            : 'border-border/65 bg-background/35 text-muted-foreground',
                        )}
                      >
                        <span>{runtimeConfig.sandbox.sandboxSettings.enabled ? '沙箱已启用' : '沙箱已禁用'}</span>
                        <span className="text-xs">{runtimeConfig.sandbox.sandboxSettings.enabled ? 'ON' : 'OFF'}</span>
                      </button>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-foreground/90">allowUnsandboxedCommands</label>
                      <button
                        type="button"
                        onClick={() => updateSandboxSettings({
                          allowUnsandboxedCommands: runtimeConfig.sandbox.sandboxSettings.allowUnsandboxedCommands !== true,
                        })}
                        aria-pressed={runtimeConfig.sandbox.sandboxSettings.allowUnsandboxedCommands === true}
                        className={cn(
                          'flex h-10 w-full items-center justify-between rounded-lg border px-3 text-sm transition-all',
                          runtimeConfig.sandbox.sandboxSettings.allowUnsandboxedCommands
                            ? 'border-primary/45 bg-primary/15 text-foreground'
                            : 'border-border/65 bg-background/35 text-muted-foreground',
                        )}
                      >
                        <span>{runtimeConfig.sandbox.sandboxSettings.allowUnsandboxedCommands ? '允许未沙箱命令' : '仅允许沙箱命令'}</span>
                        <span className="text-xs">{runtimeConfig.sandbox.sandboxSettings.allowUnsandboxedCommands ? 'ON' : 'OFF'}</span>
                      </button>
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <label className="text-xs font-medium text-foreground/90">network.allowManagedDomainsOnly</label>
                      <button
                        type="button"
                        onClick={() => updateSandboxNetwork({
                          allowManagedDomainsOnly: runtimeConfig.sandbox.sandboxSettings.network?.allowManagedDomainsOnly !== true,
                        })}
                        aria-pressed={runtimeConfig.sandbox.sandboxSettings.network?.allowManagedDomainsOnly === true}
                        className={cn(
                          'flex h-10 w-full items-center justify-between rounded-lg border px-3 text-sm transition-all',
                          runtimeConfig.sandbox.sandboxSettings.network?.allowManagedDomainsOnly
                            ? 'border-primary/45 bg-primary/15 text-foreground'
                            : 'border-border/65 bg-background/35 text-muted-foreground',
                        )}
                      >
                        <span>
                          {runtimeConfig.sandbox.sandboxSettings.network?.allowManagedDomainsOnly
                            ? '仅允许托管域名'
                            : '允许非托管域名（按其他规则）'}
                        </span>
                        <span className="text-xs">{runtimeConfig.sandbox.sandboxSettings.network?.allowManagedDomainsOnly ? 'ON' : 'OFF'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label htmlFor="sandbox-network-allowed-domains" className="text-xs font-medium text-foreground/90">
                        network.allowedDomains (每行一个)
                      </label>
                      <Textarea
                        id="sandbox-network-allowed-domains"
                        rows={4}
                        value={formatLineList(runtimeConfig.sandbox.sandboxSettings.network?.allowedDomains)}
                        onChange={(e) => updateSandboxNetwork({ allowedDomains: parseLineList(e.target.value) })}
                        placeholder="example.com"
                        className={fieldClassName}
                      />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="sandbox-filesystem-allow-write" className="text-xs font-medium text-foreground/90">
                        filesystem.allowWrite (每行一个)
                      </label>
                      <Textarea
                        id="sandbox-filesystem-allow-write"
                        rows={4}
                        value={formatLineList(runtimeConfig.sandbox.sandboxSettings.filesystem?.allowWrite)}
                        onChange={(e) => updateSandboxFilesystem({ allowWrite: parseLineList(e.target.value) })}
                        placeholder="/tmp"
                        className={fieldClassName}
                      />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="sandbox-filesystem-deny-write" className="text-xs font-medium text-foreground/90">
                        filesystem.denyWrite (每行一个)
                      </label>
                      <Textarea
                        id="sandbox-filesystem-deny-write"
                        rows={4}
                        value={formatLineList(runtimeConfig.sandbox.sandboxSettings.filesystem?.denyWrite)}
                        onChange={(e) => updateSandboxFilesystem({ denyWrite: parseLineList(e.target.value) })}
                        placeholder="/Users/secret"
                        className={fieldClassName}
                      />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="sandbox-filesystem-deny-read" className="text-xs font-medium text-foreground/90">
                        filesystem.denyRead (每行一个)
                      </label>
                      <Textarea
                        id="sandbox-filesystem-deny-read"
                        rows={4}
                        value={formatLineList(runtimeConfig.sandbox.sandboxSettings.filesystem?.denyRead)}
                        onChange={(e) => updateSandboxFilesystem({ denyRead: parseLineList(e.target.value) })}
                        placeholder="/Users/secret"
                        className={fieldClassName}
                      />
                    </div>
                  </div>

                  <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5 text-xs text-muted-foreground">
                    说明：沙箱边界由 Claude Agent SDK 提供。此处仅配置 SDK 官方 `sandboxSettings` 字段。
                  </div>

                  {runtimeMessage && (
                    <div
                      className={cn(
                        'rounded-xl border px-3 py-2 text-xs',
                        /失败|错误/.test(runtimeMessage)
                          ? 'border-destructive/35 bg-destructive/12 text-destructive'
                          : 'border-border/60 bg-secondary/35 text-muted-foreground',
                      )}
                    >
                      {runtimeMessage}
                    </div>
                  )}
                </div>
              )}

              {activePrimary === 'skills' && (
                <div className="settings-panel-enter space-y-3">
                  <div className="rounded-2xl border border-border/60 bg-[linear-gradient(168deg,hsl(var(--secondary)/0.42),hsl(var(--background)/0.36))] p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Wrench className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm font-semibold text-foreground/95">Skill 管理</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full border border-border/60 bg-background/45 px-3 py-1 text-xs text-muted-foreground">
                          已启用 {enabledSkillCount}/{skillItems.length}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={runtimeBusy}
                          onClick={handleRefreshSkills}
                          className="gap-1.5 border-border/65 bg-background/40 hover:bg-secondary/65"
                        >
                          <RefreshCw className={cn('h-3.5 w-3.5', runtimeBusy && 'animate-spin')} />
                          刷新
                        </Button>
                      </div>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      技能来源目录：`./.claude/skills`、`~/.claude/skills`、`$CODEX_HOME/skills`。开启后会注入系统提示词。
                    </p>
                  </div>

                  <Input
                    value={skillQuery}
                    onChange={(e) => setSkillQuery(e.target.value)}
                    placeholder="按 skill id / name / description 搜索"
                    className={fieldClassName}
                  />

                  {filteredSkillItems.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/55 bg-secondary/20 px-3 py-3 text-xs text-muted-foreground">
                      {skillItems.length === 0 ? '当前未发现可用技能。' : '没有匹配的技能。'}
                    </div>
                  ) : (
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {filteredSkillItems.map((skill) => {
                        const enabled = runtimeConfig.enabledSkillIds.includes(skill.id);
                        return (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => toggleSkill(skill.id)}
                            aria-pressed={enabled}
                            className={cn(
                              'group w-full rounded-xl border px-3 py-3 text-left transition-all duration-200',
                              enabled
                                ? 'border-primary/38 bg-[linear-gradient(140deg,hsl(var(--primary)/0.2),hsl(var(--cool-accent)/0.1))]'
                                : 'border-border/55 bg-secondary/30 hover:border-border/80 hover:bg-secondary/52',
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-foreground/92 truncate">{skill.name || skill.id}</p>
                                <p className="mt-0.5 break-all text-[11px] text-muted-foreground/80">{skill.id}</p>
                                {skill.description && (
                                  <p className="mt-1 text-xs text-muted-foreground/85 line-clamp-2">{skill.description}</p>
                                )}
                                <p className="mt-1.5 break-all text-[11px] text-muted-foreground/70">{skill.path}</p>
                              </div>
                              <div
                                className={cn(
                                  'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide',
                                  enabled
                                    ? 'border-primary/45 bg-primary/18 text-primary'
                                    : 'border-border/60 bg-background/35 text-muted-foreground',
                                )}
                              >
                                {enabled ? 'ON' : 'OFF'}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {runtimeMessage && (
                    <div
                      className={cn(
                        'rounded-xl border px-3 py-2 text-xs',
                        /失败|错误/.test(runtimeMessage)
                          ? 'border-destructive/35 bg-destructive/12 text-destructive'
                          : 'border-border/60 bg-secondary/35 text-muted-foreground',
                      )}
                    >
                      {runtimeMessage}
                    </div>
                  )}
                </div>
              )}

              {activePrimary === 'mcp' && activeMcpSubMenu === 'servers' && (
                <div className="settings-panel-enter space-y-3">
                  <div className="rounded-2xl border border-border/60 bg-[linear-gradient(168deg,hsl(var(--secondary)/0.45),hsl(var(--background)/0.38))] p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Server className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm font-semibold text-foreground/95">服务器列表</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mcpBusy}
                        onClick={handleRefreshMcp}
                        className="gap-1.5 border-border/65 bg-background/40 hover:bg-secondary/65"
                      >
                        <RefreshCw className={cn('h-3.5 w-3.5', mcpBusy && 'animate-spin')} />
                        刷新
                      </Button>
                    </div>

                    <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
                      <div className="rounded-xl border border-border/60 bg-background/35 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">已启用</p>
                        <p className="mt-1 text-sm font-semibold text-foreground/92">{enabledMcpServers}</p>
                      </div>
                      <div className="rounded-xl border border-border/60 bg-background/35 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">已连接</p>
                        <p className="mt-1 text-sm font-semibold text-foreground/92">{connectedMcpServers}</p>
                      </div>
                      <div className="rounded-xl border border-border/60 bg-background/35 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">工具数</p>
                        <p className="mt-1 text-sm font-semibold text-foreground/92">{mcpTools.length}</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border/60 bg-secondary/24 p-4">
                    <p className="text-sm font-semibold text-foreground/95">添加或更新 MCP 服务器</p>
                    <p className="mt-1 text-xs text-muted-foreground">支持 `stdio`、`streamable-http` 和 `sse`。</p>

                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <label htmlFor="mcp-name" className="text-xs font-medium text-foreground/90">名称</label>
                        <Input
                          id="mcp-name"
                          value={mcpName}
                          onChange={(e) => setMcpName(e.target.value)}
                          placeholder="例如 filesystem"
                          className={fieldClassName}
                        />
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="mcp-transport" className="text-xs font-medium text-foreground/90">传输协议</label>
                        <select
                          id="mcp-transport"
                          value={mcpTransport}
                          onChange={(e) => setMcpTransport(e.target.value as McpServerTransport)}
                          className={selectClassName}
                        >
                          <option value="stdio">stdio</option>
                          <option value="streamable-http">streamable-http</option>
                          <option value="sse">sse</option>
                        </select>
                      </div>

                      {mcpTransport === 'stdio' ? (
                        <>
                          <div className="space-y-2 sm:col-span-2">
                            <label htmlFor="mcp-command" className="text-xs font-medium text-foreground/90">Command</label>
                            <Input
                              id="mcp-command"
                              value={mcpCommand}
                              onChange={(e) => setMcpCommand(e.target.value)}
                              placeholder="例如 npx"
                              className={fieldClassName}
                            />
                          </div>
                          <div className="space-y-2 sm:col-span-2">
                            <label htmlFor="mcp-args" className="text-xs font-medium text-foreground/90">Args</label>
                            <Input
                              id="mcp-args"
                              value={mcpArgs}
                              onChange={(e) => setMcpArgs(e.target.value)}
                              placeholder="空格分隔，例如 -y @anthropic/mcp-server-filesystem ./"
                              className={fieldClassName}
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="space-y-2 sm:col-span-2">
                            <label htmlFor="mcp-url" className="text-xs font-medium text-foreground/90">URL</label>
                            <Input
                              id="mcp-url"
                              value={mcpUrl}
                              onChange={(e) => setMcpUrl(e.target.value)}
                              placeholder="例如 https://mcp.notion.com/mcp"
                              className={fieldClassName}
                            />
                          </div>
                          <div className="space-y-2 sm:col-span-2">
                            <label htmlFor="mcp-headers" className="text-xs font-medium text-foreground/90">Headers（可选）</label>
                            <Textarea
                              id="mcp-headers"
                              value={mcpHeadersText}
                              onChange={(e) => setMcpHeadersText(e.target.value)}
                              placeholder={'每行一个，例如\nAuthorization: Bearer <token>\nX-API-Key: <key>'}
                              className={cn('min-h-[92px]', fieldClassName)}
                            />
                          </div>
                        </>
                      )}
                    </div>

                    <Button
                      size="sm"
                      disabled={mcpBusy}
                      onClick={handleSaveMcpServer}
                      className="mt-4 gap-1.5 text-primary-foreground shadow-primary/20"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      保存 MCP 服务器
                    </Button>
                  </div>

                  {mcpMessage && (
                    <div
                      className={cn(
                        'rounded-xl border px-3 py-2 text-xs',
                        mcpMessageIsError
                          ? 'border-destructive/35 bg-destructive/12 text-destructive'
                          : 'border-border/60 bg-secondary/35 text-muted-foreground',
                      )}
                    >
                      {mcpMessage}
                    </div>
                  )}

                  <div className="space-y-2.5">
                    {mcpServers.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border/55 bg-secondary/20 px-3 py-3 text-xs text-muted-foreground">
                        还没有 MCP 服务器配置。可先添加一个 `stdio` 或 URL 类型服务。
                      </div>
                    ) : (
                      mcpServers.map((server) => {
                        const statusTone = !server.enabled
                          ? 'text-muted-foreground'
                          : server.connected
                            ? 'text-[hsl(var(--cool-accent))]'
                            : 'text-primary';
                        return (
                          <div
                            key={server.name}
                            className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <PlugZap className={cn('h-3.5 w-3.5', statusTone)} />
                                  <p className="truncate text-sm font-semibold text-foreground/92">{server.name}</p>
                                  <span className="rounded-full border border-border/55 bg-background/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {server.transport}
                                  </span>
                                </div>
                                <p className="mt-1 break-all text-xs text-muted-foreground">{renderServerTarget(server)}</p>
                                <p className="mt-1 text-[11px] text-muted-foreground/85">
                                  状态: {server.enabled ? (server.connected ? '已连接' : '未连接') : '已禁用'} ·
                                  工具: {server.toolCount}
                                </p>
                                {server.lastError && (
                                  <p className="mt-1 break-all text-[11px] text-destructive/90">{server.lastError}</p>
                                )}
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={mcpBusy}
                                onClick={() => handleRemoveMcpServer(server.name)}
                                className="h-8 w-8 text-muted-foreground hover:bg-destructive/20 hover:text-destructive-foreground"
                                title="删除服务器"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {activePrimary === 'mcp' && activeMcpSubMenu === 'loadedTools' && (
                <div className="settings-panel-enter space-y-3">
                  <div className="rounded-2xl border border-border/60 bg-[linear-gradient(168deg,hsl(var(--secondary)/0.42),hsl(var(--background)/0.36))] p-4">
                    <p className="text-sm font-semibold text-foreground/95">已加载工具</p>
                    <p className="mt-1 text-xs text-muted-foreground">当前 MCP 服务器暴露给模型调用的工具清单。</p>
                  </div>

                  {mcpTools.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/55 bg-secondary/20 px-3 py-3 text-xs text-muted-foreground">
                      还没有已加载工具。请先在"服务器管理"里添加并刷新 MCP 服务器。
                    </div>
                  ) : (
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {mcpTools.map((tool) => (
                        <div
                          key={tool.alias}
                          className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-3"
                        >
                          <p className="break-all text-sm font-semibold text-foreground/92">
                            <code>{tool.alias}</code>
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            来源: {tool.server}.{tool.originalName}
                          </p>
                          {tool.description && (
                            <p className="mt-1 break-words text-[11px] text-muted-foreground/85">
                              {tool.description}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>

        <DialogFooter className="relative border-t border-border/60 bg-[linear-gradient(180deg,hsl(var(--secondary)/0.35),hsl(var(--background)/0.75))]">
          <Button
            variant="outline"
            onClick={testConnection}
            aria-hidden={!showTestConnectionButton}
            tabIndex={showTestConnectionButton ? 0 : -1}
            className={cn(
              'gap-2 border-border/65 bg-background/40 hover:bg-secondary/70 transition-opacity',
              showTestConnectionButton ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            <Zap className="h-4 w-4" />
            测试连接
          </Button>
          <Button
            onClick={handleSaveAllSettings}
            disabled={runtimeBusy}
            className="gap-2 text-primary-foreground shadow-primary/20"
          >
            保存设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
