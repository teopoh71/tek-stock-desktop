"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const OUTBOX_VERSION = 2;
const RETRYABLE_STATES = new Set(["pending", "sent"]);
const ROW_MUTATION_TYPES = new Set(["assign-id", "create", "update", "delete", "image"]);
const MUTATION_TYPES = new Set([...ROW_MUTATION_TYPES, "workbook"]);
const ENTRY_STATES = new Set(["pending", "sent", "acked", "conflict"]);

function outboxError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function requestHash(mutation) {
  const { operator, occurredAt, ...request } = mutation || {};
  return crypto.createHash("sha256")
    .update(JSON.stringify(stableValue(request)))
    .digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function historyMutation(entry) {
  if (entry.type === "workbook") {
    return Object.fromEntries(Object.entries({
      baseRevision: entry.baseRevision,
      baseItems: entry.baseItems,
      operations: entry.operations,
      requestBody: entry.requestBody,
      workbookSha256: entry.workbookSha256,
      explicitResolution: entry.explicitResolution,
      resolutionOfOpId: entry.resolutionOfOpId,
    }).filter(([, value]) => value !== undefined && value !== ""));
  }
  let after;
  if (entry.type === "create") after = entry.item;
  else if (entry.type === "delete") after = null;
  else if (entry.type === "update" && entry.baseItem) after = { ...entry.baseItem, ...(entry.patch || {}) };
  else if (entry.type === "image" && entry.baseItem) {
    after = {
      ...entry.baseItem,
      image: entry.image?.objectKey,
      imageSha256: entry.image?.sha256,
      imageVersion: entry.image?.imageVersion,
    };
  }
  return Object.fromEntries(Object.entries({
    before: entry.type === "create" ? null : entry.baseItem,
    after,
    baseItemVersion: entry.baseItemVersion,
    baseRevision: entry.baseRevision,
    baseItem: entry.baseItem,
    patch: entry.patch,
    item: entry.item,
    image: entry.image,
    workbookSha256: entry.workbookSha256,
  }).filter(([, value]) => value !== undefined && value !== ""));
}

function migrateState(value) {
  if (value?.version !== 1) return value;
  const history = [];
  let nextHistorySeq = 1;
  for (const entry of Array.isArray(value.entries) ? value.entries : []) {
    entry.operator = String(entry.operator || `desktop:${value.clientId || "unknown"}`);
    entry.occurredAt = String(entry.occurredAt || entry.createdAt || new Date(0).toISOString());
    entry.requestHash = requestHash(normalizeMutation(entry, entry.opId));
    history.push({
      sequence: nextHistorySeq++,
      opId: entry.opId,
      clientId: entry.clientId || value.clientId,
      clientSeq: entry.clientSeq,
      itemId: entry.itemId,
      type: entry.type,
      lifecycle: "migrated",
      operator: entry.operator,
      occurredAt: entry.occurredAt,
      recordedAt: entry.updatedAt || entry.createdAt || entry.occurredAt,
      mutation: historyMutation(entry),
      result: { state: entry.state },
    });
  }
  return { ...value, version: OUTBOX_VERSION, nextHistorySeq, history };
}

function validateState(source) {
  const value = migrateState(source);
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.version !== OUTBOX_VERSION
      || typeof value.clientId !== "string" || !value.clientId
      || !Number.isSafeInteger(value.nextSeq) || value.nextSeq < 1
      || !Number.isSafeInteger(value.nextHistorySeq) || value.nextHistorySeq < 1
      || !Array.isArray(value.entries) || !Array.isArray(value.history)) {
    throw outboxError("OUTBOX_CORRUPT");
  }
  const seen = new Set();
  for (const entry of value.entries) {
    if (!entry || typeof entry !== "object" || !entry.opId || seen.has(entry.opId)
        || !MUTATION_TYPES.has(entry.type) || (entry.type !== "workbook" && !entry.itemId)
        || !ENTRY_STATES.has(entry.state)
        || typeof entry.operator !== "string" || !entry.operator
        || typeof entry.occurredAt !== "string" || !entry.occurredAt) {
      throw outboxError("OUTBOX_CORRUPT");
    }
    if (entry.type === "workbook"
        && (!Array.isArray(entry.operations) || !entry.operations.length
          || !Array.isArray(entry.baseItems)
          || !entry.requestBody || typeof entry.requestBody !== "object"
          || Number(entry.requestBody.expectedRevision) !== Number(entry.baseRevision)
          || JSON.stringify(entry.requestBody.operations) !== JSON.stringify(entry.operations))) {
      throw outboxError("OUTBOX_CORRUPT");
    }
    seen.add(entry.opId);
  }
  let priorSequence = 0;
  for (const event of value.history) {
    if (!event || typeof event !== "object"
        || !Number.isSafeInteger(event.sequence) || event.sequence <= priorSequence
        || !event.opId || (event.type !== "workbook" && !event.itemId)
        || !MUTATION_TYPES.has(event.type)
        || !event.lifecycle || !event.operator || !event.occurredAt || !event.recordedAt) {
      throw outboxError("OUTBOX_CORRUPT");
    }
    priorSequence = event.sequence;
  }
  if (value.nextHistorySeq <= priorSequence) throw outboxError("OUTBOX_CORRUPT");
  return value;
}

function atomicWrite(file, value, fsApi = fs) {
  const directory = path.dirname(file);
  fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  const descriptor = fsApi.openSync(temporary, "w", 0o600);
  try {
    fsApi.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsApi.fsyncSync(descriptor);
  } finally {
    fsApi.closeSync(descriptor);
  }
  fsApi.renameSync(temporary, file);
}

function normalizeMutation(source, generatedOpId) {
  const mutation = source && typeof source === "object" && !Array.isArray(source)
    ? source
    : {};
  const type = String(mutation.type || "").trim();
  const itemId = String(mutation.itemId || "").trim();
  const opId = String(mutation.opId || generatedOpId || "").trim();
  if (!ROW_MUTATION_TYPES.has(type) || !itemId || !opId) {
    throw outboxError("OUTBOX_MUTATION_INVALID");
  }
  return Object.fromEntries(Object.entries({
    opId,
    itemId,
    type,
    baseItemVersion: Math.max(0, Math.trunc(Number(mutation.baseItemVersion) || 0)),
    baseRevision: Math.max(0, Math.trunc(Number(mutation.baseRevision) || 0)),
    baseItem: mutation.baseItem,
    patch: mutation.patch,
    item: mutation.item,
    image: mutation.image,
    workbookSha256: String(mutation.workbookSha256 || "").trim().toLowerCase(),
    operator: String(mutation.operator || "").trim().slice(0, 128),
    occurredAt: String(mutation.occurredAt || "").trim().slice(0, 64),
  }).filter(([, value]) => value !== undefined && value !== ""));
}

function normalizeWorkbookOperations(source) {
  if (!Array.isArray(source) || !source.length) throw outboxError("OUTBOX_MUTATION_INVALID");
  return source.map((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw outboxError("OUTBOX_MUTATION_INVALID");
    }
    if (operation.type === "upsert") {
      if (!String(operation.item?.id || "").trim()) throw outboxError("OUTBOX_MUTATION_INVALID");
    } else if (operation.type === "delete") {
      if (!String(operation.itemId || "").trim()) throw outboxError("OUTBOX_MUTATION_INVALID");
    } else {
      throw outboxError("OUTBOX_MUTATION_INVALID");
    }
    return clone(operation);
  });
}

function normalizeBaseItems(source) {
  if (!Array.isArray(source)) throw outboxError("OUTBOX_MUTATION_INVALID");
  const ids = new Set();
  return source.map((item) => {
    const id = String(item?.id || "").trim();
    if (!id || ids.has(id)) throw outboxError("OUTBOX_MUTATION_INVALID");
    ids.add(id);
    return clone(item);
  });
}

function normalizeWorkbookTransaction(source, generatedOpId) {
  const value = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const opId = String(value.opId || generatedOpId || "").trim();
  if (!opId) throw outboxError("OUTBOX_MUTATION_INVALID");
  const baseRevision = Math.max(0, Math.trunc(Number(value.baseRevision) || 0));
  const operations = normalizeWorkbookOperations(value.operations);
  return {
    opId,
    type: "workbook",
    baseRevision,
    baseItems: normalizeBaseItems(value.baseItems),
    operations,
    requestBody: { expectedRevision: baseRevision, operations: clone(operations) },
    workbookSha256: String(value.workbookSha256 || "").trim().toLowerCase(),
    explicitResolution: value.explicitResolution === true ? true : undefined,
    resolutionOfOpId: String(value.resolutionOfOpId || "").trim(),
    operator: String(value.operator || "").trim().slice(0, 128),
    occurredAt: String(value.occurredAt || "").trim().slice(0, 64),
  };
}

function createSyncOutbox(options = {}) {
  const file = path.resolve(String(options.file || ""));
  if (!path.isAbsolute(String(options.file || ""))) throw outboxError("OUTBOX_PATH_INVALID");
  const fsApi = options.fsApi || fs;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const now = options.now || (() => new Date().toISOString());
  const getOperator = typeof options.getOperator === "function"
    ? options.getOperator
    : () => options.operator;
  let state;
  if (fsApi.existsSync(file)) {
    try {
      state = validateState(JSON.parse(fsApi.readFileSync(file, "utf8")));
    } catch (error) {
      if (error?.code === "OUTBOX_CORRUPT") throw error;
      throw outboxError("OUTBOX_CORRUPT");
    }
  } else {
    state = {
      version: OUTBOX_VERSION,
      clientId: String(randomUUID()),
      nextSeq: 1,
      nextHistorySeq: 1,
      entries: [],
      history: [],
    };
  }

  const persist = () => atomicWrite(file, state, fsApi);
  const find = (opId) => state.entries.find((entry) => entry.opId === String(opId || ""));
  const recordHistory = (entry, lifecycle, result = {}) => {
    const recordedAt = now();
    state.history.push({
      sequence: state.nextHistorySeq++,
      opId: entry.opId,
      clientId: entry.clientId,
      clientSeq: entry.clientSeq,
      itemId: entry.itemId,
      type: entry.type,
      lifecycle,
      operator: entry.operator,
      occurredAt: entry.occurredAt,
      recordedAt,
      mutation: historyMutation(entry),
      result: clone(result),
    });
  };
  const changeState = (opId, nextState, result = {}) => {
    const entry = find(opId);
    if (!entry) throw outboxError("OUTBOX_OPERATION_NOT_FOUND");
    entry.state = nextState;
    entry.updatedAt = now();
    Object.assign(entry, result);
    recordHistory(entry, nextState, result);
    persist();
    return clone(entry);
  };

  return {
    enqueue(source) {
      const mutation = normalizeMutation(source, source?.opId ? "" : randomUUID());
      const hash = requestHash(mutation);
      const existing = find(mutation.opId);
      if (existing) {
        if (existing.requestHash !== hash) throw outboxError("OUTBOX_IDEMPOTENCY_CONFLICT");
        return clone(existing);
      }
      const timestamp = now();
      mutation.operator = mutation.operator || String(getOperator() || "").trim().slice(0, 128)
        || `desktop:${state.clientId}`;
      mutation.occurredAt = mutation.occurredAt || timestamp;
      const entry = {
        ...mutation,
        requestHash: hash,
        clientId: state.clientId,
        clientSeq: state.nextSeq,
        state: "pending",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.nextSeq += 1;
      state.entries.push(entry);
      recordHistory(entry, "queued");
      persist();
      return clone(entry);
    },

    enqueueWorkbookTransaction(source) {
      const transaction = normalizeWorkbookTransaction(source, source?.opId ? "" : randomUUID());
      const hash = requestHash(transaction);
      const existing = find(transaction.opId);
      if (existing) {
        if (existing.requestHash !== hash) throw outboxError("OUTBOX_IDEMPOTENCY_CONFLICT");
        return clone(existing);
      }
      const timestamp = now();
      transaction.operator = transaction.operator || String(getOperator() || "").trim().slice(0, 128)
        || `desktop:${state.clientId}`;
      transaction.occurredAt = transaction.occurredAt || timestamp;
      const clientSeq = state.nextSeq++;
      const entry = {
        ...transaction,
        requestHash: hash,
        clientId: state.clientId,
        clientSeq,
        originClientSeq: clientSeq,
        state: "pending",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.entries.push(entry);
      recordHistory(entry, "queued");
      persist();
      return clone(entry);
    },

    replaceWorkbookConflict(opId, source, result = {}) {
      const entry = find(opId);
      if (!entry) throw outboxError("OUTBOX_OPERATION_NOT_FOUND");
      if (entry.type !== "workbook" || entry.state !== "conflict") {
        throw outboxError("OUTBOX_MUTATION_INVALID");
      }
      const replacement = normalizeWorkbookTransaction({
        ...source,
        opId: entry.opId,
        operator: entry.operator,
        occurredAt: entry.occurredAt,
      }, "");
      recordHistory(entry, "superseded", {
        nextWorkbookSha256: replacement.workbookSha256,
      });
      Object.assign(entry, replacement, {
        requestHash: requestHash(replacement),
        state: "conflict",
        attempts: 0,
        updatedAt: now(),
        conflictCode: String(result.conflictCode || "VERSION_CONFLICT").slice(0, 64),
        conflictDetails: result.conflictDetails == null ? undefined : clone(result.conflictDetails),
      });
      delete entry.lastAttemptAt;
      delete entry.commitRevision;
      delete entry.acknowledgedAt;
      recordHistory(entry, "conflict", {
        conflictCode: entry.conflictCode,
        conflictDetails: entry.conflictDetails,
      });
      persist();
      return clone(entry);
    },

    rebaseWorkbookTransaction(opId, source) {
      const entry = find(opId);
      if (!entry) throw outboxError("OUTBOX_OPERATION_NOT_FOUND");
      if (entry.type !== "workbook") throw outboxError("OUTBOX_MUTATION_INVALID");
      const priorOpId = entry.opId;
      let nextOpId = String(randomUUID());
      while (!nextOpId || find(nextOpId)) nextOpId = String(randomUUID());
      const rebased = normalizeWorkbookTransaction({
        ...source,
        opId: nextOpId,
        workbookSha256: entry.workbookSha256,
        operator: entry.operator,
        occurredAt: entry.occurredAt,
      }, "");
      recordHistory(entry, "rebased", { nextOpId, baseRevision: rebased.baseRevision });
      Object.assign(entry, rebased, {
        requestHash: requestHash(rebased),
        clientSeq: state.nextSeq++,
        originClientSeq: entry.originClientSeq || entry.clientSeq,
        state: "pending",
        attempts: 0,
        lastAttemptAt: undefined,
        rebasedFromOpId: priorOpId,
        updatedAt: now(),
      });
      recordHistory(entry, "queued", { rebasedFromOpId: priorOpId });
      persist();
      return clone(entry);
    },

    rebaseImageMutation(opId, source = {}) {
      const entry = find(opId);
      if (!entry) throw outboxError("OUTBOX_OPERATION_NOT_FOUND");
      if (entry.type !== "image") throw outboxError("OUTBOX_MUTATION_INVALID");
      const priorOpId = entry.opId;
      let nextOpId = String(randomUUID());
      while (!nextOpId || find(nextOpId)) nextOpId = String(randomUUID());
      const rebased = normalizeMutation({
        ...entry,
        opId: nextOpId,
        baseItem: source.baseItem,
        baseRevision: source.baseRevision,
      }, "");
      recordHistory(entry, "rebased", { nextOpId, baseRevision: rebased.baseRevision });
      Object.assign(entry, rebased, {
        requestHash: requestHash(rebased),
        clientSeq: state.nextSeq++,
        state: "pending",
        attempts: 0,
        lastAttemptAt: undefined,
        rebasedFromOpId: priorOpId,
        updatedAt: now(),
      });
      delete entry.conflictCode;
      delete entry.conflictDetails;
      delete entry.commitRevision;
      delete entry.acknowledgedAt;
      recordHistory(entry, "queued", { rebasedFromOpId: priorOpId });
      persist();
      return clone(entry);
    },

    captureBase(opId, result = {}) {
      const entry = find(opId);
      if (!entry) throw outboxError("OUTBOX_OPERATION_NOT_FOUND");
      if (entry.baseItem !== undefined) return clone(entry);
      entry.baseItem = clone(result.baseItem);
      entry.baseRevision = Math.max(0, Math.trunc(Number(result.baseRevision) || 0));
      entry.updatedAt = now();
      recordHistory(entry, "base-captured", { baseRevision: entry.baseRevision });
      persist();
      return clone(entry);
    },

    markSent(opId) {
      const entry = find(opId);
      if (!entry) throw outboxError("OUTBOX_OPERATION_NOT_FOUND");
      entry.attempts = Math.max(0, Number(entry.attempts) || 0) + 1;
      entry.lastAttemptAt = now();
      return changeState(opId, "sent");
    },

    acknowledge(opId, result = {}) {
      return changeState(opId, "acked", {
        commitRevision: Math.max(0, Math.trunc(Number(result.commitRevision) || 0)),
        itemVersion: Math.max(0, Math.trunc(Number(result.itemVersion) || 0)),
        acknowledgedAt: now(),
      });
    },

    markConflict(opId, result = {}) {
      return changeState(opId, "conflict", {
        conflictCode: String(result.conflictCode || "VERSION_CONFLICT").slice(0, 64),
        conflictDetails: result.conflictDetails == null ? undefined : clone(result.conflictDetails),
      });
    },

    supersedeEarlierWorkbookTransactions(opId, result = {}) {
      const selected = find(opId);
      if (!selected || selected.type !== "workbook" || selected.state !== "acked") {
        throw outboxError("OUTBOX_OPERATION_NOT_ACKNOWLEDGED");
      }
      const selectedOrigin = selected.originClientSeq || selected.clientSeq;
      const superseded = state.entries.filter((entry) => entry.type === "workbook"
        && entry.opId !== selected.opId
        && (entry.originClientSeq || entry.clientSeq) < selectedOrigin
        && entry.state !== "acked");
      for (const entry of superseded) {
        recordHistory(entry, "superseded", {
          supersededByOpId: selected.opId,
          reason: String(result.reason || "newer-workbook-transaction-committed").slice(0, 80),
          commitRevision: Math.max(0, Math.trunc(Number(result.commitRevision) || 0)),
        });
      }
      if (superseded.length) {
        const ids = new Set(superseded.map((entry) => entry.opId));
        state.entries = state.entries.filter((entry) => !ids.has(entry.opId));
        persist();
      }
      return superseded.length;
    },

    retryable() {
      return clone(state.entries
        .filter((entry) => RETRYABLE_STATES.has(entry.state))
        .sort((left, right) => left.clientSeq - right.clientSeq));
    },

    pruneAcknowledged() {
      const before = state.entries.length;
      state.entries = state.entries.filter((entry) => entry.state !== "acked");
      if (state.entries.length !== before) persist();
      return before - state.entries.length;
    },

    snapshot() {
      return clone(state);
    },

    history() {
      return clone(state.history);
    },
  };
}

module.exports = {
  MUTATION_TYPES,
  OUTBOX_VERSION,
  atomicWrite,
  createSyncOutbox,
  requestHash,
};
