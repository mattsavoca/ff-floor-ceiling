# Model monitoring site PRD

Date: 2026-09-06
Branch: master
Status: Complete

## Objective

Write the first product requirements document for a T3 website that presents
the project's data science method, model calibration, weekly projection-to-
simulation workflow, drift monitoring, and manual overrides.

## Relevant Field-Guide Entries

- `field-guide/architecture.md` - separates rankings, simulations, team
  signals, and game outputs.
- `field-guide/backtesting.md` - defines historical inputs, quantile bins, and
  calibration limits.
- `field-guide/model-experimentation.md` - defines direct p85 experiments and
  SHAP interpretation.
- `field-guide/recurring-problems.md` - records uncertainty, identity, and
  calibration risks.
- `field-guide/tooling.md` - records the R, Python, and Windows paths.

## Inspection and Decisions

The repository records a progression from the rank-conditioned player sampler,
through leakage-safe backtesting and tail analysis, to direct XGBoost p85
experiments and a Python team defense branch. The PRD keeps these model families
separate and labels the team and game paths as experimental.

The earlier `rostership-model-4for4` repository and the owner-supplied floor and
ceiling design document describe half-workload and quarter-workload reductions,
player exclusions, fixed projection edits, and a defense ceiling uplift. The PRD
turns these into one explicit, reversible override layer over original outputs.

The owner selected anonymous uploads with temporary browser sessions for the
first release. The PRD therefore defines an opaque signed session cookie,
session expiry, no account recovery, private artifact cleanup, rate limits, and
session-based isolation. Public methodology and curated demonstration data stay
open.

The owner also confirmed that leave-one-season-out evaluation was the original
method. Results looked too good, so the engineer investigated leakage on
2026-09-03 and changed the rule to use only seasons earlier than the target.
The PRD presents this as a decision stage in the methodology timeline.

## Implementation

- Added `docs/PRD_model_monitoring_site.md`.
- Defined Overview, Methodology, Model Calibration, Projection to Sim, and
  Manual Overrides tabs.
- Defined separate input-change and forecast-performance monitoring views.
- Defined interactive calibration and player-range visualizations with linked
  tables, filters, counts, reset controls, and plain-English explainers.
- Defined the FBG upload contract, run states, CSV fields, and worker boundary.
- Defined anonymous workspace records, expiry rules, isolation checks, and
  abuse limits.
- Defined override precedence, validation, revisions, reset behavior, and
  evaluation treatment.
- Defined delivery stages, acceptance criteria, and implementation prerequisites.

## Verification

- Read the current field guide, session logs, README files, source code, saved
  XGBoost metrics, and defense metrics.
- Read the owner-supplied HTML design document and the earlier repository's
  override files through the authenticated GitHub CLI.
- Read the T3 introduction, ECharts interaction documentation, and the
  quantile-loss reference.
- `git diff --check` - passed for the working tree changes.
- Searched the PRD for the old signed-in access wording and replaced it with
  anonymous session behavior.

## Final Outcome

The PRD is ready for review and later implementation. It treats the site as a
working weekly monitoring tool and as a public record of model decisions. It
does not claim that the current team defense or direct QB models are ready for
production.

## Open Questions

- Confirm the proposed 24-hour inactivity and seven-day absolute session limits.
- Replay the proposed drift thresholds against historical weeks before enabling
  automatic status labels.
- Select the hosting vendor after measuring a real worker run.
- Decide whether the owner admin path uses NextAuth.js or a deployment-level
  access control layer.

## Field-Guide Review

No durable field-guide change was requested in this session. The PRD records the
leakage correction and points to the dated correction log. The existing guide
wording remains pending a separate curation review.
