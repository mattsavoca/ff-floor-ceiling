# Model monitoring site deployment and rollback

Date: 2026-09-06  
Branch: master  
Status: Complete

## Objective

Record the model monitoring site that was created, the Vercel deployments
that were inspected, and the rollback to the first Ready deployment that
contained the historical calibration evidence.

Keep the Vercel rollback separate from GitHub. Preserve the older deployment's
legacy FFFL context because the owner explicitly accepted it for this rollback.

## Relevant Field-Guide Entries

- `field-guide/architecture.md` - defines the web and model worker boundary.
- `field-guide/tooling.md` - defines the Windows and Vercel commands.
- `field-guide/web-and-deployment.md` - defines deployment inspection and
  rollback rules.
- `field-guide/backtesting.md` - defines the historical calibration evidence.

## Inspection and Decisions

The working tree contains the model monitoring PRD and the Next.js site under
`web/`, plus the job contracts under `contracts/` and the worker boundary under
`services/model-worker/`. The current source preview bundles 242 Week 1 2026
forecast rows and keeps historical evaluation pending until outcome rows load.

The newer source build was deployed as
`web-m18dk2ce0-matt-savocas-projects.vercel.app`, deployment
`dpl_8zWQmWk2fgTq4fQTCBoyNL7N8K8p`, created at `2026-09-06 13:50:33 -0400`.
The owner then requested the earlier deployment because it contained the
historical calibration evidence.

The Vercel deployment list contained several Ready builds. The oldest listed
build with the requested historical evidence was
`web-48reuzzml-matt-savocas-projects.vercel.app`, deployment
`dpl_FabBffwqE8YoTHi5fNJwyP8z7f86`, created at
`2026-09-06 12:06:17 -0400`.

The inspected deployment contained the Model calibration tab, 2025 Week 17,
13,378 player-game outcomes, 2024-2025 held-out rows, position calibration
tables, and historical error values. It also contained the old FFFL v1.0
scoring option and a 400 accepted-row display. The owner accepted those old
labels as part of the rollback.

The rollback changed the Vercel production alias only. GitHub and the working
tree remained unchanged.

## Meaningful Conversation and Decisions

### User

The site must roll back to the first Vercel deployment with the real historical
data, even if that deployment contains FFFL information.

### Agent

The agent inspected the old deployment, confirmed the historical calibration
content and legacy FFFL context, promoted the Ready deployment, then inspected
the stable alias and page output.

### Reasoning Preserved

The deployed artifact and the current worktree can describe different product
states. A Vercel rollback can restore the needed historical evidence without a
Git rollback. Legacy labels from that artifact do not expand the current
product scope.

## Verification

- `npx vercel inspect https://web-48reuzzml-matt-savocas-projects.vercel.app` -
  showed deployment `dpl_FabBffwqE8YoTHi5fNJwyP8z7f86`, target `production`, and
  status `Ready`.
- `npx vercel inspect https://web-m18dk2ce0-matt-savocas-projects.vercel.app` -
  showed the newer source build as deployment
  `dpl_8zWQmWk2fgTq4fQTCBoyNL7N8K8p`, target `production`, and status `Ready`.
- `npx vercel curl / --deployment https://web-48reuzzml-matt-savocas-projects.vercel.app` -
  showed the historical overview, calibration navigation, 2025 Week 17, and
  the FFFL v1.0 option.
- `npx vercel promote https://web-48reuzzml-matt-savocas-projects.vercel.app` -
  completed with `Success`.
- `npx vercel inspect https://web-two-ashen-eola21ih6h.vercel.app` - showed the
  stable alias on deployment `dpl_FabBffwqE8YoTHi5fNJwyP8z7f86`.
- `npx vercel curl / --deployment https://web-two-ashen-eola21ih6h.vercel.app` -
  showed the restored historical page and its legacy FFFL context.
- `git status --short` - showed the pre-existing application and PRD changes.
  The rollback added no Git changes.

## Commits

- No commit was created for the Vercel rollback or this field-guide update.

## Final Outcome

Vercel production now points to the first inspected Ready deployment with the
historical calibration page. The stable aliases are
`https://web-two-ashen-eola21ih6h.vercel.app` and
`https://web-matt-savocas-projects.vercel.app`.

The field guide now records the web boundary, Vercel inspection commands,
rollback process, and the rule that legacy FFFL content remains deployment
state rather than current product scope.

## Open Questions

- Decide later whether to replace the restored legacy deployment with a new
  build that includes the historical calibration evidence without FFFL labels.

## Field-Guide Review

Accepted
