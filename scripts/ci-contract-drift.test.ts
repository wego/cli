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
 *   - `src/api-types.d.ts` is generated, not committed. Checks A and C are
 *     compile-time comparisons against it; a committed copy is a second contract
 *     to keep in step, and a stale one silently checks the wrong shapes.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const CI = ".github/workflows/ci-cli.yml";

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

describe("ci-cli: the generated types exist before anything compares them", () => {
  it("generates them before the typecheck", () => {
    const generate = steps.findIndex((step) =>
      step.run?.includes("api-types:generate"),
    );
    const typecheck = indexOfStep("Typecheck");
    expect(generate).toBeGreaterThan(-1);
    expect(typecheck).toBeGreaterThan(generate);
  });

  it("runs the unit tests over ./src, where Check B lives", () => {
    expect(stepNamed("Unit tests")?.run).toBe("bun run test");
    expect(scripts.test).toContain("./src");
  });
});

describe("package.json: the contract scripts", () => {
  it("regenerates the types on install", () => {
    // `trustedDependencies` governs DEPENDENCIES' lifecycle scripts, not the
    // root package's own, so an empty list does not stop this running.
    expect(scripts.postinstall).toBe("bun run api-types:generate");
    expect(manifest.trustedDependencies).toEqual([]);
  });

  it("refreshes the contract by hand, never on a schedule", () => {
    expect(scripts["api-contract:refresh"]).toBe(
      "bun run scripts/refresh-api-contract.ts && bun run api-types:generate",
    );
    expect(scripts["api-types:generate"]).toBe(
      "bun run scripts/generate-api-types.ts",
    );
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

  it("is refreshed from production and nowhere else", () => {
    const refresher = readFileSync("scripts/refresh-api-contract.ts", "utf8");
    const hosts = refresher.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    expect([...new Set(hosts)]).toEqual([CONTRACT_URL]);
  });
});
