import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { AgentService } from '../agent-service';
import { normalizeRuntimeConfig } from '../runtime-config';

test('openai provider setup does not mutate ~/.claude/settings.json', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-service-home-'));
  const fakeHome = path.join(tempRoot, 'home');
  const claudeDir = path.join(fakeHome, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });

  const initialSettings = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://example.invalid/base',
      ANTHROPIC_API_KEY: 'original-key',
      EXTRA_FLAG: 'keep-me',
    },
  }, null, 2);
  fs.writeFileSync(settingsPath, initialSettings, 'utf8');

  const beforeStat = fs.statSync(settingsPath);
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  const service = new AgentService();

  try {
    service.setConfig({
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });

    const env = await (service as unknown as {
      buildEnv: () => Promise<Record<string, string | undefined>>;
    }).buildEnv();
    assert.equal(env.ANTHROPIC_API_KEY, 'proxy-key-not-used');
    assert.match(env.ANTHROPIC_BASE_URL || '', /^http:\/\/127\.0\.0\.1:\d+$/);

    const afterSettings = fs.readFileSync(settingsPath, 'utf8');
    const afterStat = fs.statSync(settingsPath);
    assert.equal(afterSettings, initialSettings);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  } finally {
    await service.cleanup();

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('normalizeRuntimeConfig ignores legacy docker fields and applies sdk defaults', () => {
  const normalized = normalizeRuntimeConfig({
    sandbox: {
      mode: 'sandbox',
      image: 'node:20-alpine',
      cpus: 8,
      memoryMB: 8192,
      networkEnabled: true,
    },
    enabledSkillIds: ['a', 'b'],
  });

  assert.equal(normalized.sandbox.mode, 'sandbox');
  assert.deepEqual(normalized.sandbox.sandboxSettings, {
    enabled: false,
    allowUnsandboxedCommands: false,
  });
  assert.deepEqual(normalized.enabledSkillIds, ['a', 'b']);
  const sandboxRecord = normalized.sandbox as unknown as Record<string, unknown>;
  assert.equal('image' in sandboxRecord, false);
  assert.equal('cpus' in sandboxRecord, false);
  assert.equal('memoryMB' in sandboxRecord, false);
  assert.equal('networkEnabled' in sandboxRecord, false);
});

test('agent sdk options include sandbox only when runtime mode is sandbox', () => {
  const service = new AgentService();

  const buildSDKOptions = (service as unknown as {
    buildSDKOptions: (env: Record<string, string | undefined>) => Record<string, unknown>;
  }).buildSDKOptions.bind(service);

  const localOptions = buildSDKOptions({});
  assert.equal(localOptions.sandbox, undefined);

  service.setSandboxConfig({
    mode: 'sandbox',
    sandboxSettings: {
      enabled: true,
      allowUnsandboxedCommands: false,
      network: {
        allowedDomains: ['example.com'],
      },
    },
  });

  const sandboxOptions = buildSDKOptions({});
  const sandboxSetting = sandboxOptions.sandbox as Record<string, unknown>;
  assert.equal(sandboxSetting.enabled, true);
  assert.equal(sandboxSetting.allowUnsandboxedCommands, false);
  assert.deepEqual(
    (sandboxSetting.network as Record<string, unknown>).allowedDomains,
    ['example.com'],
  );

  service.setSandboxConfig({
    mode: 'local',
    sandboxSettings: {
      enabled: true,
      allowUnsandboxedCommands: false,
    },
  });

  const localOptionsAgain = buildSDKOptions({});
  assert.equal(localOptionsAgain.sandbox, undefined);
});

test('source no longer contains docker run sandbox wrapper path', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const srcRoot = path.join(repoRoot, 'src');
  const legacySandboxPath = path.join(srcRoot, 'main-process', 'sandbox', 'sandbox-manager.ts');
  assert.equal(fs.existsSync(legacySandboxPath), false);

  const filesToCheck = [
    path.join(srcRoot, 'agent-service.ts'),
    path.join(srcRoot, 'main-process', 'main-process-context.ts'),
    path.join(srcRoot, 'renderer', 'stores', 'chat-store.ts'),
  ];

  for (const filePath of filesToCheck) {
    const content = fs.readFileSync(filePath, 'utf8');
    assert.equal(content.includes('docker run --rm -i'), false, `${filePath} still contains docker wrapper command`);
    assert.equal(content.includes('prepareToolInput('), false, `${filePath} still references command rewrite path`);
  }
});
