/**
 * The next report, rendered from the SHARED payloads and read through a fake
 * GitHub API on a fake clock.
 *
 * The payloads in `scripts/next-report/payloads/` are the cross-repository
 * interface: wego-ai tests its writer against the same files, byte for byte.
 * So a rendering test here is also a statement that the two sides agree on what
 * each verdict looks like, and the files are read, never inlined.
 *
 * The polling cases matter as much as the rendering ones. The release lane waits
 * up to 45 minutes; a wait that ended on the wrong state (reporting "did not
 * start" while a check was running, or trusting a check from another App) would
 * put the wrong sentence in front of a person deciding a promote.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  banner,
  type CheckRun,
  type Clock,
  commandMessage,
  EVALS_CHECK_NAME,
  evalsLine,
  type Limits,
  parseReport,
  pickCheck,
  pollLine,
  REPORT_APP_ID,
  renderCompleted,
  run,
} from "./next-report";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TAG = "v1.5.0";
const DETAILS = "https://github.com/wego/wego-ai/actions/runs/1";

const payload = (name: string): string =>
  readFileSync(`scripts/next-report/payloads/${name}.json`, "utf8");

/** A payload as wego-ai delivers it: prose, then the one ```json fence. */
const check = (overrides: Partial<CheckRun> & { body?: string } = {}) => {
  const { body, ...rest } = overrides;
  return {
    id: 1,
    name: "cli-next-smoke",
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-23T10:00:00Z",
    details_url: DETAILS,
    app: { id: REPORT_APP_ID },
    output: {
      title: "v1.5.0 · ready",
      summary: "smoke of cli/next",
      text: `The smoke ran against staging.\n\n\`\`\`json\n${body ?? payload("ready")}\n\`\`\`\n`,
    },
    ...rest,
  } satisfies CheckRun;
};

const completed = (name: string) =>
  renderCompleted(TAG, SHA, check({ body: payload(name) }), { table: true });

describe("a completed report, per shared payload", () => {
  it.each([
    ["ready", "✓ Ready: nothing new is wrong in v1.5.0", "::notice::"],
    [
      "look-first",
      "⚠ Look first: startup is 28% slower than v1.4.2",
      "::warning::",
    ],
    [
      "staging-problem",
      "✗ Staging problem: whoami failed and staging's health check was failing",
      "::warning::",
    ],
    [
      "binary-problem",
      "✗ Binary problem: the built-in skill does not match the tag",
      "::warning::",
    ],
  ])("%s: banner, link, annotation", (name, line, kind) => {
    const out = completed(name);
    const lines = out.summary.split("\n");
    expect(lines[0]).toBe("### next report · v1.5.0");
    expect(lines).toContain(line);
    expect(out.summary).toContain(
      `Details: [private wego-ai run (org members)](${DETAILS})`,
    );
    expect(out.annotations).toHaveLength(1);
    expect(out.annotations[0]?.startsWith(kind)).toBe(true);
    expect(out.annotations[0]).toContain(
      "See the private report before promoting.",
    );
  });

  it("renders every part with its label, previous beside current", () => {
    const table = completed("ready").summary;
    expect(table).toContain("| Part | v1.4.2 | v1.5.0 |");
    expect(table).toContain(
      "| Binary is the tag | – | ✓ version · commit · skill |",
    );
    expect(table).toContain("| Stable commands | 6/6 | ✓ 6/6 |");
    expect(table).toContain("| Error responses | 3/3 | ✓ 3/3 |");
    expect(table).toContain(
      "| Search round trips | – | ✓ flights ✓ hotels ✓ |",
    );
    expect(table).toContain("| Startup | 39 ms | 41 ms |");
    // The evals are their own check now, never a row of the smoke's table.
    expect(table).not.toContain("Skill evals");
  });

  it("marks a failed step", () => {
    expect(completed("staging-problem").summary).toContain(
      "| Stable commands | 6/6 | ✗ 5/6 |",
    );
    expect(completed("binary-problem").summary).toContain(
      "| Binary is the tag | – | ✗ version · commit · skill |",
    );
    expect(completed("look-first").summary).toContain(
      "| Startup | 39 ms | 50 ms |",
    );
  });

  it("reads a first release, which has no previous version", () => {
    const first = JSON.parse(payload("ready"));
    delete first.previous;
    const out = renderCompleted(
      TAG,
      SHA,
      check({ body: JSON.stringify(first) }),
      { table: true },
    );
    expect(out.summary).toContain("| Part | previous | v1.5.0 |");
  });
});

describe("a completed check whose report cannot be read", () => {
  it.each([
    ["malformed", "not valid JSON"],
    ["unknown-schema", "cli-next-smoke/v9"],
  ])("%s: the title, the link, and a warning", (name, reason) => {
    const out = completed(name);
    expect(out.summary).toContain("● Report unreadable: v1.5.0 · ready");
    expect(out.summary).toContain(DETAILS);
    expect(out.summary).not.toContain("| Part |");
    expect(out.annotations).toHaveLength(1);
    expect(out.annotations[0]).toStartWith("::warning::");
    expect(out.annotations[0]).toContain("could not be read");
    expect(out.annotations[0]).toContain(reason);
  });

  it("reads no fence, or two fences, as no report", () => {
    expect(parseReport("no json here")).toHaveProperty("error");
    const two = `\`\`\`json\n${payload("ready")}\n\`\`\`\n\`\`\`json\n${payload("ready")}\n\`\`\``;
    expect(parseReport(two)).toHaveProperty("error");
    expect(parseReport(null)).toHaveProperty("error");
  });

  it("refuses a report about a different commit", () => {
    const out = renderCompleted(
      TAG,
      "f".repeat(40),
      check({ body: payload("ready") }),
      {
        table: true,
      },
    );
    expect(out.summary).toContain("● Report unreadable");
    expect(out.annotations[0]).toContain("is for commit");
  });
});

describe("annotations carry another repository's text safely", () => {
  it("escapes the characters that end or corrupt a workflow command", () => {
    expect(commandMessage("50%\nnext::warning::x\r")).toBe(
      "50%25%0Anext::warning::x%0D",
    );
  });

  it("keeps a pipe in a headline from splitting the table row", () => {
    const report = JSON.parse(payload("ready"));
    report.parts[3].value = "flights | hotels";
    const out = renderCompleted(
      TAG,
      SHA,
      check({ body: JSON.stringify(report) }),
      { table: true },
    );
    expect(out.summary).toContain("✓ flights \\| hotels");
  });
});

describe("pickCheck: wego-ai's App, and only that App", () => {
  it("ignores a same-named check from any other App", () => {
    expect(pickCheck([check({ app: { id: 1 } })])).toBeUndefined();
    expect(pickCheck([check({ app: null })])).toBeUndefined();
  });

  it("takes the newest of several", () => {
    const old = check({ id: 1, started_at: "2026-09-23T09:00:00Z" });
    const fresh = check({ id: 2, started_at: "2026-09-23T10:00:00Z" });
    expect(pickCheck([old, fresh])?.id).toBe(2);
    expect(pickCheck([fresh, old])?.id).toBe(2);
  });
});

/** A clock that only moves when the code under test sleeps. */
const fakeClock = (start = Date.parse("2026-09-23T10:00:00Z")) => {
  let t = start;
  const clock: Clock & { slept: number } = {
    slept: 0,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      clock.slept += ms;
    },
  };
  return clock;
};

const LIMITS: Limits = {
  intervalMs: 30_000,
  startMs: 600_000,
  totalMs: 2_700_000,
};

const ENV = {
  GITHUB_REPOSITORY: "wego/cli",
  GITHUB_TOKEN: "t",
  TAG,
  SHA,
};

/**
 * A GitHub API that answers the check-runs endpoint with whatever `answer`
 * returns for the n-th look, and counts the looks.
 */
const fakeApi = (answer: (n: number) => CheckRun[] | Response) => {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    if (url.includes("/check-runs")) {
      const a = answer(calls.filter((c) => c.includes("/check-runs")).length);
      return a instanceof Response
        ? a
        : Response.json({ total_count: a.length, check_runs: a });
    }
    if (url.endsWith(`/commits/${TAG}`)) return Response.json({ sha: SHA });
    return new Response("not found", { status: 404 });
  };
  return { calls, fetcher };
};

describe("the release lane's wait", () => {
  it("logs one line per look, with the wego-ai run linked once", async () => {
    const api = fakeApi((n) =>
      n === 1
        ? []
        : n < 4
          ? [check({ status: "in_progress", conclusion: null })]
          : [check()],
    );
    const lines: string[] = [];
    const clock = { ...fakeClock(), log: (l: string) => lines.push(l) };
    await run([], { ...ENV, NOTIFY_STATUS: "202" }, api.fetcher, clock, LIMITS);
    expect(lines).toEqual([
      `waiting for cli-next-smoke on ${TAG} (${SHA.slice(0, 7)}), up to 45 min, looking every 30 s`,
      "0 min: not started yet",
      `0.5 min: in progress: wego-ai run ${DETAILS}`,
      "1 min: in progress",
      "1.5 min: completed: v1.5.0 · ready",
    ]);
  });

  it("logs a failed look as such, and keeps looking", () => {
    expect(pollLine({ error: "HTTP 502" }, 90_000, false)).toBe(
      "1.5 min: could not read the check runs (HTTP 502)",
    );
  });

  it("keeps a writer's title on one line, so it cannot start a workflow command", () => {
    const titled = check({
      output: { title: "ok\n::stop-commands::x", summary: null, text: null },
    });
    expect(pollLine({ check: titled }, 60_000, false)).not.toContain("\n");
    const running = check({
      status: "in_progress",
      details_url: "https://example.test/1\n::warning::x",
    });
    expect(pollLine({ check: running }, 60_000, true)).not.toContain("\n");
  });

  it("breaks a legacy ##[ command in a writer's title, which the runner finds mid-line", () => {
    const titled = check({
      output: { title: "ok ##[stop-commands]x", summary: null, text: null },
    });
    const line = pollLine({ check: titled }, 60_000, false);
    expect(line).not.toContain("##[");
    expect(line).toContain("stop-commands]x");
  });

  it("does not look when the receiver is switched off (404)", async () => {
    const api = fakeApi(() => []);
    const clock = fakeClock();
    const out = await run(
      [],
      { ...ENV, NOTIFY_STATUS: "404" },
      api.fetcher,
      clock,
      LIMITS,
    );
    expect(out.summary).toContain("● No report: the receiver is switched off");
    expect(api.calls).toEqual([]);
    expect(clock.slept).toBe(0);
  });

  it.each([
    "400",
    "401",
    "403",
    "500",
    "error",
    "",
  ])("does not look when the request was refused (%p)", async (status) => {
    const api = fakeApi(() => []);
    const out = await run(
      [],
      { ...ENV, NOTIFY_STATUS: status },
      api.fetcher,
      fakeClock(),
      LIMITS,
    );
    expect(out.summary).toContain(
      "● No report: the request to wego-ai was refused",
    );
    expect(api.calls).toEqual([]);
  });

  it("gives up after 10 min when no check appears, with a warning", async () => {
    const api = fakeApi(() => []);
    const clock = fakeClock();
    const out = await run(
      [],
      { ...ENV, NOTIFY_STATUS: "202" },
      api.fetcher,
      clock,
      LIMITS,
    );
    expect(out.summary).toContain("● No report: wego-ai did not start");
    expect(out.annotations[0]).toStartWith("::warning::");
    expect(clock.slept).toBe(600_000);
  });

  it("treats another App's check as no check at all", async () => {
    const api = fakeApi(() => [check({ app: { id: 42 } })]);
    const out = await run(
      [],
      { ...ENV, NOTIFY_STATUS: "202" },
      api.fetcher,
      fakeClock(),
      LIMITS,
    );
    expect(out.summary).toContain("● No report: wego-ai did not start");
    expect(out.summary).not.toContain("Ready");
  });

  it("stops at 45 min when the check is still running", async () => {
    const api = fakeApi(() => [check({ status: "in_progress" })]);
    const clock = fakeClock();
    const out = await run(
      [],
      { ...ENV, NOTIFY_STATUS: "409" },
      api.fetcher,
      clock,
      LIMITS,
    );
    expect(out.summary).toContain(
      "● No report yet: still running after 45 min",
    );
    expect(clock.slept).toBe(2_700_000);
  });

  it("renders the report once the check completes", async () => {
    const api = fakeApi((n) =>
      n < 4
        ? [check({ status: "in_progress" })]
        : [check({ body: payload("look-first") })],
    );
    const clock = fakeClock();
    const out = await run(
      [],
      { ...ENV, NOTIFY_STATUS: "202" },
      api.fetcher,
      clock,
      LIMITS,
    );
    expect(out.summary).toContain("⚠ Look first:");
    expect(out.summary).toContain("| Part |");
    expect(clock.slept).toBe(90_000);
    expect(api.calls[0]).toContain(
      `/repos/wego/cli/commits/${SHA}/check-runs?check_name=cli-next-smoke`,
    );
  });

  it("keeps looking through an API error, and says so if it never clears", async () => {
    const api = fakeApi(() => new Response("no", { status: 403 }));
    const out = await run(
      [],
      { ...ENV, NOTIFY_STATUS: "202" },
      api.fetcher,
      fakeClock(),
      LIMITS,
    );
    expect(out.summary).toContain(
      "● No report: the check runs could not be read",
    );
    expect(out.annotations[0]).toContain("HTTP 403");
  });

  it("refuses a tag that is not a release tag without calling out", async () => {
    const api = fakeApi(() => []);
    const out = await run(
      [],
      { ...ENV, TAG: "main; rm -rf /", NOTIFY_STATUS: "202" },
      api.fetcher,
      fakeClock(),
      LIMITS,
    );
    expect(out.summary).toContain("is not a vX.Y.Z release tag");
    expect(api.calls).toEqual([]);
  });
});

describe("the promote banner: one look, one line", () => {
  it("shows the verdict and the link, without the table", async () => {
    const api = fakeApi(() => [check({ body: payload("ready") })]);
    const clock = fakeClock();
    const out = await run(["--banner"], ENV, api.fetcher, clock, LIMITS);
    expect(out.summary).toContain("✓ Ready: nothing new is wrong in v1.5.0");
    expect(out.summary).toContain(DETAILS);
    expect(out.summary).not.toContain("| Part |");
    expect(clock.slept).toBe(0);
    // One look at the tag's commit, then one at each check.
    expect(api.calls).toHaveLength(3);
  });

  it("says how long ago a running check started", () => {
    const out = banner(
      TAG,
      SHA,
      { check: check({ status: "in_progress" }) },
      Date.parse("2026-09-23T10:12:30Z"),
    );
    expect(out.summary).toContain("● No report yet, started 12 min ago");
  });

  it("says when there is no report at all, without polling", async () => {
    const api = fakeApi(() => [check({ app: { id: 42 } })]);
    const clock = fakeClock();
    const out = await run(["--banner"], ENV, api.fetcher, clock, LIMITS);
    expect(out.summary).toContain("● No report:");
    expect(clock.slept).toBe(0);
  });

  it("reports a tag that resolves to no commit", async () => {
    const out = await run(
      ["--banner"],
      { ...ENV, TAG: "v9.9.9" },
      fakeApi(() => []).fetcher,
      fakeClock(),
      LIMITS,
    );
    expect(out.summary).toContain("the tag's commit could not be read");
  });
});

/** An evals check as wego-ai writes it. */
const evalsCheck = (overrides: Partial<CheckRun> & { body?: string } = {}) =>
  check({
    name: EVALS_CHECK_NAME,
    output: {
      title: "v1.5.0 · evals",
      summary: "evals of cli/next",
      text: `\`\`\`json\n${overrides.body ?? payload("evals-ready")}\n\`\`\`\n`,
    },
    ...overrides,
  });

/** A GitHub API that answers each check name from its own list. */
const fakeChecks = (smoke: CheckRun[], evals: CheckRun[]) =>
  fakeApi(() => [...smoke, ...evals]);

describe("the evals: their own check, one line", () => {
  it.each([
    [
      "evals-ready",
      "Skill evals: ✓ Ready: skill answers held against v1.4.2",
      undefined,
    ],
    [
      "evals-look-first",
      "Skill evals: ⚠ Look first: skill answers scored lower than v1.4.2",
      "::warning::",
    ],
    [
      "evals-partial",
      "Skill evals: ✓ Ready: frozen set held; persona subset skipped, no skill or command change since v1.4.2",
      undefined,
    ],
    [
      "evals-skipped",
      "Skill evals: ● Skipped: nothing in skills/ or src/ changed since v1.4.2",
      undefined,
    ],
  ])("%s", (name, line, kind) => {
    const out = evalsLine(
      SHA,
      { check: evalsCheck({ body: payload(name) }) },
      0,
    );
    expect(out.line).toBe(line);
    expect(out.annotation?.slice(0, 11)).toBe(kind);
  });

  it("is a state, not an error, while it runs or before it starts", () => {
    expect(evalsLine(SHA, { check: undefined }, 0).line).toBe(
      "● Skill evals: not started yet",
    );
    expect(
      evalsLine(
        SHA,
        { check: evalsCheck({ status: "in_progress" }) },
        Date.parse("2026-09-23T11:30:00Z"),
      ).line,
    ).toBe("● Skill evals: running, started 90 min ago");
  });

  it("shows an unreadable report as such, with a warning", () => {
    for (const body of [payload("malformed"), payload("ready")]) {
      const out = evalsLine(SHA, { check: evalsCheck({ body }) }, 0);
      expect(out.line).toBe("● Skill evals: report unreadable: v1.5.0 · evals");
      expect(out.annotation?.startsWith("::warning::")).toBe(true);
    }
  });

  it("ignores an evals check from another App", () => {
    expect(
      pickCheck([evalsCheck({ app: { id: 42 } })], EVALS_CHECK_NAME),
    ).toBeUndefined();
  });

  it("the release run waits for the smoke only, then looks once at the evals", async () => {
    const api = fakeChecks([check()], [evalsCheck({ status: "in_progress" })]);
    const clock = fakeClock();
    const out = await run(
      [],
      { ...ENV, NOTIFY_STATUS: "202" },
      api.fetcher,
      clock,
      LIMITS,
    );
    expect(out.summary).toContain("✓ Ready: nothing new is wrong in v1.5.0");
    expect(out.summary).toContain(
      "● Skill evals: running, started 0 min ago; the promote banner shows the result",
    );
    expect(clock.slept).toBe(0);
  });

  it("the promote banner shows both", async () => {
    const api = fakeChecks(
      [check()],
      [evalsCheck({ body: payload("evals-look-first") })],
    );
    const out = await run(["--banner"], ENV, api.fetcher, fakeClock(), LIMITS);
    expect(out.summary).toContain("✓ Ready: nothing new is wrong in v1.5.0");
    expect(out.summary).toContain(
      "Skill evals: ⚠ Look first: skill answers scored lower than v1.4.2",
    );
    expect(out.annotations.some((a) => a.includes("skill evals"))).toBe(true);
  });
});
