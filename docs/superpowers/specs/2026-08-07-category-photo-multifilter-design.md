# TEK STOCK Category Photo Multi-Filter Design

Date: 2026-08-07

## Scope

Change only the inventory browsing controls. Do not read, write, upload, delete, or migrate any real workbook or inventory record during development and verification.

## Category photo buttons

- Replace visible category text pills with compact square photo buttons.
- Every category photo must come from an existing real product record in the same canonical category. No TEK STOCK logo, generic icon, emoji, cartoon, or generated illustration is allowed.
- Choose the representative deterministically from eligible same-category items: valid approved image first, then highest current stock, then model and permanent product ID. Record the source product ID, model, and image path in the isolated test report.
- The `All` control is not a category. It uses a compact 2x2 montage made only from four selected real inventory product photos. Clicking it clears all selected categories.
- A button is 36x36 CSS pixels, smaller than the current variable-width text pills. The selected state uses a visible brand-colour outline and check mark.
- Category names remain available as `aria-label` and `title` text for accessibility, but are not rendered as button text.
- If a category has no approved real image, do not substitute a logo or placeholder. Keep the existing text category control for that category and report the missing-photo condition.

## Multi-select filtering

- Store selected canonical category labels as a set.
- No selected categories means all items.
- Clicking one photo selects only that category from the initial state.
- Clicking more photos adds those categories using OR semantics: `餐椅 + 餐桌` shows the union of both categories.
- Clicking a selected photo removes it. Removing the last selection returns to all items.
- Search and stock-status filters continue to compose with the category selection.

## Stock sorting

- Remove the visible `数量最多` text control.
- Add two compact arrow-only buttons beside the stock filters:
  - `↓`: current stock descending.
  - `↑`: current stock ascending.
- Sorting applies only to the currently filtered result and never mutates the authoritative `baseItems` array.
- Ties are deterministic: model with numeric comparison, then permanent product ID.
- The active arrow has a clear selected state and accessible label/title. Selecting the other arrow switches direction.

## Newest-added sorting and missing dates

- Add a compact `newest added` sort control, not a today/7-day filter.
- Within the current category, search, and stock-status result, items with a valid immutable `createdAt` are ordered newest first.
- Current bundled legacy evidence: 324 total items and 0 items with a reliable `createdAt`. Do not infer a date from Excel row number, file timestamp, modification time, model number, or the current time.
- Compatibility rule:
  1. Treat `createdAt` as an optional ISO-8601 product field.
  2. For future products, the central API assigns it once on the first successful creation and preserves it through edits, photo replacement, stock changes, and workbook convergence.
  3. Products without a reliable date remain valid but sort after all dated products. Their relative order is deterministic by model and permanent product ID.
  4. The isolated report must list the number and IDs of records missing `createdAt` rather than hiding the limitation.
- This development task validates UI handling and the schema contract using isolated data. It must not backfill or deploy guessed dates into real inventory.

## Isolation and test evidence

- Put filtering, sorting, and representative-photo selection in a small testable module.
- Use isolated fixture items that reference copied/packaged real inventory photo assets; never open a real Excel workbook.
- Required automated checks:
  1. Single-select `餐椅` returns only chairs.
  2. Multi-select `餐椅 + 餐桌` returns the union with no duplicates.
  3. `↓` sorts the multi-select result from highest to lowest current stock.
  4. `↑` sorts the same result from lowest to highest current stock.
  5. Re-clicking a selected category removes it.
  6. Sorting does not mutate the input item order.
  7. Each photo button source belongs to its own canonical category and is an approved real inventory image.
  8. Newest-added sorting puts valid dates newest first inside a multi-category result and places missing-date legacy records last without inventing dates.
- Capture an isolated desktop screenshot showing the photo buttons and arrow buttons. Produce a bounded JSON report containing selected categories, ordered model/stock pairs, and representative photo source records.

## Out of scope

- No cloud API, Excel synchronization, conflict-resolution, installer, inventory editing, or mobile write behaviour changes.
- No real inventory cleanup or conflict choice.
