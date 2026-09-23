---
name: cli-tests
description: How to test a change to the wego CLI in this repository. Use when adding or changing a command, a flag, output, an error path or an API call, when writing or moving a unit test or an integration scenario, or when a fixture or the contract check fails.
---

# Testing a CLI change

The rules are in `AGENTS.md`; this is the procedure. The short version: parsers and
logic get unit tests, everything a caller sees gets an integration scenario, and
nothing here talks to a real API.

## 1. Choose the tier

| You are testing | Tier | Where |
|---|---|---|
| How argv becomes API-call arguments (a flag, a bound, a default) | Unit, on the `parse*Args` function or a plain function | `src/<module>.test.ts` |
| HTTP client behaviour: query mapping, headers, retries, timeouts, tolerant parsing | Unit | `src/api.test.ts` |
| Pure logic: settle loops, formatting, precedence, PKCE, storage | Unit | beside the module |
| Exit code, stdout, stderr, what reaches the wire, files written | Integration scenario | `integration/<area>.test.ts` |
| Install, update, uninstall, signing | Artifact checks | release workflows and `scripts/*.sh` |
| Behaviour against staging, skill quality | Not here | wego-ai's next smoke and evals |

If a unit test needs a command's output, it is an integration scenario. Importing
`run` or a command handler (`login`, `whoami`, `places`, `info`, `feedback`,
`flights`, `hotels`, `logout`, `config`, `telemetry`) into a unit test fails
`scripts/unit-tier-guard.test.ts`. If the logic you need is inside a handler,
export it as a plain function and unit-test that.

## 2. Write the scenario

Read `integration/README.md` once, then copy the shape of a neighbouring file.

```ts
import { expect, it } from "bun:test";
import { readFixture, route } from "./harness/fixtures";
import { useScenario } from "./harness/scenario";
import { json, signIn } from "./harness/wego";

const s = useScenario();

it("prints the caller's identity", async () => {
  signIn(s.home); // as a previous login left it
  const fake = s.fake({ routes: [route("user")] });
  const result = await s.run(["whoami"]);

  expect(result.code).toBe(0);
  expect(json(result).sub).toBe(readFixture("user").body.sub);
  expect(fake.requests("getCurrentUser")[0]?.token).toBe("access-1");
});
```

- Assert on `result.code`, `result.out`, `result.err`, `fake.seen` /
  `fake.requests(op)` (path, query, body, token), and files in `s.home`.
- Values from the API are read from the fixture; values the scenario sets (argv,
  settings) may be written out.
- A route's answers are served in order and the last repeats: a settling search
  needs `route(first, then)`, not a read count.
- Logged-out, expired and refreshed sessions: `signIn(s.home, {...})` plus the
  fake's `accept` and `refresh` options (see `integration/auth.test.ts`).
- Faults: `{ fault: "non-json" }`, `startDropper()` (a reset) and `startDropper({ partial: true })` (a body cut off).
- The test fails by itself if any request or answer breaks the contract, or a
  request reaches a route nobody declared. Do not assert that separately.
- Keep a scenario under a few seconds. A path that needs a long wait is tested
  as a plain function; keep one fast scenario for it end to end.

### When a command or flag changes

`skills/wego/SKILL.md` tells the user's agent which commands to run, and it ships
inside the binary. `integration/skill-matches-cli.test.ts` fails when the skill
names a command that no longer answers `--help`, or a `--flag` its help does not
list. Rename a flag, and update the skill in the same change. Whether the skill
still leads the agent well is the evals' question, answered per release in wego-ai.

## 3. Get the fixture

There is no recorder or generator. Take the first that fits:

1. **Reuse** an existing file in `integration/fixtures/`.
2. **Edit a copy** in the scenario: `answer("flights-results", (b) => ({ ...b, results: [] }))`.
3. **Errors inline**: `problem(404, "not_found")`. Codes are the contract's closed
   set: `validation_failed`, `invalid_token`, `insufficient_scope`, `not_found`,
   `rates_require_hotel_search`, `rate_limited`, `bad_gateway`,
   `upstream_unavailable`, `upstream_rate_limited`, `internal_error`. A status the
   operation does not declare is rejected: the contract declares no 410 and no
   500, so use 502 `bad_gateway` for a server failure.
4. **New file**, only for an operation nothing answers yet:
   `{ "op": "<operationId>", "status": 200, "body": { … } }`. Then run
   `bun test --preload ./integration/harness/preload.ts ./integration/fixtures.test.ts`
   and fix each path it names until it passes. A few list items, not a page.
   Optionally base the body on a real staging answer with `curl` (the command is
   in `integration/README.md`), never on `wego` output, and replace the account's
   identity with `integration@example.com`, `Integration Test`, `1001`.

If the contract rejects a fixture, fix the fixture. Never loosen
`integration/harness/contract.ts` or `fake.ts` to make a scenario pass.

## 4. When the API changed

1. Refresh the contract: `bun run api-contract:refresh` (see `CONTRIBUTING.md`,
   "When the API changes"), committed on its own.
2. `bun run typecheck`: the static contract checks name what the CLI's types no
   longer match.
3. `bun run test:integration`: the fixtures the new contract rejects fail by name
   in `fixtures.test.ts`; fix them, then the scenarios.

## 5. Before you finish

```sh
bun run check
bun run test:integration
```

Both clean. In the pull request, say which tier each new test is in, and for any
test you removed, where its coverage went.
