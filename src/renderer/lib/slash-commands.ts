/**
 * Slash command definitions and parser.
 *
 * After the SDK migration:
 * - /clear creates a fresh session explicitly
 * - /compact is shown as SDK-managed capability
 * - /config and /model remain UI-only operations
 * - /help shows combined built-in + SDK commands
 * - SDK slash commands from .claude/commands/ are included in suggestions
 */

export interface ParsedSlashCommand {
  raw: string;
  name: string;
  args: string[];
}

export interface SlashCommandDefinition {
  name: string;
  usage: string;
  description: string;
  isSDK?: boolean;
}

export type SlashCommandAction = 'sdk' | 'ui-config' | 'ui-model' | 'help';

export const BUILT_IN_SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    name: 'help',
    usage: '/help',
    description: '显示内置命令帮助',
  },
  {
    name: 'clear',
    usage: '/clear',
    description: '新建并切换到空白会话',
    isSDK: true,
  },
  {
    name: 'compact',
    usage: '/compact',
    description: '查看上下文压缩状态（SDK 自动管理）',
    isSDK: true,
  },
  {
    name: 'config',
    usage: '/config',
    description: '打开设置面板',
  },
  {
    name: 'model',
    usage: '/model <model-id>',
    description: '切换当前模型',
  },
  {
    name: 'skills',
    usage: '/skills',
    description: '查看可用技能与启用状态',
  },
  {
    name: 'skill',
    usage: '/skill <on|off> <skill-id|name>',
    description: '启用或停用指定技能',
  },
  {
    name: 'sandbox',
    usage: '/sandbox <on|off|status>',
    description: '切换或查看沙箱执行模式',
  },
];

let sdkCommands: SlashCommandDefinition[] = [];

export function setSdkSlashCommands(commands: Array<{ name: string; description?: string; argumentHint?: string }>): void {
  sdkCommands = commands
    .filter((c) => !BUILT_IN_SLASH_COMMANDS.some((b) => b.name === c.name))
    .map((c) => ({
      name: c.name,
      usage: c.argumentHint ? `/${c.name} ${c.argumentHint}` : `/${c.name}`,
      description: c.description || `SDK 命令: ${c.name}`,
      isSDK: true,
    }));
}

export function getAllSlashCommands(): SlashCommandDefinition[] {
  return [...BUILT_IN_SLASH_COMMANDS, ...sdkCommands];
}

export function getCommandAction(name: string): SlashCommandAction {
  if (name === 'config') return 'ui-config';
  if (name === 'model') return 'ui-model';
  if (name === 'help') return 'help';
  return 'sdk';
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const withoutPrefix = trimmed.slice(1).trim();
  if (!withoutPrefix) return null;

  const segments = withoutPrefix.split(/\s+/).filter(Boolean);
  if (segments.length === 0) return null;

  const [name, ...args] = segments;
  return { raw: trimmed, name: name.toLowerCase(), args };
}

export function formatSlashCommandHelp(): string {
  const allCommands = getAllSlashCommands();
  const lines = [
    '可用斜杠命令:',
    ...allCommands.map((command) => {
      const sdkTag = command.isSDK ? ' (SDK)' : '';
      return `- \`${command.usage}\`：${command.description}${sdkTag}`;
    }),
    '',
    '补充:',
    '- 支持 `@路径` 引用文件，例如 `@src/main.ts` 或 `@src/main.ts:10-40`',
    '- SDK 命令会直接发送给 Agent 处理',
  ];

  return lines.join('\n');
}

export function getSlashCommandSuggestions(query: string): SlashCommandDefinition[] {
  const normalizedQuery = query.trim().toLowerCase();
  const allCommands = getAllSlashCommands();

  if (!normalizedQuery) return allCommands;

  return allCommands
    .filter((command) => command.name.startsWith(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name));
}
