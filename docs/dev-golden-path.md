# Dev golden path — `direnv` (live-source `wego`)

How to drive the CLI, and the agents that shell out to it, from source. Summary
lives in [`AGENTS.md`](../AGENTS.md); the setup and its sharp edges live here.

## The setup

The repo-root [`.envrc`](../../../.envrc) prepends `apps/cli/.bin` to `PATH`.
`.bin/wego` is a **relative** symlink to `src/index.ts`, so `wego` runs the
TypeScript directly through its `#!/usr/bin/env bun` shebang — no compile, no
link. `wego version` prints `0.0.0-dev`. Edit a `.ts` file and the next `wego`
reflects it.

One-time: install [`direnv`](https://direnv.net), hook it into your shell, then
`direnv allow` at the repo root.

After that, being anywhere in the repo puts the live-source `wego` on `PATH`.
`cd` out and direnv restores your prior `PATH` verbatim — an installed `wego`, or
"not found", comes back untouched.

It is **shell-scoped** (no user-global state) and **per-worktree correct**
(`PATH_add` resolves relative to that worktree's `.envrc`, so parallel worktrees
never collide over a single link). To drive an agent from source, launch it from
`apps/cli/` with direnv active: `cd apps/cli && claude` (or `codex`). It picks up
the co-located skill and finds `wego` on `PATH`.

The committed `.envrc` and `.bin/wego` are inert without direnv, so they are safe
for teammates who don't use it.

## Gotcha — an agent launched *outside* direnv silently uses the installed *prod* `wego`

A process inherits its `PATH` at launch. direnv rewrites `PATH` only in the
**interactive** shell you launch from: it cannot retroactively touch an
already-running agent, and it never activates in the non-interactive shells the
agent's tool calls spawn.

So the source `wego` reaches the agent **only by inheritance**. Launch
`claude`/`codex` from a direnv-active shell in the worktree and every bare-`wego`
shell-out — including the `/wego` skill, which calls bare `wego` — runs
`src/index.ts` with the staging `.env.local`.

Launch it from anywhere direnv is *not* active and bare `wego` falls through to
the globally-installed binary (`~/.local/bin/wego`, baked with **prod** config).
**No error, just the wrong environment**: prod auth, prod API, prod token. `wego
login` opens `auth.wego.com`, not `auth.wegostaging.com`.

**Verify before trusting a dev session.** `which wego` must resolve under
`…/apps/cli/.bin/`, never `~/.local/bin`. If it is wrong, **exit and relaunch**
the agent from *this* worktree with direnv active — per-worktree, its
`.bin/wego → ../src/index.ts` points at this worktree's source.

Can't relaunch? Use the per-command escapes below; neither relies on the launch
environment.

## Per-command escapes

direnv only injects into an **interactive, hooked** shell. A non-interactive
`sh -c "wego …"` — what tool-driven agents and CI-style scripts run — sees
neither the `PATH_add` nor the `dotenv`: `wego` is "not found" and
`WEGO_CLI_CLIENT_ID` is unset.

- **`direnv exec <dir> <cmd>`** loads that dir's `.envrc` for one command with no
  shell hook. `direnv exec . wego whoami` from the repo root puts the live-source
  `wego` on `PATH` *and* sources `apps/cli/.env.local`.
- **Without direnv at all**, invoke `./apps/cli/.bin/wego` directly. A
  from-source run **loads its own `apps/cli/.env.local` regardless of cwd or
  shell** (`src/env-local.ts`), so only `PATH` needs solving.

After editing `.envrc`, direnv **blocks** it until you re-run `direnv allow`.
Expected, but it surfaces as an "is blocked" error mid-session.

## Why the `.envrc` also loads `.env.local`

The same `.envrc` runs `dotenv_if_exists apps/cli/.env.local`, exporting the
CLI's OAuth config (public, PKCE, no secret) into the shell so `wego` is fully
configured from **any** cwd, not only `apps/cli/`.

Without it, Bun auto-loads `.env.local` only from the directory a script runs in,
so `wego` invoked from the repo root would resolve on `PATH` but start without
its required public runtime configuration.

`dotenv_if_exists` no-ops when the file is absent — for example before you
`cp .env.local.example .env.local` — preserving that fail-fast. Real shell env
vars still win over Bun's `.env` files, so running from `apps/cli/` yields the
identical value. Consistent everywhere.

## Skill discovery

`.claude/skills/wego/` is the canonical skill directory.

- **Claude Code** discovers it directly.
- **Codex** discovers it via a `.agents/skills/wego` symlink at **two** levels:
  the app-local `apps/cli/.agents/skills/wego` (Codex launched from `apps/cli`)
  and the repo-root `.agents/skills/wego` (Codex launched from the monorepo root,
  where the other repo skills live).

Both point at the one canonical body, so with the direnv golden path putting
`wego` on `PATH` repo-wide, `codex` finds the skill from either root. Keep a
single skill body rather than copying it between agent-specific directories.

## Fallback without direnv

From `apps/cli/`, run `bun link`, then put Bun's global bin dir on `PATH`:

```sh
export PATH="$(bun pm bin -g):$PATH"
```

In a first-time Bun home `bun pm bin -g` can be empty, so fall back to
`${BUN_INSTALL:-$HOME/.bun}/bin`. Run `bun unlink` when done.

Note `bun link` is **user-global** — one shim for all shells and worktrees. The
direnv path avoids that sharp edge.

Either way, keep `src/index.ts` executable with its `#!/usr/bin/env bun` shebang:
it is the declared bin target and the symlink's resolve target. This setup is
developer-local — do not add it to the skill or require it in CI.

## What the source `wego` connects to

A from-source run bakes in nothing, so its config comes entirely from
`.env.local` plus code defaults, and those must be kept **coherent**. This is
12-factor: orthogonal vars, no "environment" mode switch, so `.env.local.example`
declares each one explicitly rather than leaning on a silent default.

- **Auth → staging.** `.env.local` sets `WEGO_AUTH_*` to `auth.wegostaging.com`,
  so `wego login` and refresh go to staging.
- **API base → local `apps/api`.** `.env.local.example` declares the portless URL
  `WEGO_API_URL=https://api.localhost` explicitly, not as a hidden default, so the
  dev deploy is fully specified and coherent with staging auth. Run
  `bunx portless`; for plain `bun dev`, override with
  `WEGO_API_URL=http://localhost:3001`.
- **Keep auth and API in the same environment.** A staging token sent to the prod
  api, or the reverse, is rejected **401 right after a successful login** — the
  classic incoherence trap. Retarget by editing `WEGO_API_URL` *and* the auth URLs
  together. Precedence: runtime env > baked release config.
- **Hotels have no activation gate.** They serve like flights against the
  configured `HOTELS_METASEARCH_BASE_URL`; a metasearch route 503s only on a real
  upstream outage, never as a deliberate dark state.
- **`apps/api` binds `:3001` — check ownership before starting or killing it.** An
  editor task or another worktree/session may already own it. Confirm with
  `lsof -i :3001` and don't blind-`pkill -f "bun --hot src/dev.ts"`, which will
  kill a server you didn't start.
