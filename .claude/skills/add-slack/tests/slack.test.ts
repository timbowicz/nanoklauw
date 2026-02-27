import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('slack skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: slack');
    expect(content).toContain('@slack/bolt');
  });

  it('has all files declared in adds', () => {
    const addFile = path.join(skillDir, 'add', 'src', 'channels', 'slack.ts');
    expect(fs.existsSync(addFile)).toBe(true);

    const content = fs.readFileSync(addFile, 'utf-8');
    expect(content).toContain('class SlackChannel');
    expect(content).toContain('implements Channel');

    // Test file for the channel
    const testFile = path.join(skillDir, 'add', 'src', 'channels', 'slack.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('SlackChannel'");
  });

  it('has barrel file modification for self-registration', () => {
    const barrelFile = path.join(skillDir, 'modify', 'src', 'channels', 'index.ts');
    expect(fs.existsSync(barrelFile)).toBe(true);

    const content = fs.readFileSync(barrelFile, 'utf-8');
    expect(content).toContain("import './slack.js'");
    expect(content).toContain("import './whatsapp.js'");
  });

  it('has intent file for barrel modification', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'))).toBe(true);
  });

  it('has setup documentation', () => {
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'SLACK_SETUP.md'))).toBe(true);
  });

  it('has reference files', () => {
    expect(
      fs.existsSync(path.join(skillDir, 'references', 'slack-app-manifest.yaml')),
    ).toBe(true);
  });

  it('slack.ts implements required Channel interface methods', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'channels', 'slack.ts'),
      'utf-8',
    );

    // Channel interface methods
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('async disconnect()');
    expect(content).toContain('async setTyping(');

    // Security pattern: reads tokens from .env, not process.env
    expect(content).toContain('readEnvFile');
    expect(content).not.toContain('process.env.SLACK_BOT_TOKEN');
    expect(content).not.toContain('process.env.SLACK_APP_TOKEN');

    // Key behaviors
    expect(content).toContain('socketMode: true');
    expect(content).toContain('MAX_MESSAGE_LENGTH');
    expect(content).toContain('TRIGGER_PATTERN');
    expect(content).toContain('userNameCache');
  });

  it('slack.ts includes local features', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'channels', 'slack.ts'),
      'utf-8',
    );

    // Auto-registration
    expect(content).toContain('registerGroup');
    expect(content).toContain('slugify');

    // /abort support
    expect(content).toContain('isAbortCommand');
    expect(content).toContain('/abort');

    // Hourglass typing
    expect(content).toContain('hourglass_flowing_sand');

    // Thread tracking
    expect(content).toContain('botActiveThreads');
    expect(content).toContain('lastTriggerTs');

    // File attachment placeholders
    expect(content).toContain("'Image'");
    expect(content).toContain("'File'");
    expect(content).toContain('f.name');
  });
});
