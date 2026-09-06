# Field-guide curation for model experimentation

Date: 2026-09-06
Branch: unavailable
Status: Complete

## Objective

Promote the durable experimentation lessons from the direct XGBoost p85 and
SHAP sessions into the project field guide. Keep one-off results and current
model warnings in their original session logs.

## Relevant Field-Guide Entries

- `field-guide/init.md` - index that must expose every guide entry.
- `field-guide/backtesting.md` - historical FBG joins, quantile definitions,
  and baseline calibration checks.
- `field-guide/testing.md` - focused checks before treating backtest results as
  calibrated.
- `field-guide/architecture.md` - separation between player ranges and
  downstream team or game experiments.
- `field-guide/recurring-problems.md` - existing calibration and FBG data risks.

## Inspection and Decisions

The XGBoost and SHAP session logs contain a durable workflow as well as
experiment-specific findings. The durable workflow is now a separate entry
because direct model experiments and SHAP interpretation have a distinct
retrieval purpose from the existing simulation calibration rules.

The permanent entry records:

- separate direct-model outputs from the production baseline,
- one quantile model per position,
- prior-season walk-forward evaluation,
- `actual_score` as the p85 target,
- explicit FBG set selection and join audits,
- duplicate-feature checks before interpretation,
- baseline metrics required for model comparison, and
- raw-output SHAP with additivity checks and causal limits.

The current QB result, Trevor Lawrence example, exact duplicate feature pair,
and projected-sack warning remain in the session logs because they are evidence
from this experiment, not permanent product rules.

## Review and Extraction

### Initial Misunderstanding

- The first review treated the XGBoost and SHAP work as session-only because
  the current results are mixed. The user clarified that experimentation
  workflow belongs in the field guide even when individual candidates remain
  experimental.

### Durable Lessons

- Direct p85 models need a separate experiment boundary, position-specific
  walk-forward evaluation, explicit target definition, baseline comparison,
  and SHAP attribution checks.
- Exact duplicate or highly correlated features limit the meaning of individual
  feature attribution.

### Task-Specific Details

- The 2023 warm-up choice, 144-candidate grid, two-season metric table,
  Trevor Lawrence underprediction, and QB projected-sack direction remain in
  the dated XGBoost and SHAP logs.

### Existing Coverage

- `field-guide/backtesting.md` already covers FBG joins, quantile definitions,
  and calibration summaries.
- `field-guide/testing.md` already covers focused checks before calibration
  claims.
- `field-guide/architecture.md` already keeps player ranges separate from
  downstream team and game experiments.

### Proposed Changes

- Add `field-guide/model-experimentation.md` as the primary home for the
  direct p85 and SHAP workflow.
- Add the entry and retrieval keywords to `field-guide/init.md`.
- Mark the two source session logs as reviewed.

### Potential Enforcement

- Keep the current output audits and SHAP additivity check as required manual
  verification.
- Consider a future Python test for exact duplicate projection columns,
  unique out-of-sample keys, finite predictions, and required metric columns.

## Implementation

- Added `field-guide/model-experimentation.md`.
- Added the entry and retrieval keywords to `field-guide/init.md`.
- Updated both XGBoost session logs with the completed field-guide review.

## Verification

- Confirmed every path in the new entry exists.
- Confirmed the index links to the new entry.
- Ran `git diff --check` on the changed Markdown files.
- The underlying XGBoost and SHAP verification remains recorded in the two
  source session logs.

## Final Outcome

The field guide now includes the direct p85 experimentation workflow and SHAP
interpretation rules. It does not promote the current QB behavior or the
two-season performance results into general product guidance.

## Open Questions

- Whether the direct model remains stable after removing one of the exact
  duplicate projection features.
- Whether later seasons support a broader production decision by position.

## Field-Guide Review

Accepted

No commit was created.
