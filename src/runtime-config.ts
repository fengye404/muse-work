import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeConfig, SandboxConfig } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function normalizeNetworkConfig(value: unknown): SandboxSettings['network'] {
  if (!isRecord(value)) return undefined;
  const network: NonNullable<SandboxSettings['network']> = {};

  const allowedDomains = normalizeStringArray(value.allowedDomains);
  if (allowedDomains) network.allowedDomains = allowedDomains;

  const allowManagedDomainsOnly = normalizeBoolean(value.allowManagedDomainsOnly);
  if (allowManagedDomainsOnly !== undefined) network.allowManagedDomainsOnly = allowManagedDomainsOnly;

  const allowUnixSockets = normalizeStringArray(value.allowUnixSockets);
  if (allowUnixSockets) network.allowUnixSockets = allowUnixSockets;

  const allowAllUnixSockets = normalizeBoolean(value.allowAllUnixSockets);
  if (allowAllUnixSockets !== undefined) network.allowAllUnixSockets = allowAllUnixSockets;

  const allowLocalBinding = normalizeBoolean(value.allowLocalBinding);
  if (allowLocalBinding !== undefined) network.allowLocalBinding = allowLocalBinding;

  const httpProxyPort = normalizeNumber(value.httpProxyPort);
  if (httpProxyPort !== undefined) network.httpProxyPort = httpProxyPort;

  const socksProxyPort = normalizeNumber(value.socksProxyPort);
  if (socksProxyPort !== undefined) network.socksProxyPort = socksProxyPort;

  return Object.keys(network).length > 0 ? network : undefined;
}

function normalizeFilesystemConfig(value: unknown): SandboxSettings['filesystem'] {
  if (!isRecord(value)) return undefined;
  const filesystem: NonNullable<SandboxSettings['filesystem']> = {};

  const allowWrite = normalizeStringArray(value.allowWrite);
  if (allowWrite) filesystem.allowWrite = allowWrite;

  const denyWrite = normalizeStringArray(value.denyWrite);
  if (denyWrite) filesystem.denyWrite = denyWrite;

  const denyRead = normalizeStringArray(value.denyRead);
  if (denyRead) filesystem.denyRead = denyRead;

  return Object.keys(filesystem).length > 0 ? filesystem : undefined;
}

function normalizeIgnoreViolations(value: unknown): SandboxSettings['ignoreViolations'] {
  if (!isRecord(value)) return undefined;
  const normalized: Record<string, string[]> = {};

  for (const [rule, rawValue] of Object.entries(value)) {
    const items = normalizeStringArray(rawValue);
    if (items) normalized[rule] = items;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeRipgrep(value: unknown): SandboxSettings['ripgrep'] {
  if (!isRecord(value)) return undefined;
  if (typeof value.command !== 'string' || value.command.trim().length === 0) return undefined;

  const ripgrep: NonNullable<SandboxSettings['ripgrep']> = {
    command: value.command.trim(),
  };

  const args = normalizeStringArray(value.args);
  if (args) ripgrep.args = args;

  return ripgrep;
}

function normalizeSandboxSettings(value: unknown): SandboxSettings {
  const raw = isRecord(value) ? value : {};
  const settings: SandboxSettings = {
    enabled: normalizeBoolean(raw.enabled) ?? false,
    allowUnsandboxedCommands: normalizeBoolean(raw.allowUnsandboxedCommands) ?? false,
  };

  const autoAllowBashIfSandboxed = normalizeBoolean(raw.autoAllowBashIfSandboxed);
  if (autoAllowBashIfSandboxed !== undefined) settings.autoAllowBashIfSandboxed = autoAllowBashIfSandboxed;

  const network = normalizeNetworkConfig(raw.network);
  if (network) settings.network = network;

  const filesystem = normalizeFilesystemConfig(raw.filesystem);
  if (filesystem) settings.filesystem = filesystem;

  const ignoreViolations = normalizeIgnoreViolations(raw.ignoreViolations);
  if (ignoreViolations) settings.ignoreViolations = ignoreViolations;

  const enableWeakerNestedSandbox = normalizeBoolean(raw.enableWeakerNestedSandbox);
  if (enableWeakerNestedSandbox !== undefined) settings.enableWeakerNestedSandbox = enableWeakerNestedSandbox;

  const excludedCommands = normalizeStringArray(raw.excludedCommands);
  if (excludedCommands) settings.excludedCommands = excludedCommands;

  const ripgrep = normalizeRipgrep(raw.ripgrep);
  if (ripgrep) settings.ripgrep = ripgrep;

  return settings;
}

function cloneSandboxSettings(settings: SandboxSettings): SandboxSettings {
  return {
    ...settings,
    network: settings.network
      ? {
        ...settings.network,
        allowedDomains: settings.network.allowedDomains ? [...settings.network.allowedDomains] : undefined,
        allowUnixSockets: settings.network.allowUnixSockets ? [...settings.network.allowUnixSockets] : undefined,
      }
      : undefined,
    filesystem: settings.filesystem
      ? {
        ...settings.filesystem,
        allowWrite: settings.filesystem.allowWrite ? [...settings.filesystem.allowWrite] : undefined,
        denyWrite: settings.filesystem.denyWrite ? [...settings.filesystem.denyWrite] : undefined,
        denyRead: settings.filesystem.denyRead ? [...settings.filesystem.denyRead] : undefined,
      }
      : undefined,
    ignoreViolations: settings.ignoreViolations
      ? Object.fromEntries(
        Object.entries(settings.ignoreViolations).map(([rule, values]) => [rule, [...values]]),
      )
      : undefined,
    excludedCommands: settings.excludedCommands ? [...settings.excludedCommands] : undefined,
    ripgrep: settings.ripgrep
      ? {
        ...settings.ripgrep,
        args: settings.ripgrep.args ? [...settings.ripgrep.args] : undefined,
      }
      : undefined,
  };
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mode: 'local',
  sandboxSettings: {
    enabled: false,
    allowUnsandboxedCommands: false,
  },
};

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  sandbox: {
    mode: DEFAULT_SANDBOX_CONFIG.mode,
    sandboxSettings: cloneSandboxSettings(DEFAULT_SANDBOX_CONFIG.sandboxSettings),
  },
  enabledSkillIds: [],
};

export function normalizeRuntimeConfig(input: unknown): RuntimeConfig {
  if (!isRecord(input)) {
    return {
      sandbox: {
        mode: DEFAULT_SANDBOX_CONFIG.mode,
        sandboxSettings: cloneSandboxSettings(DEFAULT_SANDBOX_CONFIG.sandboxSettings),
      },
      enabledSkillIds: [],
    };
  }

  const rawSandbox = isRecord(input.sandbox) ? input.sandbox : {};
  const normalizedSandboxSettings = normalizeSandboxSettings(rawSandbox.sandboxSettings);

  // Backward compatibility only: legacy Docker fields may still exist in
  // persisted config (image/cpus/memoryMB/networkEnabled). They are read and
  // intentionally ignored after migration to SDK-native sandbox settings.
  void rawSandbox.image;
  void rawSandbox.cpus;
  void rawSandbox.memoryMB;
  void rawSandbox.networkEnabled;

  return {
    sandbox: {
      mode: rawSandbox.mode === 'sandbox' ? 'sandbox' : 'local',
      sandboxSettings: normalizedSandboxSettings,
    },
    enabledSkillIds: Array.isArray(input.enabledSkillIds)
      ? input.enabledSkillIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
  };
}
