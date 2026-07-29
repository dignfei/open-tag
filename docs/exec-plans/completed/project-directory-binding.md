# project-directory-binding - bind an agent to an existing project without overwriting project instructions

## Goal

Let a human optionally bind an agent to an existing directory on the agent's selected machine. The
runtime starts with that directory as its cwd, so existing repository instructions, MCP config, and
runtime-native project context remain available. open-tag's own durable state remains under
`OPEN_TAG_HOME/agents/<agent-id>` and reset/delete operations never delete or rewrite the bound
project.

## Non-negotiable contract

- `stateDir` and `projectDir` are distinct. `stateDir` owns `MEMORY.md`, `notes/`, personality,
  runtime-injection artifacts, and session bookkeeping. `projectDir` is an operator-owned directory
  that open-tag only uses as cwd and as a source of runtime-native project context.
- The selected machine's daemon validates and canonicalizes a configured path with `realpath` plus
  a directory `stat`. The server must not validate a remote macOS/Linux/Windows path locally.
- `agent:reset` and agent deletion only touch `stateDir`. They never remove or clear `projectDir`.
- Existing `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.mcp.json`, and similar project files are never
  overwritten, permanently appended, renamed, or deleted by open-tag.
- "Append open-tag instructions" means protocol-level composition: use the runtime's system,
  developer, custom-instructions, agent-config, or per-turn prompt channel. It does not mean mutate
  a project file. If a runtime has no independent channel, use a visible per-turn prompt envelope or
  fail closed; never silently fall back to writing `AGENTS.md`.
- Changing a bound directory invalidates the recorded runtime session. Resuming a thread created
  under a different cwd is not assumed safe.
- The existing process environment and real user `HOME` remain unchanged in this slice. Therefore
  global auth/config/MCP/skills continue to be shared exactly as today; per-agent `CODEX_HOME` or
  provider-home isolation remains separate work.

## Runtime protocol matrix

| Runtime | Project cwd | open-tag instruction composition | Project files touched |
|---|---|---|---|
| Claude Code | spawn `cwd` | native append-system-prompt file stored in `stateDir` | none |
| Codex | app-server `cwd` | `developerInstructions` | none |
| Copilot CLI | spawn `cwd` | managed instruction directory added through `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | none |
| OpenCode | spawn `cwd` | a uniquely named primary agent supplied through merged inline config | none |
| Pi | spawn `cwd` | native append-system-prompt file stored in `stateDir` | none |
| Hermes | spawn `cwd` | existing per-turn open-tag prompt envelope | none |
| Kimi Code | spawn `cwd` | compatibility instruction envelope repeated on every fresh/resumed turn (`0.19.x` has no separate system channel) | none |
| Cursor Agent | spawn `cwd` | managed always-on plugin rule passed through public `--plugin-dir` | none |

Kimi's compatibility envelope is lower priority than a native system prompt. Kimi `0.29+` has an
experimental custom-agent file, but the installed `0.19.2` runtime does not; the envelope preserves
current compatibility without moving `KIMI_CODE_HOME` (which would also hide existing auth/config).

## Steps and verification

1. **Protocol and ownership map**
   - Confirm every runtime's cwd, resume semantics, and independent instruction channel against
     current adapter code, installed CLI help, and primary documentation.
   - Verification: the matrix above has no "assumed" row; unsupported behavior is explicit.

2. **Data and daemon contract**
   - Add nullable `projectPath` to the agent record and launch config.
   - Add a targeted daemon RPC that canonicalizes an existing directory on the selected machine.
   - Revalidate at every start to close create/start time-of-check/time-of-use drift.
   - Verification: unit tests cover missing/file/relative/canonical paths and integration tests prove
     a cross-tenant or offline machine cannot validate a path.

3. **Runtime separation and no-overwrite injection**
   - Extend `StartOpts` with `stateDir`; use `projectPath ?? stateDir` as cwd.
   - Move all generated instruction files into `stateDir` and replace current Kimi/Cursor/Copilot/
     OpenCode writes to `{cwd}/AGENTS.md` with their verified protocol channels.
   - Keep workspace browsing and memory/profile mutation scoped to `stateDir`. Point project-local
     skill discovery at `projectDir` without exposing arbitrary project files through the web file
     browser.
   - Verification: adapter tests create sentinel instruction files in the project and assert their
     content and metadata are unchanged after start/stop.

4. **Human API and UI**
   - Add optional project-directory input to agent creation and show the canonical bound path in the
     agent profile. The server validates on the selected machine before insert/start.
   - Allow changing/removing the directory only while the agent is inactive; clear `sessionId` in the
     same update.
   - Verification: API tests cover create, invalid path, offline daemon, active-agent edit rejection,
     unbind, and session clearing; browser verification covers create and profile display/edit.

5. **Real runtime and reset safety verification**
   - In an isolated dev stack, bind a disposable project containing sentinel `AGENTS.md` and runtime
     config, start at least the native-injection runtimes available on the machine, and confirm cwd
     plus instruction loading.
   - Run full reset and delete; prove the project directory and sentinel hashes still exist unchanged.
   - Verification: retain CLI/API output and browser screenshot under `.shots/`.

6. **Documentation and release preparation**
   - Update `ARCHITECTURE.md`, `FEATURES.md`, generated schema docs, README verified behavior,
     tech-debt entries, daemon package version, and `CHANGELOG.md`; run `/doc-sync`.
   - Verification: root+web typecheck, relevant unit/integration/E2E suites, daemon bundle build, and
     doc-sync all pass. Publishing the npm/GitHub release is a separate explicit external action.

## Progress log

- 2026-07-28: created isolated worktree `open-tag-project-directory` from `origin/main` at
  `ce808b6`. Dependency install succeeded; initial DB setup was blocked because PostgreSQL on 5433
  was not running.
- 2026-07-28: traced current state/cwd coupling and confirmed four adapters currently write generated
  instructions into `{cwd}/AGENTS.md`, which would corrupt a bound real project.
- 2026-07-28: verified native/independent composition paths for Claude, Codex, Pi, Copilot, OpenCode,
  and the existing Hermes prompt envelope. Verified Kimi's installed-version limitation and Cursor's
  public plugin/rules protocol; both adapters now avoid project writes.
- 2026-07-28: implemented the data/RPC/UI/runtime split, capability gate, canonical path validation,
  start/edit status claim, read-only project skills, and path-safe agent detail serializer.
- 2026-07-28: live browser/Claude verification loaded the project's existing `AGENTS.md`, reported the
  exact bound cwd, and survived full reset with both project sentinel SHA-256 hashes unchanged.
- 2026-07-28: adversarial review found and closed four boundary gaps: state symlink escapes, mutable
  Turn preflight, connection-replacement capability races, and delete-without-stop. Project skill
  metadata is manager-only.
- 2026-07-28: real Pi, Kimi, Hermes, and Codex agents used configured gateway-backed models to load
  the bound project's `AGENTS.md` and marker through the server/daemon/CLI path, persisted the exact
  expected reply, stopped with daemon confirmation, and left both sentinel hashes unchanged. This
  exposed and closed two lifecycle defects: idle one-shot adapters did not settle stop, and a Hermes
  startup empty-inbox check could suppress `online` and deadlock the next durable Turn.
- 2026-07-28: root+web typecheck, daemon package build, web/docs builds, DB sync, focused
  HTTP/WS/runtime tests, sequential full tests, and diff/doc audits pass.

## Decision log

- Bind the directory per agent, not per open-tag server/workspace: filesystem paths are local to one
  machine and two agents may intentionally use different checkouts.
- Keep global runtime homes shared in this slice. Directory reuse and runtime-home isolation solve
  different problems; combining them would unexpectedly hide existing auth/MCP/config that the user
  explicitly wants to preserve.
- Do not implement literal permanent append to repository instruction files. Concurrent agents would
  accumulate contradictory identities and crash recovery could leave stale open-tag policy inside a
  user's source tree.

## Outcome

- All eight runtime adapters accept separate `cwd` and `stateDir`; generated identity artifacts stay
  in daemon-managed state and existing project instructions remain native runtime inputs.
- The target daemon owns path validation, revalidates before every start, and advertises an explicit
  capability. Actual start/delivery sends re-check required capabilities on the exact WebSocket.
- Reset/profile/workspace/runtime state operations reject symbolic-link escapes. Project-bound delete
  remains visible and retryable until the daemon confirms the process stopped.
- This slice deliberately preserves the real `HOME` and any existing `CODEX_HOME`. Per-agent runtime
  home/config isolation is separate work because enabling it implicitly would hide existing auth,
  MCP configuration, and skills.
