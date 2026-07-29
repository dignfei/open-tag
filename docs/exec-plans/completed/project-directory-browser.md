# project-directory-browser - safely browse projects on a selected daemon machine

## Goal

Keep manual project-path entry while letting an owner/admin browse directories and discover likely
projects on the selected daemon machine. Directory metadata is exposed only below roots explicitly
shared by that daemon, and the same policy gates manual entry and runtime start.

This feature improves remote path discovery. It is not a filesystem sandbox: runtimes still execute
as the daemon OS user and retain the real `HOME` for existing auth, MCP, config, and skills.

## Non-negotiable contract

- `OPEN_TAG_PROJECT_ROOTS` is the daemon-local authority for paths that OpenTag may expose or bind.
  No configured roots means browse, discover, manual resolve, and project-bound start fail closed.
- A path is checked without filesystem probing before lookup, canonicalized with `realpath`, then
  checked again against canonical roots. A symbolic link must not escape a shared root.
- Browser responses contain directory metadata only. Project discovery checks marker names only and
  never reads project file contents.
- Directory listing, discovery depth, result count, and RPC duration are bounded. Hidden/sensitive
  locations are excluded from browsing.
- Requests target the selected machine and require tenant ownership plus both agent-management and
  machine-management authority. Old daemons fail with an explicit capability error.
- Picking a directory does not replace final `project:resolve` validation. Start revalidates the
  stored canonical path as it does today.

## Steps and verification

1. **Daemon policy and filesystem operations**
   - Parse and canonicalize shared roots; implement bounded listing and marker-only discovery.
   - Verification: tests cover unset roots, valid descendants, prefix collisions, missing paths,
     symbolic-link escape, hidden/sensitive paths, result limits, and project markers.
2. **Targeted protocol and Human API**
   - Add a versioned daemon capability and targeted roots/list/discover RPCs.
   - Verification: tests cover manager success, ordinary-member denial, foreign-machine denial,
     offline/old daemon errors, and response correlation.
3. **Agent create/edit UX**
   - Keep manual input; add a remote folder picker with roots, discovered projects, breadcrumbs,
     lazy directory loading, loading/error/empty/offline states, and machine-switch reset.
   - Verification: web typecheck/build plus real browser checks at desktop and 390x844.
4. **Real stack and regression verification**
   - Start the isolated server/daemon with a disposable shared root, browse/select/create an agent,
     and prove an outside-root manual path and symlink escape are rejected.
   - Verification: API/curl evidence, browser evidence, relevant unit/integration suites, full
     typecheck, daemon bundle build, and `git diff --check`.
5. **Documentation and release preparation**
   - Document daemon root configuration, capability/API codemap, UI behavior, and sandbox boundary;
     run `/doc-sync` and update the existing unreleased daemon changelog entry.
   - Verification: docs/site build and doc-sync audit pass. Commit, push, merge, GitHub Release, and
     npm publication remain separate explicit actions.

## Decision log

- 2026-07-29: chose explicit shared roots over whole-home scanning. A denylist alone cannot enumerate
  every sensitive location and directory names are themselves private metadata.
- 2026-07-29: manual entry uses the same policy as the picker; otherwise a safe picker would only be
  cosmetic and the existing path-existence oracle would remain.
- 2026-07-29: remote browsing is lazy; recursive scanning is limited to an explicit project-discovery
  operation with fixed depth/result bounds.

## Progress log

- 2026-07-29: grounded the feature against the uncommitted project-directory worktree, existing
  `project:resolve` RPC, machine-targeted model probing, and Human-plane capability model.
- 2026-07-29: implemented the daemon allowlist/browser, exact-connection WS correlation, Human API,
  create/inactive-edit picker, responsive styles, docs, and release preparation. Query paths use
  `POST .../project-directories/query`; `GET .../project-directories` returns roots only.
- 2026-07-29: verification passed: 31 focused browser/security/RPC/API/path tests, 40 lifecycle and
  state regression tests, root + web TypeScript, daemon bundle, web build, docs build, and
  `git diff --check`. A live server/daemon returned the configured shared root, discovered projects,
  rejected outside-root and hidden paths, and rejected URL query paths. Browser checks selected the
  Hermes repository, preserved the outer form on Escape, and showed no overflow or console errors at
  390x844. No test Agent was created.
- 2026-07-29: the 36 `agentManager` cases also pass with Node's `--test-force-exit`; without that
  flag, every concrete assertion completes but a pre-existing residual handle keeps the runner open.
  This remains an explicit test-harness warning rather than a hidden success.
- 2026-07-29: intentionally not verified in this slice: Windows junction/UNC behavior on a live
  Windows host, OS-level runtime containment outside shared roots, and removal of the unavoidable
  `realpath`/`stat` to runtime-spawn race. The allowlist remains a disclosure/binding policy rather
  than a process sandbox. Commit, push, merge, release, npm publication, and daemon restart outside
  this isolated worktree remain explicit follow-up actions.
