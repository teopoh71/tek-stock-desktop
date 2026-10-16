# External AI handoff

## Scope

This is an Electron / Node.js desktop inventory application. The repository is deliberately free of production inventory and runtime secrets. Use `inventory/alibaba-cloud.example.json` as a configuration shape only; never add a real Cloudflare token, endpoint credential, workbook, or customer data to the repository.

## Current defects

1. Deleting a whole Excel model row and then creating one or two new models in the same row position can trigger a workbook identity migration/sync failure. A new model must receive a new item identity and must never inherit a deleted row's cloud identity because it occupies the same Excel row.
2. The Excel action can report success when WPS only opens its home screen. Success must mean the requested workbook is actually open.
3. The update screen can report an older available version than the installed application. Version/manifest handling needs a safe, testable fix.

## Primary files

- `main.cjs`
- `excel-live.cjs`
- `central-sync.cjs`
- `workbook-identity-migration.cjs`
- `workbook-migration-transaction.cjs`
- `inventory/excel-delta-core.js`
- `inventory/excel-sync-core.js`
- `inventory/excel-open-core.js`
- `updater-core.cjs`

## Required regression coverage

- Delete an entire model row, add one new model in the same visual row, then sync.
- Delete an entire model row, add two new models in the same visual row region, then sync.
- Confirm deleted identities are not reused and production data is never silently deleted or migrated.
- Confirm WPS home screen is not treated as the workbook being open.
- Confirm the updater cannot recommend a lower/stale version as an update.

The synthetic fixture under `test/fixtures` is for local testing only and is not production data.

## Wholesale workflow (branch feature/wholesale-orders-ui, not released)

The 库存 / 订单·送货 / 到货 tabs and the product-dialog buttons (卖出 / 到货入仓 / 放展厅 / 登记在路上)
store structured lines inside the existing `outbound`, `arrival` and `showroom` text fields. There is
no new Excel column and no cloud schema change, so older app versions keep working. Logic is in
`inventory/movement-core.js` (tests: `test/movement-core.test.cjs`), UI in `inventory/movement-ui.js`.

- outbound delivered: `CUSTOMER PO 25360 ( 4 PCS ) DD: 30-10-26` (counted as sold by the existing `( N PCS )` rule; stock −4)
- outbound booked: `[已订] CUSTOMER PO 25360 ×4 DD: 30-10-26` (not sold; 可卖 = stock − booked)
- arrival received: `4 PCS ( 16-10-26 ) PI 7226` (stock +4)
- arrival in transit: `[在路上] PI 7226 ×4 ETA: 5-11-26` (stock unchanged until 确认到货)
- showroom: `CUSTOMER C/S ( 1 PCS ) ON 16-10-26` (stock −1; 收回 restores it)

Lines that do not match these formats are legacy free text: they are shown and kept, never counted.
