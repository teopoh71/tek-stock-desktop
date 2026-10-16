"use strict";

// Wholesale workflow UI: work tiles, 库存 / 订单 / 到货 tabs and the movement
// panel in the product dialog. All writes go through api.commit(item, patch).
(function initMovementUi(root) {
  const core = root.TekStockMovement;

  const actionLabels = {
    sale: "卖出 / 客户订货", arrive: "到货入仓", showroom: "放展厅", transit: "登记在路上",
  };
  const kindLabels = { booked: "已订未送", delivered: "已送货", received: "到货入仓", transit: "在路上", showroom: "展厅" };
  const kindPill = { booked: "mv-p-due", delivered: "mv-p-done", received: "mv-p-ok", transit: "mv-p-in", showroom: "mv-p-show" };

  function todayIso() {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
  }

  function dayLabel(iso) {
    const days = core.daysUntil(iso, todayIso());
    if (days < 0) return `逾期 ${-days} 天`;
    if (days === 0) return "今天";
    return `${days} 天后`;
  }

  function mount(doc, api) {
    const esc = api.escapeHtml;
    const $ = (id) => doc.getElementById(id);
    const panes = { stock: $("stockView"), orders: $("ordersView"), incoming: $("incomingView") };
    let activeItem = null;
    let orderFilter = "open";
    let busy = false;

    function setTab(name) {
      if (!panes[name]) return;
      doc.querySelectorAll("#viewTabs [data-view]").forEach((button) => {
        button.setAttribute("aria-selected", String(button.dataset.view === name));
      });
      Object.entries(panes).forEach(([key, pane]) => { if (pane) pane.hidden = key !== name; });
    }

    function renderTiles() {
      const data = core.overview(api.items(), todayIso());
      $("mvAvailable").textContent = data.available.toLocaleString();
      $("mvDueSoon").textContent = data.dueSoon.toLocaleString();
      $("mvTransit").textContent = data.transit.toLocaleString();
      $("mvOversold").textContent = data.oversold.toLocaleString();
      $("mvOversoldTile").classList.toggle("is-alert", data.oversold > 0);
    }

    function thumb(item) {
      const source = api.imageSource(item);
      return `<span class="mv-thumb">${source
        ? `<img src="${esc(source)}" data-fallback="${esc(api.imageFallback(item))}" alt="" loading="lazy">`
        : `<span class="image-fallback" aria-label="No photo">HP</span>`}</span>`;
    }

    function modelCell(entry) {
      return `<button class="mv-link mv-model" type="button" data-mv-open="${esc(entry.item.id)}">${thumb(entry.item)}<span>${esc(entry.item.model)}</span></button>`;
    }

    function watchImages(container) {
      container.querySelectorAll(".mv-thumb img").forEach((image) => image.addEventListener("error", api.onImageError));
    }

    function renderOrders() {
      let rows = core.collect(api.items(), ["booked", "delivered"]);
      if (orderFilter === "open") rows = rows.filter((entry) => entry.kind === "booked");
      if (orderFilter === "done") rows = rows.filter((entry) => entry.kind === "delivered");
      rows.sort((a, b) => (orderFilter === "done" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)));
      const readOnly = api.readOnly();
      $("ordersRows").innerHTML = rows.map((entry) => {
        const soon = entry.kind === "booked" && core.daysUntil(entry.date, todayIso()) <= 7;
        return `<tr>
          <td class="mv-num">${esc(entry.dateText)}${entry.kind === "booked" ? ` <span class="mv-pill ${soon ? "mv-p-due" : "mv-p-done"}">${dayLabel(entry.date)}</span>` : ""}</td>
          <td>${esc(entry.who)}</td><td class="mv-num">${esc(entry.po)}</td><td>${modelCell(entry)}</td>
          <td class="mv-r mv-num">${entry.qty}</td>
          <td><span class="mv-pill ${kindPill[entry.kind]}">${kindLabels[entry.kind]}</span></td>
          <td class="mv-r">${entry.kind === "booked" && !readOnly ? lineButton("deliver", entry, "标记已送") : ""}</td></tr>`;
      }).join("") || `<tr><td colspan="7" class="mv-empty">${orderFilter === "done" ? "还没有用新方式登记的送货。" : "没有未送的订单。打开产品，按“卖出 / 客户订货”登记。"}</td></tr>`;
      watchImages($("ordersRows"));
    }

    function renderIncoming() {
      const rows = core.collect(api.items(), ["transit"]).sort((a, b) => a.date.localeCompare(b.date));
      const readOnly = api.readOnly();
      $("incomingRows").innerHTML = rows.map((entry) => `<tr>
        <td class="mv-num">${esc(entry.dateText)} <span class="mv-pill mv-p-in">${dayLabel(entry.date)}</span></td>
        <td class="mv-num">${esc(entry.ref || "—")}</td><td>${modelCell(entry)}</td>
        <td class="mv-r mv-num">${entry.qty}</td>
        <td class="mv-r">${readOnly ? "" : lineButton("receive", entry, "确认到货入仓")}</td></tr>`).join("")
        || `<tr><td colspan="5" class="mv-empty">目前没有在路上的货。打开产品，按“登记在路上”加入。</td></tr>`;
      watchImages($("incomingRows"));
    }

    function lineButton(type, entry, label) {
      return `<button class="mv-line-button" type="button" data-mv-line="${type}" data-mv-item="${esc(entry.item?.id || activeItem?.id || "")}" data-mv-field-line="${esc(entry.line)}">${label}</button>`;
    }

    function renderDetail(item, showroomCount) {
      activeItem = item;
      const panel = $("movementPanel");
      if (!panel) return;
      const summary = core.summarize(item);
      const { entries } = core.parseItem(item);
      const readOnly = api.readOnly();
      const ledger = [...entries].sort((a, b) => b.date.localeCompare(a.date)).map((entry) => {
        const sign = entry.kind === "received" ? "+" : entry.kind === "transit" ? "(+" : entry.kind === "booked" ? "订 " : "−";
        const who = [entry.who, entry.po && `PO ${entry.po}`, entry.ref].filter(Boolean).join(" · ");
        let tools = "";
        if (!readOnly && entry.kind === "booked") tools = lineButton("deliver", entry, "已送") + lineButton("cancelBooking", entry, "取消");
        if (!readOnly && entry.kind === "transit") tools = lineButton("receive", entry, "到货") + lineButton("cancelTransit", entry, "取消");
        if (!readOnly && entry.kind === "showroom") tools = lineButton("showroomReturn", entry, "收回");
        return `<div class="mv-ledger-row">
          <span class="mv-num">${esc(entry.dateText)}</span>
          <div class="mv-ledger-who"><span class="mv-pill ${kindPill[entry.kind]}">${kindLabels[entry.kind]}</span> <small>${esc(who)}</small></div>
          <span class="mv-num mv-qty">${sign}${entry.qty}${entry.kind === "transit" ? ")" : ""}</span>
          <span class="mv-ledger-tools">${tools}</span></div>`;
      }).join("");
      panel.innerHTML = `
        <div class="mv-calc">
          <div class="mv-calc-main${summary.available < 0 ? " is-alert" : ""}"><span>可卖 = 库存 − 已订</span><strong class="mv-num">${summary.available}</strong></div>
          <div><span>已订未送</span><strong class="mv-num">${summary.booked}</strong></div>
          <div><span>展厅</span><strong class="mv-num">${showroomCount}</strong></div>
          <div><span>在路上</span><strong class="mv-num">${summary.transit}</strong></div>
        </div>
        ${summary.available < 0 ? `<p class="mv-alert">订单比仓库多 ${-summary.available} 件，到货前请先和客户确认送货日期。</p>` : ""}
        ${readOnly ? "" : `<div class="mv-actions">${Object.entries(actionLabels).map(([type, label]) =>
          `<button class="mv-action mv-action-${type}" type="button" data-mv-form="${type}">${label}</button>`).join("")}</div>`}
        <div id="movementFormSlot"></div>
        ${ledger ? `<div class="mv-ledger">${ledger}</div>` : `<p class="mv-empty">还没有用新方式登记的进出记录。旧的文字记录在下面“文字记录”里。</p>`}`;
    }

    function showForm(type) {
      const slot = $("movementFormSlot");
      if (!slot) return;
      const isSale = type === "sale";
      const needWho = isSale || type === "showroom";
      const needRef = type === "arrive" || type === "transit";
      const dateLabel = isSale ? "送货日期" : type === "transit" ? "预计到货" : "日期";
      const customers = [...new Set(core.collect(api.items(), ["booked", "delivered", "showroom"]).map((entry) => entry.who))].sort();
      slot.innerHTML = `<form class="mv-form" id="movementForm" data-type="${type}">
        <label>数量<input id="mvQty" type="number" min="1" max="9999" step="1" value="1" required></label>
        <label>${dateLabel}<input id="mvDate" type="date" value="${todayIso()}" required></label>
        ${needWho ? `<label>${isSale ? "客户" : "展厅 / 客户"}<input id="mvWho" list="mvCustomers" autocomplete="off" required></label>
          <datalist id="mvCustomers">${customers.map((name) => `<option value="${esc(name)}"></option>`).join("")}</datalist>` : ""}
        ${isSale ? `<label>PO 号<input id="mvPo" autocomplete="off" required></label>
          <label>状态<select id="mvDelivered"><option value="">已订，还没送</option><option value="1">已经送货</option></select></label>` : ""}
        ${needRef ? `<label>货柜 / PI<input id="mvRef" placeholder="例如 PI 7226" autocomplete="off"></label>` : ""}
        <div class="mv-form-actions"><button type="button" data-mv-cancel>取消</button><button class="mv-save" type="submit">保存${actionLabels[type]}</button></div>
      </form>`;
      $("mvQty").focus();
    }

    async function commit(item, action, message) {
      if (busy || api.readOnly()) return;
      let patch;
      try {
        patch = core.applyMovement(item, action);
      } catch (error) {
        api.toast(error.message || "保存失败");
        return;
      }
      busy = true;
      try {
        await api.commit(item, patch, message);
      } finally {
        busy = false;
      }
    }

    doc.addEventListener("submit", (event) => {
      if (event.target?.id !== "movementForm" || !activeItem) return;
      event.preventDefault();
      const type = event.target.dataset.type;
      const value = (id) => $(id)?.value ?? "";
      const action = {
        type, qty: value("mvQty"), date: value("mvDate"), who: value("mvWho"), po: value("mvPo"), ref: value("mvRef"),
        delivered: value("mvDelivered") === "1",
      };
      const label = type === "sale" ? (action.delivered ? "已送货" : "已订") : actionLabels[type];
      void commit(activeItem, action, `已保存：${activeItem.model} ${label} ${action.qty} 件`);
    });

    doc.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.view) { setTab(button.dataset.view); return; }
      if (button.dataset.mvJump) { setTab(button.dataset.mvJump); return; }
      if (button.dataset.orderFilter) {
        orderFilter = button.dataset.orderFilter;
        doc.querySelectorAll("[data-order-filter]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip === button)));
        renderOrders();
        return;
      }
      if (button.dataset.mvOpen) {
        const item = api.items().find((candidate) => candidate.id === button.dataset.mvOpen);
        if (item) api.open(item);
        return;
      }
      if (button.dataset.mvForm) { showForm(button.dataset.mvForm); return; }
      if ("mvCancel" in button.dataset) { $("movementFormSlot").innerHTML = ""; return; }
      if (button.dataset.mvLine) {
        const item = api.items().find((candidate) => candidate.id === button.dataset.mvItem);
        if (!item) return;
        const type = button.dataset.mvLine;
        const done = { deliver: "已标记送货，仓库已扣除", cancelBooking: "订单已取消", receive: "已确认到货，加入仓库",
          cancelTransit: "在路上记录已取消", showroomReturn: "展厅样品已收回仓库" }[type];
        void commit(item, { type, line: button.dataset.mvFieldLine, date: todayIso() }, `${item.model}：${done}`);
      }
    });

    function refresh() {
      renderTiles();
      renderOrders();
      renderIncoming();
    }

    setTab("stock");
    return { refresh, renderDetail, setTab };
  }

  root.TekStockMovementUi = { mount };
})(typeof globalThis !== "undefined" ? globalThis : this);
