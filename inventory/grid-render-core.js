(function (root) {
  "use strict";
  const states = new WeakMap();
  function render(grid, items, markup, onImageError) {
    const previous = states.get(grid) || new Map();
    const next = new Map();
    const desired = items.map((item, index) => {
      const id = String(item.id);
      if (!id || next.has(id)) throw new Error("GRID_ITEM_ID_INVALID");
      const html = markup(item, index);
      const existing = previous.get(id);
      let node;
      if (existing && existing.html === html && existing.node.parentNode === grid) {
        node = existing.node;
      } else {
        const template = grid.ownerDocument.createElement("template");
        template.innerHTML = html.trim();
        node = template.content.firstElementChild;
        if (!node || template.content.childElementCount !== 1) throw new Error("GRID_CARD_INVALID");
        node.querySelectorAll("img.product-image").forEach(image => {
          image.addEventListener("error", onImageError);
        });
      }
      next.set(id, { node, html });
      return node;
    });
    const retained = new Set(desired);
    for (const child of Array.from(grid.children)) {
      if (!retained.has(child)) child.remove();
    }
    let cursor = grid.firstElementChild;
    for (const node of desired) {
      if (node === cursor) cursor = cursor.nextElementSibling;
      else grid.insertBefore(node, cursor);
    }
    states.set(grid, next);
  }
  root.TekStockGridRender = { render };
})(typeof window === "undefined" ? globalThis : window);
