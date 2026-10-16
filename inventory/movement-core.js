"use strict";

// Structured stock movements stored as plain lines inside the existing
// arrival / outbound / showroom text fields, so Excel, the cloud schema and
// older app versions keep working without a migration.
//   outbound, delivered: "BELLA HOME PO 25360 ( 4 PCS ) DD: 30-10-26"  (counted as sold by recordQuantity)
//   outbound, booked:    "[已订] BELLA HOME PO 25360 ×4 DD: 30-10-26"  (not counted as sold)
//   arrival, received:   "4 PCS ( 16-10-26 ) PI 7226"
//   arrival, in transit: "[在路上] PI 7226 ×4 ETA: 5-11-26"
//   showroom:            "BELLA HOME C/S ( 1 PCS ) ON 16-10-26"
(function initMovementCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.TekStockMovement = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const BOOKED_TAG = "[已订]";
  const TRANSIT_TAG = "[在路上]";
  const MAX_QTY = 9999;
  const DATE = "(\\d{1,2}-\\d{1,2}-\\d{2,4})";

  const patterns = {
    booked: new RegExp(`^\\[已订\\]\\s*(.+?)\\s+PO\\s+(\\S+)\\s+×(\\d+)\\s+DD:\\s*${DATE}\\s*$`),
    delivered: new RegExp(`^(.+?)\\s+PO\\s+(\\S+)\\s+\\(\\s*(\\d+)\\s*PCS?\\s*\\)\\s+DD:\\s*${DATE}\\s*$`, "i"),
    transit: new RegExp(`^\\[在路上\\]\\s*(.*?)\\s*×(\\d+)\\s+ETA:\\s*${DATE}\\s*$`),
    received: new RegExp(`^(\\d+)\\s*PCS?\\s*\\(\\s*${DATE}\\s*\\)\\s*(.*)$`, "i"),
    showroom: new RegExp(`^(.+?)\\s+C/S\\s+\\(\\s*(\\d+)\\s*PCS?\\s*\\)\\s+ON\\s+${DATE}\\s*$`, "i"),
  };

  function movementError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function lines(text) {
    return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  function parseDayMonthYear(text) {
    const match = /^(\d{1,2})-(\d{1,2})-(\d{2,4})$/.exec(String(text || "").trim());
    if (!match) return "";
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
    return date.toISOString().slice(0, 10);
  }

  function formatDate(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!match || !parseDayMonthYear(`${match[3]}-${match[2]}-${match[1]}`)) {
      throw movementError("INVALID_DATE", "请选择正确的日期");
    }
    return `${Number(match[3])}-${Number(match[2])}-${match[1].slice(2)}`;
  }

  function cleanText(value, { upper = false, required = false, label = "" } = {}) {
    let text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/[[\]()×]/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 60);
    if (upper) text = text.toUpperCase();
    if (required && !text) throw movementError("MISSING_FIELD", `请填写${label}`);
    return text;
  }

  function cleanPo(value) {
    const text = cleanText(value).replace(/\s+/g, "");
    if (!text) throw movementError("MISSING_FIELD", "请填写 PO 号");
    return text;
  }

  function cleanQty(value) {
    const qty = Number(value);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw movementError("INVALID_QTY", "数量要填 1 到 9999 的整数");
    }
    return qty;
  }

  function parseLine(field, line) {
    let match;
    if (field === "outbound" && (match = patterns.booked.exec(line))) {
      return { kind: "booked", who: match[1], po: match[2], qty: Number(match[3]), dateText: match[4] };
    }
    if (field === "outbound" && (match = patterns.delivered.exec(line))) {
      return { kind: "delivered", who: match[1], po: match[2], qty: Number(match[3]), dateText: match[4] };
    }
    if (field === "arrival" && (match = patterns.transit.exec(line))) {
      return { kind: "transit", ref: match[1], qty: Number(match[2]), dateText: match[3] };
    }
    if (field === "arrival" && (match = patterns.received.exec(line))) {
      return { kind: "received", qty: Number(match[1]), dateText: match[2], ref: match[3].trim() };
    }
    if (field === "showroom" && (match = patterns.showroom.exec(line))) {
      return { kind: "showroom", who: match[1], qty: Number(match[2]), dateText: match[3] };
    }
    return null;
  }

  function parseItem(item) {
    const entries = [];
    const legacy = [];
    for (const field of ["outbound", "arrival", "showroom"]) {
      for (const line of lines(item?.[field])) {
        const parsed = parseLine(field, line);
        if (!parsed) {
          legacy.push({ field, line });
          continue;
        }
        const date = parseDayMonthYear(parsed.dateText);
        if (!date || !parsed.qty) {
          legacy.push({ field, line });
          continue;
        }
        entries.push({ ...parsed, field, line, date });
      }
    }
    return { entries, legacy };
  }

  function stockOf(item) {
    return Number(item?.stock) || 0;
  }

  function summarize(item) {
    const { entries } = parseItem(item);
    const sum = (kind) => entries.filter((entry) => entry.kind === kind).reduce((total, entry) => total + entry.qty, 0);
    const warehouse = stockOf(item);
    const booked = sum("booked");
    return { warehouse, booked, available: warehouse - booked, transit: sum("transit"), showroom: sum("showroom") };
  }

  function appendLine(text, line) {
    const existing = String(text || "").replace(/\s+$/, "");
    return existing ? `${existing}\n${line}` : line;
  }

  function replaceLine(text, oldLine, newLine) {
    const all = String(text || "").split(/\r?\n/);
    const index = all.findIndex((line) => line.trim() === oldLine);
    if (index < 0) throw movementError("LINE_NOT_FOUND", "这条记录已被别人修改，请按 Update 刷新后再试");
    if (newLine) all[index] = newLine;
    else all.splice(index, 1);
    return all.join("\n").trim();
  }

  function findEntry(item, field, line, kind) {
    const entry = parseItem(item).entries.find((candidate) => candidate.field === field && candidate.line === line);
    if (!entry || entry.kind !== kind) {
      throw movementError("LINE_NOT_FOUND", "这条记录已被别人修改，请按 Update 刷新后再试");
    }
    return entry;
  }

  function requireStock(item, qty) {
    const stock = stockOf(item);
    if (qty > stock) throw movementError("NOT_ENOUGH_STOCK", `仓库只有 ${stock} 件，不够 ${qty} 件`);
  }

  // Returns the field patch for one action. The caller persists it through the
  // normal local-edit → Excel → cloud path.
  function applyMovement(item, action) {
    const type = action?.type;
    const stock = stockOf(item);
    if (type === "sale") {
      const qty = cleanQty(action.qty);
      const who = cleanText(action.who, { upper: true, required: true, label: "客户" });
      const po = cleanPo(action.po);
      const date = formatDate(action.date);
      if (action.delivered) {
        requireStock(item, qty);
        return { stock: stock - qty, outbound: appendLine(item.outbound, `${who} PO ${po} ( ${qty} PCS ) DD: ${date}`) };
      }
      return { outbound: appendLine(item.outbound, `${BOOKED_TAG} ${who} PO ${po} ×${qty} DD: ${date}`) };
    }
    if (type === "deliver") {
      const entry = findEntry(item, "outbound", action.line, "booked");
      requireStock(item, entry.qty);
      return {
        stock: stock - entry.qty,
        outbound: replaceLine(item.outbound, entry.line, `${entry.who} PO ${entry.po} ( ${entry.qty} PCS ) DD: ${formatDate(action.date)}`),
      };
    }
    if (type === "cancelBooking") {
      const entry = findEntry(item, "outbound", action.line, "booked");
      return { outbound: replaceLine(item.outbound, entry.line, "") };
    }
    if (type === "arrive") {
      const qty = cleanQty(action.qty);
      const ref = cleanText(action.ref, { upper: true });
      const line = `${qty} PCS ( ${formatDate(action.date)} )${ref ? ` ${ref}` : ""}`;
      return { stock: stock + qty, arrival: appendLine(item.arrival, line) };
    }
    if (type === "transit") {
      const qty = cleanQty(action.qty);
      const ref = cleanText(action.ref, { upper: true });
      return { arrival: appendLine(item.arrival, `${TRANSIT_TAG}${ref ? ` ${ref}` : ""} ×${qty} ETA: ${formatDate(action.date)}`) };
    }
    if (type === "receive") {
      const entry = findEntry(item, "arrival", action.line, "transit");
      const line = `${entry.qty} PCS ( ${formatDate(action.date)} )${entry.ref ? ` ${entry.ref}` : ""}`;
      return { stock: stock + entry.qty, arrival: replaceLine(item.arrival, entry.line, line) };
    }
    if (type === "cancelTransit") {
      const entry = findEntry(item, "arrival", action.line, "transit");
      return { arrival: replaceLine(item.arrival, entry.line, "") };
    }
    if (type === "showroom") {
      const qty = cleanQty(action.qty);
      const who = cleanText(action.who, { upper: true, required: true, label: "展厅 / 客户" });
      requireStock(item, qty);
      return { stock: stock - qty, showroom: appendLine(item.showroom, `${who} C/S ( ${qty} PCS ) ON ${formatDate(action.date)}`) };
    }
    if (type === "showroomReturn") {
      const entry = findEntry(item, "showroom", action.line, "showroom");
      return { stock: stock + entry.qty, showroom: replaceLine(item.showroom, entry.line, "") };
    }
    throw movementError("UNKNOWN_ACTION", "未知操作");
  }

  function daysUntil(iso, todayIso) {
    return Math.round((Date.parse(iso) - Date.parse(todayIso)) / 86400000);
  }

  function collect(items, kinds) {
    const wanted = new Set(kinds);
    return (items || []).flatMap((item) => parseItem(item).entries
      .filter((entry) => wanted.has(entry.kind))
      .map((entry) => ({ ...entry, item })));
  }

  function overview(items, todayIso) {
    const summaries = (items || []).map(summarize);
    return {
      available: summaries.reduce((total, summary) => total + Math.max(0, summary.available), 0),
      dueSoon: collect(items, ["booked"]).filter((entry) => daysUntil(entry.date, todayIso) <= 7).length,
      transit: summaries.reduce((total, summary) => total + summary.transit, 0),
      oversold: summaries.filter((summary) => summary.available < 0).length,
    };
  }

  return {
    BOOKED_TAG,
    TRANSIT_TAG,
    parseDayMonthYear,
    formatDate,
    parseItem,
    summarize,
    applyMovement,
    collect,
    overview,
    daysUntil,
  };
});
