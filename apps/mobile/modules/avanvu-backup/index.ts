import { requireOptionalNativeModule } from 'expo-modules-core';

interface AvanvuBackupNative {
  excludeFromBackup(path: string): boolean;
}

const native = requireOptionalNativeModule<AvanvuBackupNative>('AvanvuBackup');

/**
 * Exclude a path from iCloud and device backups. Returns false when the native module is missing (for example
 * in a build made before the module was added) so callers can record the miss without crashing.
 */
export function excludeFromBackup(path: string): boolean {
  try {
    return native?.excludeFromBackup(path.replace(/^file:\/\//, '')) ?? false;
  } catch {
    return false;
  }
}
