import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { findChannel } from './router.js';
import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { Channel, RegisteredGroup, SendMessageOpts } from './types.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    opts?: SendMessageOpts,
  ) => Promise<void>;
  sendImage: (jid: string, image: Buffer, caption?: string) => Promise<void>;
  sendDocument: (
    jid: string,
    document: Buffer,
    filename: string,
    caption?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  sendMessageWithId?: (
    jid: string,
    text: string,
  ) => Promise<string | undefined>;
  getMainChatJid?: () => string | undefined;
}

/**
 * Build IpcDeps from channels array and app-level callbacks.
 * Extracts the inline closure construction from index.ts main().
 */
export function createIpcDeps(cfg: {
  channels: Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: IpcDeps['writeGroupsSnapshot'];
}): IpcDeps {
  return {
    sendMessage: (jid, text, opts) => {
      const channel = findChannel(cfg.channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, opts);
    },
    sendImage: (jid, image, caption) => {
      const channel = findChannel(cfg.channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendImage)
        throw new Error(`Channel ${channel.name} does not support images`);
      return channel.sendImage(jid, image, caption);
    },
    sendDocument: (jid, document, filename, caption) => {
      const channel = findChannel(cfg.channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendDocument)
        throw new Error(`Channel ${channel.name} does not support documents`);
      return channel.sendDocument(jid, document, filename, caption);
    },
    registeredGroups: cfg.registeredGroups,
    registerGroup: cfg.registerGroup,
    syncGroupMetadata: (force) =>
      Promise.all(cfg.channels.map((ch) => ch.syncGroupMetadata?.(force))).then(
        () => {},
      ),
    getAvailableGroups: cfg.getAvailableGroups,
    writeGroupsSnapshot: cfg.writeGroupsSnapshot,
    sendMessageWithId: (jid, text) => {
      const channel = findChannel(cfg.channels, jid);
      if (!channel?.sendMessageWithId) return Promise.resolve(undefined);
      return channel.sendMessageWithId(jid, text);
    },
    getMainChatJid: () => {
      const groups = cfg.registeredGroups();
      const mainEntry = Object.entries(groups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      );
      return mainEntry?.[0]; // The JID is the key
    },
  };
}

function getGroupName(
  deps: IpcDeps,
  folder: string,
): string {
  const groups = deps.registeredGroups();
  const entry = Object.values(groups).find((g) => g.folder === folder);
  return entry?.name || folder;
}

/** Check if a source group is authorized to access a target JID. */
function canAccessJid(
  sourceGroup: string,
  targetFolder: string | undefined,
  isMain: boolean,
): boolean {
  return isMain || (!!targetFolder && targetFolder === sourceGroup);
}

/** Resolve a container-relative IPC path to a host path.
 *  Validates the resolved path stays within the group's IPC directory
 *  to prevent path traversal attacks from container agents. */
function resolveIpcPath(
  containerPath: string,
  sourceGroup: string,
): string | null {
  const groupIpcBase = path.resolve(path.join(DATA_DIR, 'ipc', sourceGroup));
  // Strip the container prefix and resolve relative to the group's IPC dir
  const relativePart = containerPath.replace(/^\/workspace\/ipc\//, '');
  const resolved = path.resolve(groupIpcBase, relativePart);
  // Ensure resolved path is within the group's IPC directory
  if (
    !resolved.startsWith(groupIpcBase + path.sep) &&
    resolved !== groupIpcBase
  ) {
    logger.warn(
      { containerPath, sourceGroup, resolved },
      'IPC path traversal blocked',
    );
    return null;
  }
  return resolved;
}

async function handleIpcMessage(
  data: { chatJid: string; text: string; mentions?: string[] },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  const targetGroup = registeredGroups[data.chatJid];
  if (canAccessJid(sourceGroup, targetGroup?.folder, isMain)) {
    const opts = data.mentions?.length
      ? { mentions: data.mentions }
      : undefined;
    await deps.sendMessage(data.chatJid, data.text, opts);
    logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC message attempt blocked',
    );
  }
}

async function handleIpcImage(
  data: { chatJid: string; imagePath: string; caption?: string },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  const targetGroup = registeredGroups[data.chatJid];
  if (!canAccessJid(sourceGroup, targetGroup?.folder, isMain)) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC image attempt blocked',
    );
    return;
  }
  const hostImagePath = resolveIpcPath(data.imagePath, sourceGroup);
  if (!hostImagePath) return;
  if (fs.existsSync(hostImagePath)) {
    const imageBuffer = fs.readFileSync(hostImagePath);
    await deps.sendImage(data.chatJid, imageBuffer, data.caption);
    try {
      fs.unlinkSync(hostImagePath);
    } catch {}
    logger.info(
      { chatJid: data.chatJid, sourceGroup, size: imageBuffer.length },
      'IPC image sent',
    );
  } else {
    logger.warn(
      { chatJid: data.chatJid, imagePath: hostImagePath, sourceGroup },
      'IPC image file not found',
    );
  }
}

async function handleIpcDocument(
  data: {
    chatJid: string;
    filePath: string;
    filename: string;
    caption?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  const targetGroup = registeredGroups[data.chatJid];
  if (!canAccessJid(sourceGroup, targetGroup?.folder, isMain)) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC document attempt blocked',
    );
    return;
  }
  const hostFilePath = resolveIpcPath(data.filePath, sourceGroup);
  if (!hostFilePath) return;
  if (fs.existsSync(hostFilePath)) {
    const fileBuffer = fs.readFileSync(hostFilePath);
    // Sanitize filename to prevent path separators in display name
    const safeFilename = path.basename(data.filename);
    await deps.sendDocument(
      data.chatJid,
      fileBuffer,
      safeFilename,
      data.caption,
    );
    try {
      fs.unlinkSync(hostFilePath);
    } catch {}
    logger.info(
      {
        chatJid: data.chatJid,
        sourceGroup,
        size: fileBuffer.length,
        filename: safeFilename,
      },
      'IPC document sent',
    );
  } else {
    logger.warn(
      { chatJid: data.chatJid, filePath: hostFilePath, sourceGroup },
      'IPC document file not found',
    );
  }
}

let ipcWatcherRunning = false;
const MAX_IPC_FILE_BYTES = 1024 * 1024; // 1 MiB safety cap
const IPC_READ_CHUNK_BYTES = 64 * 1024;

function listIpcJsonFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);
}

export function readIpcJsonFile(filePath: string): unknown {
  const initialStat = fs.lstatSync(filePath);
  if (!initialStat.isFile()) {
    throw new Error('IPC entry is not a regular file');
  }
  if (initialStat.size > MAX_IPC_FILE_BYTES) {
    throw new Error(`IPC file exceeds ${MAX_IPC_FILE_BYTES} bytes`);
  }

  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filePath, openFlags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('IPC entry is not a regular file');
    }
    if (stat.size > MAX_IPC_FILE_BYTES) {
      throw new Error(`IPC file exceeds ${MAX_IPC_FILE_BYTES} bytes`);
    }
    const raw = readUtf8WithLimit(fd, MAX_IPC_FILE_BYTES);
    return JSON.parse(raw);
  } finally {
    fs.closeSync(fd);
  }
}

function readUtf8WithLimit(fd: number, maxBytes: number): string {
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) {
      throw new Error(`IPC file exceeds ${maxBytes} bytes`);
    }

    const toRead = Math.min(IPC_READ_CHUNK_BYTES, remaining);
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = fs.readSync(fd, buf, 0, toRead, null);
    if (bytesRead === 0) break;

    total += bytesRead;
    if (total > maxBytes) {
      throw new Error(`IPC file exceeds ${maxBytes} bytes`);
    }

    chunks.push(bytesRead === toRead ? buf : buf.subarray(0, bytesRead));
  }

  return Buffer.concat(chunks, total).toString('utf-8');
}

function quarantineIpcFile(
  ipcBaseDir: string,
  sourceGroup: string,
  file: string,
  filePath: string,
): void {
  const errorDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(errorDir, { recursive: true });
  const targetPath = path.join(errorDir, `${sourceGroup}-${file}`);
  try {
    fs.renameSync(filePath, targetPath);
  } catch (moveErr) {
    const code = (moveErr as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(
        { file, sourceGroup, filePath, targetPath, err: moveErr },
        'Failed to quarantine IPC file; attempting best-effort delete',
      );
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Remove stale IPC task and proxy-response files left by killed containers.
 * Called once at startup before the IPC watcher begins polling.
 */
function cleanupStaleIpcTasks(ipcBaseDir: string): void {
  try {
    const groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
      try {
        return (
          fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && f !== 'errors'
        );
      } catch {
        return false;
      }
    });

    let tasksCleaned = 0;
    let responsesCleaned = 0;

    for (const group of groupFolders) {
      // Clean stale task files (proxy_web_search, request_network_access, etc.)
      const tasksDir = path.join(ipcBaseDir, group, 'tasks');
      if (fs.existsSync(tasksDir)) {
        for (const file of fs.readdirSync(tasksDir)) {
          if (file.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(tasksDir, file));
              tasksCleaned++;
            } catch {}
          }
        }
      }

      // Clean stale proxy responses that were never consumed
      const inputDir = path.join(ipcBaseDir, group, 'input');
      if (fs.existsSync(inputDir)) {
        for (const file of fs.readdirSync(inputDir)) {
          if (file.startsWith('proxy-response-') && file.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(inputDir, file));
              responsesCleaned++;
            } catch {}
          }
        }
      }
    }

    if (tasksCleaned > 0 || responsesCleaned > 0) {
      logger.info(
        { tasksCleaned, responsesCleaned },
        'Cleaned up stale IPC files from previous service instance',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale IPC files');
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Clean up stale IPC task files from previous service instances.
  // Orphan tasks (from containers killed during restarts) cause duplicate
  // approval requests that confuse users and waste the current container's
  // polling timeout.
  cleanupStaleIpcTasks(ipcBaseDir);

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = listIpcJsonFiles(messagesDir);
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const data = readIpcJsonFile(filePath) as any;
              if (
                data.type === 'message' &&
                data.chatJid &&
                typeof data.text === 'string' &&
                data.text.trim() !== ''
              ) {
                await handleIpcMessage(
                  data,
                  sourceGroup,
                  isMain,
                  deps,
                  registeredGroups,
                );
              } else if (
                data.type === 'send_image' &&
                data.chatJid &&
                data.imagePath
              ) {
                await handleIpcImage(
                  data,
                  sourceGroup,
                  isMain,
                  deps,
                  registeredGroups,
                );
              } else if (
                data.type === 'send_document' &&
                data.chatJid &&
                data.filePath &&
                data.filename
              ) {
                await handleIpcDocument(
                  data,
                  sourceGroup,
                  isMain,
                  deps,
                  registeredGroups,
                );
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              quarantineIpcFile(ipcBaseDir, sourceGroup, file, filePath);
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = listIpcJsonFiles(tasksDir);
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const data = readIpcJsonFile(filePath) as any;
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              quarantineIpcFile(ipcBaseDir, sourceGroup, file, filePath);
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For proxy requests
    requestId?: string;
    url?: string;
    query?: string;
    domain?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'proxy_web_fetch': {
      if (!isMain && data.requestId && data.url) {
        const { handleProxyWebFetch } = await import('./network-proxy.js');
        await handleProxyWebFetch(
          { requestId: data.requestId, url: data.url, prompt: data.prompt },
          sourceGroup,
          {
            sendMessageWithId: deps.sendMessageWithId!,
            getMainChatJid: deps.getMainChatJid!,
            getGroupName: (folder) => getGroupName(deps, folder),
          },
        );
      }
      break;
    }

    case 'proxy_web_search': {
      if (!isMain && data.requestId && data.query) {
        const { handleProxyWebSearch } = await import('./network-proxy.js');
        await handleProxyWebSearch(
          { requestId: data.requestId, query: data.query },
          sourceGroup,
          {
            sendMessageWithId: deps.sendMessageWithId!,
            getMainChatJid: deps.getMainChatJid!,
            getGroupName: (folder) => getGroupName(deps, folder),
          },
        );
      }
      break;
    }

    case 'request_network_access': {
      if (!isMain && data.requestId && data.domain) {
        const { handleNetworkAccessRequest } =
          await import('./network-proxy.js');
        await handleNetworkAccessRequest(
          { requestId: data.requestId, domain: data.domain },
          sourceGroup,
          {
            sendMessageWithId: deps.sendMessageWithId!,
            getMainChatJid: deps.getMainChatJid!,
            getGroupName: (folder) => getGroupName(deps, folder),
          },
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
