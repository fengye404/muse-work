import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

export type ExecutionMode = 'local' | 'sandbox';

export interface SandboxConfig {
  mode: ExecutionMode;
  sandboxSettings: SandboxSettings;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: 'workspace' | 'home' | 'codex';
  path: string;
}

export interface RuntimeConfig {
  sandbox: SandboxConfig;
  enabledSkillIds: string[];
}
