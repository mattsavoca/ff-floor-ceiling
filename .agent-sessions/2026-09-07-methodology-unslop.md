# Unslop the Methodology tab

Date: 2026-09-07
Branch: master
Status: Complete

## Objective

Rewrite the Methodology tab so it tells stakeholders which model supplies each
forecast number and what evidence supports the model choice. Reduce repeated
definitions, preserve the three model cards, add the floor/ceiling choice
view, and remove the false source-status indicator.

## Relevant Field-Guide Entries

- `field-guide/init.md` - Routed the task to the web and testing guidance.
- `field-guide/code-conventions.md` - Preserved existing component and class
  patterns.
- `field-guide/testing.md` - Required typecheck, lint, build, and browser
  checks for the web change.
- `field-guide/web-and-deployment.md` - Required the focused Next.js checks.

## Inspection and Proposed Approach

`MethodologyPage` contained repeated definitions, a shared constants panel,
and a grey paragraph that obscured the source of each output. The existing
Calibration page supplied the toggle pattern, and
`floorPositionModelSelections` supplied the floor comparison data.

The serving contract in `web/lib/server/forecast.ts` resolved the median
ambiguity: `ffsimulator` supplies p50 for every position. For RB, WR, and TE,
the CSV projection remains a separate average, while XGBoost supplies p15 and
p85. The source grid therefore shows the shipped output path, and the choice
table remains explicitly labeled as held-out model-selection evidence.

## Meaningful Conversation and Decisions

### User

Requested a shorter, stakeholder-facing Methodology tab. The request required
the exact output glosses, removal of the shared contract and duplicated choice
copy, a model-output grid, and a Floor/Ceiling toggle above the choice table.
The user also required that the median-source contradiction be resolved before
the grid was built.

### Agent

Used the serving forecast code to choose `ffsimulator p50` for all four
positions. Added the output-source grid, dynamic ceiling and floor choice
views, the requested copy, the Path 1 limitation, and the Path 2 output note.
Removed unused contract and choice-result CSS along with the misleading source
status dot.

### Reasoning Preserved

The source grid answers where the shipped floor, median, and ceiling come
from. The choice table answers which candidate won held-out calibration. Those
views can differ, so the table keeps its held-out caption and the page states
that a new completed season can change a pick.

## Follow-up

The three expandable Model Card panels now appear below the Model Choice pane.
The direct XGBoost titles now read `Machine Learning-based Ceiling Model` and
`Machine Learning-based Floor Model`. The card bodies and the ffsimulator title
remain unchanged.

The follow-up removed the Candidate and Implemented status pills, removed the
held-out-results action, renamed the choice pane to `Positional Model
Selection`, and expanded the range note with short coverage and pinball-loss
definitions.

The latest follow-up keeps `ContextStrip` in the app shell but hides it when
Methodology is active. It changes the section title to `Floor and Ceiling
Modeling Process`, removes the old scoring and test sentence, and adds the
requested backtest description and highlighted percentile assumption.

## Verification

- `npm run typecheck` from `web/` - passed.
- `npm run lint` from `web/` - passed with 11 existing warnings and no errors;
  no new Methodology lint issue was reported.
- `npm run build` from `web/` - passed. Next.js compiled and generated all
  static pages.
- T3 browser check - passed on desktop and mobile layouts. The Floor / P15
  toggle changed the table caption and selected models as expected.
- T3 browser check - confirmed Methodology has no `.context-strip` element and
  Overview still has one.
- `git diff --check` - passed; Git emitted only its LF/CRLF normalization
  warnings.
- Existing unrelated worktree changes were preserved.

## Commits

- None. The user did not request a commit.

## Final Outcome

The Methodology tab now leads with the product contract, shows the serving
model for each percentile and position, and lets readers compare floor and
ceiling model choices before opening the three detailed Model Cards.

## Open Questions

- None.

## Field-Guide Review

No durable lessons
