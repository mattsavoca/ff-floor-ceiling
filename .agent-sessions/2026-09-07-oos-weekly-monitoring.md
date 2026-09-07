# OOS weekly model monitoring controls

Date: 2026-09-07  
Branch: master  
Status: Complete

## Objective

Link the top context strip to the Overview page and show the selected
position-specific model's performance for the 2025 out-of-sample weeks 14,
15, 16, and 17.

## Relevant Field-Guide Entries

- `field-guide/architecture.md` - defines the web and model-data boundary.
- `field-guide/testing.md` - defines the validation checks for the web app.
- `field-guide/web-and-deployment.md` - defines local preview and deployment
  boundaries.

## Inspection and Decisions

The context strip previously exposed 2026, 2025, and 2024 seasons plus early
weeks, while the Overview page showed a stored Week 1 2026 forecast. The
calibration data already contained the selected model map: `ffsimulator` for
QB and XGBoost for RB, WR, and TE.

The calibration-data generator now emits weekly selected-model metrics for the
four OOS weeks and for each supported position. The Overview page reads those
generated rows instead of recalculating metrics in the browser. The context
strip keeps its controls usable while making the full strip keyboard-accessible
as a link to Overview. Changing a control from another page also opens the
matching Overview slice.

Only season 2025 and weeks 14 through 17 are available in the context-strip
selectors.

## Meaningful Conversation and Decisions

### User

Show the best model's performance on OOS data, with only 2025 Weeks 14, 15,
16, and 17 available, and link the context strip to Overview.

### Agent

Used the existing generated calibration artifact as the source of truth,
added weekly position and overall summary rows, and presented the selected
model mix and performance details in Overview. Preserved the user's unrelated
simulation-count changes in the working tree.

## Verification

- `python backtest_fbg_2023_2025\scripts\10_build_calibration_page_data.py` -
  regenerated the typed calibration artifact.
- Focused artifact check - confirmed 16 position rows, 4 weekly summaries,
  the selected model map, and summary coverage values for Weeks 14-17.
- `npm run typecheck` in `web` - passed.
- `npm run lint` in `web` - passed with no warnings.
- `npm run build` in `web` - passed, including static page generation.
- `git diff --check` - passed with no whitespace errors.
- Local T3 preview at `http://localhost:3001` - confirmed the four selector
  options, Overview navigation, Week 14 and Week 17 rendering, model mix,
  and mobile-width layout without horizontal overflow.

## Commits

- No commit was created.

## Final Outcome

The context strip now links to Overview, its selectors are limited to the OOS
scope, and Overview shows the selected model's weekly performance for the
chosen week.

## Open Questions

- Deployment was not requested. The public Vercel URL remains unchanged.

## Field-Guide Review

No durable field-guide update was needed. The existing web, architecture, and
testing guidance covered this implementation.
