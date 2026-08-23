# TEK STOCK concurrent Excel operator guide

## Daily operation

1. On each computer, open TEK STOCK and use its **Open Excel** control. Do not open another computer's workbook, a copied workbook, or the old shared workbook.
2. Each computer opens only its own private `TEK-STOCK-LIVE.xlsx` through its local TEK STOCK app. The private workbook remains local to that computer.
3. Both computers may keep Excel open and edit at the same time. Products have permanent IDs, so different products and different fields can converge safely.
4. Save Excel after every group of edits. A change is not published to TEK STOCK's shared cloud state until the workbook is saved. Leave TEK STOCK running so it can synchronize automatically.
5. Wait for synchronization before relying on the mobile view. Mobile is read-only and reflects the confirmed cloud state; it never writes to either workbook.

## Conflicts

If both computers change the same field or replace the same product photo before synchronizing, TEK STOCK stops that change and asks which value to keep. Review the displayed Excel and cloud values (photos are identified by their verified hashes), then choose **Keep Excel** or **Keep cloud** for every listed field. Closing the conflict dialog makes no change. TEK STOCK publishes a choice only after the complete resolution succeeds.

Different-field edits do not require a choice. A delete that conflicts with another computer's edit also stops for review rather than discarding data.

## Photos and stock

Photo replacements and stock changes follow the same save-and-synchronize rule. Replacing the same photo independently on two computers never silently overwrites the first choice; the second replacement remains pending until an operator explicitly keeps Excel or cloud. A photo may appear after the product fields because each computer fills its verified local photo cache asynchronously. Do not copy cache files or workbooks between computers.

## Updates and recovery

Use **Update** for future fixes. An ordinary Update replaces application files while preserving the private workbook, workbook client ID, pending outbox, credentials, backups, and photo cache.

Do not use **Reinstall** for normal updates, synchronization, migration, or conflict recovery. Reinstall is a separate operator action and is not invoked by those flows. If an Update or synchronization cannot complete, keep Excel saved, leave the local files in place, and collect diagnostics before requesting support.
