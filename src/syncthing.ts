import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const SYNCTHING_API_URL = 'http://localhost:8384';
const MACBOOK_DEVICE_ID =
  'KODMOZS-LTPOFBM-HSPM4QH-F4WBJG5-UTKNUSH-IVM4YNK-2YHHJK3-LLBQJQT';
const SERVER_DEVICE_ID =
  'SRHFCDF-H243S2S-J7BWOOV-OG33VLB-4KRPGM6-SQT5CIA-OC7LDGZ-EFRSKQL';

const STIGNORE_CONTENT = `// Niet syncen
logs/
.mcp.json
*.tmp
*.swp
*~
.DS_Store
Thumbs.db
`;

function getApiKey(): string | undefined {
  const env = readEnvFile(['SYNCTHING_API_KEY']);
  return process.env.SYNCTHING_API_KEY || env.SYNCTHING_API_KEY;
}

/** POST/GET to Syncthing REST API using Node http (avoids fetch compat issues). */
function syncthingRequest(
  method: string,
  apiPath: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, SYNCTHING_API_URL);
    const postData = body ? JSON.stringify(body) : undefined;

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          'X-API-Key': apiKey,
          ...(postData
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
              }
            : {}),
        },
        timeout: 5000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        res.on('end', () => {
          let data: unknown = raw;
          try {
            data = JSON.parse(raw);
          } catch {
            // not JSON — keep as string
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Syncthing API request timed out'));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Add a group folder to Syncthing for automatic sync to the MacBook.
 * No-ops if SYNCTHING_API_KEY is not set or folder already exists.
 * Never throws — sync failure must not block group registration.
 */
export async function addSyncthingFolder(
  folder: string,
  label: string,
): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.debug('SYNCTHING_API_KEY not set, skipping Syncthing sync');
    return;
  }

  const folderId = `nanoklauw-${folder}`;
  const folderPath = path.join(GROUPS_DIR, folder);

  try {
    // Check if folder already exists in Syncthing
    const { data: folders } = await syncthingRequest(
      'GET',
      '/rest/config/folders',
      apiKey,
    );
    if (
      Array.isArray(folders) &&
      folders.some((f: { id: string }) => f.id === folderId)
    ) {
      logger.debug({ folderId }, 'Syncthing folder already exists');
      return;
    }

    // Set ACL so syncthing user can access the folder
    try {
      execFileSync('setfacl', ['-m', 'u:syncthing:rwx', folderPath]);
    } catch (err) {
      logger.warn({ folder, err }, 'Failed to set ACL for syncthing');
      // Continue — Syncthing may still work if permissions allow
    }

    // Write .stignore
    const stignorePath = path.join(folderPath, '.stignore');
    if (!fs.existsSync(stignorePath)) {
      fs.writeFileSync(stignorePath, STIGNORE_CONTENT);
    }

    // Create .stfolder marker
    const stfolderPath = path.join(folderPath, '.stfolder');
    fs.mkdirSync(stfolderPath, { recursive: true });

    // Add folder to Syncthing config
    const folderConfig = {
      id: folderId,
      label: `NanoClaw - ${label}`,
      filesystemType: 'basic',
      path: folderPath,
      type: 'sendreceive',
      devices: [
        {
          deviceID: MACBOOK_DEVICE_ID,
          introducedBy: '',
          encryptionPassword: '',
        },
        {
          deviceID: SERVER_DEVICE_ID,
          introducedBy: '',
          encryptionPassword: '',
        },
      ],
      rescanIntervalS: 60,
      fsWatcherEnabled: true,
      fsWatcherDelayS: 5,
      ignorePerms: true,
      autoNormalize: true,
      minDiskFree: { value: 1, unit: '%' },
      versioning: {
        type: '',
        params: {},
        cleanupIntervalS: 3600,
        fsPath: '',
        fsType: 'basic',
      },
      order: 'random',
      maxConflicts: 10,
      paused: false,
      markerName: '.stfolder',
      maxConcurrentWrites: 2,
    };

    const { status } = await syncthingRequest(
      'POST',
      '/rest/config/folders',
      apiKey,
      folderConfig,
    );

    if (status >= 200 && status < 300) {
      logger.info({ folderId, label }, 'Syncthing folder added');
    } else {
      logger.warn(
        { folderId, status },
        'Syncthing folder add returned non-2xx',
      );
    }
  } catch (err) {
    logger.warn({ folder, err }, 'Failed to add Syncthing folder');
  }
}
