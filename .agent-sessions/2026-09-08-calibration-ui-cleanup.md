# Calibration UI cleanup

Date: 2026-09-08
Branch: master
Status: Complete

## Objective

Simplify the web app Calibration tab. Rename the page heading, remove the
intro and supporting status text, make the model summary full width, remove
the extra policy panes, hide metric detail copy in calibration cards, and put
the ceiling check below the estimate chart at full width.

## Relevant Field-Guide Entries

- `field-guide/web-and-deployment.md` - Next.js preview and build checks for
  changes under `web/`.

## Inspection and Proposed Approach

`web/components/FloorCeilingApp.tsx` renders separate Ceiling and Floor
calibration views through a shared `SectionIntro`, `MetricCard`, and chart-grid
style. The smallest consistent change was to apply the requested presentation
updates to both views, keep metric detail copy available to Overview, and add a
full-row calibration check class for the ceiling view.

## Meaningful Conversation and Decisions

### User

Requested a focused cleanup of the Calibration tab, including exact heading
copy, removal of status and explanatory panes, shorter Past results controls,
and a full-width row for the ceiling check.

### Agent

Applied the same calibration presentation rules to Ceiling / P85 and Floor /
P15 so the subviews do not switch back to the removed UI. Preserved the
shared metric detail behavior for non-calibration pages.

### Reasoning Preserved

The Calibration tab contains two views. The request names the ceiling chart,
but the surrounding elements are shared in meaning, so both views use the
same heading, summary, Past results, and pane removals.

## Verification

- `npm run typecheck` from `web/` - passed.
- `npm run lint` from `web/` - passed with 11 existing warnings and no errors.
- `npm run build` from `web/` - passed; Next.js generated the production routes.
- Local collaborative browser at `http://localhost:3000/` - confirmed the
  Calibration heading, removed intro/status content, zero calibration metric
  detail nodes, zero policy panes, and a check panel below the estimate panel
  at full grid width.
- Responsive browser check at iPhone 12 Pro size - confirmed the calibration
  layout stacks cleanly and both charts use the available content width.

## Commits

- No commit created.

## Final Outcome

The Calibration tab now shows `Model Calibration`, no intro paragraph or top
status pills, a full-width model summary, compact metric cards, the requested
Past results label, and a full-width check panel below the estimate chart. The
Test basis and Use this result panes are removed from both calibration views.

## Open Questions

- None.

## Field-Guide Review

No durable lessons
