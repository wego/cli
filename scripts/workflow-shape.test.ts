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
 * ASSERTED BY PROPERTY WHERE THERE IS A PROPERTY. Nothing here pins the string
 * "sign": the claim is "the job that may sign is the one that runs the signing
 * action, and it can do nothing else". Rename the job freely; violate the shape
 * and this fails.
 *
 * `ID_TOKEN_HOLDERS` below is the one deliberate exception, and it is a LIST
 * because there is no longer a property that separates the holders. Two jobs now
 * want an OIDC token for unrelated reasons: `sign` exchanges it for a Fulcio
 * certificate, and the verification job presents it as an identity to a
 * receiver in wego-ai that writes a check run back. "The job that runs cosign"
 * does not describe the second kind, and "any job that needs an identity"
 * describes every job anyone will ever want to add. So the set is enumerated, and
 * widening it is a diff a release signer reviews rather than a property that
 * quietly admits one more.
 *
 * The mutations this suite kills:
 *   - `id-token: write` added at workflow level, or to a job outside the named
 *     set -> "exactly these jobs".
 *   - the signing job given `setup-bun`, `bun install` or any `bun run` -> "installs nothing".
 *   - the signing job or a verification job given an `environment:` or the store
 *     token -> "cannot reach the store".
 *   - a store-writing job given `id-token: write` -> "cannot sign".
 *   - a lane given a `workflow_call` trigger, or a job delegating to a reusable
 *     workflow -> "the signing call stays in the lane file".
 *   - a verification job given a guard or a setting, or its body grown a third
 *     field -> "always asks, and sends only what the receiver needs".
 *   - the verification job given a checkout or any grant beside `id-token` ->
 *     "an identity leaves, and nothing else does".
 *   - a report reader given a write grant, an OIDC token or a secret, or made
 *     able to go red -> "reads the report, and nothing else".
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

/**
 * EVERY JOB IN THE REPOSITORY THAT MAY HOLD `id-token: write`, by file and name.
 *
 * Three, in two files, and they are two kinds of thing:
 *
 *   edge-cli.yml    sign            cosign, for the edge ring's signed record
 *   release-cli.yml sign            cosign, for the release manifest
 *   release-cli.yml notify-verify   the release's identity, to the verify receiver
 *
 * The receiver in wego-ai reads the token's claims - `repository`, `event_name`,
 * `ref`, `job_workflow_ref`, `sha` - and answers 403 to anything else, so the
 * value of `id-token: write` in the verification job is precisely that it cannot
 * be minted anywhere else and still match. A fourth job quietly granted the
 * permission is a fourth place a token naming this repository can be produced, and
 * `workflow-lanes.test.ts` cannot see it because none of these jobs touches a ring.
 */
const ID_TOKEN_HOLDERS: Record<string, string[]> = {
  "edge-cli.yml": ["sign"],
  "release-cli.yml": ["sign", "notify-verify"],
};

/** The job that presents an identity rather than signs with one. */
const VERIFY_JOBS: [string, string][] = [["release-cli.yml", "notify-verify"]];

/** The one receiver, spelled out in the workflow rather than read from a setting. */
const RECEIVER_URL = "https://api.wego.com/.well-known/internal/cli-verify";

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
 * The signing assertion below has to know both spellings. Knowing only `./`, it
 * would reject a correct local call to `sign-manifest` the moment anyone adopts
 * the recommended form - a failure that would not be true, on the one assertion
 * that guards the release signer.
 */
const isLocalUses = (uses: string): boolean =>
  uses.startsWith("./") || uses.startsWith("$/");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
}
interface Job {
  permissions?: Record<string, string>;
  environment?: unknown;
  env?: Record<string, unknown>;
  steps?: Step[];
  needs?: string | string[];
  if?: string;
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

/**
 * 1 - the whole security claim, half one, and now stated over the WHOLE directory
 * rather than per signing lane.
 *
 * Scoping it to the two signing lanes was right while `sign` was the only holder
 * anywhere; it is not right now, because a third file can grant the permission and
 * a suite that only reads two files would never look. `readdirSync` is what makes
 * "no other job, in no other workflow" an assertion rather than an intention.
 */
describe("id-token: write is granted to exactly the named jobs", () => {
  const files = readdirSync(".github/workflows")
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();

  it("finds the workflows the named set refers to", () => {
    // A renamed file would otherwise drop out of the scan AND out of the
    // comparison, leaving this suite green having asserted nothing about it.
    for (const file of Object.keys(ID_TOKEN_HOLDERS)) {
      expect(
        files,
        `${file} is named in ID_TOKEN_HOLDERS but does not exist`,
      ).toContain(file);
    }
  });

  it.each(files)("%s grants it to exactly the jobs named for it", (file) => {
    const holders = signers(lane(file));
    // A workflow-level grant reaches every job in the file, including ones added
    // later by someone who never read this test.
    expect(
      holders,
      `${file} grants id-token at workflow level, which reaches every job in it`,
    ).not.toContain("<workflow-level>");
    expect(
      holders.sort(),
      `${file}'s id-token holders are not the named set. Widening it is a deliberate edit to ID_TOKEN_HOLDERS, reviewed by a release signer.`,
    ).toEqual([...(ID_TOKEN_HOLDERS[file] ?? [])].sort());
  });
});

describe.each(SIGNING_LANES)("%s: the signing capability", (file) => {
  const wf = lane(file);

  it("gives it to the job that actually signs, and to no other", () => {
    // Still a property: whatever else holds an OIDC token in this file, exactly
    // one job runs the signing action, and it is one of the named holders.
    const signing = signingJobs(wf);
    expect(signing).toHaveLength(1);
    expect(signers(wf)).toContain(signing[0] as string);
  });

  // 2 — the signing job runs no repository code, so there is nothing in it to
  // abuse the token it holds. `sign-manifest` needs cosign and a dist/ only.
  it("keeps the signing job free of anything that installs or runs dependencies", () => {
    const [name] = signingJobs(wf);
    const steps = wf.jobs[name as string]?.steps ?? [];
    for (const step of steps) {
      expect(step.uses ?? "").not.toContain("setup-bun");
      expect(step.run ?? "").not.toMatch(/\bbun (install|run|x)\b/);
    }
  });

  // 3 — and cannot reach the store even if something in it did run.
  it("keeps the store token and its environment out of the signing job", () => {
    const [name] = signingJobs(wf);
    const job = wf.jobs[name as string] as Job;
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain(STORE_TOKEN);
  });
});

/**
 * THE VERIFICATION JOBS: an identity leaves, and nothing else does.
 *
 * It holds `id-token: write` so a receiver in wego-ai can read a token GitHub
 * signed and decide, from its claims alone, whether this repository is asking. The
 * whole arrangement rests on this repository holding NO credential for it, which is
 * three separate properties and not one:
 *
 *   - no `environment:`, so the job cannot be handed the store token the way
 *     `release` and the promote lanes are;
 *   - no `secrets.` reference, so nothing is handed to it directly either;
 *   - the request body carries the tag and the sha and nothing more, so a future
 *     field cannot become a place to put something that matters.
 *
 * And no switch: the job always asks, and a receiver that is switched off answers
 * 404, which the job reports as "not verified" rather than as a red release.
 */
describe.each(
  VERIFY_JOBS,
)("%s %s: presents an identity, holds no secret", (file, name) => {
  const wf = lane(file);
  const job = wf.jobs[name] as Job | undefined;
  const text = JSON.stringify(job ?? {});

  it("exists", () => {
    expect(job, `${file} has no job '${name}'`).toBeDefined();
  });

  it("declares no environment, so it can never be handed the store token", () => {
    expect(job?.environment).toBeUndefined();
    expect(text).not.toContain(STORE_TOKEN);
  });

  it("reads no secret at all", () => {
    expect(text).not.toContain("secrets.");
  });

  it("always runs, and asks the one receiver", () => {
    // A guard or a variable here would be a second switch beside the receiver's.
    expect(job?.if, `${file} ${name} must not be guarded`).toBeUndefined();
    expect(text).not.toContain("vars.");
    const post = (job?.steps ?? []).find((s) => s.env?.RECEIVER !== undefined);
    expect(post?.env?.RECEIVER).toBe(RECEIVER_URL);
  });

  it("reads a switched-off receiver as not verified, not as a failure", () => {
    const post = (job?.steps ?? []).find((s) => s.env?.RECEIVER !== undefined);
    const arm = /\n\s*404\)([^;]*);;/.exec(post?.run ?? "");
    expect(arm, `${file} ${name} has no 404) arm`).not.toBeNull();
    expect(arm?.[1]).toContain("::notice::");
    expect(arm?.[1]).not.toContain("exit 1");
  });

  it("sends the tag and the sha, and nothing else", () => {
    // The receiver also accepts `suites`, `platforms` and `reason`. None is this
    // repository's decision, and an unused field is one more thing two
    // repositories have to keep agreeing about.
    const post = (job?.steps ?? []).find((s) =>
      (s.run ?? "").includes("jq -cn"),
    );
    expect(post?.run, `${file} ${name} builds no request body`).toBeDefined();
    const body = /jq -cn([^']*)'([^']*)'/.exec(post?.run ?? "");
    expect(body?.[2]).toBe("{tag:$tag, sha:$sha}");
    // `--arg`, so the two values are jq data rather than jq program text.
    expect(post?.run).toContain('--arg tag "$TAG"');
    expect(post?.run).toContain('--arg sha "$SHA"');
  });

  it("interpolates no expression into a run body", () => {
    // Everything arrives through `env:`. A `${{ }}` inside `run:` is substituted by
    // the runner before bash sees it, which is how an input becomes code.
    for (const step of job?.steps ?? []) {
      expect(
        step.run ?? "",
        `${file} ${name}: a run: body interpolates a \${{ }} expression`,
      ).not.toContain("${{");
    }
  });
});

/**
 * The one `needs:` edge worth asserting, and why it is not simply "no edge".
 *
 * `notify-verify` waits for the job that advances `cli/next`, because a
 * verification of bytes the ring is not yet serving proves nothing. That job is
 * also the one holding the store token, so the edge exists on purpose and cannot be
 * removed. What must stay true is that it is the ONLY such edge: `needs:` passes a
 * job's outputs, never its secrets, but each additional edge to a token-bearing job
 * is another place a future output could carry something it should not.
 */
describe("release-cli.yml: notify-verify waits for the pointer, and nothing else privileged", () => {
  const wf = lane("release-cli.yml");

  /** The job whose steps move `cli/next`. Found by the step, not by its name. */
  const advancer = Object.entries(wf.jobs).find(([, job]) =>
    (job.steps ?? []).some((s) => s.name === "Advance cli/next"),
  )?.[0];

  it("finds the job that advances cli/next", () => {
    expect(advancer).toBeDefined();
  });

  it("needs no store-writing job but that one", () => {
    const job = wf.jobs["notify-verify"] as Job | undefined;
    const needs = job?.needs === undefined ? [] : [job.needs].flat();
    const privileged = needs.filter((n) => storeWriters(wf).includes(n));
    expect(privileged).toEqual([advancer as string]);
  });
});

/**
 * What `notify-verify` hands on, and what it holds while doing it.
 *
 * `next-report` reads the receiver's answer from a job output, so the output is
 * part of the interface: rename it on one side and the reader sees an empty
 * status, which it reads as "refused", and every report says so. And the job
 * holds exactly one grant. It checks nothing out and reads no tree, so
 * `contents: read` would be a second capability with no step to use it.
 */
describe("release-cli.yml: notify-verify hands on the answer, and holds only the token", () => {
  const wf = lane("release-cli.yml");
  const job = wf.jobs["notify-verify"] as
    | (Job & { outputs?: Record<string, string> })
    | undefined;
  const post = (job?.steps ?? []).find((s) => s.env?.RECEIVER !== undefined) as
    | (Step & { id?: string })
    | undefined;

  it("holds id-token: write and no other grant", () => {
    expect(job?.permissions).toEqual({ "id-token": "write" });
  });

  it("checks nothing out and installs nothing", () => {
    for (const step of job?.steps ?? []) {
      expect(step.uses ?? "").not.toContain("actions/checkout");
      expect(step.uses ?? "").not.toContain("setup-bun");
      expect(step.run ?? "").not.toMatch(/\bbun (install|run|x)\b/);
    }
  });

  it("asks for a token with the audience the receiver checks", () => {
    expect(post?.run).toContain("audience=wego-cli-verify");
  });

  it("exposes the status output next-report reads, from the step that asks", () => {
    expect(post?.id).toBeDefined();
    expect(job?.outputs?.status?.replace(/\s+/g, "")).toBe(
      `\${{steps.${post?.id}.outputs.status}}`,
    );
    // Written before the request, so a step that dies before an answer still
    // leaves `error` to read, and again after it, with the code.
    const run = post?.run ?? "";
    expect(run.indexOf("status=error")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("status=error")).toBeLessThan(run.indexOf("curl"));
    expect(run).toContain('echo "status=$CODE" >> "$GITHUB_OUTPUT"');
  });

  it("fails loudly on any answer it does not name", () => {
    const arm = /\n\s*\*\)([^;]*);;/.exec(post?.run ?? "");
    expect(arm?.[1]).toContain("::error::");
    expect(arm?.[1]).toContain("exit 1");
  });
});

/**
 * THE REPORT READERS: they read a check run, and can do nothing else.
 *
 * Two jobs run `scripts/next-report.ts`: `release-cli.yml`'s `next-report`, which
 * waits for wego-ai's verdict after a release, and the banner at the top of
 * `promote-cli.yml`. Both read another repository's text into a public summary,
 * and both are advice rather than gates, which is two separate properties:
 *
 *   - READ-ONLY. `checks: read` for the API, `contents: read` for the checkout,
 *     nothing else. No environment, no `id-token`, and no secret but the run's
 *     own `github.token`: a reader that could write, sign or reach the store is a
 *     privileged job whose input is text from outside this repository.
 *   - NEVER RED. `continue-on-error` on the job, and a step that ends in
 *     `exit 0`. A red reader would read as a failed release, or on the promote
 *     lane as a refused gate, over a report that is only ever advice.
 */
const READERS: [string, string][] = [
  ["release-cli.yml", "next-report"],
  ["promote-cli.yml", "next-report"],
];

describe.each(
  READERS,
)("%s %s: reads the report, and nothing else", (file, name) => {
  const wf = lane(file);
  const job = wf.jobs[name] as
    | (Job & { "continue-on-error"?: unknown })
    | undefined;
  const text = JSON.stringify(job ?? {});
  const step = (job?.steps ?? []).find((s) =>
    (s.run ?? "").includes("scripts/next-report.ts"),
  );

  it("exists, and runs the report script", () => {
    expect(job, `${file} has no job '${name}'`).toBeDefined();
    expect(step).toBeDefined();
  });

  it("holds checks: read, at most contents: read beside it, and nothing else", () => {
    const grants = job?.permissions ?? {};
    expect(grants.checks).toBe("read");
    for (const [scope, level] of Object.entries(grants)) {
      expect(
        ["checks", "contents"],
        `${file} ${name} grants ${scope}`,
      ).toContain(scope);
      expect(level, `${file} ${name} grants ${scope}: ${level}`).toBe("read");
    }
  });

  it("declares no environment and reads no secret but the run's own token", () => {
    expect(job?.environment).toBeUndefined();
    expect(text).not.toContain(STORE_TOKEN);
    expect(text).not.toContain("secrets.");
    expect(text).not.toContain("vars.");
    const tokens = [...text.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)]
      .map((m) => m[1] ?? "")
      .filter((expr) => /token/i.test(expr));
    expect(tokens).toEqual(["github.token"]);
  });

  it("can never go red", () => {
    expect(job?.["continue-on-error"]).toBe(true);
    expect(step?.run?.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("is needed by no other job", () => {
    for (const [other, j] of Object.entries(wf.jobs)) {
      const needs = j.needs === undefined ? [] : [j.needs].flat();
      expect(needs, `${file}: '${other}' needs '${name}'`).not.toContain(name);
    }
  });

  it("interpolates no expression into a run body", () => {
    for (const s of job?.steps ?? []) {
      expect(s.run ?? "").not.toContain("${{");
    }
  });
});

describe("release-cli.yml: next-report runs whenever notify-verify ran", () => {
  const job = lane("release-cli.yml").jobs["next-report"] as Job | undefined;

  it("waits for notify-verify, red included, and only when it ran", () => {
    // Without `!cancelled()` a refused request (a red notify-verify) would skip
    // the one job that says why there is no report; `always()` would also keep it
    // waiting up to 55 min after someone cancelled the run. Without the result
    // check it would run on a release that never published, and report on nothing.
    expect(job?.needs).toContain("notify-verify");
    const cond = (job?.if ?? "").replace(/\s+/g, " ");
    expect(cond).toContain("!cancelled()");
    expect(cond).not.toContain("always()");
    expect(cond).toContain("needs.notify-verify.result == 'failure'");
    expect(cond).toContain("needs.notify-verify.result == 'success'");
  });

  it("hands the script the receiver's answer through env", () => {
    const step = (job?.steps ?? []).find((s) =>
      (s.run ?? "").includes("scripts/next-report.ts"),
    );
    expect(String(step?.env?.NOTIFY_STATUS).replace(/\s+/g, "")).toBe(
      `\${{needs.notify-verify.outputs.status}}`,
    );
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
