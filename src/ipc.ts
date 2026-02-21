import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { findChannel } from './channel-manager.js';
import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';
import { Channel, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendImage: (jid: string, image: Buffer, caption?: string) => Promise<void>;
  sendDocument: (jid: string, document: Buffer, filename: string, caption?: string) => Promise<void>;
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
}

/**
 * Build IpcDeps from channels array and app-level callbacks.
 * Extracts the inline closure construction from index.ts main().
 */
export function createIpcDeps(opts: {
  channels: Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: IpcDeps['writeGroupsSnapshot'];
}): IpcDeps {
  return {
    sendMessage: (jid, text) => {
      const channel = findChannel(opts.channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendImage: (jid, image, caption) => {
      const channel = findChannel(opts.channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendImage)
        throw new Error(
          `Channel ${channel.name} does not support images`,
        );
      return channel.sendImage(jid, image, caption);
    },
    sendDocument: (jid, document, filename, caption) => {
      const channel = findChannel(opts.channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendDocument)
        throw new Error(
          `Channel ${channel.name} does not support documents`,
        );
      return channel.sendDocument(jid, document, filename, caption);
    },
    registeredGroups: opts.registeredGroups,
    registerGroup: opts.registerGroup,
    syncGroupMetadata: (force) =>
      Promise.all(
        opts.channels.map((ch) => ch.syncGroupMetadata?.(force)),
      ).then(() => {}),
    getAvailableGroups: opts.getAvailableGroups,
    writeGroupsSnapshot: opts.writeGroupsSnapshot,
  };
}

/** Check if a source group is authorized to access a target JID. */
function canAccessJid(
  sourceGroup: string,
  targetFolder: string | undefined,
  isMain: boolean,
): boolean {
  return isMain || (!!targetFolder && targetFolder === sourceGroup);
}

/** Resolve a container-relative IPC path to a host path. */
function resolveIpcPath(containerPath: string, sourceGroup: string): string {
  return containerPath.replace(
    '/workspace/ipc/',
    path.join(DATA_DIR, 'ipc', sourceGroup) + '/',
  );
}

async function handleIpcMessage(
  data: { chatJid: string; text: string },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  const targetGroup = registeredGroups[data.chatJid];
  if (canAccessJid(sourceGroup, targetGroup?.folder, isMain)) {
    await deps.sendMessage(data.chatJid, data.text);
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
  if (fs.existsSync(hostFilePath)) {
    const fileBuffer = fs.readFileSync(hostFilePath);
    await deps.sendDocument(
      data.chatJid,
      fileBuffer,
      data.filename,
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
        filename: data.filename,
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

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

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
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                await handleIpcMessage(data, sourceGroup, isMain, deps, registeredGroups);
              } else if (data.type === 'send_image' && data.chatJid && data.imagePath) {
                await handleIpcImage(data, sourceGroup, isMain, deps, registeredGroups);
              } else if (data.type === 'send_document' && data.chatJid && data.filePath && data.filename) {
                await handleIpcDocument(data, sourceGroup, isMain, deps, registeredGroups);
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
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
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
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

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
