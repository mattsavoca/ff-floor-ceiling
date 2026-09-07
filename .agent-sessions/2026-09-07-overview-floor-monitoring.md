# Integrate floor monitoring into Overview

Date: 2026-09-07
Branch: master
Status: Complete

## Objective

Add the completed p15 floor model to the existing Overview monitoring page.
Keep ceiling monitoring in place, add matching floor KPIs, charts, model-mix
cards, and weekly position results, and avoid creating a separate Overview
sub-tab.

## Relevant Field-Guide Entries

- `field-guide/init.md` - Routed the task to the web and deployment guidance.
- `field-guide/web-and-deployment.md` - Required the focused Next.js checks.
- `field-guide/architecture.md` - Confirms that the web app presents saved
  artifacts and does not train or run the model in the browser.

## Inspection and Proposed Approach

`web/components/FloorCeilingApp.tsx` already rendered weekly ceiling data from
`oosWeeklySummaries` and `oosWeeklyPositionMetrics`. The generated calibration
data also contained matching floor exports:
`floorOosWeeklySummaries` and `floorOosWeeklyPositionMetrics`.

The smallest consistent change was to extend `OverviewPage` with the floor
data path and reuse the existing cards, charts, tables, and click-to-select
week behavior. The calibration tab remains the detailed historical review.

## Meaningful Conversation and Decisions

### User

Requested that the complete floor model be integrated into `OVERVIEW`, using
the existing ceiling presentation, with similar charts and KPIs and no
separate sub-tab.

### Agent

Added ceiling and floor model-mix cards, KPI rows, last-four-week coverage
charts, position coverage charts, and weekly position scorecards in the same
Overview page. Changed the existing floor drift readout to use the selected
week instead of the all-season floor calibration result.

### Reasoning Preserved

Floor coverage targets 15% of final scores at or below p15. Ceiling coverage
targets 85% at or below p85. The Overview must show weekly values from the
matching weekly summary exports, while the calibration tab can continue to
show all-season and season-filtered evidence.

## Verification

- `npm run typecheck` from `web/` - passed.
- `npm run lint` from `web/` - passed.
- `npm run build` from `web/` - passed. Next.js compiled and generated all
  static pages.
- `git diff --check` - passed.
- Existing unrelated changes in `docs/`, `services/`, and `tests/` were
  preserved.

## Commits

- None. The user did not request a commit.

## Final Outcome

The Overview now presents ceiling and floor monitoring together. The floor
view uses the completed p15 weekly data and has no new tab or separate
navigation path.

## Open Questions

- None.

## Field-Guide Review

No durable lessons
