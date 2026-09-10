import { describe, expect, it } from "bun:test";
import { parseInstallRecord } from "./ring-follow";
import {
  formatVersionNotice,
  isNewerVersion,
  isSelfManagementCommand,
  looksLikeVersion,
  MAX_VERSION_BYTES,
  maybeNotifyNewVersion,
  NOTICE_INTERVAL_PROD_MS,
  NOTICE_INTERVAL_STAGING_MS,
  noticeChannel,
  noticeIntervalMs,
  parseSemver,
  shouldNotify,
  type UpdateCheckState,
  type VersionNoticeDeps,
} from "./version-notice";

/**
 * Like the background skill refresh, this is an almost-silent code path: it writes
 * to no stream and swallows every failure, so a broken guard fails open (a network
 * call after every command) or fails closed (nobody is ever told about a release)
 * with no symptom either way. `maybeNotifyNewVersion` returns its decision AND its
 * message instead of printing, so both halves can be asserted directly.
 */

const NOW = 1_800_000_000_000;
const BASE = "https://blob.example.com/cli/latest";
/** The install endpoint + ring an installed binary records (foundations#74 rung 3).
 *  `stable` because that is what a plain `curl … | bash` writes. */
const INSTALL_URL = "https://api.wego.com/install";
const DEFAULT_RECORD = { ring: "stable", installUrl: INSTALL_URL };
/** What the notice fetches for the default record: the ring-qualified `?dl=` form
 *  `wego update` uses, through the same first-party host. */
const DEFAULT_VERSION_URL = `${INSTALL_URL}?dl=VERSION&ring=stable`;
const CURRENT = "0.4.1";
const LATEST = "0.4.2";

interface Harness extends VersionNoticeDeps {
  fetches: () => string[];
  claims: () => number;
  written: () => string[];
}

/** A deps bundle whose default state DOES check and DOES notify, so each test can
 *  flip exactly one field and attribute the outcome to it. */
function deps(over: Partial<VersionNoticeDeps> = {}): Harness {
  const fetches: string[] = [];
  const written: string[] = [];
  const claims = { n: 0 };
  const base: VersionNoticeDeps = {
    command: "whoami",
    fromSource: false,
    version: CURRENT,
    flavor: "wego",
    invokedAs: "wego",
    // A record by DEFAULT: it is the only source a notice can resolve, so the
    // base bundle has to carry one for the cases below to exercise the notice at
    // all. Absence is now its own case (`skips when no ring was recorded`).
    readInstallRecord: async () => DEFAULT_RECORD,
    env: {},
    now: NOW,
    // Stale by a day and a second ⇒ past the prod window.
    readState: async () => ({
      latest: "",
      checkedAt: NOW - NOTICE_INTERVAL_PROD_MS - 1_000,
    }),
    claimWindow: async () => {
      claims.n++;
      return true;
    },
    writeLatest: async (latest) => {
      written.push(latest);
    },
    fetch: (async (url: string) => {
      fetches.push(String(url));
      return new Response(`${LATEST}\n`);
    }) as unknown as typeof fetch,
    ...over,
  };
  return Object.assign(base, {
    fetches: () => fetches,
    claims: () => claims.n,
    written: () => written,
  });
}

/** A stored answer `age` ms old. */
function stored(latest: string, age: number): () => Promise<UpdateCheckState> {
  return async () => ({ latest, checkedAt: NOW - age });
}

describe("parseSemver / isNewerVersion", () => {
  // Every row is a real hazard, not a permutation for its own sake. The two
  // load-bearing properties: unparseable input is never a guess, and only a
  // STRICTLY newer remote produces a notice.
  const table: Array<
    [current: string, remote: string, newer: boolean, why: string]
  > = [
    [CURRENT, LATEST, true, "the baseline"],
    ["0.4.2", "0.4.2", false, "never nag at parity"],
    ["0.4.2", "0.4.1", false, "a channel ROLLBACK must stay silent"],
    ["0.4.3-rc.1", "0.4.3", true, "§11.3: a release outranks its prerelease"],
    ["0.4.3", "0.4.3-rc.1", false, "a staging binary ahead of the channel"],
    ["0.4.3-rc.1", "0.4.3-rc.2", true, "numeric identifier"],
    ["0.4.3-rc.2", "0.4.3-rc.10", true, "numeric, NOT lexical ('10' < '2')"],
    ["0.4.3-rc.10", "0.4.3-rc.2", false, "the reverse of the above"],
    [
      "0.4.3-rc.1",
      "0.4.3-rc.1.1",
      true,
      "longer field set wins on equal prefix",
    ],
    ["0.4.3-rc.1.1", "0.4.3-rc.1", false, "the reverse of the above"],
    ["0.4.3-alpha", "0.4.3-beta", true, "ASCII compare for alphanumerics"],
    ["0.4.3-rc.1", "0.4.3-rc.alpha", true, "numeric sorts below alphanumeric"],
    ["0.9.9", "0.10.0", true, "minor is numeric, not lexical"],
    ["0.10.0", "0.9.9", false, "minor dominates in the other direction too"],
    ["1.0.0", "0.99.99", false, "major dominates"],
    ["0.4.2", "1.0.0", true, "major dominates in the other direction too"],
    ["0.4.2", "0.4.3+build.5", true, "build metadata is ignored in precedence"],
    ["0.4.3+a", "0.4.3+b", false, "build metadata never makes it newer"],
    ["0.4.2", "0.4.3\n", true, "the published file ends in a newline"],
    ["0.4.2", "  0.4.3  ", true, "surrounding whitespace"],
    ["0.4.2", "v0.4.3", false, "a `v` prefix is not our format"],
    ["0.4.2", "cli-v0.4.3", false, "the tag, not the version"],
    ["0.4.2", "0.4.3\n0.4.4", false, "multi-line body is garbage"],
    ["0.4.2", "<!DOCTYPE html>", false, "an HTML error page served 200"],
    ["0.4.2", "0.4", false, "too few components"],
    ["0.4.2", "0.4.3.1", false, "too many components"],
    ["0.4.2", "00.4.3", false, "leading zero in a core component"],
    ["0.4.3-rc.01", "0.4.3", false, "leading zero makes CURRENT unparseable"],
    [
      "0.4.2",
      "0.4.99999999999999999999",
      false,
      "digit count past Number precision",
    ],
    ["0.4.2", "0.4.3-", false, "empty prerelease"],
    ["0.4.2", "0.4.3-a..b", false, "empty prerelease identifier"],
    ["garbage", "0.4.3", false, "unparseable current"],
    ["0.4.2", "", false, "empty body"],
  ];

  for (const [current, remote, newer, why] of table) {
    it(`${JSON.stringify(current)} vs ${JSON.stringify(remote)} → ${newer} (${why})`, () => {
      expect(isNewerVersion(remote, current)).toBe(newer);
    });
  }

  it("parses the two shapes the release pipeline actually produces", () => {
    expect(parseSemver("0.4.2")).toEqual({
      major: 0,
      minor: 4,
      patch: 2,
      pre: [],
    });
    expect(parseSemver("0.4.3-rc.1")).toEqual({
      major: 0,
      minor: 4,
      patch: 3,
      pre: ["rc", 1],
    });
  });
});

describe("noticeIntervalMs", () => {
  it("checks staging hourly and prod daily", () => {
    // The staging channel carries the prerelease line, which moves far more often
    // than prod's, so a tester on a 24h window can be a whole day behind their own
    // channel.
    expect(noticeIntervalMs("wegostaging")).toBe(NOTICE_INTERVAL_STAGING_MS);
    expect(noticeIntervalMs("wego")).toBe(NOTICE_INTERVAL_PROD_MS);
    expect(NOTICE_INTERVAL_STAGING_MS).toBeLessThan(NOTICE_INTERVAL_PROD_MS);
  });
});

describe("isSelfManagementCommand", () => {
  it("covers update, uninstall and skill, and nothing else", () => {
    for (const c of ["update", "uninstall", "skill"]) {
      expect(isSelfManagementCommand(c)).toBe(true);
    }
    for (const c of ["whoami", "version", "help", "flights", undefined]) {
      expect(isSelfManagementCommand(c)).toBe(false);
    }
  });
});

describe("maybeNotifyNewVersion", () => {
  it("checks the channel and returns the notice when a newer release exists", async () => {
    const d = deps();
    const r = await maybeNotifyNewVersion(d);
    expect(r.outcome).toBe("checked");
    expect(r.message).toBe(formatVersionNotice("wego", CURRENT, LATEST));
    expect(d.fetches()).toEqual([DEFAULT_VERSION_URL]);
    expect(d.written()).toEqual([LATEST]);
  });

  it("notifies on the same run that discovers the release", async () => {
    // A notice deferred to the NEXT command would be invisible to anyone who runs
    // the CLI once a day — which is most people.
    const d = deps({ readState: async () => null });
    expect((await maybeNotifyNewVersion(d)).message).toBeTruthy();
  });

  it("says nothing when the channel matches the running binary", async () => {
    const d = deps({ version: LATEST });
    const r = await maybeNotifyNewVersion(d);
    expect(r.outcome).toBe("checked");
    expect(r.message).toBeUndefined();
  });

  it("skips on a self-management command, before any other guard", async () => {
    // `update` would nag on the very run that fixed the problem: the running
    // process's baked version is stale relative to the binary it just wrote.
    for (const command of ["update", "uninstall", "skill"]) {
      const d = deps({ command });
      expect(await maybeNotifyNewVersion(d)).toEqual({
        outcome: "skipped-explicit-command",
      });
      expect(d.fetches()).toHaveLength(0);
    }
  });

  it("skips a from-source run", async () => {
    const d = deps({ fromSource: true });
    expect((await maybeNotifyNewVersion(d)).outcome).toBe(
      "skipped-from-source",
    );
    expect(d.fetches()).toHaveLength(0);
  });

  it("skips a dev-stamped binary even when the exec-path test passes", async () => {
    // A locally compiled binary with a baked channel base but no RELEASE_TAG is
    // NOT from source by exec path, and would otherwise nag `0.0.0-dev -> …`
    // forever. `update.ts` gates on both signals for the same reason.
    const d = deps({ version: "0.0.0-dev", fromSource: false });
    expect((await maybeNotifyNewVersion(d)).outcome).toBe(
      "skipped-from-source",
    );
    expect(d.fetches()).toHaveLength(0);
  });

  it("skips when no ring was recorded, and asks nobody", async () => {
    // foundations#74 rung 3: a missing record refuses rather than guesses. The
    // `fetches()` assertion is the half that matters - refusing means no request
    // is made at all, not a request to a guessed prefix.
    const d = deps({ readInstallRecord: async () => null });
    expect((await maybeNotifyNewVersion(d)).outcome).toBe("skipped-no-record");
    expect(d.fetches()).toHaveLength(0);
  });

  it("reads WEGO_CLI_NO_UPDATE_NOTICE liberally", async () => {
    // Erring toward "off" respects an operator who clearly meant to disable it.
    for (const raw of ["1", "yes", "on", "true", "anything", " x "]) {
      const d = deps({ env: { WEGO_CLI_NO_UPDATE_NOTICE: raw } });
      expect(await maybeNotifyNewVersion(d)).toEqual({
        outcome: "skipped-opt-out",
      });
      expect(d.fetches()).toHaveLength(0);
    }
    for (const raw of [undefined, "", "0", "false", "FALSE"]) {
      const d = deps({ env: { WEGO_CLI_NO_UPDATE_NOTICE: raw } });
      expect((await maybeNotifyNewVersion(d)).outcome).toBe("checked");
    }
  });

  it("nags from the stored answer inside the window, with NO network call", async () => {
    // This is the whole "persist, then nag" contract: the throttle governs the
    // channel READ, not the message, so a stale install keeps being told.
    const d = deps({ readState: stored(LATEST, 60_000) });
    const r = await maybeNotifyNewVersion(d);
    expect(r.outcome).toBe("cached");
    expect(r.message).toBe(formatVersionNotice("wego", CURRENT, LATEST));
    expect(d.fetches()).toHaveLength(0);
    expect(d.claims()).toBe(0);
  });

  it("uses the staging window for the staging flavor", async () => {
    const age = NOTICE_INTERVAL_STAGING_MS + 1_000;
    // Same age: fresh for prod, stale for staging.
    expect(
      (await maybeNotifyNewVersion(deps({ readState: stored("", age) })))
        .outcome,
    ).toBe("cached");
    expect(
      (
        await maybeNotifyNewVersion(
          deps({ flavor: "wegostaging", readState: stored("", age) }),
        )
      ).outcome,
    ).toBe("checked");
  });

  it("treats a stamp in the future as stale instead of throttling forever", async () => {
    // A clock set backwards (or a bad write) would otherwise pin `now - checkedAt`
    // negative and freeze the check permanently.
    const d = deps({ readState: stored("", -60_000) });
    expect((await maybeNotifyNewVersion(d)).outcome).toBe("checked");
    expect(d.fetches()).toHaveLength(1);
  });

  it("claims the window BEFORE fetching", async () => {
    // Otherwise a hanging or failing channel leaves the stamp untouched and
    // re-triggers a full-deadline fetch on every single command.
    const order: string[] = [];
    const d = deps({
      claimWindow: async () => {
        order.push("claim");
        return true;
      },
      fetch: (async () => {
        order.push("fetch");
        throw new Error("boom");
      }) as unknown as typeof fetch,
    });
    expect((await maybeNotifyNewVersion(d)).outcome).toBe("checked");
    expect(order).toEqual(["claim", "fetch"]);
  });

  it("does not fetch when the window cannot be claimed, but still nags from cache", async () => {
    // A read-only $HOME must not turn into a network call per command; a version we
    // already know about is still worth saying.
    const d = deps({
      claimWindow: async () => false,
      readState: stored(LATEST, NOTICE_INTERVAL_PROD_MS + 1_000),
    });
    const r = await maybeNotifyNewVersion(d);
    expect(r.outcome).toBe("skipped-unclaimable");
    expect(r.message).toBeTruthy();
    expect(d.fetches()).toHaveLength(0);
  });

  it("clears the stored answer on a 404, the one authoritative absence", async () => {
    // A pre-VERSION tag, or a channel that stopped publishing one: stop nagging
    // rather than advertising a version nobody serves.
    const d = deps({
      readState: stored(LATEST, NOTICE_INTERVAL_PROD_MS + 1_000),
      fetch: (async () =>
        new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    const r = await maybeNotifyNewVersion(d);
    expect(r.message).toBeUndefined();
    expect(d.written()).toEqual([""]);
  });

  it("keeps the stored answer on a transport failure or 5xx", async () => {
    // One flaky minute must not erase a real answer.
    const failures: Array<() => Promise<Response>> = [
      async () => {
        throw new Error("network down");
      },
      async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
      async () => new Response("oops", { status: 500 }),
    ];
    for (const f of failures) {
      const d = deps({
        readState: stored(LATEST, NOTICE_INTERVAL_PROD_MS + 1_000),
        fetch: f as unknown as typeof fetch,
      });
      const r = await maybeNotifyNewVersion(d);
      expect(r.message).toBe(formatVersionNotice("wego", CURRENT, LATEST));
      expect(d.written()).toHaveLength(0);
    }
  });

  it("refuses an oversized body by declared length and by actual bytes", async () => {
    // A deadline bounds time, not bytes — a mis-pointed base is a 95 MB object.
    const huge = "9".repeat(MAX_VERSION_BYTES + 1);
    const declared = deps({
      fetch: (async () =>
        new Response(huge, {
          headers: { "content-length": String(huge.length) },
        })) as unknown as typeof fetch,
    });
    expect((await maybeNotifyNewVersion(declared)).message).toBeUndefined();
    expect(declared.written()).toHaveLength(0);
    // Chunked responses declare no length, so the body is bounded again after read.
    const chunked = deps({
      fetch: (async () => {
        const res = new Response(huge);
        res.headers.delete("content-length");
        return res;
      }) as unknown as typeof fetch,
    });
    expect((await maybeNotifyNewVersion(chunked)).message).toBeUndefined();
    expect(chunked.written()).toHaveLength(0);
  });

  it("stops pulling an oversized chunked body instead of buffering it", async () => {
    // The bound is only worth anything if it applies WHILE reading: buffering the
    // whole 95 MB object and rejecting it afterwards still paid the memory on
    // someone else's command. Count the chunks the stream is asked for - a reader
    // that cancels on the cap takes a couple, `res.text()` takes all 100.
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(MAX_VERSION_BYTES).fill(0x39); // "9"
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 100) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const d = deps({
      readState: stored(LATEST, NOTICE_INTERVAL_PROD_MS + 1_000),
      fetch: (async () => new Response(stream)) as unknown as typeof fetch,
    });
    const r = await maybeNotifyNewVersion(d);
    expect(pulled).toBeLessThan(10);
    expect(cancelled).toBe(true);
    // An over-limit body teaches us nothing, so the stored answer survives.
    expect(d.written()).toHaveLength(0);
    expect(r.message).toBe(formatVersionNotice("wego", CURRENT, LATEST));
  });

  it("reads a version split across chunks", async () => {
    // The bounded reader concatenates; a per-chunk parse would see "0." and "4.2".
    const parts = ["0.", "4.2", "\n"].map((s) => new TextEncoder().encode(s));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    });
    const d = deps({
      fetch: (async () => new Response(stream)) as unknown as typeof fetch,
    });
    const r = await maybeNotifyNewVersion(d);
    expect(d.written()).toEqual([LATEST]);
    expect(r.message).toBe(formatVersionNotice("wego", CURRENT, LATEST));
  });

  it("never persists a garbage body over a real stored answer", async () => {
    // Asserting `written()`, not just the absent message, is the whole point: a
    // `200` carrying a captive-portal page is short enough to pass the byte cap, so
    // persisting it verbatim would erase a genuine known version and silence the
    // notice for the rest of the window — one flukey response, 24h of silence.
    for (const body of ["", "\n", "v0.4.3", "cli-v0.4.3", "<!DOCTYPE html>"]) {
      const d = deps({
        readState: stored(LATEST, NOTICE_INTERVAL_PROD_MS + 1_000),
        fetch: (async () => new Response(body)) as unknown as typeof fetch,
      });
      const r = await maybeNotifyNewVersion(d);
      expect(d.written()).toHaveLength(0);
      // The known-newer version is intact, so the user is still told about it.
      expect(r.message).toBe(formatVersionNotice("wego", CURRENT, LATEST));
    }
  });

  it("keeps the stored answer on a 403, which is not proof of absence", async () => {
    // A public store answering 403 is a misconfiguration or an edge rule, not
    // "this object was never published" — only a 404 is authoritative.
    const d = deps({
      readState: stored(LATEST, NOTICE_INTERVAL_PROD_MS + 1_000),
      fetch: (async () =>
        new Response("denied", { status: 403 })) as unknown as typeof fetch,
    });
    expect((await maybeNotifyNewVersion(d)).message).toBe(
      formatVersionNotice("wego", CURRENT, LATEST),
    );
    expect(d.written()).toHaveLength(0);
  });

  it("still returns the notice when persisting the answer fails", async () => {
    const d = deps({
      writeLatest: async () => {
        throw new Error("EROFS");
      },
    });
    expect((await maybeNotifyNewVersion(d)).message).toBeTruthy();
  });

  it("trims the trailing newline the published file carries", async () => {
    const d = deps();
    await maybeNotifyNewVersion(d);
    expect(d.written()).toEqual([LATEST]);
  });

  it("reads a slashed record through the real parser and still asks one URL", async () => {
    // Through `parseInstallRecord`, not a hand-built record: the parser is what
    // canonicalizes `/install/`, so injecting a pre-shaped object here would assert
    // a state the real path cannot produce.
    const d = deps({
      readInstallRecord: async () =>
        parseInstallRecord(
          JSON.stringify({ ring: "stable", installUrl: `${INSTALL_URL}/` }),
        ),
    });
    await maybeNotifyNewVersion(d);
    expect(d.fetches()).toEqual([DEFAULT_VERSION_URL]);
  });

  it("names the flavor it was built as, not the notice's own wording", async () => {
    const d = deps({ flavor: "wegostaging", invokedAs: "wegostaging" });
    expect((await maybeNotifyNewVersion(d)).message).toBe(
      `A new wegostaging is available: ${CURRENT} -> ${LATEST}. Run \`wegostaging update -y\`.`,
    );
  });

  it("tells a renamed install to run the command it actually has", async () => {
    // `WEGO_CLI_BIN` installs the same prod release under another name. The flavor
    // still names the RELEASE (that is its identity), but a hint reading `wego
    // update -y` would name a command that does not exist on that machine.
    const d = deps({ flavor: "wego", invokedAs: "mywego" });
    expect((await maybeNotifyNewVersion(d)).message).toBe(
      `A new wego is available: ${CURRENT} -> ${LATEST}. Run \`mywego update -y\`.`,
    );
  });

  it("returns a single line, so stderr stays one actionable statement", async () => {
    const message = (await maybeNotifyNewVersion(deps())).message ?? "";
    expect(message).not.toContain("\n");
  });
});

/**
 * The ring the notice reads from, and the oracle it applies once it has read.
 *
 * Both halves are regressions of one shipped defect: every prod build bakes
 * `…/cli/stable`, so an EDGE install read the stable version, found a plain
 * `X.Y.Z` outranking its own `X.Y.Z-edge.<sha>`, and nagged daily to "update" to
 * a version `update` itself then refused to install. Pointing the read at the
 * recorded ring fixes half of it; comparing two `-edge.<sha>` builds by semver
 * ordering is the other half, and it is a coin flip.
 */
describe("channel resolution", () => {
  const RECORD = { ring: "edge", installUrl: "https://api.wego.com/install" };

  it("resolves the RECORDED ring", () => {
    expect(noticeChannel(RECORD)).toEqual({
      base: "https://api.wego.com/install",
      ring: "edge",
    });
  });

  it("refuses without a record instead of guessing a channel", () => {
    // foundations#74 rung 3, the stop-the-world rung: "a missing record refuses
    // rather than guesses", and it exists to make silent channel drift
    // impossible. A baked-URL fallback here IS that drift - a binary carrying the
    // retired `cli/latest` would compare against a prefix nothing advances and
    // report "up to date" for ever, silently.
    expect(noticeChannel(null)).toBeNull();
  });

  it("normalizes a base that a hand-built record slipped past the parser", () => {
    // Belt-and-braces, and named as such: `parseInstallRecord` already canonicalizes
    // `/install/` (proved in ring-follow.test.ts), so the only way to reach this is
    // a caller that builds an `InstallRecord` itself. It stays because the cost is a
    // slash-strip and the failure it prevents is a doubled `//?dl=` in a URL.
    expect(
      noticeChannel({ ...RECORD, installUrl: "https://api.wego.com/install/" }),
    ).toEqual({ base: "https://api.wego.com/install", ring: "edge" });
  });

  it("fetches the ring-qualified URL update also uses", async () => {
    const d = deps({
      version: "0.7.2-edge.aaaaaaaaa",
      readInstallRecord: async () => RECORD,
    });
    await maybeNotifyNewVersion(d);
    expect(d.fetches()).toEqual([
      "https://api.wego.com/install?dl=VERSION&ring=edge",
    ]);
  });

  it("never reports the stable version to an edge install", async () => {
    // The shipped defect, end to end: the record says edge, so the stable
    // `VERSION` object is never even fetched.
    const d = deps({
      version: "0.7.2-edge.aaaaaaaaa",
      readInstallRecord: async () => RECORD,
      fetch: (async () =>
        new Response("0.7.2-edge.aaaaaaaaa\n")) as unknown as typeof fetch,
    });
    const result = await maybeNotifyNewVersion(d);
    expect(result.message).toBeUndefined();
  });

  it("treats an unreadable record as no record, and does not throw", async () => {
    // The read rejecting must not escape into the caller (the notice is a
    // best-effort side path), and must not be softened into a guess either: an
    // EACCES record is indistinguishable from none, so it refuses like none.
    const d = deps({
      readInstallRecord: async () => {
        throw new Error("EACCES");
      },
    });
    const result = await maybeNotifyNewVersion(d);
    expect(result.outcome).toBe("skipped-no-record");
    expect(result.message).toBeUndefined();
    expect(d.fetches()).toHaveLength(0);
  });
});

describe("shouldNotify", () => {
  it("keeps strictly-greater for plain versions", () => {
    expect(shouldNotify("0.4.2", "0.4.1")).toBe(true);
    expect(shouldNotify("0.4.1", "0.4.1")).toBe(false);
    // A channel rollback stays silent rather than advertising a downgrade.
    expect(shouldNotify("0.4.0", "0.4.1")).toBe(false);
  });

  it("notifies on a DIFFERENT prerelease in either lexical direction", () => {
    // The coin flip this replaces: `4aeec3a2f` is the real successor of
    // `e30454f2a` on `cli/edge`, and sorts BELOW it. Ordering by semver announces
    // one of these two and silently drops the other.
    const older = "0.7.2-edge.e30454f2a";
    const newer = "0.7.2-edge.4aeec3a2f";
    expect(isNewerVersion(newer, older)).toBe(false); // the bug, pinned
    expect(shouldNotify(newer, older)).toBe(true);
    expect(shouldNotify(older, newer)).toBe(true);
  });

  it("stays silent when the prerelease build is the one running", () => {
    expect(shouldNotify("0.7.2-edge.abc", "0.7.2-edge.abc")).toBe(false);
  });

  it("notifies an edge install about a newer edge base version", () => {
    expect(shouldNotify("0.8.0-edge.aaa", "0.7.2-edge.zzz")).toBe(true);
  });

  it("refuses to guess on an unparseable side", () => {
    expect(shouldNotify("not-a-version", "0.4.1")).toBe(false);
    expect(shouldNotify("0.4.2", "")).toBe(false);
  });
});

describe("looksLikeVersion", () => {
  it("accepts a semver-INVALID edge sha the channel really serves", () => {
    // `0123456` is a legal short sha and an illegal semver numeric identifier
    // (§9, no leading zeros), so `parseSemver` rejects it. Gating the channel
    // read on strict parsing silenced the notice permanently for those builds.
    expect(parseSemver("0.7.2-edge.0123456")).toBeNull();
    expect(looksLikeVersion("0.7.2-edge.0123456")).toBe(true);
    expect(shouldNotify("0.7.2-edge.0123456", "0.7.2-edge.abcdef0")).toBe(true);
  });

  it("still rejects what the gate exists to reject", () => {
    expect(looksLikeVersion("<html>captive portal</html>")).toBe(false);
    expect(looksLikeVersion("")).toBe(false);
  });
});

describe("the message names only what is known", () => {
  const RECORD = { ring: "edge", installUrl: "https://api.wego.com/install" };

  it("says 'a new wego' when the ordering is real", async () => {
    expect((await maybeNotifyNewVersion(deps())).message).toBe(
      `A new wego is available: ${CURRENT} -> ${LATEST}. Run \`wego update -y\`.`,
    );
  });

  it("says 'now serves' when all that is known is that the bytes differ", async () => {
    const d = deps({
      version: "0.7.2-edge.e30454f2a",
      readInstallRecord: async () => RECORD,
      fetch: (async () =>
        new Response("0.7.2-edge.4aeec3a2f\n")) as unknown as typeof fetch,
    });
    expect((await maybeNotifyNewVersion(d)).message).toBe(
      "Your wego channel now serves 0.7.2-edge.4aeec3a2f (you have 0.7.2-edge.e30454f2a). Run `wego update -y`.",
    );
  });
});
