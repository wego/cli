# integration/

The CLI's integration tier: the **compiled `wego` binary**, run as its own process
with real argv and real HTTP, against a fake API on a loopback port.

```sh
bun run test:integration                                   # compiles the host binary
WEGO_INTEGRATION_BINARY=dist/wego-linux-x64 bun run test:integration   # drives a built one
```

It needs no network, no account and no staging access, so it runs on every pull
request (as a step of `ci-cli`) and, in the release run, on each of the five built
targets on its own runner before anything is published (`integration (<target>)`).
Both block.

## What it proves

That the binary a user installs does what an agent relies on: the exit code for
each outcome, JSON and only JSON on stdout, prose on stderr, the request each
command sends, the credentials and settings it writes, and the login it completes.
No in-process test can see any of that: the stream split and the exit code only
exist at the process boundary.

## Why the fake can be trusted

A fake that only answers what its author expected can only fail when it disagrees
with itself (#1328). This one is held to the API's published contract instead:

- **Every request** the binary sends is matched to an operation in
  `contract/openapi.json` and checked against it: path parameters, query parameters
  (an undeclared one fails), and the JSON body.
- **Every answer** the fake sends is checked against the same operation's declared
  status, media type and schema before the scenario can pass.
- **A request no scenario expects** fails the scenario, by name.

So a scenario passes only if the CLI and the API's contract agree. A contract
refresh that the CLI does not keep up with fails here, and so does a fixture that
no longer matches the contract (`fixtures.test.ts`).

## Layout

| Path | What |
|---|---|
| `harness/binary.ts` | Compiles the host binary, or copies the one `WEGO_INTEGRATION_BINARY` names, as `wego` |
| `harness/fake.ts` | The fake: the API, the auth server's token endpoint, faults |
| `harness/contract.ts` | The validator for the slice of JSON Schema the contract uses |
| `harness/wego.ts` | Runs the binary in a fresh home with an environment built from nothing |
| `harness/scenario.ts` | Per-test setup, and the check that nothing broke the contract |
| `harness/login.ts` | Plays the browser's part in `wego login` |
| `harness/fixtures.ts` | Reads fixtures; `route()` and `answer()` build a route's answers from them |
| `harness/preload.ts` | Resolves the binary once, before any scenario loads |
| `fixtures/*.json` | One API answer each, naming its `operationId` |
| `*.test.ts` | Scenarios, one file per area |

## Writing a scenario

```ts
const s = useScenario();

it("prints the caller's identity", async () => {
  signIn(s.home);                                  // as a previous login left it
  const fake = s.fake({ routes: [route("user")] }); // answers getCurrentUser from fixtures/user.json
  const result = await s.run(["whoami"]);

  expect(result.code).toBe(0);
  expect(json(result).sub).toBe(readFixture("user").body.sub);
  expect(fake.requests("getCurrentUser")[0]?.token).toBe("access-1");
});
```

- Assert on what a caller sees: `result.code`, `result.out`, `result.err`, what the
  fake received (`fake.seen`), and files in `s.home`.
- A value that comes from the API is read from the fixture, never typed into the
  scenario, so editing a fixture cannot break it. A value the scenario sets (argv,
  settings) may be written out.
- A route's answers are served in order and the last one repeats, so a command that
  re-reads until a search settles needs no read count.
- `problem(status, code)` builds an error answer; the contract's `code` values are
  a closed set.

A unit test never asserts on a command's stdout, stderr or exit code; that is this
tier's job. `scripts/unit-tier-guard.test.ts` enforces it.

## Getting a fixture

There is no recorder and no generator: a fixture is a small JSON file you write,
and the contract check is what keeps it honest. Take the first of these that fits.

1. **Reuse one.** `route("flights-results")` answers every scenario that needs a
   results page.
2. **Edit a copy for one scenario.** `answer("flights-results", (b) => ({ ...b,
   results: [] }))` is an empty page; the edit is checked against the contract as
   it is served, like any answer.
3. **An error is inline.** `problem(404, "not_found")`, with a `code` from the
   contract's closed set.
4. **Write a new file** only for an operation nothing answers yet, or an answer an
   edit cannot express:

   ```json
   { "op": "<operationId from contract/openapi.json>", "status": 200, "body": { } }
   ```

   Fill the body, then let the contract tell you what is wrong with it:

   ```sh
   bun test --preload ./integration/harness/preload.ts ./integration/fixtures.test.ts
   ```

   Each failure names the file and the path, for example
   `200 body.metadata.totalCandidates: required`. Repeat until it passes. Keep the
   body to what a scenario reads plus what the contract requires; a few list items,
   not a page.

**Basing a body on a real answer** is optional and needs no tool: with a staging
login (`wego --target staging login`), ask the API directly and trim the result.

```sh
TOKEN=$(jq -r .accessToken "${XDG_CONFIG_HOME:-$HOME/.config}/wego/auth.wegostaging.com/credentials.json")
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.wegostaging.com/v1/places?query=London" | jq '.results |= .[:3]'
```

Before committing it, replace anything that identifies the account (email, name,
user id) with `integration@example.com`, `Integration Test` and `1001`.
`integration/` is code-owned, and a reviewer checks exactly that. Do not copy a
`wego …` command's output instead: the CLI reshapes what it prints, so it is not
what the API sends.

Real traffic is what the next smoke is for: it runs the published binary against
staging on every release. Fixtures only have to be what the contract says the API
may send.
