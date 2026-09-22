/**
 * The api↔cli contract chain, as `ci-cli.yml` and `package.json` wire it.
 *
 * Three claims, and each one is a line someone could plausibly "tidy up":
 *
 *   - The drift step NEVER fails the job. It is a reminder about a vendored
 *     file, on the required check, against an API that deploys on its own
 *     cadence. Drop `continue-on-error` or let one branch fall through without
 *     `exit 0` and every CLI pull request opened after an unrelated API release
 *     is blocked on a contract its author never touched. Nothing else notices:
 *     the workflow still parses, and the step still passes on the day it is
 *     changed.
 *   - The contract is fetched from PRODUCTION and nowhere else. The document
 *     carries a `servers` block naming its host, so a staging URL would rewrite
 *     that line on every refresh and compare the committed contract against one
 *     nothing ships against.
 *   - `src/api-types.d.ts` is generated, not committed, and the `typecheck`
 *     script is what generates it. Checks A and C are compile-time comparisons
 *     against it; a committed copy is a second contract to keep in step, and a
 *     stale one silently checks the wrong shapes. Move the generation back out
 *     into a workflow step and only the lane carrying that step is covered -
 *     the release lane and every developer's terminal compare against whatever
 *     `postinstall` last left behind, or against nothing at all.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const CI = ".github/workflows/ci-cli.yml";
/** The other lane that typechecks, and the reason generation belongs to the script. */
const RELEASE = ".github/workflows/release-cli.yml";

const DRIFT_STEP = "Contract drift (warning only)";

/** The published contract, and the only host it may be fetched from. */
const CONTRACT_URL = "https://api.wego.com/openapi";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  "continue-on-error"?: boolean;
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      environment?: unknown;
      steps?: Step[];
    }
  >;
}

const workflow = Bun.YAML.parse(readFileSync(CI, "utf8")) as Workflow;
const job = workflow.jobs["ci-cli"];
const steps = job?.steps ?? [];

const stepNamed = (name: string): Step | undefined =>
  steps.find((step) => step.name === name);

const indexOfStep = (name: string): number =>
  steps.findIndex((step) => step.name === name);

interface Manifest {
  scripts?: Record<string, string>;
  trustedDependencies?: string[];
}
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
const scripts = manifest.scripts ?? {};

describe("ci-cli: the contract drift step cannot veto a merge", () => {
  it("is present, after the tests", () => {
    expect(indexOfStep(DRIFT_STEP)).toBeGreaterThan(indexOfStep("Unit tests"));
    expect(indexOfStep("Unit tests")).toBeGreaterThan(-1);
  });

  it("carries continue-on-error", () => {
    expect(stepNamed(DRIFT_STEP)?.["continue-on-error"]).toBe(true);
  });

  it("ends every branch of its script in `exit 0`", () => {
    // The second half of the pair. `continue-on-error` alone survives a
    // rewrite of the script; an `exit 0` on every path alone survives a
    // rewrite of the step. Together, one edit cannot make this a gate.
    const run = stepNamed(DRIFT_STEP)?.run ?? "";
    expect(run).not.toBe("");
    const exits = run.match(/^\s*exit \d+\s*$/gm) ?? [];
    expect(exits.length).toBeGreaterThan(2);
    expect(exits.every((line) => line.trim() === "exit 0")).toBe(true);
    // GitHub runs `bash -e` by default, so `exit 0` on every path is only
    // true if the script turns that off: an unguarded failure would otherwise
    // abort before the trailing `exit 0` and hand the job a non-zero status.
    expect(run).toMatch(/^\s*set \+e\s*$/m);
    expect(run).not.toMatch(/^\s*set -[a-z]*e/m);
  });

  it("warns rather than fails, and says how to fix it", () => {
    const run = stepNamed(DRIFT_STEP)?.run ?? "";
    expect(run).toContain("::warning::contract ");
    expect(run).toContain("bun run api-contract:refresh");
    // A fetch that does not answer is a notice, never a warning: a flaky CDN
    // is not drift, and a warning nobody can act on trains people to ignore
    // the real one.
    expect(run).toContain("::notice::");
    expect(run).not.toContain("::error::");
  });

  it("fetches production, with the retry and timeout that keep it quiet", () => {
    const run = stepNamed(DRIFT_STEP)?.run ?? "";
    expect(run).toContain(CONTRACT_URL);
    expect(run).toContain("--retry 3");
    expect(run).toContain("--max-time 20");
    const hosts = run.match(/https?:\/\/[^\s"';]+/g) ?? [];
    expect([...new Set(hosts)]).toEqual([CONTRACT_URL]);
  });

  it("needs no secret and no extra permission", () => {
    const step = stepNamed(DRIFT_STEP);
    expect(JSON.stringify(step)).not.toContain("secrets.");
    expect(JSON.stringify(step)).not.toContain("id-token");
    expect(step?.env).toBeUndefined();
    // `contents: read` and nothing else, at workflow level and job level.
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job?.permissions).toBeUndefined();
    expect(job?.environment).toBeUndefined();
  });

  it("keeps the checkout credential-free", () => {
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });
});

describe("the generated types exist before anything compares them", () => {
  // The guarantee used to be a `ci-cli` step that ran `api-types:generate`
  // ahead of the typecheck. That covered this one lane and nothing else: the
  // release lane typechecks without it, and a developer whose install skipped
  // `postinstall` got 168 errors about code that is fine, because Checks A and
  // C resolve to `never` when the file is absent. The generation now lives in
  // the `typecheck` script, so every caller inherits it.
  it("are regenerated by the typecheck script itself", () => {
    const typecheck = scripts.typecheck ?? "";
    // Anchored and POSITIVE, matching the whole generate-to-bunx boundary,
    // because a blacklist only refuses the separator someone already thought
    // of. `; bunx` alone let three worse spellings through: `;bunx` (no
    // space), a bare `&` (generation backgrounded, tsc racing it) and a
    // newline - and `||`, which is the inversion of the guarantee, running
    // tsc only when the generation FAILED. A new separator now has to be
    // written into this line to pass, rather than merely dodge it.
    expect(typecheck).toMatch(
      /^\s*bun run api-types:generate\s+&&\s+bunx\b.*\btsc\b/,
    );
    expect(typecheck).toContain("--noEmit");
  });

  it("are not regenerated by a second, drifting copy in ci-cli", () => {
    // A standalone step here would be a second place to keep in step with
    // package.json, and the lane that has one would silently diverge from the
    // lane that does not.
    const standalone = steps.filter(
      (step) =>
        step.run?.includes("api-types:generate") &&
        !step.run?.includes("typecheck"),
    );
    expect(standalone).toEqual([]);
    expect(indexOfStep("Typecheck")).toBeGreaterThan(-1);
    expect(stepNamed("Typecheck")?.run).toBe("bun run typecheck");
  });

  it("cover the release lane too, which has no generate step of its own", () => {
    const release = Bun.YAML.parse(readFileSync(RELEASE, "utf8")) as Workflow;
    const releaseSteps = Object.values(release.jobs).flatMap(
      (releaseJob) => releaseJob.steps ?? [],
    );
    const typechecks = releaseSteps.filter((step) =>
      step.run?.includes("typecheck"),
    );
    expect(typechecks.length).toBeGreaterThan(0);
    for (const step of typechecks) expect(step.run).toBe("bun run typecheck");
    expect(
      releaseSteps.filter(
        (step) =>
          step.run?.includes("api-types:generate") &&
          !step.run?.includes("typecheck"),
      ),
    ).toEqual([]);
  });

  it("runs the unit tests over ./src, where Check B lives", () => {
    expect(stepNamed("Unit tests")?.run).toBe("bun run test");
    expect(scripts.test).toContain("./src");
  });
});

describe("package.json: the contract scripts", () => {
  // Three assertions used to sit above this one, each comparing a script string
  // to its own literal: `postinstall`, `api-contract:refresh`,
  // `api-types:generate`. They restated `package.json` rather than constraining
  // it, and the failure they imagined is loud anyway - `src/api-wire.ts` opens
  // with `import type { components, operations } from "./api-types"`, so a tree
  // where the generator did not run dies on TS2307 at the first `bun run
  // typecheck`, named and immediate. What survives below is the one claim about
  // these scripts that is NOT visible in the file: the order they run in.

  // Not a restatement of package.json, and worth the line it costs:
  // `trustedDependencies` decides which DEPENDENCIES may run lifecycle scripts
  // during `bun install` - the install that runs beside the signing identity and
  // the store token in three lanes. Empty is the claim: nothing in the tree gets
  // to execute on install. The root package's own `postinstall` is unaffected;
  // this list governs the dependencies, not the package it appears in.
  it("lets no dependency run a lifecycle script on install", () => {
    expect(manifest.trustedDependencies).toEqual([]);
  });

  it("regenerates the types as part of the refresh, and only on success", () => {
    // `postinstall` generated the types from the OLD contract. A refresh that
    // stopped at the JSON would leave them behind it, and the very next
    // `bun run typecheck` would run Checks A and C against shapes the API no
    // longer publishes - the stale-snapshot failure this whole PR exists to
    // end, reintroduced one step later.
    //
    // `&&`, not `;`: a failed fetch must leave the tree exactly as it was.
    const refresh = scripts["api-contract:refresh"] ?? "";
    expect(refresh).toContain("&& bun run api-types:generate");
    expect(refresh).not.toContain("; bun run api-types:generate");
    expect(refresh.indexOf("refresh-api-contract")).toBeLessThan(
      refresh.indexOf("api-types:generate"),
    );
  });
});

describe("src/api-types.d.ts is generated, not committed", () => {
  it("is ignored by git", () => {
    expect(readFileSync(".gitignore", "utf8")).toContain("src/api-types.d.ts");
  });

  it("is not tracked", () => {
    const tracked = Bun.spawnSync([
      "git",
      "ls-files",
      "--",
      "src/api-types.d.ts",
    ]);
    expect(tracked.stdout.toString().trim()).toBe("");
  });
});

describe("the vendored contract is committed", () => {
  it("is tracked, so a fresh clone can typecheck", () => {
    const tracked = Bun.spawnSync([
      "git",
      "ls-files",
      "--",
      "contract/openapi.json",
    ]);
    expect(tracked.stdout.toString().trim()).toBe("contract/openapi.json");
  });

  it("is what the generator reads", () => {
    const generator = readFileSync("scripts/generate-api-types.ts", "utf8");
    expect(generator).toContain('"../contract/openapi.json"');
    // The monorepo path the generator used to resolve does not exist here, and
    // neither does `bun run --filter cli`.
    expect(generator).not.toContain("apps/api");
    expect(generator).not.toContain("--filter cli");
  });

  it("is typechecked locally even when it is the only staged file", () => {
    // A refresh commit is `contract/openapi.json` alone: CONTRIBUTING says to
    // commit that diff on its own, and the regenerated `src/api-types.d.ts` is
    // gitignored, so no `*.ts` is staged beside it. The pre-commit typecheck
    // stanza used to key on `*.ts` only, which made the commit that changes
    // what the CLI is checked against the one commit that never checked it.
    //
    // Matched on the stanza's own line, not the whole file, so an unrelated
    // hook edit does not trip this.
    const hook = readFileSync(".husky/pre-commit", "utf8");
    const typecheckStanza = hook
      .split("\n")
      .find((line) => line.includes("staged") && line.includes("'*.ts'"));
    expect(typecheckStanza).toBeDefined();
    expect(typecheckStanza).toContain("contract");
  });

  it("is formatted by biome, like every other committed file", () => {
    // The vendored contract used to be exempted from biome, because biome
    // reformats it and the refresh script wrote a different shape - so every
    // refresh left `bun run lint` red. The fix is to let biome own the
    // formatting and have the refresh run it, not to carve the file out: an
    // exemption is a rule nobody can see from the file itself, and this
    // repository has exactly one formatter.
    const biome = readFileSync("biome.jsonc", "utf8");
    expect(biome).not.toContain('"!contract"');
    const refresher = readFileSync("scripts/refresh-api-contract.ts", "utf8");
    expect(refresher).toContain('"biome", "format", "--write"');
  });

  it("is refreshed from production and nowhere else", () => {
    const refresher = readFileSync("scripts/refresh-api-contract.ts", "utf8");
    const hosts = refresher.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    expect([...new Set(hosts)]).toEqual([CONTRACT_URL]);
  });
});
