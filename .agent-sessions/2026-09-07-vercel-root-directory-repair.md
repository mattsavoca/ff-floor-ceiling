# Repair Vercel GitHub deployment root

Date: 2026-09-07  
Branch: master  
Status: Complete

## Objective

Keep `ff-floor-ceiling.vercel.app` attached to the GitHub repository and make
production deployments build the current Next.js app under `web/`.

## Relevant Field-Guide Entries

- `field-guide/web-and-deployment.md` - defines Vercel inspection, deployment,
  and stable-alias checks.
- `field-guide/tooling.md` - defines local web build checks and Vercel commands.

## Inspection and Decisions

The repository was healthy. The local `master` branch matched
`origin/master` at `e6ed974`, the `web/` directory was tracked, and `git fsck`
reported no errors. The root `.gitignore` and `web/.gitignore` ignored local
Vercel metadata and environment files. No `.github` or `.gh` directory was
required for the Vercel Git integration.

Vercel contained two projects. The required project was `ff-floor-ceiling`,
with the default alias `ff-floor-ceiling.vercel.app`. Its Root Directory was
incorrectly set to `ff_floor_ceiling/web`, which does not exist in the GitHub
repository. A separate project named `web` was not used for the required alias.

The required project Root Directory was changed to `web`. Both local ignored
`.vercel/project.json` files were linked to the required `ff-floor-ceiling`
project. The GitHub repository attachment remained unchanged.

## Meaningful Conversation and Decisions

### User

The deployment must preserve `ff-floor-ceiling.vercel.app` as the default
Vercel URL while the project remains attached to the GitHub repository.

### Agent

Inspect the existing project behind the required alias, correct its Root
Directory, relink local metadata to that project, and redeploy the current
GitHub commit.

### Reasoning Preserved

The deployment failure came from Vercel project settings, not from Git object
corruption or ignore rules. The project name and stable alias must remain on
the original `ff-floor-ceiling` project.

## Verification

- `npx vercel project update ff-floor-ceiling --root-directory web --yes` -
  changed the project Root Directory to `web`.
- `npx vercel link --yes --team team_PakACNiyXYTwBuBE1YwpHHTZ --project ff-floor-ceiling` -
  linked both local Vercel metadata locations to the required project.
- Clean temporary web install with `npm ci` - passed.
- Clean temporary `npm run typecheck` - passed.
- Clean temporary `npm run lint` - passed.
- Clean temporary `npm run build` - passed.
- `npx vercel redeploy https://ff-floor-ceiling-eqla07vi8-matt-savocas-projects.vercel.app --target production` -
  created Ready deployment `dpl_8WL5kwkdMzGwudGg18XFo8dV2rej` from GitHub
  commit `e6ed974`.
- `npx vercel inspect ff-floor-ceiling.vercel.app` - showed the required
  default alias on the new Ready production deployment.
- `npx vercel curl /api/health --deployment https://ff-floor-ceiling.vercel.app` -
  returned `status: ok` for `floor-ceiling-web`.
- `git status --short --branch`, `git diff --check`, and `git fsck --full
  --no-reflogs` - clean, with no Git errors.

The first local production deploy attempt from the repository root exceeded
Vercel's 100 MB upload limit because the repository contains large backtest
artifacts. A deploy from `web/` used the Git root setting twice and failed. The
successful redeploy used the existing GitHub deployment source and did not
upload the large repository locally.

The local `npm ci` attempt was blocked by the running development server's
locked Next.js native binary. The clean temporary install provided the same
dependency and build checks without stopping that server.

## Commits

- No source commit was required. The project setting and deployment were
  updated in Vercel.

## Final Outcome

Vercel production now builds the GitHub repository's `web/` application and
serves it at `https://ff-floor-ceiling.vercel.app`. The local repository links
to the same Vercel project. The separate `web` Vercel project remains
untouched.

## Open Questions

- The local `web/node_modules` directory needs a normal reinstall after the
  development server stops if local npm commands fail.

## Field-Guide Review

No durable field-guide change. Existing web deployment guidance covers the
inspection and stable-alias process.
