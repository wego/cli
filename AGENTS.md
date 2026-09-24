# AGENTS.md

Instructions for coding agents working in this repository. People: the same
rules are in `CONTRIBUTING.md`, which is the longer version.

## Commands

```sh
bun install
bun run check              # lint, typecheck, unit tests: must be clean
bun run test:integration   # the compiled binary against the contract-checked fake
bun run format             # biome, writing every safe fix
```

Bun only, never npm, node or yarn. Never commit with `--no-verify`.

## Tests: one test, one tier

| Tier | Proves | Lives in | Runs |
|---|---|---|---|
| Unit | Each piece of code across its edge cases: parsers (argv to API arguments), the HTTP client, pure logic | `src/*.test.ts`, `scripts/*.test.ts` | Every PR, blocking |
| Integration | The compiled binary works: exit codes, stdout, stderr, the request on the wire, files written | `integration/` | Every PR, and every release on its linux and macOS targets, blocking |
| Artifact checks | What ships is signed, installable, self-updating | the release and promote workflows | Release and promote, blocking |
| Next smoke and evals | The published binary against staging, and how well its skill performs | wego-ai | Every release, report only |

Rules that decide where a test goes:

- **A unit test never asserts on a command's stdout, stderr or exit code.** That is
  the integration tier's job. `scripts/unit-tier-guard.test.ts` enforces it by
  refusing a unit test that imports a command entry point.
- **Tests here never touch the network, staging, production or a secret.** The
  integration fake is on loopback and every other request is refused.
- **Only deterministic checks block.** Anything that depends on staging's data or
  timing reports, and lives in wego-ai.
- **Persona and skill evals never enter this repository**: no cases, scores,
  transcripts or harness code. They live in wego-ai only.
- **The contract is the boundary.** The CLI is tested against
  `contract/openapi.json`, never against a live API. When the API changes, the
  contract is refreshed first (`CONTRIBUTING.md`, "When the API changes").
- **Add a test only when it gives confidence nothing else gives.** Delete a
  duplicate rather than keep it. A slow timing path (a settle budget, a timeout)
  is tested as a plain function, with one fast scenario end to end.

The step-by-step for writing tests is the `cli-tests` skill
(`.agents/skills/cli-tests/SKILL.md`).

## Where else to look

- `CONTRIBUTING.md`: setup, hooks, signed commits, commit messages, API changes.
- `integration/README.md`: the harness, scenarios and fixtures.
- `docs/release.md`: the rings, the release gates, the next report.
- `SECURITY.md`: what is in scope.

## Do not

- Edit `skills/`: it is the agent skill compiled into the shipped binary, not
  instructions for working here. Development skills live in `.agents/skills/`.
- Write an em-dash in anything a user reads.
- Weaken `integration/harness/contract.ts` or `fake.ts` to make a scenario pass:
  fix the fixture or the CLI.
