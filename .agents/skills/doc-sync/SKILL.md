---
name: doc-sync
description: Reconcile docs with code after a change (or as a periodic audit). Use before calling any change "done", at the end of every PR, or when asked to audit doc/code drift. Enforces this repo's hard rule: code change = doc change in the same commit.
---

# doc-sync — keep docs and code converged

This repo treats doc lag as **an unfinished bug** (see AGENTS.md § Doc-sync discipline).
This skill is the executable procedure; the canonical *mapping table* (which change owes
which doc) lives in **AGENTS.md** — read it there, do not copy it here.

> This file is canonical at `.agents/skills/doc-sync/SKILL.md` (`.claude/skills/doc-sync`
> is a symlink). The skill itself iterates: when a run shows an instruction here is wrong
> or misleading, fix it **in the same pass**, with the run's evidence in the commit message.

## Mode 1 — per-change sync (run at the end of every change)

1. **Determine the change surface.**
   `git diff --stat origin/main...HEAD` (or the staged diff for uncommitted work).

2. **Map each changed path against the AGENTS.md doc-sync table.** Produce the list of
   docs owed by this change. The high-traffic rows:
   - `src/db/schema.ts` → `docs/generated/db-schema.md` (hand-maintained snapshot — **no
     generator script exists despite the `generated/` dir name**; update the table row
     *and* any enum lists by hand; prod DB migrates via `prod:up` → `db:push:prod`).
   - Routes / CLI subcommands / daemon protocol → `ARCHITECTURE.md` §II codemap + §IV contracts.
   - Module purpose / boundary / invariant changed → `ARCHITECTURE.md` §II–IV.
   - Feature completed or modified → `FEATURES.md` checkbox (**checkbox + a short note**;
     long verification narratives belong in the PR, not the checklist).
   - TODO / known drift left behind → `docs/tech-debt-tracker.md` new entry
     (next free ID — check the **archive** too so IDs are never reused).
   - `src/daemon/**` shipped in the bundle → bump `packages/daemon/package.json`,
     cut a GitHub Release, **and add the version's `CHANGELOG.md` entry**. Merged ≠ shipped.

3. **Status single-source rule.** Security/authorization item states (F*/C*/IDOR-B*) live
   **only** in `docs/authorization.md` §6. Other docs (PLANS, tech-debt I44) may point
   there but must never mirror per-item states — mirrored lists are how C10 stayed
   "remaining" for weeks after it was fixed. Detect mechanically, don't trust prose:
   `grep -rnE '\b(C1[0-2]|C[1-9]|B[1-6]|F[0-9]|IDOR)\b' --include='*.md' docs/ *.md | grep -vE 'authorization\.md|docs/exec-plans/|docs/superpowers/'`
   (historical plan/spec records legitimately narrate the states they shipped — the rule
   polices *live* docs). A hit naming an item's *state* (open/fixed/remaining) is a
   violation; a bare pointer to authorization.md §6 is fine.

4. **Staleness check on every doc you touched.** For each edited doc: file paths it names
   exist; `tech-debt I<n>` / `D<n>` references resolve (tracker or archive); counts/enums
   match code (`grep`, `wc -l` — better: drop volatile numbers entirely, per
   ARCHITECTURE.md's header rule).

5. **Hygiene gates.**
   - No personal/machine refs in what this change **adds** (core belief #9). Grep the
     *added diff lines*, not whole files:
     `git diff origin/main -- <files> | grep '^+' | grep -E '~/\.claude|/Users/'`.
     A personal absolute path (`/Users/<name>/…`) is a violation. Two known non-violations
     that this grep still surfaces: a generic runtime path that is product behavior
     (e.g. `~/.claude/skills` as Claude CLI's global skills dir), and a tech-debt entry
     *quoting* a personal path as the evidence of the debt it records. Judge, don't
     blind-fail — but never add a *new* personal path outside those two shapes.
   - Touched `src/daemon/prompt.ts`? Grep for provider-specific tool names
     (`Read`, `cat`, `grep`, vision hints) → expect zero hits (code-quality red line).

6. **Fail loud.** In the PR/summary, list: docs updated · docs checked-and-clean ·
   drift found but deferred (with its new tech-debt entry ID).

## Mode 2 — periodic full audit (on request / doc-gardening)

Cross-check the status documents against code and each other; they drift fastest:

1. `FEATURES.md` — sample every `[ ]` unchecked line: is the feature actually still
   missing? (grep the endpoint / CLI verb / component). Unchecked-but-shipped is the
   most common rot.
2. `docs/PLANS.md` — every referenced plan file exists; Active items are still active;
   completed plans moved to `docs/exec-plans/completed/` **with their status line
   updated** (a moved plan still saying "merge pending <date>" is half-finished rot).
3. `docs/tech-debt-tracker.md` — no duplicate IDs (incl. vs the archive); ⬜/🟡 entries
   spot-checked against code; newly-✅ entries: **move the full row** to the archive.
   The tracker keeps no stub — it holds open items only; cross-references resolve by
   grepping both files.
4. `docs/authorization.md` §6 vs any doc that mentions security items — pointers only,
   no mirrored states (run the Mode 1 step-3 grep).
5. `ARCHITECTURE.md` §II — new substantive modules (>50 lines) present in the codemap.
   Recipe: `git log --since=<last audit> --name-only --diff-filter=A --pretty=format: -- 'src/*' 'web/src/*'`,
   then check each surviving non-test file's basename appears in the codemap. Named files
   exist; `CHANGELOG.md`'s newest **version** heading (the `[Unreleased]` section doesn't
   count) matches `packages/daemon/package.json`.
6. **Size / density audit — docs must stay maps, not manuals.** Line counts hide bloat
   (long table rows); rank by bytes: `git ls-files '*.md' | xargs wc -c | sort -rn | head`.
   For each fat doc, check it against **its own stated form rule** (FEATURES' "checkbox +
   short note" header, ARCHITECTURE's "write only what doesn't change often" header) —
   self-rule violations are the strongest trim mandate. Cut change-history narrative
   ("the former X was removed…", "before this fix…") and verification evidence — git log
   and PRs own those. Frozen plan/spec archives of shipped work are deletable (git
   history retains them); before deleting, grep for inbound references incl. from `src/`.
7. **`README.zh-CN.md` parity** — diff section structure + bullet counts against
   `README.md`; the zh mirror silently misses EN feature edits (drift is one-directional).
   Small deltas: translate in the same pass. A backlog: open a tech-debt entry.

Report findings with file:line evidence; fix mechanically-safe drift in the same pass,
open tech-debt entries for anything needing a decision.
