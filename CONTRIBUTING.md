# Contributing

This repo follows a **git-flow** model: all development happens on `develop`,
`master` holds only released code, and tags trigger the Docker release.

## Branches

| Branch                                     | Purpose                                      | Protection                                                                                                  |
| ------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `master`                                   | Production code, tagged releases (`vX.Y.Z`)  | PR required, CI (`ci` check) required and up to date with head, no force-push/deletion, enforced for admins |
| `develop`                                  | Integration branch — always buildable        | CI (`ci` check) required and up to date with head, no force-push/deletion                                   |
| `feat/*`, `fix/*`, `chore/*`, `refactor/*` | Short-lived work branches                    | —                                                                                                           |
| `release/*`                                | Stabilization + version bump for one release | —                                                                                                           |
| `hotfix/*`                                 | Urgent fixes from `master`                   | —                                                                                                           |

Both protected branches are subject to the **same required `ci` status check**
defined in `.github/workflows/ci.yml` (lint, format, typecheck, test, build).

## Day-to-day flow

1. Branch from `develop`:

   ```bash
   git switch develop && git pull
   git switch -c feat/my-feature
   ```

2. Work, commit (Conventional Commits: `feat:`, `fix:`, `chore:`, `test:`, …).
3. Push and open a **PR into `develop`** — CI must pass and the branch must be
   up to date before merge. GitHub deletes the head branch automatically
   (`delete_branch_on_merge` is on).
4. Dependabot PRs also target `develop` (configured via `target-branch` in
   `.github/dependabot.yml`); minor/patch updates auto-merge after CI via
   `.github/workflows/dependabot-auto-merge.yml`.

## Documentation

Extensive docs live in [`docs/`](docs/README.md) (guides + ADRs).

- A PR that **changes behavior must update the guide/ADR it crosses** — in
  the same PR. Code comments remain the source of truth; docs describe
  intent.
- New architecture-level decisions get a new ADR in `docs/adr/` (next free
  number, `docs/README.md` index entry); see the existing files for the
  format.

## Code design

Contributed code **shall follow the SOLID principles**:

- **S**ingle Responsibility — one reason to change per module/class.
- **O**pen/Closed — extend behavior without modifying existing code.
- **L**iskov Substitution — subtypes must be substitutable for their base types.
- **I**nterface Segregation — small, focused interfaces over fat ones.
- **D**ependency Inversion — depend on abstractions, not concrete
  implementations (e.g. inject dependencies rather than instantiating them
  inline).

Reviewers may ask for refactors where SOLID is violated; significant design
changes should be documented as an ADR (see [Documentation](#documentation)).

## Releases (`develop` → `master`)

1. Create a release branch from `develop`:

   ```bash
   git switch -c release/1.9.0 develop
   ```

2. Bump `package.json` version and write the `CHANGELOG.md` entry (move the
   `Unreleased` section under the new `vX.Y.Z` heading).
3. Open a PR from `release/*` into `develop`, let CI pass, merge.
4. Fast-forward `master` to `develop` via a second PR (`release/*` → `master`)
   or locally: `git switch master && git merge --ff-only develop && git push`.
5. Tag and publish the GitHub Release — this triggers
   `.github/workflows/release.yml` (CI as quality gate, then the Docker image
   is pushed to `ghcr.io/j-stechmann/geldlage:<tag>`).

## Hotfixes (`master` → back to `develop`)

1. Branch from `master`: `git switch -c hotfix/1.9.1 master`
2. Fix, bump the patch version, update `CHANGELOG.md`.
3. PR into `master`, merge, tag + publish the release.
4. Back-merge: PR `hotfix/*` (or `master`) into `develop` so the fix isn't
   lost in the next release.

## Notes

- The GitHub Release (not the git tag) is what publishes the Docker image.
- Versions are also tagged `vX.Y.Z` — see the existing tags for the pattern.
- `enforce_admins` is on for `master`: the same rules apply to the repo admin
  (no self-merging broken or unreviewed-by-CI code).
