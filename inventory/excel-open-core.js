(function initExcelOpenCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TekStockExcelOpen = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createExcelOpenCore() {
  "use strict";

  async function openWorkbook(excelApi, createPayload) {
    if (!excelApi) throw new Error("Excel bridge is unavailable");

    const info = await excelApi.info();
    if (!info?.exists) {
      const created = await excelApi.ensure(createPayload);
      if (!created?.ok) {
        throw new Error(created?.error || "Excel file creation failed");
      }
    }

    const opened = await excelApi.open();
    if (!opened?.ok) throw new Error(opened?.error || "Excel open failed");
    return opened;
  }

  return { openWorkbook };
}));
