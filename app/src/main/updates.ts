// Auto-update seam. Only active in a packaged, signed build with a configured feed
// (electron-builder "publish"); dev builds and unsigned builds skip it.

import { app } from "electron";

export async function setupUpdates(log: (...a: unknown[]) => void): Promise<void> {
  if (!app.isPackaged || process.env.BLACKHOLE_DEV_NO_UPDATE) return;
  try {
    const { autoUpdater } = (await import("electron-updater")).default ?? (await import("electron-updater"));
    autoUpdater.autoDownload = true;
    autoUpdater.on("error", (e: Error) => log(`update: ${e.message}`));
    autoUpdater.on("update-downloaded", (i: { version: string }) => log(`update ${i.version} downloaded; installs on quit`));
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    log(`update check skipped: ${(e as Error).message}`);
  }
}
