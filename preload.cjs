const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("TekStockExcel", {
  info: () => ipcRenderer.invoke("tek-stock-excel-info"),
  ensure: () => ipcRenderer.invoke("tek-stock-excel-ensure"),
  bootstrap: () => ipcRenderer.invoke("tek-stock-excel-bootstrap"),
  write: (items) => ipcRenderer.invoke("tek-stock-excel-write", items),
  acknowledge: (payload) => ipcRenderer.invoke("tek-stock-excel-ack", payload),
  read: () => ipcRenderer.invoke("tek-stock-excel-read"),
  prepareUpdate: () => ipcRenderer.invoke("tek-stock-excel-prepare-update"),
  resetLocalFromCloud: (confirmation) =>
    ipcRenderer.invoke("tek-stock-excel-reset-local", { confirmation }),
  open: async () => {
    const bootstrap = await ipcRenderer.invoke("tek-stock-excel-bootstrap");
    if (!bootstrap?.ok) return bootstrap;
    const opened = await ipcRenderer.invoke("tek-stock-excel-open");
    return { ...opened, bootstrapState: bootstrap.state };
  },
  onChanged: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("tek-stock-excel-changed", listener);
    return () => ipcRenderer.removeListener("tek-stock-excel-changed", listener);
  },
});

contextBridge.exposeInMainWorld("TekStockRuntime", {
  getSecrets: () => ipcRenderer.invoke("tek-stock-runtime-secrets"),
  saveUploadToken: (token) => ipcRenderer.invoke("tek-stock-runtime-save-upload-token", token),
  clearUploadToken: () => ipcRenderer.invoke("tek-stock-runtime-clear-upload-token"),
});

contextBridge.exposeInMainWorld("TekStockCloud", {
  snapshot: () => ipcRenderer.invoke("tek-stock-cloud-snapshot"),
  // Keep renderer code out of Electron's raw "Error invoking remote method"
  // failure surface.  A handler normally returns a bounded result, but an
  // unexpected main-process/IPC failure must still cross the bridge as a
  // cloneable diagnostic result so Update can render the real stage/code.
  syncWorkbook: async () => {
    try {
      return await ipcRenderer.invoke("tek-stock-cloud-sync-workbook");
    } catch (error) {
      const detail = String(error?.code || error?.message || error || "WORKBOOK_SYNC_FAILED")
        .replace(/Error invoking remote method[^:]*:\s*/i, "")
        .slice(0, 240);
      return {
        ok: false,
        workbookAcknowledged: false,
        errorCode: "WORKBOOK_SYNC_IPC_FAILED",
        detail,
        message: "Excel 云端同步暂时失败，请保存 Excel 后按 Update 重试。",
      };
    }
  },
  identityMigrationPlan: () => ipcRenderer.invoke("tek-stock-cloud-identity-migration-plan"),
  applyIdentityMigration: (manifest) =>
    ipcRenderer.invoke("tek-stock-cloud-identity-migration-apply", manifest),
  mutate: (operations) => ipcRenderer.invoke("tek-stock-cloud-mutate", operations),
  listSyncConflicts: () => ipcRenderer.invoke("tek-stock-cloud-list-conflicts"),
  resolveSyncConflict: (payload) => ipcRenderer.invoke("tek-stock-cloud-resolve-conflict", payload),
  replacePhoto: (itemId, dataUrl, identity = {}) =>
    ipcRenderer.invoke("tek-stock-cloud-replace-photo", {
      itemId,
      dataUrl,
      imageSha256: String(identity?.imageSha256 || ""),
      imageVersion: String(identity?.imageVersion || ""),
    }),
  status: () => ipcRenderer.invoke("tek-stock-cloud-status"),
  onSynced: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("tek-stock-cloud-synced", listener);
    return () => ipcRenderer.removeListener("tek-stock-cloud-synced", listener);
  },
  onSyncFailed: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("tek-stock-cloud-sync-failed", listener);
    return () => ipcRenderer.removeListener("tek-stock-cloud-sync-failed", listener);
  },
});

contextBridge.exposeInMainWorld("TekStockDiagnostics", {
  append: (entry) => ipcRenderer.invoke("tek-stock-diagnostics-append", entry),
  getPath: () => ipcRenderer.invoke("tek-stock-diagnostics-get-path"),
  export: () => ipcRenderer.invoke("tek-stock-diagnostics-export"),
  openFolder: () => ipcRenderer.invoke("tek-stock-diagnostics-open-folder"),
});

contextBridge.exposeInMainWorld("TekStockUpdater", {
  check: () => ipcRenderer.invoke("tek-stock-updater-status"),
  receipt: () => ipcRenderer.invoke("tek-stock-updater-receipt"),
  update: () => ipcRenderer.invoke("tek-stock-updater-update"),
  reinstall: () => ipcRenderer.invoke("tek-stock-updater-reinstall"),
});
