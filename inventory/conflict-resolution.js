(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TekStockConflictResolution = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TEXT_FIELDS = new Set([
    "model", "category", "specification", "arrival", "showroom", "outbound",
  ]);
  const NUMBER_FIELDS = new Set([
    "stock", "showroomQuantity", "computedTotalSold", "totalSold", "cost", "sellingPrice",
  ]);
  const DELETE_FIELD = "_deleteProduct";
  const PHOTO_FIELD = "image";
  const ALLOWED_FIELDS = new Set([...TEXT_FIELDS, ...NUMBER_FIELDS, DELETE_FIELD, PHOTO_FIELD]);
  const ALLOWED_CHOICES = new Set(["keep-excel", "keep-cloud"]);

  function conflictError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function safeField(value) {
    const field = String(value || "").trim();
    if (!ALLOWED_FIELDS.has(field)) throw conflictError("CONFLICT_FIELD_INVALID");
    return field;
  }

  function displayValue(value) {
    if (value == null) return "";
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw conflictError("CONFLICT_VALUE_INVALID");
    }
    return String(value);
  }

  function formatConflict(conflict) {
    if (!conflict || typeof conflict !== "object" || Array.isArray(conflict)) {
      throw conflictError("CONFLICT_INVALID");
    }
    const itemId = String(conflict.itemId || "").trim();
    if (!itemId) throw conflictError("CONFLICT_ITEM_INVALID");
    const formatted = {
      itemId,
      field: safeField(conflict.field),
      base: displayValue(conflict.base),
      excel: displayValue(conflict.excel),
      cloud: displayValue(conflict.cloud),
    };
    if (formatted.field === PHOTO_FIELD) {
      for (const value of [formatted.base, formatted.excel, formatted.cloud]) {
        if (!/^(?:|[a-f0-9]{64})$/i.test(value)) {
          throw conflictError("CONFLICT_VALUE_INVALID");
        }
      }
    }
    const model = String(conflict.model || "").trim();
    if (model) formatted.model = model;
    return formatted;
  }

  function buildResolutionPatch(conflict, choice) {
    if (!ALLOWED_CHOICES.has(choice)) throw conflictError("CONFLICT_CHOICE_INVALID");
    const field = safeField(conflict?.field);
    if (choice === "keep-cloud") return {};
    if (field === DELETE_FIELD) return { _deleteProduct: true };
    if (field === PHOTO_FIELD) {
      const digest = String(conflict?.excel || "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(digest)) throw conflictError("CONFLICT_VALUE_INVALID");
      return { imageSha256: digest };
    }
    if (NUMBER_FIELDS.has(field)) {
      const value = Number(conflict?.excel);
      if (!Number.isFinite(value)) throw conflictError("CONFLICT_VALUE_INVALID");
      return { [field]: value };
    }
    return { [field]: String(conflict?.excel ?? "") };
  }

  async function collectConflictResolutions(conflicts, choose) {
    if (!Array.isArray(conflicts) || typeof choose !== "function") {
      throw conflictError("CONFLICT_INVALID");
    }
    const resolutions = [];
    for (let index = 0; index < conflicts.length; index += 1) {
      const conflict = conflicts[index];
      const itemId = String(conflict?.itemId || "").trim();
      const field = safeField(conflict?.field);
      if (!itemId) throw conflictError("CONFLICT_ITEM_INVALID");
      const choice = await choose(conflict, index);
      if (choice == null || choice === "") return null;
      if (!ALLOWED_CHOICES.has(choice)) throw conflictError("CONFLICT_CHOICE_INVALID");
      resolutions.push({ itemId, field, choice });
    }
    return resolutions;
  }

  async function handleBackgroundSyncConflict(resolveConflicts) {
    if (typeof resolveConflicts !== "function") throw conflictError("CONFLICT_HANDLER_INVALID");
    return resolveConflicts();
  }

  return {
    ALLOWED_CHOICES,
    ALLOWED_FIELDS,
    DELETE_FIELD,
    PHOTO_FIELD,
    buildResolutionPatch,
    collectConflictResolutions,
    formatConflict,
    handleBackgroundSyncConflict,
  };
});
