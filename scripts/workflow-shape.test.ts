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
import { existsSync, readdirSync, readFileSync } from "node:fs";

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

/** The composite action both lanes sign with; a local path, never a package. */
const SIGN_ACTION = ".github/actions/sign-manifest";

/**
 * Does this `uses:` name an action inside THIS repository?
 *
 * Two spellings, and both are local. `./path` is relative to the workspace, so
 * it needs a checkout first. `$/path` is the self repository reference: it
 * resolves to this repository at the RUNNING COMMIT with no checkout, it may
 * not carry an `@ref`, and GitHub now recommends it over `./` precisely because
 * `./` resolves against whatever the caller happened to check out.
 *
 * Both guards below have to know both spellings, or adopting the recommended
 * one breaks them in opposite directions: the signing assertion would reject a
 * correct local call, and the dependabot check would demand an update entry for
 * an action that has no version to bump. Neither failure would be true.
 */
const isLocalUses = (uses: string): boolean =>
  uses.startsWith("./") || uses.startsWith("$/");

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
    expect(step?.uses ?? "").toSatisfy(isLocalUses);
  });
});

/**
 * `bun install` runs this repository's `prepare` script, and `prepare` is husky:
 * it points `core.hooksPath` at `.husky/_`. On a runner that is at best pointless
 * and at worst load-bearing in the wrong direction - `release-please.yml`,
 * `release-badge.yml` and the promote lane all commit, and a pre-commit hook
 * firing inside a release job would fail a release over a file the lane did not
 * write and cannot fix.
 *
 * `.github/actions/setup-bun` sets `HUSKY=0` for exactly that reason. The guard
 * only holds while every install goes through the composite, and the next
 * workflow to add a bare `bun install` would undo it silently, months later, in
 * a lane nobody runs on a pull request.
 *
 * The mutation this kills: a `run: bun install` step added anywhere outside the
 * composite action - in a workflow, or in one of the OTHER composite actions,
 * which is the half a workflows-only scan misses.
 */
const INSTALL = /\bbun\s+install\b/;

/** The one action allowed to install; it is the action that carries `HUSKY=0`. */
const INSTALLER = "setup-bun";

describe("every `bun install` goes through the composite action", () => {
  const files = readdirSync(".github/workflows").filter((f) =>
    /\.ya?ml$/.test(f),
  );

  /**
   * Every composite action except the installer itself. Both spellings: GitHub
   * accepts `action.yaml`, and a guard that only knows `action.yml` would skip
   * the file it was added to watch, silently and green.
   */
  const actionFile = (dir: string): string | undefined =>
    [
      `.github/actions/${dir}/action.yml`,
      `.github/actions/${dir}/action.yaml`,
    ].find((path) => existsSync(path));

  const actions = readdirSync(".github/actions").filter(
    (d) => d !== INSTALLER && actionFile(d) !== undefined,
  );

  it("finds workflows and composite actions to check", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(actions.length).toBeGreaterThan(0);
  });

  it.each(files)("%s runs no bare `bun install`", (file) => {
    const wf = lane(file);
    const installs = Object.values(wf.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "")
      .filter((run) => INSTALL.test(run));

    expect(installs).toEqual([]);
  });

  it.each(actions)("the %s action runs no bare `bun install`", (dir) => {
    const text = readFileSync(actionFile(dir) as string, "utf8");
    const action = Bun.YAML.parse(text) as {
      runs?: { steps?: { run?: string }[] };
    };
    const installs = (action.runs?.steps ?? [])
      .map((step) => step.run ?? "")
      .filter((run) => INSTALL.test(run));

    expect(installs).toEqual([]);
  });

  it("keeps HUSKY=0 on the composite action's install step", () => {
    const action = readFileSync(".github/actions/setup-bun/action.yml", "utf8");
    expect(action).toContain("HUSKY: 0");
  });
});

/**
 * DEPENDABOT COVERAGE: every composite action that uses a third-party action
 * has an entry in `.github/dependabot.yml` naming its directory.
 *
 * WHY THIS IS NOT COVERED ELSEWHERE. The dependency graph parses GitHub Actions
 * manifests only under `.github/workflows/`, so an action named only inside a
 * a `.github/actions/<dir>/action.yml` is invisible to it - and therefore invisible to
 * Dependabot alerts. Three were, before `.github/dependabot.yml` existed:
 * `oven-sh/setup-bun` and `actions/cache` in `setup-bun`, and
 * `sigstore/cosign-installer` in `sign-manifest`. The last one runs in the `sign`
 * job, the only job in this repository holding `id-token: write`.
 *
 * Every one of them is SHA-pinned. A pin stops a compromised publisher pushing
 * new code at us; it cannot tell us the pinned version has since been disclosed
 * vulnerable. `.github/dependabot.yml` is what tells us, and only for the
 * directories it names.
 *
 * WHY A TEST. The failure is silent in both directions:
 *
 *   - Add a composite action, or a third-party `uses:` to an existing one, and
 *     forget the entry: the action is watched by nothing, the checks stay green,
 *     and nobody finds out until a disclosure nobody was told about.
 *   - Rename or delete a composite directory and leave the entry: Dependabot
 *     keeps an update job pointed at a path that no longer exists. It does not
 *     fail the config; it just covers nothing.
 *
 * Both assertions below are the same invariant `wego/cli#77` added for PROMOTERS
 * vs CODEOWNERS: the config and the thing it covers must not drift.
 *
 * `directory: "/"` is deliberately NOT accepted as coverage for these. In
 * dependabot-core's `github_actions` file fetcher, `/` is a special case that
 * fetches a ROOT-level `action.yml` and then scans `.github/workflows/`; every
 * other directory scans that directory itself. A composite action is only
 * reached by an entry that names its own directory.
 */
describe("dependabot watches every composite action's third-party uses", () => {
  const actionFileFor = (dir: string): string | undefined =>
    [
      `.github/actions/${dir}/action.yml`,
      `.github/actions/${dir}/action.yaml`,
    ].find((path) => existsSync(path));

  /**
   * A `uses:` that resolves OUTSIDE this repository, and so has a version worth
   * watching. A local composite action - either spelling, see `isLocalUses` -
   * has its own directory checked on its own iteration and nothing to bump.
   */
  const thirdPartyUses = (dir: string): string[] => {
    const action = Bun.YAML.parse(
      readFileSync(actionFileFor(dir) as string, "utf8"),
    ) as { runs?: { steps?: { uses?: string }[] } };

    return (action.runs?.steps ?? [])
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined)
      .filter((uses) => !isLocalUses(uses));
  };

  const dependabot = Bun.YAML.parse(
    readFileSync(".github/dependabot.yml", "utf8"),
  ) as { updates?: { "package-ecosystem"?: string; directory?: string }[] };

  const watched = new Set(
    (dependabot.updates ?? [])
      .filter((u) => u["package-ecosystem"] === "github-actions")
      .map((u) => u.directory)
      .filter((d): d is string => d !== undefined),
  );

  const composites = readdirSync(".github/actions").filter(
    (d) => actionFileFor(d) !== undefined,
  );

  const needsWatching = composites.filter((d) => thirdPartyUses(d).length > 0);

  it("finds composite actions with third-party uses to check", () => {
    // Guards the loops below against an empty list passing vacuously - a moved
    // directory would otherwise turn this whole block into a no-op.
    expect(composites.length).toBeGreaterThan(0);
    expect(needsWatching.length).toBeGreaterThan(0);
  });

  it.each(
    needsWatching,
  )("the %s action has a dependabot entry for its own directory", (dir) => {
    expect(watched).toContain(`/.github/actions/${dir}`);
  });

  it("has no dependabot entry pointing at a directory it need not watch", () => {
    const stale = [...watched]
      .filter((d) => d.startsWith("/.github/actions/"))
      .filter(
        (d) => !needsWatching.includes(d.slice("/.github/actions/".length)),
      );

    expect(stale).toEqual([]);
  });
});
