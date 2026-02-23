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
  reactions: {
    add: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
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

  const registered = { C123ABC: { name: 'test', folder: 'test', trigger: '@NanoClaw', added_at: '', requiresTrigger: true } };

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

  describe('user name resolution', () => {
    it('resolves sender_name via users.info', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
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
      const registeredGroups = vi.fn(() => registered);
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
      const registeredGroups = vi.fn(() => registered);
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
      const registeredGroups = vi.fn(() => registered);
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
      const registeredGroups = vi.fn(() => registered);
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

  describe('file attachment placeholders', () => {
    it('appends image placeholder for image files', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: {
          channel: 'C123ABC',
          user: 'U123',
          ts: '1.1',
          channel_type: 'channel',
          text: '<@U_BOT> check this',
          files: [{ name: 'photo.jpg', mimetype: 'image/jpeg' }],
        },
      });

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][1].content).toContain('[Image: photo.jpg]');
    });

    it('appends file placeholder for non-image files', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: {
          channel: 'C123ABC',
          user: 'U123',
          ts: '1.1',
          channel_type: 'channel',
          text: '<@U_BOT> review this',
          files: [{ name: 'report.pdf', mimetype: 'application/pdf' }],
        },
      });

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][1].content).toContain('[File: report.pdf]');
    });

    it('includes both text and file placeholders', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: {
          channel: 'C123ABC',
          user: 'U123',
          ts: '1.1',
          channel_type: 'channel',
          text: '<@U_BOT> here are files',
          files: [
            { name: 'pic.png', mimetype: 'image/png' },
            { name: 'doc.txt', mimetype: 'text/plain' },
          ],
        },
      });

      const content = onMessage.mock.calls[0][1].content;
      expect(content).toContain('here are files');
      expect(content).toContain('[Image: pic.png]');
      expect(content).toContain('[File: doc.txt]');
    });

    it('processes file-only messages (no text) when mentioned', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: {
          channel: 'C123ABC',
          user: 'U123',
          ts: '1.1',
          channel_type: 'channel',
          text: '<@U_BOT>',
          files: [{ name: 'image.jpg', mimetype: 'image/jpeg' }],
        },
      });

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][1].content).toContain('[Image: image.jpg]');
    });
  });

  describe('typing indicator (hourglass)', () => {
    it('adds hourglass reaction for setTyping(true)', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      // Trigger a message to set lastTriggerTs
      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.1', channel_type: 'channel', text: '<@U_BOT> hello' },
      });

      await channel.setTyping('C123ABC', true);

      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: 'C123ABC',
        timestamp: '1.1',
        name: 'hourglass_flowing_sand',
      });
    });

    it('removes hourglass reaction for setTyping(false)', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.1', channel_type: 'channel', text: '<@U_BOT> hello' },
      });

      await channel.setTyping('C123ABC', false);

      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123ABC',
        timestamp: '1.1',
        name: 'hourglass_flowing_sand',
      });
    });

    it('does not throw on reaction API error', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.1', channel_type: 'channel', text: '<@U_BOT> hello' },
      });

      mockClient.reactions.add.mockRejectedValueOnce(new Error('no_permission'));

      await expect(channel.setTyping('C123ABC', true)).resolves.toBeUndefined();
    });

    it('does nothing without a trigger timestamp', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.setTyping('C999ZZZ', true);

      expect(mockClient.reactions.add).not.toHaveBeenCalled();
    });
  });

  describe('bot-initiated thread auto-reply', () => {
    it('auto-triggers in active thread without mention', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];

      // First message: mention bot (starts active thread)
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.0', channel_type: 'channel', text: '<@U_BOT> hello' },
      });

      // Second message: thread reply without mention
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.1', thread_ts: '1.0', channel_type: 'channel', text: 'follow up question' },
      });

      expect(onMessage).toHaveBeenCalledTimes(2);
      // Second message should have trigger prepended
      expect(onMessage.mock.calls[1][1].content).toMatch(/^@\w+/);
      expect(onMessage.mock.calls[1][1].content).toContain('follow up question');
    });

    it('ignores thread messages in non-active threads', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];

      // Thread reply in a thread the bot was never mentioned in
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '2.1', thread_ts: '2.0', channel_type: 'channel', text: 'random reply' },
      });

      expect(onMessage).toHaveBeenCalledTimes(1);
      // Should NOT have trigger prepended
      expect(onMessage.mock.calls[0][1].content).toBe('random reply');
    });

    it('uses thread root ts for replies in a thread', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      const handler = mockMessageHandlers[0];

      // Top-level mention
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.0', channel_type: 'channel', text: '<@U_BOT> hello' },
      });

      // Thread reply (auto-triggered)
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.1', thread_ts: '1.0', channel_type: 'channel', text: 'more' },
      });

      mockClient.chat.postMessage.mockClear();
      await channel.sendMessage('C123ABC', 'reply');

      // Should reply to thread root, not the latest reply ts
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123ABC',
        text: 'reply',
        thread_ts: '1.0',
      });
    });
  });

  describe('bot self-message tracking', () => {
    it('delivers outgoing message via onMessage with is_from_me', async () => {
      const onMessage = vi.fn();
      const channel = createChannel({ onMessage });
      await channel.connect();

      await channel.sendMessage('C123ABC', 'bot reply');

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0]).toBe('C123ABC');
      expect(onMessage.mock.calls[0][1]).toMatchObject({
        content: 'bot reply',
        is_from_me: true,
        is_bot_message: true,
        sender_name: expect.any(String),
      });
    });

    it('delivers full text once for split messages', async () => {
      const onMessage = vi.fn();
      const channel = createChannel({ onMessage });
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('C123ABC', longText);

      // postMessage called twice (split), but onMessage called once with full text
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][1].content).toBe(longText);
      expect(onMessage.mock.calls[0][1].is_from_me).toBe(true);
      expect(onMessage.mock.calls[0][1].is_bot_message).toBe(true);
    });

    it('does not deliver outgoing message when send fails', async () => {
      const onMessage = vi.fn();
      const channel = createChannel({ onMessage });
      await channel.connect();

      mockClient.chat.postMessage.mockRejectedValueOnce(new Error('network'));

      await channel.sendMessage('C123ABC', 'will fail');

      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe('mentions', () => {
    it('replaces @userId with <@userId> in posted text', async () => {
      const onMessage = vi.fn();
      const channel = createChannel({ onMessage });
      await channel.connect();

      await channel.sendMessage('C123ABC', 'Hey @U999XYZ check this out', { mentions: ['U999XYZ'] });

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123ABC',
        text: 'Hey <@U999XYZ> check this out',
        thread_ts: undefined,
      });
    });

    it('preserves original text in self-tracking onMessage', async () => {
      const onMessage = vi.fn();
      const channel = createChannel({ onMessage });
      await channel.connect();

      await channel.sendMessage('C123ABC', 'Hey @U999XYZ check this', { mentions: ['U999XYZ'] });

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][1].content).toBe('Hey @U999XYZ check this');
    });

    it('leaves text unchanged without mentions', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('C123ABC', 'no mentions here');

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123ABC',
        text: 'no mentions here',
        thread_ts: undefined,
      });
    });

    it('handles multiple mentions', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('C123ABC', 'Hey @U111 and @U222', { mentions: ['U111', 'U222'] });

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123ABC',
        text: 'Hey <@U111> and <@U222>',
        thread_ts: undefined,
      });
    });
  });

  describe('outgoing message queue', () => {
    it('queues failed messages and flushes on reconnect', async () => {
      const onMessage = vi.fn();
      const channel = createChannel({ onMessage });
      await channel.connect();

      mockClient.chat.postMessage.mockRejectedValueOnce(new Error('network error'));
      await channel.sendMessage('C123ABC', 'queued msg');

      // Message failed — onMessage not called
      expect(onMessage).not.toHaveBeenCalled();

      mockClient.chat.postMessage.mockClear();

      // Reconnect triggers flush
      await channel.disconnect();
      await channel.connect();

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123ABC',
        text: 'queued msg',
        thread_ts: undefined,
      });

      // onMessage called after successful flush
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][1]).toMatchObject({
        content: 'queued msg',
        is_from_me: true,
        is_bot_message: true,
      });
    });

    it('caps queue size at 100', async () => {
      const onMessage = vi.fn();
      const channel = createChannel({ onMessage });
      await channel.connect();

      // Queue 105 rejections
      for (let i = 0; i < 105; i++) {
        mockClient.chat.postMessage.mockRejectedValueOnce(new Error('down'));
      }

      for (let i = 0; i < 105; i++) {
        await channel.sendMessage('C123ABC', `msg-${i}`);
      }

      mockClient.chat.postMessage.mockClear();
      onMessage.mockClear();

      await channel.disconnect();
      await channel.connect();

      // Only 100 messages flushed (items 0-99, items 100-104 dropped)
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(100);
    });

    it('preserves thread_ts in queued messages', async () => {
      const onMessage = vi.fn();
      const registeredGroups = vi.fn(() => registered);
      const channel = createChannel({ onMessage, registeredGroups });
      await channel.connect();

      // Set up a thread context
      const handler = mockMessageHandlers[0];
      await handler({
        client: mockClient,
        message: { channel: 'C123ABC', user: 'U123', ts: '1.0', channel_type: 'channel', text: '<@U_BOT> hello' },
      });

      mockClient.chat.postMessage.mockRejectedValueOnce(new Error('fail'));
      await channel.sendMessage('C123ABC', 'threaded reply');

      mockClient.chat.postMessage.mockClear();
      onMessage.mockClear();

      await channel.disconnect();
      await channel.connect();

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123ABC',
        text: 'threaded reply',
        thread_ts: '1.0',
      });
    });
  });
});
