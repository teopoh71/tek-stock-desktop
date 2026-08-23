"use strict";

function gateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function createWorkbookOperationGate(options = {}) {
  const timeoutMs = Math.max(1, Number(options.quiesceTimeoutMs) || 10_000);
  let chain = Promise.resolve();
  let resetPending = false;
  let nextSequence = 0;
  let resetCutoff = Number.POSITIVE_INFINITY;
  let activeAutomaticSync;

  function releaseResetGate() {
    resetPending = false;
    resetCutoff = Number.POSITIVE_INFINITY;
  }

  function scheduleSync(operation) {
    const sequence = nextSequence;
    nextSequence += 1;
    if (resetPending && sequence >= resetCutoff) {
      return Promise.reject(gateError("CLOUD_RESET_IN_PROGRESS"));
    }
    chain = chain.catch(() => {}).then(async () => {
      if (resetPending && sequence >= resetCutoff) {
        throw gateError("CLOUD_RESET_IN_PROGRESS");
      }
      return operation();
    });
    return chain;
  }

  function scheduleAutomaticSync(operation, options = {}) {
    const controller = new AbortController();
    const entry = {
      controller,
      onCancel: typeof options.onCancel === "function" ? options.onCancel : () => {},
      cancelRequested: false,
    };
    activeAutomaticSync = entry;
    const sequence = nextSequence;
    nextSequence += 1;
    const run = async () => {
      if (resetPending && sequence >= resetCutoff) {
        throw gateError("CLOUD_RESET_IN_PROGRESS");
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation({ signal: controller.signal });
    };
    chain = chain.catch(() => {}).then(run).finally(() => {
      if (activeAutomaticSync === entry) activeAutomaticSync = undefined;
    });
    return chain;
  }

  async function runReset(operation, options = {}) {
    if (resetPending) throw gateError("CLOUD_RESET_IN_PROGRESS");
    resetPending = true;
    resetCutoff = nextSequence;
    let timer;
    let timedOut = false;
    const pending = chain.catch(() => {});
    try {
      if (options.cancelAutomaticSync === true && activeAutomaticSync) {
        const automatic = activeAutomaticSync;
        const accepted = automatic.onCancel();
        if (accepted !== false) {
          automatic.cancelRequested = true;
          automatic.controller.abort(gateError("CLOUD_RESET_SYNC_CANCELLED"));
        }
      }
      await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(gateError("CLOUD_RESET_SYNC_IN_PROGRESS")), timeoutMs);
        }),
      ]);
      return await operation();
    } catch (error) {
      if (error?.code === "CLOUD_RESET_SYNC_IN_PROGRESS") {
        timedOut = true;
        pending.finally(releaseResetGate).catch(() => {});
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (!timedOut) releaseResetGate();
    }
  }

  return {
    runReset,
    scheduleSync,
    scheduleAutomaticSync,
    scheduleWrite: scheduleSync,
    isResetPending: () => resetPending,
  };
}

module.exports = { createWorkbookOperationGate };
