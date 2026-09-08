# Overview Context Strip Cleanup

Date: 2026-09-08
Branch: master
Status: Complete

## Objective

Update the Overview context strip in `web` so its default is 2025 Week 17,
week choices match the available season data, and obsolete metric and date
metadata are removed. Preserve the separate 2026 Week 1 forecast-run context.

## Relevant Field-Guide Entries

- `field-guide/web-and-deployment.md` - The change affects the Next.js web app.
- `field-guide/init.md` - The repository requires a session record for
  substantial coding work.

## Inspection and Proposed Approach

`web/components/FloorCeilingApp.tsx` held a single fixed week list for both
seasons, defaulted the shared run context to 2026 Week 1, and rendered the
Metric, Source refresh, and Forecast created controls in `ContextStrip`.
Overview evidence covers 2025 Weeks 14 through 17. The bundled forecast run
covers 2026 Week 1.

The smallest safe change keeps forecast-run state unchanged and adds separate
Overview monitoring state. The context strip uses season-specific options:
2025 maps to Weeks 14 through 17, and 2026 maps to Week 1. Changing Season
selects the latest available week for that season when the current week is not
valid.

## Meaningful Conversation and Decisions

### User

Requested an Overview-focused UI update for the default season and week,
season-specific available weeks, removal of the Metric dropdown, and removal
of both date metadata blocks.

### Agent

Used the project forward-implementation rule and the web field guide. Kept the
2026 Week 1 forecast workflow separate from the 2025 Week 17 Overview default
so the Overview change does not make the projection form's run context invalid.

### Reasoning Preserved

The fixed list was a union of two different data contexts. A single shared
selector allowed invalid season-week pairs. The Overview selector must reflect
monitoring availability, while the forecast workflow must retain its own run
context.

## Verification

- `npm run typecheck` from `web` - passed.
- `npm run lint` from `web` - passed with 11 existing warnings and no errors.
- `npm run build` from `web` - passed. Static and dynamic routes generated.
- Local Next.js preview - default context showed Season 2025 and Week 17; the
  Week options were 14, 15, 16, and 17; Metric and both date blocks were absent.
- Local preview season switch - 2026 showed only Week 1; switching back to
  2025 restored Weeks 14 through 17 and Week 17.
- `git diff --check` - passed with only Git line-ending warnings.

## Commits

- No commit created. The user did not request a commit.

## Final Outcome

Updated `web/components/FloorCeilingApp.tsx` and removed obsolete context-strip
CSS from `web/app/globals.css`. The Overview now has the requested default and
valid season-specific week choices. The Metric control, Source refresh date,
and Forecast created date are removed.

## Open Questions

- None.

## Field-Guide Review

No durable lessons
