"use strict";

function createPrivateWorkbookBootstrap(options = {}) {
  const {
    ensurePrivateWorkbook,
    workbookLocation,
    centralSyncService,
    writeWorkbook,
    readWorkbook,
    watchWorkbook = () => {},
    now = () => new Date(),
  } = options;
  if (typeof ensurePrivateWorkbook !== "function"
      || typeof workbookLocation !== "function"
      || typeof centralSyncService !== "function"
      || typeof writeWorkbook !== "function"
      || typeof readWorkbook !== "function") {
    throw new TypeError("PRIVATE_WORKBOOK_MAIN_OPTIONS_INVALID");
  }
  return async function bootstrapPrivateWorkbook() {
    const result = await ensurePrivateWorkbook({
      location: workbookLocation(),
      fetchSnapshot: () => centralSyncService().snapshot(false),
      writeWorkbook,
      readWorkbook,
      now,
    });
    if (result.ok) watchWorkbook();
    return result;
  };
}

function registerPrivateWorkbookBootstrapIpc(ipc, bootstrapPrivateWorkbook) {
  if (typeof ipc?.handle !== "function" || typeof bootstrapPrivateWorkbook !== "function") {
    throw new TypeError("PRIVATE_WORKBOOK_IPC_OPTIONS_INVALID");
  }
  const handler = async () => {
    const result = await bootstrapPrivateWorkbook();
    return { ...result, created: result.state === "bootstrapped" };
  };
  ipc.handle("tek-stock-excel-bootstrap", handler);
  ipc.handle("tek-stock-excel-ensure", handler);
}

module.exports = { createPrivateWorkbookBootstrap, registerPrivateWorkbookBootstrapIpc };
