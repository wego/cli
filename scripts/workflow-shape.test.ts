/**
 * WORKFLOW SHAPE: the capability split in the publishing lanes, asserted.
 *
 * Two capabilities must never meet in one job:
 *   - `id-token: write`, which cosign exchanges for a Fulcio certificate naming
 *     this workflow - the identity `identitiesForRing` pins and every installed
 *     binary verifies;
 *   - `BLOB_READ_WRITE_TOKEN`, which writes the store those binaries download from.
 *
 * They used to meet. The release job held both, ran a frozen install, and then ran
 * `upload-release-blob.ts`, which imports `@vercel/blob` - 31 packages
 * transitively. `id-token: write` is granted per JOB and GitHub sets
 * `ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN` for EVERY step of a job that holds it,
 * so imported code anywhere in that job could mint its own certificate under the
 * name clients trust, and sign whatever it liked. Splitting `sign` out is what
 * closed that; these tests are what keep it closed.
 *
 * WHY A TEST AND NOT A COMMENT. Every regression below is one or two lines, and -
 * except the last - all of them still publish a green release. A weakened lane
 * looks exactly like a working one:
 *
 *   - `setup-bun` added to the signing job (a new signing check needs a script)
 *     -> dependency code is back beside the OIDC token. Nothing fails.
 *   - `id-token: write` moved to workflow level (a new job wants attestations)
 *     -> every job in the file can sign. Nothing fails.
 *   - `environment: production` added to the signing job (it needs a var)
 *     -> the signer can read the store token. Nothing fails.
 *   - the signing job merged back into the publisher ("why the artifact hop?")
 *     -> both capabilities reunited. Nothing fails.
 *   - the signing call extracted into a reusable workflow ("two lanes, one call")
 *     -> the Fulcio SAN re-points at THAT file and every `wego update` fails
 *        closed. This one fails loudly, and catastrophically.
 *
 * The same class already cost this repository twice: the two lanes carried copied
 * signing calls that drifted apart, killing an edge run and then the first real
 * release (see `.github/actions/sign-manifest`). Comments were present throughout.
 *
 * ASSERTED BY PROPERTY, NOT BY NAME. Nothing here pins the string "sign": the
 * claim is "exactly one job may sign, it is the one that runs the signing action,
 * and it can do nothing else". Rename the job freely; violate the shape and this
 * fails.
 *
 * The mutations this suite kills:
 *   - `id-token: write` added at workflow level, or to a second job -> "exactly one".
 *   - the signing job given `setup-bun`, `bun install` or any `bun run` -> "installs nothing".
 *   - the signing job given an `environment:` or the store token -> "cannot reach the store".
 *   - a store-writing job given `id-token: write` -> "cannot sign".
 *   - a lane given a `workflow_call` trigger, or a job delegating to a reusable
 *     workflow -> "the signing call stays in the lane file".
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The two lanes that sign. `promote-cli.yml` copies an already-signed record
 * rather than making one, which is why it holds no `id-token` to begin with.
 *
 * Mutable arrays, not `as const`: `describe.each` takes `unknown[]`.
 */
const SIGNING_LANES: string[] = ["edge-cli.yml", "release-cli.yml"];

/** Every lane that can write a ring, signing or not. */
const PUBLISHING_LANES: string[] = [...SIGNING_LANES, "promote-cli.yml"];

const STORE_TOKEN = "BLOB_READ_WRITE_TOKEN";

/** The build-time variable that decides whether a binary can post telemetry. */
const POSTHOG_VAR = "WEGO_CLI_POSTHOG_PROJECT_KEY";

/** The composite action both lanes sign with; a local path, never a package. */
const SIGN_ACTION = ".github/actions/sign-manifest";

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
}
interface Job {
  permissions?: Record<string, string>;
  environment?: unknown;
  env?: Record<string, unknown>;
  steps?: Step[];
  /** A job-level `uses:` is how a reusable workflow is called. */
  uses?: string;
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

/** Read synchronously: `describe` bodies run before any await would settle. */
function lane(file: string): Workflow {
  const text = readFileSync(`.github/workflows/${file}`, "utf8");
  return Bun.YAML.parse(text) as Workflow;
}

/** Jobs granting `id-token: write`, plus the workflow block if it grants it. */
function signers(wf: Workflow): string[] {
  const found: string[] = [];
  if (wf.permissions?.["id-token"] === "write") found.push("<workflow-level>");
  for (const [name, job] of Object.entries(wf.jobs)) {
    if (job.permissions?.["id-token"] === "write") found.push(name);
  }
  return found;
}

/** Jobs that name the store token anywhere - job env, step env, or a run body. */
function storeWriters(wf: Workflow): string[] {
  return Object.entries(wf.jobs)
    .filter(([, job]) => JSON.stringify(job).includes(STORE_TOKEN))
    .map(([name]) => name);
}

/**
 * Steps that PASS the PostHog key to a build, by parsed `env:` key — not by text.
 *
 * Text matching would be wrong in both directions here: `edge-cli.yml` names the
 * variable in a comment explaining why it must not pass it, and a comment is
 * exactly what this suite exists to stop relying on.
 */
function keyedSteps(wf: Workflow): string[] {
  const found: string[] = [];
  for (const [name, job] of Object.entries(wf.jobs)) {
    if (job.env && POSTHOG_VAR in job.env) found.push(`${name} (job env)`);
    for (const [i, step] of (job.steps ?? []).entries()) {
      if (step.env && POSTHOG_VAR in step.env) found.push(`${name} step ${i}`);
    }
  }
  return found;
}

/** Jobs invoking the signing composite action. */
function signingJobs(wf: Workflow): string[] {
  return Object.entries(wf.jobs)
    .filter(([, job]) =>
      (job.steps ?? []).some((s) => (s.uses ?? "").includes(SIGN_ACTION)),
    )
    .map(([name]) => name);
}

describe.each(SIGNING_LANES)("%s: the signing capability", (file) => {
  const wf = lane(file);

  // 1 — the whole security claim, half one.
  it("grants id-token to exactly one job, and never at workflow level", () => {
    const holders = signers(wf);
    expect(holders).not.toContain("<workflow-level>");
    expect(holders).toHaveLength(1);
  });

  it("gives it to the job that actually signs, and to no other", () => {
    expect(signingJobs(wf)).toEqual(signers(wf));
  });

  // 2 — the signing job runs no repository code, so there is nothing in it to
  // abuse the token it holds. `sign-manifest` needs cosign and a dist/ only.
  it("keeps the signing job free of anything that installs or runs dependencies", () => {
    const [name] = signers(wf);
    const steps = wf.jobs[name as string]?.steps ?? [];
    for (const step of steps) {
      expect(step.uses ?? "").not.toContain("setup-bun");
      expect(step.run ?? "").not.toMatch(/\bbun (install|run|x)\b/);
    }
  });

  // 3 — and cannot reach the store even if something in it did run.
  it("keeps the store token and its environment out of the signing job", () => {
    const [name] = signers(wf);
    const job = wf.jobs[name as string] as Job;
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain(STORE_TOKEN);
  });
});

describe.each(PUBLISHING_LANES)("%s: the store capability", (file) => {
  const wf = lane(file);

  // 4 — the other half of the claim, and the one that holds for promote too.
  it("never gives id-token to a job that can write the store", () => {
    const holders = new Set(signers(wf));
    for (const name of storeWriters(wf)) expect(holders.has(name)).toBe(false);
  });
});

describe.each(SIGNING_LANES)("%s: the signing identity", (file) => {
  const wf = lane(file);

  // 5 — the Fulcio SAN is `<repo>/.github/workflows/<file>@<ref>`: the FILE, not
  // the job. Moving cosign between jobs of this file is invisible to clients;
  // moving it into a `workflow_call` file re-points the SAN and every installed
  // binary refuses the ring. A composite action is safe - it runs inline here.
  it("keeps the signing call in the lane file: no reusable workflow, either way", () => {
    expect(Object.keys(wf.on ?? {})).not.toContain("workflow_call");
    for (const job of Object.values(wf.jobs)) expect(job.uses).toBeUndefined();
  });

  it("signs through the local composite action, not a published one", () => {
    const [name] = signingJobs(wf);
    const step = (wf.jobs[name as string]?.steps ?? []).find((s) =>
      (s.uses ?? "").includes(SIGN_ACTION),
    );
    expect(step?.uses).toStartWith("./");
  });
});

/**
 * THE TELEMETRY KEY: which lane may bake it, asserted rather than commented.
 *
 * Same failure shape as everything above — one line, and the release stays green.
 * Both directions have already shipped:
 *
 *   - NOT PASSED in the release lane. `WEGO_CLI_POSTHOG_PROJECT_KEY` did not survive
 *     the wego-ai -> wego/cli cutover, so v1.1.0 through v1.2.1 baked an empty key,
 *     returned "skipped-unbaked" and sent nothing for two weeks (c0685ff). The key
 *     is optional by design (`release-config.ts` does `|| undefined`), so every
 *     build was green. It was found from outside, by asking PostHog why no 1.2.x
 *     events existed.
 *
 *   - PASSED in the edge lane. Edge builds are dogfood and must never count as
 *     product telemetry, but they emitted into the production project from
 *     2026-08-27 to 09-07 (203 events, 4 devices) and polluted it. The variable now
 *     sits at REPO level, so it is visible to `edge-cli.yml`'s job whatever its
 *     `environment:` says: NOT PASSING IT IS THE ENTIRE MECHANISM.
 *
 * The two claims are one claim, which is why they are one block: exactly one lane
 * bakes this key. `verify-build`'s SMOKE 1 asserts the other end — that the binary
 * the release lane produced actually carries one.
 */
describe("the telemetry key capability", () => {
  it("bakes the key in the release lane, in exactly one place", () => {
    expect(keyedSteps(lane("release-cli.yml"))).toHaveLength(1);
  });

  it("never bakes it in the edge lane, whose builds are dogfood", () => {
    expect(keyedSteps(lane("edge-cli.yml"))).toEqual([]);
  });

  it("never bakes it in the promote lane, which rebuilds nothing", () => {
    expect(keyedSteps(lane("promote-cli.yml"))).toEqual([]);
  });

  it("passes it from vars, never from secrets", () => {
    // A `secrets.` reference would be the tell that someone treated it as one and
    // scoped it to an environment - which is invisible to the build job, because
    // that job deliberately carries no `environment:`. That is precisely how the
    // two-week blackout happened.
    const wf = lane("release-cli.yml");
    const values = Object.values(wf.jobs).flatMap((job) => [
      job.env?.[POSTHOG_VAR],
      ...(job.steps ?? []).map((s) => s.env?.[POSTHOG_VAR]),
    ]);
    const passed = values.filter((v) => v !== undefined);
    expect(passed).toHaveLength(1);
    expect(String(passed[0])).toContain(`vars.${POSTHOG_VAR}`);
    expect(String(passed[0])).not.toContain("secrets.");
  });

  it("keeps the key out of any job that can write the store", () => {
    // Same split as signing: a build must not be able to publish, so the job that
    // holds this must not be a store writer either.
    const wf = lane("release-cli.yml");
    const writers = new Set(storeWriters(wf));
    for (const where of keyedSteps(wf)) {
      expect(writers.has(where.split(" ")[0] as string)).toBe(false);
    }
  });
});
