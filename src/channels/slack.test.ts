import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  shouldIgnoreSlackMessageSubtype,
  SlackChannel,
} from './slack.js';

const mockCommandHandlers = new Map<string, (args: any) => Promise<void>>();
const mockMessageHandlers: Array<(args: any) => Promise<void>> = [];

const mockClient = {
  auth: { test: vi.fn(async () => ({ user_id: 'U_BOT' })) },
  chat: {
    postMessage: vi.fn(async () => ({})),
    postEphemeral: vi.fn(async () => ({})),
  },
  conversations: {
    info: vi.fn(async () => ({ channel: { name: 'eng-platform' } })),
  },
  users: {
    info: vi.fn(async () => ({
      user: { profile: { display_name: 'Alice' }, real_name: 'Alice Smith', name: 'asmith' },
    })),
  },
};

vi.mock('@slack/bolt', () => {
  class MockApp {
    client = mockClient;
    command(name: string, handler: (args: any) => Promise<void>) {
      mockCommandHandlers.set(name, handler);
    }
    message(handler: (args: any) => Promise<void>) {
      mockMessageHandlers.push(handler);
    }
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
  }
  return {
    App: MockApp,
    LogLevel: { WARN: 'warn' },
  };
});

describe('shouldIgnoreSlackMessageSubtype', () => {
  it('returns false for undefined', () => {
    expect(shouldIgnoreSlackMessageSubtype(undefined)).toBe(false);
  });

  it('keeps file_share events', () => {
    expect(shouldIgnoreSlackMessageSubtype('file_share')).toBe(false);
  });

  it('ignores unrelated subtypes', () => {
    expect(shouldIgnoreSlackMessageSubtype('bot_message')).toBe(true);
  });
});

describe('SlackChannel', () => {
  beforeEach(() => {
    mockCommandHandlers.clear();
    mockMessageHandlers.length = 0;
    vi.clearAllMocks();
  });

  function createChannel(overrides?: Partial<ConstructorParameters<typeof SlackChannel>[0]>) {
    return new SlackChannel({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'secret',
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      onAbort: vi.fn(async () => true),
      registerGroup: vi.fn(),
      registeredGroups: vi.fn(() => ({})),
      ...overrides,
    });
  }

  it('owns Slack-style channel IDs', () => {
    const channel = createChannel();
    expect(channel.ownsJid('C123ABC')).toBe(true);
    expect(channel.ownsJid('G123ABC')).toBe(true);
    expect(channel.ownsJid('D123ABC')).toBe(true);
    expect(channel.ownsJid('not-a-slack-jid')).toBe(false);
  });

  it('auto-registers on mention for unregistered channel', async () => {
    const onMessage = vi.fn();
    const registerGroup = vi.fn();
    const channel = createChannel({ onMessage, registerGroup });
    await channel.connect();

    const handler = mockMessageHandlers[0];
    await handler({
      client: mockClient,
      message: {
        channel: 'C123ABC',
        user: 'U123',
        ts: '1.2',
        channel_type: 'channel',
        text: '<@U_BOT> hello',
      },
    });

    expect(registerGroup).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('auto-registers DMs without mention', async () => {
    const onMessage = vi.fn();
    const registerGroup = vi.fn();
    const channel = createChannel({ onMessage, registerGroup });
    await channel.connect();

    const handler = mockMessageHandlers[0];
    await handler({
      client: mockClient,
      message: {
        channel: 'D123ABC',
        user: 'U123',
        ts: '1.2',
        channel_type: 'im',
        text: 'hello',
      },
    });

    expect(registerGroup).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('handles abort text fallback without storing message', async () => {
    const onMessage = vi.fn();
    const onAbort = vi.fn(async () => true);
    const channel = createChannel({ onMessage, onAbort });
    await channel.connect();

    const handler = mockMessageHandlers[0];
    await handler({
      client: mockClient,
      message: {
        channel: 'C123ABC',
        user: 'U123',
        ts: '1.2',
        channel_type: 'channel',
        text: '/abort',
      },
    });

    expect(onAbort).toHaveBeenCalledWith('C123ABC');
    expect(onMessage).not.toHaveBeenCalled();
    expect(mockClient.chat.postEphemeral).toHaveBeenCalled();
  });

  it('wires slash command /abort', async () => {
    const onAbort = vi.fn(async () => true);
    const channel = createChannel({ onAbort });
    await channel.connect();

    const handler = mockCommandHandlers.get('/abort');
    expect(handler).toBeTruthy();

    const ack = vi.fn(async () => {});
    await handler!({ ack, command: { channel_id: 'C123ABC' } });

    expect(onAbort).toHaveBeenCalledWith('C123ABC');
    expect(ack).toHaveBeenCalledWith('Abort requested.');
  });

  // setTyping is intentionally a no-op (ephemeral status messages were distracting)

  describe('user name resolution', () => {
    it('resolves sender_name via users.info', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => ({ C123ABC: { name: 'test', folder: 'test', trigger: '@NanoClaw', added_at: '', requiresTrigger: true } }));
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.1', channel_type: 'channel', text: '<@U_BOT> hello' },
      });

      expect(mockClient.users.info).toHaveBeenCalledWith({ user: 'U123' });
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][1].sender_name).toBe('Alice');
    });

    it('caches user name (no re-fetch on second message)', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => ({ C123ABC: { name: 'test', folder: 'test', trigger: '@NanoClaw', added_at: '', requiresTrigger: true } }));
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      const msg = { client: mockClient, message: { channel: 'C123ABC', user: 'U123', ts: '1.1', channel_type: 'channel', text: '<@U_BOT> hello' } };

      await handler(msg);
      await handler({ ...msg, message: { ...msg.message, ts: '1.2', text: '<@U_BOT> again' } });

      expect(mockClient.users.info).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(onMessage.mock.calls[1][1].sender_name).toBe('Alice');
    });

    it('falls back to userId on API error', async () => {
      mockClient.users.info.mockRejectedValueOnce(new Error('API error'));
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => ({ C123ABC: { name: 'test', folder: 'test', trigger: '@NanoClaw', added_at: '', requiresTrigger: true } }));
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'UFAIL', ts: '1.1', channel_type: 'channel', text: '<@U_BOT> hello' },
      });

      expect(onMessage.mock.calls[0][1].sender_name).toBe('UFAIL');
    });
  });

  describe('threading', () => {
    it('sends reply with thread_ts matching incoming message ts', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => ({ C123ABC: { name: 'test', folder: 'test', trigger: '@NanoClaw', added_at: '', requiresTrigger: true } }));
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1718000000.000100', channel_type: 'channel', text: '<@U_BOT> hello' },
      });

      await channel.sendMessage('C123ABC', 'Hi there!');

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123ABC',
        text: 'Hi there!',
        thread_ts: '1718000000.000100',
      });
    });

    it('sends without thread_ts when no prior incoming message', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('C999ZZZ', 'proactive message');

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C999ZZZ',
        text: 'proactive message',
        thread_ts: undefined,
      });
    });
  });

  describe('message splitting', () => {
    it('sends a short message as a single postMessage', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('C123ABC', 'short');

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    it('splits a long message into multiple chunks with same thread_ts', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => ({ C123ABC: { name: 'test', folder: 'test', trigger: '@NanoClaw', added_at: '', requiresTrigger: true } }));
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      // Trigger an incoming message to set thread_ts
      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.5', channel_type: 'channel', text: '<@U_BOT> hello' },
      });
      mockClient.chat.postMessage.mockClear();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('C123ABC', longText);

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = mockClient.chat.postMessage.mock.calls as any;
      const call1 = calls[0]![0];
      const call2 = calls[1]![0];

      expect(call1.text).toHaveLength(3900);
      expect(call2.text).toHaveLength(1100);
      expect(call1.thread_ts).toBe('1.5');
      expect(call2.thread_ts).toBe('1.5');
    });
  });
});
