/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MEDIA_DIR = path.join(IPC_DIR, 'media');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    mentions: z.array(z.string()).optional().describe(
      'User identifiers to @mention (phone numbers for WhatsApp, Slack user IDs for Slack). Include the corresponding @identifier in the text.',
    ),
  },
  async (args) => {
    const data: Record<string, string | string[] | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      mentions: args.mentions,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'react_to_message',
  'React to a message with an emoji. Omit message_id to react to the most recent message in the chat.',
  {
    emoji: z.string().describe('The emoji to react with (e.g. "👍", "❤️", "🔥")'),
    message_id: z.string().optional().describe('The message ID to react to. If omitted, reacts to the latest message in the chat.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'reaction',
      chatJid,
      emoji: args.emoji,
      messageId: args.message_id || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return { content: [{ type: 'text' as const, text: `Reaction ${args.emoji} sent.` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'generate_image',
  `Generate a NEW image from a text prompt and send it to the chat.

MODEL SELECTION:
• gemini-3.1-flash-image-preview: DEFAULT — fast, high quality, 4K support, thinking mode, search grounding (~$0.05-0.07/image at 1024px)
• gemini-3-pro-image-preview: Highest quality, use when flash result isn't good enough (~$0.13-0.24/image)
• imagen-4.0-fast-generate-001: Legacy Imagen, fast and cheap (~$0.02/image)
• imagen-4.0-generate-001: Legacy Imagen, higher quality (~$0.04/image)

Default to "gemini-3.1-flash-image-preview" for all requests.
Fall back to "gemini-3-pro-image-preview" if the user wants maximum quality.
Use Imagen models only if specifically requested.

IMPORTANT:
• The prompt must be in English. Translate if needed.
• Be descriptive — detailed prompts produce better results.
• The generated image is automatically sent to the current chat.`,
  {
    prompt: z.string().describe('English description of the image to generate. Be descriptive for best results.'),
    model: z.enum(['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'imagen-4.0-fast-generate-001', 'imagen-4.0-generate-001'])
      .default('gemini-3.1-flash-image-preview')
      .describe('Model to use. gemini-3.1-flash-image-preview is the default (fast, high quality). gemini-3-pro-image-preview for max quality.'),
    caption: z.string().optional().describe('Optional caption to send with the image'),
  },
  async (args) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: 'text' as const, text: 'GEMINI_API_KEY is not configured. Cannot generate images.' }],
        isError: true,
      };
    }

    try {
      const genai = new GoogleGenAI({ apiKey });
      const isGemini = args.model.startsWith('gemini-');
      let imageBuffer: Buffer;

      if (isGemini) {
        // Gemini models use generateContent with responseModalities
        const response = await genai.models.generateContent({
          model: args.model,
          contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
          config: { responseModalities: ['TEXT', 'IMAGE'] },
        });

        const parts = response.candidates?.[0]?.content?.parts;
        const imagePart = parts?.find((p: { inlineData?: { mimeType?: string; data?: string } }) => p.inlineData?.mimeType?.startsWith('image/'));
        if (!imagePart?.inlineData?.data) {
          const textPart = parts?.find((p: { text?: string }) => p.text);
          const textMsg = textPart?.text || 'No image in response';
          return {
            content: [{ type: 'text' as const, text: `Image generation did not produce an image. Model response: ${textMsg}` }],
            isError: true,
          };
        }
        imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
      } else {
        // Imagen models use generateImages
        const response = await genai.models.generateImages({
          model: args.model,
          prompt: args.prompt,
          config: { numberOfImages: 1 },
        });

        const image = response.generatedImages?.[0];
        if (!image?.image?.imageBytes) {
          return {
            content: [{ type: 'text' as const, text: 'Image generation returned no results. The prompt may have been blocked by safety filters. Try rephrasing.' }],
            isError: true,
          };
        }
        imageBuffer = Buffer.from(image.image.imageBytes, 'base64');
      }

      // Write image to media directory for host-side IPC pickup
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const imagePath = path.join(MEDIA_DIR, filename);
      fs.writeFileSync(imagePath, imageBuffer);

      // Write IPC file to send the image
      const ipcData = {
        type: 'send_image',
        chatJid,
        imagePath: `/workspace/ipc/media/${filename}`,
        caption: args.caption || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(MESSAGES_DIR, ipcData);

      return {
        content: [{ type: 'text' as const, text: `Image generated and sent (${args.model}, ${imageBuffer.length} bytes).` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Image generation failed: ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'edit_image',
  `Edit/transform an existing image using AI. Takes an input image and a text prompt describing the desired changes, and generates a modified version.

Use this when:
• A user sends a photo and wants it modified (e.g., "make this room more modern", "change the wall color to blue")
• You need to apply design changes to an existing image
• The user wants a variation of an existing image with specific changes

The prompt must be in English. Translate if needed. Be specific about what to change.
The input image must exist on disk (e.g., received media in /workspace/ipc/media/).`,
  {
    prompt: z.string().describe('English editing instruction describing what to change (e.g., "Change the wall color to light blue and add modern furniture")'),
    image_path: z.string().describe('Absolute path to the input image file (e.g., /workspace/ipc/media/abc123.jpg)'),
    model: z.enum(['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-image'])
      .default('gemini-3.1-flash-image-preview')
      .describe('Gemini model for image editing. gemini-3.1-flash-image-preview is the default (fast, high quality). gemini-3-pro-image-preview for max quality.'),
    caption: z.string().optional().describe('Optional caption to send with the edited image'),
  },
  async (args) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: 'text' as const, text: 'GEMINI_API_KEY is not configured. Cannot edit images.' }],
        isError: true,
      };
    }

    if (!fs.existsSync(args.image_path)) {
      return {
        content: [{ type: 'text' as const, text: `Input image not found: ${args.image_path}` }],
        isError: true,
      };
    }

    try {
      // Read input image and convert to base64
      const imageBuffer = fs.readFileSync(args.image_path);
      const base64Image = imageBuffer.toString('base64');

      // Detect MIME type from extension
      const ext = path.extname(args.image_path).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
      };
      const mimeType = mimeMap[ext] || 'image/jpeg';

      const genai = new GoogleGenAI({ apiKey });
      const response = await genai.models.generateContent({
        model: args.model,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType, data: base64Image } },
              { text: args.prompt },
            ],
          },
        ],
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      });

      // Extract output image from response
      const parts = response.candidates?.[0]?.content?.parts;
      if (!parts) {
        return {
          content: [{ type: 'text' as const, text: 'Image editing returned no results. The prompt may have been blocked by safety filters. Try rephrasing.' }],
          isError: true,
        };
      }

      const imagePart = parts.find((p: { inlineData?: { mimeType?: string; data?: string } }) => p.inlineData?.mimeType?.startsWith('image/'));
      if (!imagePart?.inlineData?.data) {
        // Return any text response if no image was generated
        const textPart = parts.find((p: { text?: string }) => p.text);
        const textMsg = textPart?.text || 'No image in response';
        return {
          content: [{ type: 'text' as const, text: `Image editing did not produce an image. Model response: ${textMsg}` }],
          isError: true,
        };
      }

      // Write output image to media directory
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const outputBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
      const outputFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const outputPath = path.join(MEDIA_DIR, outputFilename);
      fs.writeFileSync(outputPath, outputBuffer);

      // Write IPC file to send the image
      const ipcData = {
        type: 'send_image',
        chatJid,
        imagePath: `/workspace/ipc/media/${outputFilename}`,
        caption: args.caption || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(MESSAGES_DIR, ipcData);

      return {
        content: [{ type: 'text' as const, text: `Image edited and sent (${args.model}, ${outputBuffer.length} bytes).` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Image editing failed: ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'send_image',
  'Send an existing image file from the workspace to the chat. Use generate_image for AI-generated images.',
  {
    file_path: z.string().describe('Absolute path to the image file inside the container (e.g., /workspace/group/image.png)'),
    caption: z.string().optional().describe('Optional caption to send with the image'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    // Copy file to media directory for IPC
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const ext = path.extname(args.file_path) || '.png';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const destPath = path.join(MEDIA_DIR, filename);
    fs.copyFileSync(args.file_path, destPath);

    const ipcData = {
      type: 'send_image',
      chatJid,
      imagePath: `/workspace/ipc/media/${filename}`,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, ipcData);

    return {
      content: [{ type: 'text' as const, text: `Image sent.` }],
    };
  },
);

server.tool(
  'send_document',
  'Send a file/document from the workspace to the chat (e.g., .txt, .pdf, .csv, .json). The file is sent as a WhatsApp document attachment.',
  {
    file_path: z.string().describe('Absolute path to the file inside the container (e.g., /workspace/group/report.txt)'),
    filename: z.string().optional().describe('Display filename for the recipient (defaults to the original filename)'),
    caption: z.string().optional().describe('Optional caption to send with the document'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    // Copy file to media directory for IPC
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const ext = path.extname(args.file_path) || '';
    const ipcFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const destPath = path.join(MEDIA_DIR, ipcFilename);
    fs.copyFileSync(args.file_path, destPath);

    const displayFilename = args.filename || path.basename(args.file_path);

    const ipcData = {
      type: 'send_document',
      chatJid,
      filePath: `/workspace/ipc/media/${ipcFilename}`,
      filename: displayFilename,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, ipcData);

    return {
      content: [{ type: 'text' as const, text: `Document "${displayFilename}" sent.` }],
    };
  },
);

// --- Network access request tool (only for containers with restricted network) ---

const INPUT_DIR = path.join(IPC_DIR, 'input');
const isNetworkRestricted = process.env.NETWORK_RESTRICTED === 'true';

if (isNetworkRestricted) {
  server.tool(
    'request_network_access',
    `Request network access to a domain that is currently blocked by the restricted network firewall.
Use this when you get a connection error (ETIMEDOUT, ECONNREFUSED, etc.) trying to reach a domain.
The request is sent to the main channel for user approval. If approved, the domain is permanently
allowlisted and iptables rules are updated immediately — you can retry your original operation right after.`,
    {
      domain: z.string().describe('The domain to request access to (e.g., "api.example.com")'),
    },
    async (args) => {
      const requestId = `netaccess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'request_network_access',
        requestId,
        domain: args.domain,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      // Poll for response
      const responseFile = path.join(INPUT_DIR, `proxy-response-${requestId}.json`);
      const timeout = 6 * 60 * 1000; // 6 minutes (exceeds 5 min approval window)
      const pollInterval = 1000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          try {
            const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);

            if (response.status === 'approved') {
              return {
                content: [{ type: 'text' as const, text: `Network access to ${args.domain} approved. You can now retry your request.` }],
              };
            } else if (response.error) {
              return { content: [{ type: 'text' as const, text: response.error }], isError: true };
            } else {
              return { content: [{ type: 'text' as const, text: `Network access to ${args.domain} was denied.` }], isError: true };
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to read response: ${err}` }],
              isError: true,
            };
          }
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Network access request timed out waiting for approval.' }],
        isError: true,
      };
    },
  );
}

// --- Network proxy tools (for containers without full network access) ---

const isNetworkProxied = process.env.NETWORK_PROXY === 'true' || process.env.NETWORK_RESTRICTED === 'true';

if (isNetworkProxied) {
  server.tool(
    'web_fetch',
    `Fetch content from a URL. This request goes through the host and may require user approval.
The user will be notified and asked to approve the request. Approved domains are remembered for future requests.
If denied, you'll get an error message — inform the user accordingly.`,
    {
      url: z.string().url().describe('The URL to fetch'),
      prompt: z.string().optional().describe('What to extract from the page (not used in proxy mode, but kept for compatibility)'),
    },
    async (args) => {
      const requestId = `fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'proxy_web_fetch',
        requestId,
        url: args.url,
        prompt: args.prompt || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      // Poll for response
      const responseFile = path.join(INPUT_DIR, `proxy-response-${requestId}.json`);
      const timeout = 6 * 60 * 1000; // 6 minutes (exceeds 5 min approval window)
      const pollInterval = 1000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          try {
            const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);

            if (response.status === 'approved' && response.result) {
              return { content: [{ type: 'text' as const, text: response.result }] };
            } else if (response.error) {
              return { content: [{ type: 'text' as const, text: response.error }], isError: true };
            } else {
              return { content: [{ type: 'text' as const, text: 'Request was denied.' }], isError: true };
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to read proxy response: ${err}` }],
              isError: true,
            };
          }
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Network proxy request timed out waiting for approval.' }],
        isError: true,
      };
    },
  );

  server.tool(
    'web_search',
    `Search the web. This request goes through the host and requires user approval.
The user will be notified and asked to approve each search.
If denied, you'll get an error message — inform the user accordingly.`,
    {
      query: z.string().describe('The search query'),
    },
    async (args) => {
      const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'proxy_web_search',
        requestId,
        query: args.query,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const responseFile = path.join(INPUT_DIR, `proxy-response-${requestId}.json`);
      const timeout = 6 * 60 * 1000;
      const pollInterval = 1000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          try {
            const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);

            if (response.status === 'approved' && response.result) {
              return { content: [{ type: 'text' as const, text: response.result }] };
            } else if (response.error) {
              return { content: [{ type: 'text' as const, text: response.error }], isError: true };
            } else {
              return { content: [{ type: 'text' as const, text: 'Search request was denied.' }], isError: true };
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to read proxy response: ${err}` }],
              isError: true,
            };
          }
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Web search request timed out waiting for approval.' }],
        isError: true,
      };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
