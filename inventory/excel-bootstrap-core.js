(function initExcelBootstrapCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TekStockExcelBootstrap = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createExcelBootstrapCore() {
  "use strict";

  function bootstrapMessage(state) {
    if (state === "bootstrapped") return "本机 Excel 已从云端建立。";
    if (state === "offline-not-initialized") return "首次建立本机 Excel 需要连接云端；旧 Excel 已保留未改动。";
    if (state === "invalid-private-workbook") return "本机 Excel 无法验证，未覆盖原文件。";
    return "Excel 初始化失败";
  }

  async function openAfterBootstrap(excelApi, openWorkbook) {
    const bootstrap = await excelApi.bootstrap();
    if (!bootstrap?.ok) {
      return { ok: false, bootstrap, message: bootstrapMessage(bootstrap?.state) };
    }
    const opened = await openWorkbook();
    return {
      ok: opened?.ok === true,
      opened,
      bootstrap,
      message: bootstrap.state === "bootstrapped" ? bootstrapMessage(bootstrap.state) : "",
    };
  }

  return { bootstrapMessage, openAfterBootstrap };
}));
