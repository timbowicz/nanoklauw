import { ASSISTANT_NAME, MAIN_GROUP_FOLDER } from './config.js';
import type { RegisteredGroup } from './types.js';

/**
 * Convert a group name to a safe folder name (lowercase, hyphenated,
 * collision-resistant).  "Family Chat 🏠" → "family-chat"
 */
export function slugifyGroupName(
  name: string,
  existingGroups: Record<string, RegisteredGroup>,
): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!slug || !/^[a-z0-9]/.test(slug)) slug = 'group-' + slug;
  const existingFolders = new Set(
    Object.values(existingGroups).map((g) => g.folder),
  );
  let candidate = slug;
  let i = 2;
  while (existingFolders.has(candidate) || candidate === MAIN_GROUP_FOLDER) {
    candidate = `${slug}-${i++}`;
  }
  return candidate;
}

/**
 * If `chatJid` is an unregistered group, register it automatically with
 * `requiresTrigger: false` so the agent sees every message and can decide
 * for itself whether a response is warranted (always responds to @mentions).
 */
export function maybeAutoRegister(
  chatJid: string,
  name: string | undefined,
  isGroup: boolean | undefined,
  registeredGroups: Record<string, RegisteredGroup>,
  registerGroup: (jid: string, group: RegisteredGroup) => void,
): void {
  if (!isGroup || registeredGroups[chatJid]) return;
  const folderName = slugifyGroupName(name || chatJid, registeredGroups);
  registerGroup(chatJid, {
    name: name || chatJid,
    folder: folderName,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  });
}
