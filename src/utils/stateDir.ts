/**
 * Durable State Directory Helper
 *
 * Centralizes where persistent state files live so every state module
 * writes to the same durable location.
 *
 * On Railway, a volume is mounted at RAILWAY_VOLUME_MOUNT_PATH (e.g. /data).
 * Writing anywhere else lands on the container's ephemeral filesystem and is
 * lost on every redeploy/restart. This helper prefers that mounted volume and
 * falls back to ./data for local/dev compatibility.
 *
 * It also supports one-time migration: if a legacy state file exists outside
 * the durable directory, it is copied in once (never overwriting an existing
 * durable file, never deleting the legacy file).
 */

import { existsSync, mkdirSync, copyFileSync } from 'fs';
import * as path from 'path';

/**
 * The durable state directory.
 * Prefers the Railway mounted volume; falls back to ./data for local/dev.
 */
export function getStateDir(): string {
  const volume = process.env['RAILWAY_VOLUME_MOUNT_PATH'];
  return volume && volume.trim().length > 0 ? volume : './data';
}

/**
 * Build a path to a state file inside the durable state directory.
 */
export function getStatePath(filename: string): string {
  return path.join(getStateDir(), filename);
}

/**
 * Ensure the durable state directory exists before writes.
 */
export function ensureStateDir(): void {
  const dir = getStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[StateDir] Created state directory: ${dir}`);
  }
}

/**
 * Resolve the durable path for a state file, performing a one-time migration
 * from a legacy location if needed.
 *
 * Behavior:
 * - Ensures the durable directory exists.
 * - If the durable file already exists, returns it untouched (never overwrites).
 * - Otherwise, copies the first existing legacy file into the durable path.
 * - Never deletes legacy files.
 * - Skips any legacy path that resolves to the durable path (local/dev no-op).
 *
 * @param filename    Bare filename to store in the durable directory.
 * @param legacyPaths Ordered list of legacy paths to migrate from.
 * @returns The resolved durable file path.
 */
export function migrateLegacyStateFile(filename: string, legacyPaths: string[] = []): string {
  ensureStateDir();
  const target = getStatePath(filename);

  if (existsSync(target)) {
    return target;
  }

  for (const legacy of legacyPaths) {
    // Skip when the legacy path is the durable path (local/dev case)
    if (path.resolve(legacy) === path.resolve(target)) {
      continue;
    }
    if (existsSync(legacy)) {
      try {
        copyFileSync(legacy, target);
        console.log(`[StateDir] Migrated legacy state ${legacy} -> ${target}`);
      } catch (error) {
        console.error(`[StateDir] Failed to migrate ${legacy} -> ${target}:`, error);
      }
      break;
    }
  }

  return target;
}
