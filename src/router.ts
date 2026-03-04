import { Channel, NewMessage } from './types.js';
import { formatCurrentTime, formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const attrs = [
      `id="${escapeXml(m.id)}"`,
      `sender="${escapeXml(m.sender_name)}"`,
      `time="${escapeXml(displayTime)}"`,
    ];
    if (m.image_data) attrs.push('has-image="true"');
    if (m.document_data)
      attrs.push(`has-document="${escapeXml(m.document_data.filename)}"`);
    return `<message ${attrs.join(' ')}>${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" current_time="${escapeXml(formatCurrentTime(timezone))}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/<\/thinking>/g, '')
    .trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
