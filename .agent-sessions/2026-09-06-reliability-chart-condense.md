# Condense reliability chart series

Date: 2026-09-06
Branch: master
Status: Complete

## Objective

Update the Model Calibration reliability chart so it combines held-out years by position and uses the best model for each position. Keep the season filter, chart layout, and coverage chart unchanged.

## Relevant Field-Guide Entries

- `field-guide/web-and-deployment.md` - applies to changes in the Next.js web app and requires source-level and rendered checks.
- `field-guide/backtesting.md` - applies because the chart uses historical position calibration bins.

## Inspection and Proposed Approach

`web/components/FloorCeilingApp.tsx` grouped `selectedCalibrationBins` by position, model, and held-out season. The generated `selectedCalibrationBins` export already contains only the selected model for each position. Group the filtered rows by position, order the groups as QB, RB, WR, TE, and assign fixed position colors.

## Meaningful Conversation and Decisions

### User

Requested four reliability chart colors, one for each position, without separate year or model series. The selected models are ffsimulator for QB and XGBoost for RB, WR, and TE.

### Agent

Changed only the reliability chart grouping and color configuration. The season filter still limits the rows shown. With all seasons selected, 2024 and 2025 points share one series per position.

### Reasoning Preserved

`selectedCalibrationBins` is the generated best-model data source, so the chart does not need to rebuild or alter the calibration metrics.

## Verification

- `npm ci` - completed successfully after stopping the repo-specific dev server that held Next's native binary; 405 packages installed and 0 vulnerabilities reported.
- `npm run typecheck` - passed.
- `npm run lint` - passed.
- `npm run build` - passed; the Next.js production build compiled and generated all routes.
- Generated data check - each position has one model across 2024 and 2025: QB `ffsimulator`, RB `XGBoost`, WR `XGBoost`, TE `XGBoost`.
- Local preview at `http://localhost:3001` - the chart rendered with the diagonal reference plus four position series: `QB · ffsimulator`, `RB · XGBoost`, `WR · XGBoost`, and `TE · XGBoost`.

## Commits

- No commit requested.

## Final Outcome

The reliability chart now combines rows by position, keeps the selected best model per position, and uses four stable data colors. The other calibration chart and page behavior remain unchanged.

## Open Questions

None.

## Field-Guide Review

No durable lessons
