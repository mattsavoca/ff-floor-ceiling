# Document the ffsimulator quarterback model

Date: 2026-09-07
Branch: master
Status: Complete

## Objective

Create a model card for the `ffsimulator` quarterback range model and expose
the card in the `METHODOLOGY` tab. Preserve the current model behavior and
document the difference between the forward QB range description and the
generated floor comparison selector.

## Relevant Field-Guide Entries

- `field-guide/architecture.md` - Confirms that the web app presents saved
  artifacts and that `ffsimulator` produces independent player ranges.
- `field-guide/backtesting.md` - Defines the walk-forward backtest, p15 and
  p85 metrics, and QB conditioning baseline.
- `field-guide/model-experimentation.md` - Requires scorecard evidence before
  changing the production model path.
- `field-guide/web-and-deployment.md` - Requires focused Next.js checks for
  web changes.

## Inspection and Decisions

The model is a rank-conditioned historical outcome sampler, not a fitted
machine-learning model. It samples rank uncertainty around the expected rank,
uses a nearby position and rank outcome pool, and reports p15, p50, and p85.
The held-out evidence covers 2023 through 2025 with 1,444 QB rows and 1,000
draws per player-week. The card reports the PPR scoring contract, target-season
safe history, bootstrap intervals, relevant factors, and known limits.

The card keeps `ffsimulator` as the QB baseline. It records that the generated
floor comparison currently selects XGBoost for the QB p15 reference while the
combined forward range describes `ffsimulator` as the QB p15 path. The task
asked for documentation, so the selector was not changed silently.

## Changes

- Added `docs/model_card_ffsimulator_qb.md` with the full model card.
- Added an expandable `ffsimulator` QB model-card panel to
  `web/components/FloorCeilingApp.tsx`.
- Added the model card and backtest metadata to the `METHODOLOGY` source map.
- Added the simulation panel accent and subheading style in
  `web/app/globals.css`.

## Verification

- `npm run lint` from `web/` - passed with existing warnings and no errors.
- `git diff --check` - passed. Git reported existing line-ending warnings.
- `npm run typecheck` from `web/` - blocked by the existing live-inference
  `OverrideHistoryEntry` error at `FloorCeilingApp.tsx`: the object appended
  to history does not include the required `action` field.
- `npm run build` from `web/` - blocked by the same type error after the
  production bundle compiled.
- No browser preview was run. The preview tools were not needed for the
  documentation and static checks.

## Commits

- None. The user did not request a commit.

## Final Outcome

The QB `ffsimulator` model now has a repository model card and a matching
expanded panel in the `METHODOLOGY` tab. The card reports current evidence and
calls out the selector mismatch for review before a future model release.

### Follow-up correction

The first placement put the folded card after two large methodology cards.
Move the card directly below the range summary so the `MODEL CARD` row is
visible near the start of the tab. The current project dev server is on port
3001. Port 3000 belongs to a different local project.

Follow-up verification: the source order places the card at line 1478, before
the long methodology model grid. `npm run lint` still reaches the existing
live-inference error where `useDemoSample` is called from `resetUpload`, plus
existing warnings. The card move itself adds no lint error.

### Copy correction

The user replaced the visible title with `ffsimulator floor and ceiling
model` and replaced the subtitle with the supplied description. The repository
card heading now uses the same title. Source and the running port 3001 bundle
contain both updated strings.

## Open Questions

- Resolve whether the generated floor selector or the combined forward range
  is the serving contract for QB p15, then update the evidence and UI together.

## Field-Guide Review

No durable lessons
