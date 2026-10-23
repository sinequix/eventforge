# 1.0-rc Integration Status

Date: 2026-07-25

## Verification result

`1.0-rc` (5e0a56b) is NOT complete. 16 branches carried unmerged work at the start of
this pass; 6 previously-merged branches and their worktrees were cleaned up.

Merged and cleaned: issue-1, issue-7, issue-12, issue-13, issue-17, issue-18.
Also deleted: duplicate `1.0-rc-2`, stale `tebayoso/issue-14-sdk-marketplace`.

## Root cause of the CI failures

`Quality (Node 22/24)` fails on nearly every PR at the FIRST step, `pnpm format:check`.
Each branch adds new source + test files that were never run through Prettier:

| PR  | Branch                         | Unformatted files                                                                |
| --- | ------------------------------ | -------------------------------------------------------------------------------- |
| #36 | issue-25-otel-export           | `packages/core/src/telemetry.ts`, `packages/core/test/core.test.ts`              |
| #45 | issue-16-outcome-analytics     | `packages/core/src/outcomes.ts`, `packages/core/test/core.test.ts`               |
| #41 | issue-15-enterprise-governance | `packages/core/src/platform.ts`, `packages/core/test/platform.test.ts`           |
| #33 | issue-6-incident-correlation   | `packages/core/src/platform.ts`, `packages/core/test/correlation.test.ts`        |
| #32 | issue-23-notification-sinks    | `packages/core/src/notifications.ts`, `packages/core/test/notifications.test.ts` |

Fix per branch: `pnpm format` then commit. This is NOT a CI/CD defect — the pipeline is
correct and `1.0-rc` itself is green.

Genuine defects beyond formatting:

- PR #33 (issue-6): `error TS18048: 'match' is possibly 'undefined'` — real type error.
- PR #32 (issue-23): CodeQL check also failing.
- PR #33 (issue-6): `Validate deployment manifests` also failing.

## Conflict shape

8 PRs conflict with current `1.0-rc`. The conflicts are shallow and ADDITIVE — every
branch appends to the same two files:

- `packages/core/src/index.ts` (barrel exports)
- `workfiles/STATUS.md`

Resolution rule: keep BOTH sides, never drop existing exports/entries. Same for
`workfiles/ARCHITECTURE.md` and `workfiles/CONFIGURATION.md`.

Deeper conflicts needing judgement:

- issue-5-policy-packs: `apps/control-plane/src/app.ts`, `packages/core/src/contracts.ts`, `packages/core/test/core.test.ts`
- issue-21-sentry-linear: `apps/control-plane/src/app.ts`, `apps/control-plane/test/app.test.ts`
- issue-19-timeline: `apps/control-plane/migrations/003_commercial_platform.sql`

## Integration must be SERIAL

Every merge into `1.0-rc` touches `packages/core/src/index.ts` and `workfiles/STATUS.md`,
so each merge re-conflicts the remaining branches. Parallel conflict resolution against a
fixed base goes stale immediately. Reviews and per-branch CI fixes parallelize; the merge
into `1.0-rc` does not.

## Other findings

- `codex/issue-8-forge-connectors` had 326 lines pushed to origin with NO PR. PR #51 opened.
- `issue-22-operational-readiness` worktree held an uncommitted in-progress merge of
  `1.0-rc` (MERGE_HEAD=5e0a56b, 80 files staged). Assigned to a review worker.
- Nested worktree dirs added to `.git/info/exclude` (local only, tracked `.gitignore` untouched).
- `main` was NOT pushed, per instruction.

## Cross-cutting issues found during integration

### CRITICAL (fixed) — issue-20 test suite ran zero tests

`ReactionActionSchema` wrapped the `github.labels` option in `.refine`, which left
`z.discriminatedUnion` unable to read its discriminator, so the schema threw at MODULE LOAD.
Consequences: every import of `@eventforge/core` through the barrel broke, and the branch's
own test suite collected **0 tests** while still reporting success — it had never executed a
single assertion. Fixed with an outer `superRefine`; 3 tests now actually run.

Merging `codex/issue-20-reaction-worker` at `a7ef1ed` would have broken `1.0-rc` outright.
Safe as of `c58040a`.

Scan result: this `discriminatedUnion` + `.refine` pattern exists only on issue-20 (fixed).
issue-21 uses `discriminatedUnion` with no `.refine`. All remaining integration workers are
now instructed to verify a non-zero collected test count before reporting green.

### Pre-existing flake (unowned, needs its own issue)

`packages/mcp-server/test/http.test.ts` — "starts the local control plane when launched as
the standalone HTTP package" failed once with ECONNREFUSED on an ephemeral port, then passed
3/3 in isolation and in a clean full-gate rerun. Not caused by any branch under integration.
Will surface as random CI red until fixed.

### Confirmed fail-open defects found by review (all fixed in-branch)

| Branch   | Defect                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| issue-11 | `wilsonLowerBound()` returns NaN when agreements > eligible cases; `NaN < 0.98` is false, so the autonomy gate silently yields `eligible=true`                                |
| issue-24 | `billingDecision` checks `outageHours` AFTER its active/trialing/grace short-circuits, so active+400h outage still allows reactions — contradicts its own documented contract |
| issue-24 | `verifyStripeWebhook` has no replay-tolerance check on the webhook timestamp                                                                                                  |
| issue-20 | kill-switch freshness check is one-sided — a future `killEpochAt` passes                                                                                                      |
| issue-10 | test titled "admits only allowlisted discrete transitions" where the implementation never allowlisted anything                                                                |

Policy applied: fix anything fail-open, self-contradicting, or covered by a lying test.
Track purely latent style/robustness findings as per-issue follow-ups.

## Systemic pattern: one-sided freshness checks (fail-open on future timestamps)

Four independent branches each wrote a staleness check as `now - t < window` without also
bounding `t > now`. A future-dated timestamp therefore reads as maximally fresh and the
guard fails OPEN:

| Branch   | Guard                                | Effect of a future timestamp                     |
| -------- | ------------------------------------ | ------------------------------------------------ |
| issue-20 | kill-switch `killEpochAt`            | kill switch defeated, reaction allowed           |
| issue-11 | MFA `ownerMfaAt` / `securityMfaAt`   | post-dated MFA accepted                          |
| issue-22 | `evaluateGate` evidence `observedAt` | gate held open indefinitely, `gaReady` satisfied |
| issue-24 | `verifyStripeWebhook` timestamp      | no replay bound at all (both directions)         |

**The repo already had the correct convention.** `packages/core/src/events.ts:57` in `1.0-rc`:

```ts
function replayIsValid(occurredAt: number | undefined, now: Date, maxAgeMs: number): boolean {
  return occurredAt !== undefined && Math.abs(now.getTime() - occurredAt) <= maxAgeMs;
}
```

`Math.abs` bounds both directions. The merged baseline is correct; the four new branches
each diverged from it independently. All four are now fixed to bound both directions, with
regression tests that assert a future-dated timestamp DENIES.

Guidance for future work: reuse the `replayIsValid` precedent rather than hand-rolling a
subtraction. Any new freshness comparison should be reviewed for the future-dated case.

## Migration hazard (HIGH, fixed in issue-22)

Migration `004_operational_readiness.sql` added `authorization_id` INSIDE an already-shipped
`create table if not exists`. Postgres silently SKIPS the whole statement wherever the table
already exists, so the new column would never appear and audit inserts would fail at runtime
against a missing column. Fixed by restoring the original statement byte-for-byte and
appending an idempotent `alter table ... add column if not exists` plus a guarded not-null
block, matching migration 002's precedent.

Rule: never edit an already-applied `create table if not exists`; add a new idempotent
`alter table` instead.

**Operational caveat:** this repo has NO control-plane migration runner. Migration 004 must
be applied by hand. That is a release-blocking operational gap for `1.0-rc`, independent of
any branch.

## Vacuous tests found and corrected

- issue-20: whole suite collected 0 tests (schema threw at module load) — never ran an assertion.
- issue-10: test titled "admits only allowlisted discrete transitions" — nothing was allowlisted.
- issue-24: two webhook tests hard-coded a July 2024 timestamp; one would have passed
  vacuously once replay tolerance was added, rejecting before its assertions ran.

## THE ACTUAL CI BLOCKER: `pnpm audit`, not `pnpm quality`

The workers were right that `pnpm quality` passes locally. CI was failing at a DIFFERENT,
later step: **"Audit all dependencies used by builds and packaging"** — `pnpm audit --audit-level high`.

`1.0-rc` ITSELF fails this step. Verified directly on the base at 5e0a56b. `1.0-rc` last
went green 2026-07-24 21:19; the advisory was published after that. **No branch caused this
— it is a repo-wide blocker.**

Advisory: `GHSA-mh99-v99m-4gvg` — brace-expansion, DoS via unbounded expansion causing OOM.
Vulnerable `<=5.0.7`, patched `>=5.0.8`. Reached via 78 transitive paths.

### Partial fix applied (legitimate, keep)

`pnpm-workspace.yaml` overrides += `"brace-expansion@^5.0.5": ">=5.0.8"`, matching the file's
existing per-range convention (`fast-uri@3`, `fast-uri@4`). Lockfile now resolves the 5.x line
to 5.0.8. Verified `pnpm lint` still passes.

NOTE: pnpm 11 no longer reads `pnpm.overrides` from `package.json` — it must go in
`pnpm-workspace.yaml`. A `package.json` override is silently ignored with only a WARN.

### Why the advisory cannot be fully satisfied

The advisory's `<=5.0.7` range also covers the v1 (1.1.16) and v2 (2.1.2) lines, which are
required by `minimatch@3`. Forcing those to >=5.0.8 BREAKS ESLint outright:
`TypeError: expand is not a function` — brace-expansion v5 changed its export shape and
minimatch@3 expects v1's CommonJS export. Tested and reverted.

### Reachability

Every flagged path is DEV/BUILD tooling, not shipped product:

- `@vitest/coverage-v8 > test-exclude > glob > minimatch > brace-expansion` (root devDependency)
- `electron-builder > app-builder-lib > ... > minimatch > brace-expansion` (desktop devDependency)

`pnpm audit --prod --audit-level high` exits **0**. The production dependency tree is clean.

### Remaining moderates (do not gate CI, but worth tracking)

- `@hono/node-server` <2.0.5 — **path traversal in serve-static**. Runtime-relevant; needs a
  major bump (installed 1.19.14). Not attempted here — major bumps of a transitive dep should
  not be forced speculatively during a release integration.
- `tar` <=7.5.20 — uncontrolled recursion in mapHas/filesFilter.

### DECISION REQUIRED (security gate — not mine to make unilaterally)

Options: bump the dev-tooling dependents; scope the audit step to `--prod`; add a documented
time-boxed ignore for this advisory; or leave CI red until upstream `minimatch`/`glob` ship
releases on brace-expansion >=5.0.8.

## Result of the CI fix

Immediately after `2ca6a55` landed on `1.0-rc` and each PR took the new base:
**all 16 PRs went MERGEABLE, 10 went fully green.** The audit advisory was the single
dominant blocker; the per-branch prettier failures were secondary and mechanical.

Note on re-triggering: for `pull_request` events GitHub Actions uses the workflow file from
the PR's OWN head, so a workflow fix on the base does nothing until each branch merges it in.
`gh pr update-branch <pr>` does that remotely (a merge, not a force-push) and re-triggers CI.
Side effect: it advances the remote head, so local worktrees fall behind and workers must
`git pull` before pushing.

## Orchestration hazard: injected prompts silently not submitted

`orca orchestration dispatch --inject` delivered the task text into the agent's input buffer
but did NOT submit it for 10 of the workers. They sat at an idle prompt with the full TASK
block visible and no response line — indistinguishable at a glance from "still thinking",
but they had done nothing. Detection: read the terminal and look for a `⏺`/`✽` activity line;
its absence with task text present means unsubmitted.

Fix: `orca terminal send --terminal <h> --text "" --enter`.

One terminal (issue-15) was replaced entirely; the task then read as `dispatched` and could
not be re-dispatched, so it had to be resumed by submitting the buffered prompt in the new pane.

Lesson: after every `dispatch --inject`, verify the worker actually started before treating
a quiet `check --wait` as work-in-progress.

## Hidden semantic collision in the barrel (affects serial merge)

`workfiles/STATUS.md` and `packages/core/src/index.ts` conflicts are textually additive, but
"keep both sides" is NOT always semantically safe. On issue-5, keeping both barrel exports
surfaced a duplicate export NAME that the textual conflict hid:

- `replay-audit` exports `canonicalManifest` (for `ExportManifest`)
- `policy-packs` exports `canonicalManifest` (for `PolicyPackManifest`)

Resolved by renaming the newer one to `canonicalPolicyPackManifest`. Neither was dropped.

Implication for the remaining serial merges: after each merge, importing the barrel must be
smoke-tested for duplicate-identifier errors, not just for textual conflict resolution.

## SECOND module-load throw with a silent zero-assertion suite (issue-21)

`ProviderInstallationSchema` is a `ZodEffects`, and calling `.extend()` on it threw at module
load — so importing `@eventforge/core` through the barrel crashed, and the core suite collected
only 14 tests with `provider-installations.test.ts` never running a single assertion. After the
fix: core collects 42, control-plane 78, 190 total with declared == collected and no skips.

This is the same failure mode as issue-20. Two independent branches shipped it. Both would
have broken `1.0-rc`.

## The Date.parse NaN family (now 7 instances across 6 branches)

`Date.parse()` returns NaN for unparseable input, and EVERY comparison against NaN is false —
so a malformed timestamp reads as "never expires" / "always fresh" / "not yet stale":

| Branch   | Gate                                   | Effect                                                  |
| -------- | -------------------------------------- | ------------------------------------------------------- |
| issue-11 | shadow-evidence Wilson bound           | `eligible=true`                                         |
| issue-20 | kill switch                            | kill defeated                                           |
| issue-22 | readiness evidence                     | gate held open, `gaReady` satisfied                     |
| issue-24 | entitlement selection + webhook replay | garbage outranks valid; no replay bound                 |
| issue-14 | publisher review validity              | primary install gate returned `allowed:true`            |
| issue-8  | manifest expiry + signer validUntil    | manifest with `expiresAt:"not-a-date"` verified in 2099 |
| issue-5  | empty policy input set (`0 === 0`)     | status `complete` instead of `blocked`                  |

All fixed with mutation-verified regression tests. The correct precedent remains
`events.ts:57` (`Math.abs(...) <= maxAgeMs`) plus an explicit non-finite check.

## Quality-gate gap worth fixing separately (found on issue-8)

`packages/core/tsconfig.json` includes only `["src"]`, so **type errors in test files can never
fail `pnpm typecheck`**. Tests are type-unchecked. Not fixed here — it is a repo-wide gate
change outside this integration's scope, and fixing it may surface pre-existing errors.

Also on issue-8: the branch as originally pushed FAILED `pnpm lint` (`as any` in 5190f02) —
further evidence that the never-PR'd branch had no gate applied to it at all.

## CRITICAL: issue-9 had silently DISABLED the entire release gate

Root cause of PR #46 reporting only 2 checks where siblings reported 7: `.github/workflows/quality.yml:86`
on that branch was **invalid YAML** — `run: helm ... | grep -q 'kind: NetworkPolicy'` is a plain
YAML scalar containing `colon-space`, which is illegal. GitHub Actions therefore could not parse
the workflow AT ALL. Every push produced a zero-job `startup_failure` run with `jobs: []` and
created NO check runs.

Consequence: lint, build, typecheck, 183 tests, packaging, manifest validation and gitleaks
**all silently never ran**, and the PR read as green off CodeQL's 2 checks alone. No path or
branch filter was involved. A gate that cannot parse is a gate that always passes.

Additionally on that branch:

- Its ONLY test ran solely inside the workflow that same commit disabled, so the fail-closed
  guarantee the PR exists to provide had never executed a single assertion. `private-edge:test`
  is now wired into `pnpm quality`.
- CI invoked `pnpm private-edge:test` from the `deployment-manifests` job, which has no pnpm/Node
  setup — now called via `node` directly.

Fixed in `12cd308`; CI on that head now reports **7/7 SUCCESS**, up from 2.

**MERGE ORDER CONSTRAINT: PR #46 must merge BEFORE any other branch touching `quality.yml`.**
Until `12cd308` reaches `1.0-rc`, the release gate is a no-op on that branch.

Verified independently: `1.0-rc`'s own `quality.yml` parses as valid YAML, so the breakage was
branch-local and never reached the base.

## TOOLING INTEGRITY WARNING: rtk hook can report false success

The `rtk` shell hook rewrites and compresses command output. Confirmed directly:

- `npx prettier --check <file>` → hook prints `Prettier: All files formatted correctly`
- `rtk proxy npx prettier --check <file>` → real output: `Checking formatting... All matched files use Prettier code style!`

The first string is NOT prettier's output — it is synthesized by the hook. The issue-9 worker
reported the hook claiming success for a file prettier actually REJECTED.

Implication: do not trust hook-mediated output when validating a release gate. Re-run through
`rtk proxy`. Note that `pnpm quality` invocations DO show genuine underlying output (real
prettier/eslint/vitest text), so gate runs made through `pnpm` are trustworthy; single direct
tool invocations are the risk.

---

# FINAL RESULT

`1.0-rc` = `db24634`, pushed to origin. **CI green (Quality + CodeQL SUCCESS).**
107 commits ahead of where it started. All 22 branches are now ancestors of `1.0-rc`.
GitHub auto-closed all 20 PRs as MERGED.

Gate status on the integrated result:

- `pnpm quality` exit 0
- `pnpm audit --prod --audit-level high` exit 0
- **302 tests passing** (core 142, cloudflare 14, control-plane 90, console 27, desktop 8, mcp-server 21), 0 skipped
- barrel loads with 185 exports, no module-load throw
- `eventforge-mcp.mjs` bundle-staleness CI gate clean

## Export collisions found ONLY at merge time (4)

No single branch's CI could catch these — they exist only once two branches are both present.
All four collided against `connector-trust` (issue-8, the branch that never had a PR):

| Symbol              | Colliding modules                 | Resolution                                                  |
| ------------------- | --------------------------------- | ----------------------------------------------------------- |
| `canonicalManifest` | replay-audit / policy-packs       | → `canonicalPolicyPackManifest` (by the issue-5 worker)     |
| `manifestDigest`    | connector-trust / policy-packs    | → `policyPackManifestDigest`                                |
| `ConnectorManifest` | connector-trust / sdk             | → `ConnectorPackageManifest` (genuinely different concepts) |
| `canonicalJson`     | connector-trust / timeline        | → `canonicalRfc8785Json` (same function, hand-rolled twice) |
| `Approval`          | connector-trust / reaction-worker | → `ReactionApproval`                                        |

Root cause: `packages/core/src/index.ts` re-exports 13+ modules via unnamespaced `export *`.
Every new module raises the collision probability. **Recommend namespaced exports** before
adding more modules — this will recur otherwise.

## Follow-ups — 1, 2 and 3 are now DONE

1. ~~**No control-plane migration runner.**~~ **FIXED.** `apps/control-plane/src/migrate.ts` +
   `migrate-cli.ts`, with a ledger, checksum drift detection, an advisory lock and a
   non-writing `--status`. The seven files numbered `004` were renumbered `004`-`010` to give
   them a total order. Verified against real Postgres. See `workfiles/MIGRATIONS.md`.
   Running it surfaced an undocumented prerequisite: **pgvector** is required by `001_init.sql`.
2. ~~`packages/core/tsconfig.json` includes only `["src"]`.~~ **FIXED.** Split into
   `tsconfig.json` (typechecks `src` + `test`) and `tsconfig.build.json` (emits `src`), matching
   `packages/mcp-server`. Same for `apps/control-plane`. Enabling it surfaced **34 real type
   errors** in core's tests, all fixed — including a helper that typed its patch as the full
   parameter object (so every partial override was unsound) and `Signer.publicKey` being too
   narrow to hold the `KeyObject` the tests actually pass.
3. ~~Unnamespaced `export *` barrel.~~ **FIXED.** See below.
4. Two `canonicalJson` implementations remain duplicated; not unified because they feed content
   digests and unifying risks changing stored values.
5. Moderate advisories: `@hono/node-server` <2.0.5 (**path traversal in serve-static** —
   runtime-relevant, needs a major bump) and `tar` <=7.5.20.
6. `pnpm audit --audit-level high` over dev tooling is non-blocking; re-tighten once upstream
   minimatch/glob ship on brace-expansion >=5.0.8.
7. `mcp-server/test/http.test.ts` ECONNREFUSED flake (seen by two independent workers).
8. Per-issue latent findings (unreachable today, no production callers) are recorded in each
   branch's review doc under `workfiles/`.
9. Enterprise migration unique constraint does not constrain org-scoped rows (Postgres treats
   NULLs as distinct); needs `nulls not distinct` (PG15+) but the repo declares no PG version.

## Cleanup done

- 16 integrated worktrees removed; 22 merged local branches deleted
- earlier pass: 6 already-merged worktrees + duplicate `1.0-rc-2` + stale `tebayoso/issue-14-sdk-marketplace`
- nested worktree dirs excluded via `.git/info/exclude` (tracked `.gitignore` untouched)
- `main` NOT pushed, per instruction. Remaining: 2 worktrees (`main`, `release-1.0-rc`)

---

# Follow-up pass: the three "worth your attention" items

`1.0-rc` = `01a7d40`, CI green, `pnpm quality` exit 0, **314 tests** (up from 302).

| Item                              | Status                                                               |
| --------------------------------- | -------------------------------------------------------------------- |
| Test files never typechecked      | Fixed — split tsconfigs; 34 latent type errors found and fixed       |
| Unnamespaced `export *` barrel    | Fixed — two-tier barrel + contract test; flat surface 185 -> 69      |
| No control-plane migration runner | Fixed — runner + ledger + drift detection, verified on real Postgres |

## Deployed for verification

- **beta.eventforge.dev** — release-candidate console, separate Worker
  (`eventforge-console-beta`), HTTP 200, security headers intact, analytics disabled.
  Apex `eventforge.dev` untouched and still carries the production GA id.
- **eventforge-cloud-preview** — the Worker that bundles `@eventforge/core`.
  `/health` returns `{"ok":true,"service":"eventforge-cloud","environment":"preview","ingress":"gated"}`,
  which is the real signal that the namespaced barrel imports cleanly under workerd.

`/console` returns 503 on production — the intended fail-closed
"sign-in required" state while hosted auth remains gated there. On beta,
`/console` now serves the hosted sign-in SPA (password + email-link).

## Released: 2026-08-28 — v1.0.0-rc.1

PR [#52](https://github.com/tebayoso/eventforge/pull/52) was already merged to
`master` at `30865aa`; release tag `v1.0.0-rc.1` points at `06c5de6`
(toolchain bump after the merge). `origin/1.0-rc` was fast-forwarded to the
same commit.

GitHub: https://github.com/tebayoso/eventforge/releases/tag/v1.0.0-rc.1

| Surface                  | Result                                                   |
| ------------------------ | -------------------------------------------------------- |
| Preview API `/health`    | `ok`, `environment=preview`, `ingress=gated`             |
| Production API `/health` | `ok`, `environment=production`, `ingress=gated`          |
| `hooks.eventforge.dev`   | custom domain live; unsigned routes 404                  |
| `beta.eventforge.dev`    | live; analytics-config blanked; `/console` sign-in SPA   |
| `eventforge.dev`         | live; `/console` 503; waitlist and features pages render |

D1 applied: preview events `0002_durable_deliveries`; production control
`0003_delivery_installations`, `0003_hosted_identity`, `0004_identity_passwords`;
production events `0002_durable_deliveries`.

Not shipped: npm of `@eventforge/mcp-server`; private-edge Helm install;
production hosted sign-in / public ingress.

Quality on `master` is red at `pnpm audit --prod` (high: `fast-uri` needs
`>=3.1.5`, plus `ip-address`, `nanoid`, `tar`). `pnpm quality` itself completed.
Follow-up: bump workspace overrides.

## 2026-08-28 — production sign-in, no beta, waitlist

Beta console env removed. Apex `/console` serves hosted sign-in. `/api/auth/*`
is live on `api.eventforge.dev`. Email-link requests no longer create identities.
Landing `#waitlist` and `/waitlist` are the enrollment form. `/v1/*` other than
waitlist stays `AUTH_GATED`.

## Still open

- Moderate advisories: `@hono/node-server` <2.0.5 (path traversal in `serve-static`) and
  `tar` <=7.5.20. Both need transitive major bumps.
- Dev-tooling `pnpm audit` stays non-blocking until upstream minimatch/glob ship on
  brace-expansion >=5.0.8. The `--prod` gate is blocking and green.
- `mcp-server/test/http.test.ts` ECONNREFUSED flake.
- Two duplicated RFC 8785 `canonicalJson` implementations, not unified because they feed
  content digests.
- `apps/cloudflare/migrations/control/` still has two files numbered `0003`; left alone
  because renaming breaks wrangler's ledger where they are already applied.
- Per-issue latent findings recorded in each branch's review doc.
