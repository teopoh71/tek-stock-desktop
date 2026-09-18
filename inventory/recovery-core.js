(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TekStockRecovery = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const ACTIONS = {
    retry: "重试连接与同步", later: "稍后处理，继续查看", report: "发送诊断",
    conflicts: "查看并选择冲突资料", excel: "打开 Excel 检查", auth: "重新连接账号",
    update: "重新检查更新", folder: "打开本地诊断", help: "查看处理说明",
  };
  function advice(value) {
    const code = String(value?.errorCode || value?.code || value || "UNKNOWN_ERROR").toUpperCase();
    let kind = "unknown", title = "这一步暂时没有完成", detail = "可以稍后重试或发送诊断。请保留当前资料。", actions = ["report", "later", "help"];
    if (/CONFLICT|MIGRATION|INVALID_STOCK|DUPLICATE/.test(code)) {
      kind = "conflict"; title = "两边的资料需要核对";
      detail = "系统不会自动选一边覆盖。查看差异后逐项选择，也可以先继续查看库存。";
      actions = [/MIGRATION|INVALID_STOCK|DUPLICATE/.test(code) ? "excel" : "conflicts", "later", "report"];
    } else if (/UNAUTHORIZED|HTTP_40[13]|AUTH_FAILED/.test(code)) {
      kind = "auth"; title = "连接授权需要更新"; detail = "重新连接后再同步；暂时也能查看已加载的库存。";
      actions = ["auth", "later", "report"];
    } else if (/SHA256|SIGNATURE|DOWNGRADE|MANIFEST.*INVALID|URL_INVALID/.test(code)) {
      kind = "verification"; title = "更新包未通过校验"; detail = "安装已停止，当前版本保留。可以重新检查更新，或发送诊断。";
      actions = ["update", "later", "report"];
    } else if (/BACKUP|ENOSPC|DISK/.test(code)) {
      kind = "backup"; title = "更新前备份还未完成"; detail = "安装不会继续。请检查磁盘空间和文件权限，处理后重新检查更新。";
      actions = ["update", "later", "folder"];
    } else if (/LOCK|UNSAVED|PREPARE|BUSY|ALREADY_RUNNING|IN_PROGRESS|PENDING|CONTENT_CHANGED/.test(code)) {
      kind = "busy"; title = "还有操作或 Excel 修改未完成"; detail = "请先保存 Excel、完成当前操作，再重试。可以先继续查看，不必重装。";
      actions = ["excel", "later", "report"];
      if (code.startsWith("UPDATE_")) {
        detail = "请先保存并关闭 Excel，等待待同步标记消失，再点 Update。当前版本可以继续使用。";
        actions = ["update", "later", "report"];
      }
    } else if (/NETWORK|TIMEOUT|UNREACHABLE|UNAVAILABLE|OFFLINE|ECONN|ENOTFOUND|HTTP_5\d\d/.test(code)) {
      kind = "network"; title = "暂时连接不上云端"; detail = "程序会间隔重试。已加载的资料仍可查看；待同步状态会继续保留。";
      actions = [code.startsWith("UPDATE_") ? "update" : "retry", "later", "report"];
    }
    return { kind, title, detail, code: /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "UNKNOWN_ERROR",
      actions: actions.map(id => ({ id, label: ACTIONS[id] })) };
  }
  function mount(document, handlers = {}, options = {}) {
    let last = null, dismissed = "", running = false;
    const panel = document.createElement("section");
    panel.id = "recoveryPanel"; panel.className = "recovery-panel"; panel.hidden = true;
    panel.setAttribute("aria-label", "问题处理");
    const title = document.createElement("h2"), detail = document.createElement("p"), code = document.createElement("small");
    const actions = document.createElement("div"), status = document.createElement("p");
    actions.className = "recovery-actions"; status.setAttribute("role", "status");
    panel.append(title, detail, code, actions, status); document.body.append(panel);
    async function run(action, button) {
      if (action.id === "later") { dismissed = last.code; panel.hidden = true; return; }
      if (running) return;
      running = true; button.disabled = true; status.textContent = "正在处理…你可以继续查看库存。";
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => handlers[action.id]?.(last)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("ACTION_TIMEOUT")), options.timeoutMs || 20000); }),
        ]);
        if (result === false || result?.ok === false) {
          status.textContent = result?.errorCode === "DIAGNOSTICS_NOT_CONFIGURED"
            ? "诊断接收服务尚未配置。日志已保存在本机，可在帮助中导出。"
            : "这一步暂时未完成。可以稍后处理，或选另一个方法。";
        } else {
          status.textContent = action.id === "report"
            ? result?.sent > 0 ? `已发送 ${result.sent} 条诊断。${result.pending > 0 ? `其余 ${result.pending} 条将在后台补报。` : ""}`
              : "暂无待发送诊断；已有本地日志可在帮助中导出。"
            : "已完成此操作。";
          if (result === true && action.id === "retry") clear();
        }
      } catch { status.textContent = "处理尚未完成；后台操作可能仍在进行。可以先继续查看，稍后再检查。"; }
      finally { clearTimeout(timer); running = false; button.disabled = false; }
    }
    function show(value, force = false) {
      last = advice(value);
      if (!force && dismissed === last.code) return;
      title.textContent = last.title; detail.textContent = last.detail; code.textContent = "错误编号：" + last.code;
      status.textContent = ""; actions.replaceChildren();
      for (const action of last.actions) {
        if (action.id !== "later" && typeof handlers[action.id] !== "function") continue;
        const button = document.createElement("button"); button.type = "button";
        button.textContent = action.label; button.dataset.recoveryAction = action.id;
        button.addEventListener("click", () => void run(action, button)); actions.append(button);
      }
      panel.hidden = false;
    }
    function clear() { last = null; dismissed = ""; panel.hidden = true; }
    return { show, clear, reopen: () => { if (last) show(last.code, true); }, panel };
  }
  return { advice, mount };
});
