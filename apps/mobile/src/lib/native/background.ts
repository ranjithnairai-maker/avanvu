/**
 * Opportunistic background sync of offline content (SPEC §6.6). iOS does not guarantee background execution, so
 * this is only a helper: the foreground sync and the T-48 h and T-24 h push nudges are the reliable paths.
 * The task must be defined at module scope, so this file is imported from the root layout.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { syncOfflineContent } from './sessionFiles';

export const OFFLINE_SYNC_TASK = 'avanvu-offline-sync';

TaskManager.defineTask(OFFLINE_SYNC_TASK, async () => {
  try {
    await syncOfflineContent();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  try {
    await BackgroundTask.registerTaskAsync(OFFLINE_SYNC_TASK, { minimumInterval: 60 * 12 });
  } catch {
    /* unavailable (for example in a simulator or when background refresh is off): foreground sync still works */
  }
}
