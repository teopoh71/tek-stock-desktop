# Category Photo Multi-Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add real inventory-photo category multi-select controls and stable stock/newest sorting to the isolated desktop inventory UI.

**Architecture:** Put pure filtering, sorting, date validation, and representative-photo selection in `inventory/filter-sort-core.js`. Keep DOM rendering and event wiring in `inventory/app.js`; use existing approved image resolution for actual product photos. Add compact controls in `inventory/index.html` and CSS, then exercise them with isolated fixture tests and an Electron preview screenshot.

**Tech Stack:** Vanilla JavaScript, HTML/CSS, Node `node:test`, Electron isolated smoke harness.

## Global Constraints

- Never open or modify real Excel, real inventory, or production cloud data.
- Category photos must be real approved same-category inventory images; no logo, generic icon, emoji, cartoon, or generated artwork.
- Empty category selection means all categories; selected categories use OR semantics and repeated clicks remove selections.
- Sorting never mutates the authoritative item array.
- Do not infer `createdAt` from row numbers, file times, model numbers, or current time.

### Task 1: Pure filter/sort/photo-selection core

**Files:**
- Create: `inventory/filter-sort-core.js`
- Create: `test/filter-sort-core.test.cjs`
- Modify: `inventory/index.html` to load the module before `app.js`

**Interfaces:**
- `canonicalSelection(items, categoryLabel)` returns normalized category labels.
- `filterItems(items, { selectedCategories, query, stockFilter }, helpers)` returns a new array.
- `sortItems(items, direction, helpers)` returns a new stable array for `desc`, `asc`, or `newest`.
- `representativePhotos(items, categoryLabel, approvedImage)` returns `{ label, sourceId, model, image }` records.

- [ ] Write failing tests for chair-only, chair+table union, toggle removal input, descending and ascending stock, newest valid dates with missing dates last, non-mutating sort, and same-category real-photo source selection.
- [ ] Run `node --test test/filter-sort-core.test.cjs`; confirm expected failures because the module is absent.
- [ ] Implement the smallest pure functions and UMD/browser export.
- [ ] Re-run the focused test file and confirm all assertions pass.

### Task 2: Photo buttons and arrow controls

**Files:**
- Modify: `inventory/index.html` stock/category control markup.
- Modify: `inventory/styles.css` compact photo buttons, active ring/check, arrow controls, and montage.
- Modify: `inventory/app.js` selected-category set, representative-photo rendering, filter composition, and sort event handlers.

**Interfaces:**
- `state.selectedCategories` is a `Set` of canonical labels.
- `state.sortDirection` is `"none" | "desc" | "asc" | "newest"`.
- Category buttons carry `data-category`, `data-category-label`, `title`, and `aria-label`.
- Arrow buttons carry `data-sort="desc|asc|newest"`.

- [ ] Replace the text `数量最多` control with arrow-only `↓`, `↑`, and a compact newest-added control.
- [ ] Render each category from a deterministic same-category item with an approved photo; use a real-photo montage for `全部`.
- [ ] Preserve search and stock-status filters while applying selected categories and the active sort.
- [ ] Re-render active states without changing inventory records.

### Task 3: Isolated preview evidence

**Files:**
- Modify: `scripts/run-packaged-electron-smoke.cjs` or add `scripts/category-filter-preview.cjs` for an isolated fixture route.
- Create: `outputs/category-filter-preview.json` and `outputs/category-filter-preview.png`.

- [ ] Start the UI with temporary user-data and fixture records referencing packaged real product photos.
- [ ] Exercise chair-only, chair+table, `↓`, `↑`, and newest-added states.
- [ ] Capture a screenshot showing photo sources and controls; record ordered model/stock pairs and missing-date IDs in bounded JSON.

### Task 4: Full verification and handoff

- [ ] Run `npm test` and the isolated preview script.
- [ ] Run `git diff --check` only if repository metadata exists; otherwise report that the project is not a Git worktree.
- [ ] Verify no real workbook, outbox, credentials, or cloud calls were touched.
- [ ] Report changed files, preview path, photo-source evidence, and exact results for all three sort/filter scenarios.

