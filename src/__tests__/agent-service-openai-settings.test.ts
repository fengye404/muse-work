import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { AgentService } from '../agent-service';

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
