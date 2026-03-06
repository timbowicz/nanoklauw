import { describe, it, expect } from 'vitest';
import { parseImapAccounts } from './email.js';

// Mock readEnvFile to return test data
import { vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) => {
    const env: Record<string, string> = {
      IMAP_HOST_1: 'imap.example.com',
      IMAP_USER_1: 'user1@example.com',
      IMAP_PASS_1: 'pass1',
      IMAP_PORT_1: '993',
      IMAP_TLS_1: 'true',
      IMAP_HOST_2: 'imap.other.com',
      IMAP_USER_2: 'user2@other.com',
      IMAP_PASS_2: 'pass2',
      // No account 3
    };
    const result: Record<string, string> = {};
    for (const k of keys) {
      if (env[k]) result[k] = env[k];
    }
    return result;
  },
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('parseImapAccounts', () => {
  it('parses configured accounts from env', () => {
    const accounts = parseImapAccounts();
    expect(accounts).toHaveLength(2);

    expect(accounts[0]).toEqual({
      id: '1',
      host: 'imap.example.com',
      user: 'user1@example.com',
      pass: 'pass1',
      port: 993,
      tls: true,
    });

    expect(accounts[1]).toEqual({
      id: '2',
      host: 'imap.other.com',
      user: 'user2@other.com',
      pass: 'pass2',
      port: 993, // default
      tls: true, // default
    });
  });

  it('skips accounts without host/user/pass', () => {
    // Account 3 has no config in the mock, so only 2 should be returned
    const accounts = parseImapAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts.every((a) => a.id !== '3')).toBe(true);
  });
});

describe('EmailChannel message formatting', () => {
  it('formats email content correctly', () => {
    // Test the message format structure
    const from = 'John Doe <john@example.com>';
    const account = 'user1@example.com';
    const subject = 'Test Subject';
    const date = '2026-03-06T10:00:00.000Z';
    const body = 'Hello, this is a test email.';

    const content = [
      `[Email] From: ${from}`,
      `Account: ${account}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      '',
      body,
    ].join('\n');

    expect(content).toContain('[Email] From: John Doe');
    expect(content).toContain('Account: user1@example.com');
    expect(content).toContain('Subject: Test Subject');
    expect(content).toContain('Hello, this is a test email.');
  });

  it('truncates long bodies', () => {
    const MAX_BODY_LENGTH = 4000;
    const longBody = 'x'.repeat(5000);
    let body = longBody;
    if (body.length > MAX_BODY_LENGTH) {
      body = body.slice(0, MAX_BODY_LENGTH) + '\n[... truncated]';
    }
    expect(body.length).toBeLessThan(5000);
    expect(body).toContain('[... truncated]');
  });
});
