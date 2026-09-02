# Footballguys Week 1 Proof of Concept and Field Guide

Date: 2026-09-02
Branch: master, no commits yet in the parent repository
Status: Complete

## Objective

Extend the internal `ffsimulator` workflow to a more current Footballguys Week
1 2026 export, keep the scope to QB, RB, WR, and TE, remove free agents, and
produce a working Week 1 snapshot with 100 simulations. Then establish a
project-specific field guide so durable decisions survive future conversation
compaction.

## Relevant Field-Guide Entries

- `field-guide/architecture.md` - provider, player, team, and game boundaries
- `field-guide/code-conventions.md` - normalized ranking and range contracts
- `field-guide/recurring-problems.md` - missing uncertainty and fidelity risks
- `field-guide/testing.md` - FBG fixture and smoke-test expectations
- `field-guide/tooling.md` - Windows R commands and snapshot paths

## Inspection and Proposed Approach

The existing sampler is rank-conditioned. It can produce useful individual
player ranges, but independently sampled teammates do not share a game state.
The first NFL downstream adapter therefore remains experimental.

The FBG file has 2,998 rows, repeated set names, no explicit `rank` column, and
no explicit standard-deviation column. The offensive `Projections Consensus`
set is selected by its largest in-scope set, then filtered to QB, RB, WR, and
TE and stripped of `FA` rows. Positional rank comes from source row order. The
missing uncertainty uses median historical FantasyPros weekly `sd` by position
and rank, with a minimum of 0.5.

The Week 1 script uses the local `ffsimulator` season outcome pool because the
available weekly pool does not cover TE. This keeps the requested position scope
working while leaving a clear calibration task for the next stage.

## Meaningful Conversation and Decisions

### User

The user first clarified that the useful output needs a floor and ceiling for
Week 1, represented by p15 and p85. They then asked which rankings the prior
simulation used and whether Week 1 FantasyPros ranks were available.

The user identified a likely small-sample problem and supplied the more current
Footballguys file. They required QB, RB, WR, and TE only, no `FA` rows, an FBG
adapter, a solution for missing standard deviation, and a 100-simulation Week 1
snapshot before scaling to 10,000 simulations.

The user then requested a developer field guide before any further project
work, with continuous learning from future conversations.

### Agent

The implementation added `byor_fbg()` to the `fffloorceiling` package. It
selects the offensive consensus set, normalizes the rows, derives missing
positional ranks, and maps missing uncertainty from historical FantasyPros
weekly rank uncertainty. The existing `ffsimulator` package remains the
sampling engine. The new adapter stays in `fffloorceiling`, which preserves a
provider-neutral boundary without changing the sibling package.

The script was changed to use the FBG fixture and 100 simulations. It writes
player ranges, team ranges, experimental game margins, and metadata under
`outputs/`. A README section and public `byor_fbg()` documentation were added.

### Reasoning Preserved

- A 100-simulation run is a wiring and shape check. It is not a stable estimate
  of p15, p85, or win probability.
- The FBG rank snapshot is current for Week 1, while the current outcome pool is
  a local historical season pool. These are separate inputs and must remain
  visible in metadata.
- The historical FantasyPros `sd` mapping is a v0 proxy for missing FBG
  uncertainty. It needs out-of-sample interval calibration.
- Team and game results inherit the independent-player-environment limitation.
  Shared team or game effects and correlation data belong in a later stage.
- FBG set names repeat across offensive and defensive exports. Set selection
  must consider the in-scope offensive rows before rank derivation.

## Verification

- `R CMD INSTALL --no-multiarch --with-keep.source .` - succeeded.
- `library(fffloorceiling); testthat::test_dir('tests/testthat', reporter='progress')` -
  47 passing tests, zero failures and warnings.
- `R CMD build .` - succeeded and produced `fffloorceiling_0.1.0.tar.gz`.
- Clean-locale `R CMD check --no-manual fffloorceiling_0.1.0.tar.gz` - `Status: OK`.
- `Rscript scripts/week1_2026.R` - completed and wrote all four FBG outputs.
- Output checks - 400 players, 32 teams, 16 games, zero `FA` rows, and only
  QB, RB, WR, and TE.

The first direct `testthat::test_dir()` call omitted `library(fffloorceiling)`
and failed because this invocation does not load the package namespace. The
repository test entry point, `tests/testthat.R`, loads the package correctly.

## Commits

- None. The parent repository has no commits yet.

## Final Outcome

The FBG Week 1 proof of concept works. It produces player p15/p85 ranges,
team fantasy ranges, and experimental Week 1 game-margin outcomes from the
current Footballguys snapshot. The field-guide structure and this session log
now preserve the data contracts, assumptions, limitations, commands, and
follow-up work.

## Open Questions

- Build a position-complete Week 1 historical outcome pool so the FBG snapshot
  does not use the season pool as a TE workaround.
- Backtest and calibrate the historical FantasyPros rank-to-sd proxy against
  realized weekly outcomes.
- Increase the snapshot to 10,000 simulations after the input and output checks
  remain stable.
- Add shared team or game effects, then reassess team variance and the
  `nflseedR` adapter.
- Decide whether future FBG support should also use its raw stat projections as
  a point-mean model, instead of using the FBG ordering only.

## Field-Guide Review

Accepted

### Initial Misunderstandings

- The initial provider shape assumed fields such as FantasyPros `ecr` and `sd`.
  The FBG export has neither a direct rank field nor a standard-deviation field.
- A shared simulation ID does not make independently sampled players share a
  coherent game environment.
- A 100-simulation output can confirm pipeline wiring but cannot settle the
  small-sample concern.

### Durable Lessons

- Provider adapters must document rank and uncertainty derivation at the BYOR
  boundary.
- FBG set selection must distinguish the offensive consensus rows before
  filtering and rank assignment.
- p15 and p85 are the project Week 1 floor and ceiling contract.
- Team and game outputs remain experimental until shared game effects and
  calibration are validated.

### Task-Specific Details

- The selected FBG set ID is an input-file detail, not a permanent rule. The
  current metadata records the source name and input path, not the numeric set
  ID.
- The current random seed and the 2026 schedule are snapshot details.
- The local Windows `C.UTF-8` startup warning is a tooling detail, handled by
  the clean-locale check command.

### Existing Coverage

- `tests/testthat/test-rankings.R` enforces FBG population, positions, free-agent
  removal, rank, and uncertainty behavior.
- `tests/testthat/test-outcomes.R` covers range summaries and interval coverage.
- `README.md` documents the public workflow and current limitations.

### Proposed Changes

- Bootstrapped `field-guide/` with the prescribed index and five focused
  entries.
- Added this session log to preserve chronology, corrections, verification, and
  unresolved calibration work.
- Added `.Rbuildignore` entries so repository memory stays out of the R package
  build artifact.

### Potential Enforcement

- Keep the FBG fixture assertions and add a future regression test for the
  position-complete weekly outcome pool.
- Add an integration check that reads the generated snapshot and asserts the
  400-player, four-position, zero-FA contract before any 10,000-simulation run.
