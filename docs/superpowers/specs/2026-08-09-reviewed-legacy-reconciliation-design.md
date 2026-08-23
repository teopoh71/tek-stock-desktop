# Reviewed Legacy Reconciliation Design

## Goal

Allow the normal TEK STOCK workbook sync to repair one previously reviewed legacy state without migrating any existing cloud ID or mutating cloud inventory.

The only approved identity changes are:

- restore model `5555`, ID `中角桌和其它数量.xlsx::忧闲椅和沙发床::10`, from the authoritative live snapshot into the workbook;
- retire model `121212`, ID `fc55fe56-9a1b-40ea-b377-9db2654e567f`, from the hidden workbook baseline because it is absent from both the live snapshot and current workbook.

## Safety boundary

A pure classifier runs after the workbook and live snapshot are read, but before ID assignment, delta creation, outbox writes, photo writes, or API mutation. It accepts only the exact reviewed 320/current, 322/baseline, 321/live identity relationship. IDs must be unique, the two named records must have the reviewed models, and every shared record must be semantically identical across all sides. Any extra missing, added, renamed, duplicated, or changed record fails closed with `WORKBOOK_REVIEWED_LEGACY_SCOPE_MISMATCH`.

On an exact match, sync takes a replacement-only path using the existing `replaceWorkbook` callback and expected workbook SHA. The replacement is the authoritative live 321-record snapshot. This restores 5555 and rebuilds the hidden baseline without 121212. It performs zero cloud operations, zero photo operations, and zero ID assignments.

## Non-goals

- no permanent-ID migration;
- no change to generic three-way merge or deletion semantics;
- no manual workbook edit;
- no cloud create, update, delete, image, or ID rewrite;
- no compatibility allowance for any other discrepancy.

## Verification

Pure tests pin the exact accepted set and reject third discrepancies. An integration test drives `syncWorkbook`, verifies one workbook replacement containing the live IDs, and proves that no ID assignment or API batch write occurs. Package gates and the full test suite must pass before building or installing 1.5.72.
