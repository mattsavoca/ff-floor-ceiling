# Sidebar and Manual Overrides Cleanup

Date: 2026-09-08
Branch: master
Status: Complete

## Objective

Remove unused sidebar content and simplify the Manual Overrides page. Set the
default monitoring context to 2026 Week 1 and make override reasons optional.

## Relevant Field-Guide Entries

- `field-guide/web-and-deployment.md` - The change affects the Next.js web app.
- `field-guide/init.md` - The repository records substantial coding sessions.

## Decisions

- Removed the sidebar nav descriptions, current-run section, run card, and
  owner row. Kept the privacy note in the sidebar footer.
- Changed the monitoring defaults to 2026 Week 1. This also updates the
  default topbar context and context-strip selections.
- Removed the Manual Overrides policy strip and Override precedence pane.
- Kept the reason field for optional notes and removed the UI and API gates
  that rejected an empty reason.

## Verification

- `npm run typecheck` from `web` - passed.
- `npm run lint` from `web` - passed with 11 existing warnings and no errors.
- `npm run build` from `web` - passed.
- Local Next.js preview - confirmed the requested sidebar and Manual Overrides
  elements, default selectors, heading, paragraph, and enabled save button.
- `git diff --check` - passed with Git line-ending warnings.

## Commits

- No commit created. The user did not request a commit.

## Final Outcome

Updated `web/components/FloorCeilingApp.tsx`, `web/app/globals.css`, and the
live override route. The Manual Overrides page now uses the requested layout
and allows saves without a required reason.

## Open Questions

- None.

## Field-Guide Review

No durable lessons.
