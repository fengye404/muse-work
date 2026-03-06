import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../types';
import type { ModelConfig, ModelProvidersConfig, RuntimeConfig } from '../../types';
import type { MainProcessContext } from '../main-process-context';

function isModelProvidersConfig(payload: unknown): payload is ModelProvidersConfig {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const maybePayload = payload as Partial<ModelProvidersConfig>;
  return Array.isArray(maybePayload.providers);
}

export function registerConfigHandlers(context: MainProcessContext): void {
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, config: ModelProvidersConfig | Partial<ModelConfig>) => {
    const storage = context.getSessionStorageOrThrow();

    if (isModelProvidersConfig(config)) {
      storage.saveModelProvidersConfig(config);
    } else {
      storage.saveConfig(config);
    }

    return true;
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_LOAD, async () => {
    const storage = context.getSessionStorageOrThrow();
    return storage.loadModelProvidersConfig();
  });

  ipcMain.handle(IPC_CHANNELS.RUNTIME_CONFIG_SAVE, async (_event, config: RuntimeConfig) => {
    context.setRuntimeConfig(config);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.RUNTIME_CONFIG_LOAD, async () => {
    return context.getRuntimeConfig();
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_LIST, async () => {
    return context.listSkills();
  });
}
