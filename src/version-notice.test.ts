import { describe, expect, it } from "bun:test";
import { parseInstallRecord } from "./ring-follow";
import {
  formatVersionNotice,
  isNewerVersion,
  isSelfManagementCommand,
  looksLikeVersion,
  MAX_VERSION_BYTES,
  maybeNotifyNewVersion,
  NOTICE_INTERVAL_MS,
  noticeChannel,
  parseSemver,
  shouldNotify,
  type UpdateCheckState,
  type VersionNoticeDeps,
} from "./version-notice";

/**
 * This path writes to no stream and swallows every failure, so a broken guard
 * fails open (a network call after every command) or closed (nobody is told about
 * a release) with no symptom. `maybeNotifyNewVersion` returns its decision and
 * message instead of printing, so both can be asserted directly.
 */

const NOW = 1_800_000_000_000;
/** `stable` because that is what a plain `curl … | bash` records. */
const INSTALL_URL = "https://api.wego.com/install";
const DEFAULT_RECORD = { ring: "stable", installUrl: INSTALL_URL };
const DEFAULT_VERSION_URL = `${INSTALL_URL}?dl=VERSION&ring=stable`;
const CURRENT = "0.4.1";
const LATEST = "0.4.2";

interface Harness extends VersionNoticeDeps {
  fetches: () => string[];
  claims: () => number;
}

/** Defaults check and notify, so each test can flip one field and attribute the
 *  outcome to it. */
function deps(over: Partial<VersionNoticeDeps> = {}): Harness {
  const fetches: string[] = [];
  const claims = { n: 0 };
  const base: VersionNoticeDeps = {
    command: "whoami",
    fromSource: false,
    version: CURRENT,
    invokedAs: "wego",
    readInstallRecord: async () => DEFAULT_RECORD,
    env: {},
    now: NOW,
    // Just past the window.
    readState: async () => ({
      checkedAt: NOW - NOTICE_INTERVAL_MS - 1_000,
    }),
    claimWindow: async () => {
      claims.n++;
      return true;
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
  });
}

/** A throttle stamp `age` ms old. */
function stored(age: number): () => Promise<UpdateCheckState> {
  return async () => ({ checkedAt: NOW - age });
}

describe("parseSemver / isNewerVersion", () => {
  // Every row is a real hazard. The two properties that matter: unparseable input
  // is never a guess, and only a strictly newer remote counts as newer.
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
    ["0.4.2", "v0.4.3", false, "the tag, not the version"],
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
    expect(r.message).toBe(formatVersionNotice(CURRENT, LATEST));
    expect(d.fetches()).toEqual([DEFAULT_VERSION_URL]);
  });

  it("notifies on the same run that discovers the release", async () => {
    // A notice deferred to the next command would never reach someone who runs
    // the CLI once a day.
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
    // A locally compiled binary without RELEASE_TAG is not from source by exec
    // path, and would otherwise nag `0.0.0-dev -> …` forever.
    const d = deps({ version: "0.0.0-dev", fromSource: false });
    expect((await maybeNotifyNewVersion(d)).outcome).toBe(
      "skipped-from-source",
    );
    expect(d.fetches()).toHaveLength(0);
  });

  it("skips when no ring was recorded, and asks nobody", async () => {
    // foundations#74 rung 3: refusing means no request at all, not a request to
    // a guessed prefix.
    const d = deps({ readInstallRecord: async () => null });
    expect((await maybeNotifyNewVersion(d)).outcome).toBe("skipped-no-record");
    expect(d.fetches()).toHaveLength(0);
  });

  it("reads WEGO_CLI_NO_UPDATE_NOTICE liberally", async () => {
    // Err toward "off": any value other than empty, 0 or false disables it.
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

  it("says nothing inside the window, and asks nobody", async () => {
    // Nothing is stored, so a throttled run has nothing it was just told.
    const d = deps({ readState: stored(60_000) });
    const r = await maybeNotifyNewVersion(d);
    expect(r.outcome).toBe("throttled");
    expect(r.message).toBeUndefined();
    expect(d.fetches()).toHaveLength(0);
    expect(d.claims()).toBe(0);
  });

  it("uses the one window for every install", async () => {
    expect(
      (
        await maybeNotifyNewVersion(
          deps({ readState: stored(NOTICE_INTERVAL_MS - 1_000) }),
        )
      ).outcome,
    ).toBe("throttled");
    expect(
      (
        await maybeNotifyNewVersion(
          deps({ readState: stored(NOTICE_INTERVAL_MS + 1_000) }),
        )
      ).outcome,
    ).toBe("checked");
  });

  it("treats a stamp in the future as stale instead of throttling forever", async () => {
    // A clock set backwards (or a bad write) would otherwise pin `now - checkedAt`
    // negative and freeze the check permanently.
    const d = deps({ readState: stored(-60_000) });
    expect((await maybeNotifyNewVersion(d)).outcome).toBe("checked");
    expect(d.fetches()).toHaveLength(1);
  });

  it("claims the window BEFORE fetching", async () => {
    // Otherwise a hanging or failing channel leaves the stamp untouched and
    // triggers a full-deadline fetch on every command.
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

  it("does not fetch when the window cannot be claimed, and says nothing", async () => {
    // A read-only $HOME must not turn into a network call per command.
    const d = deps({
      claimWindow: async () => false,
      readState: stored(NOTICE_INTERVAL_MS + 1_000),
    });
    const r = await maybeNotifyNewVersion(d);
    expect(r.outcome).toBe("skipped-unclaimable");
    expect(r.message).toBeUndefined();
    expect(d.fetches()).toHaveLength(0);
  });

  // Every way of not knowing gets the same answer: silence.
  it("says nothing when the channel cannot be read", async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      [
        "404, a channel with no VERSION",
        async () => new Response("nope", { status: 404 }),
      ],
      [
        "403, an edge rule rather than an absence",
        async () => new Response("no", { status: 403 }),
      ],
      ["500", async () => new Response("oops", { status: 500 })],
      [
        "a transport failure",
        async () => {
          throw new Error("network down");
        },
      ],
      [
        "a timeout",
        async () => {
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        },
      ],
      [
        "a 200 carrying a captive-portal page",
        async () => new Response("<html>hi</html>"),
      ],
      ["a 200 carrying an empty body", async () => new Response("")],
    ];
    for (const [why, f] of cases) {
      const d = deps({
        readState: stored(NOTICE_INTERVAL_MS + 1_000),
        fetch: f as unknown as typeof fetch,
      });
      const r = await maybeNotifyNewVersion(d);
      expect(r.message, why).toBeUndefined();
      expect(r.outcome, why).toBe("checked");
    }
  });

  it("refuses an oversized body by declared length and by actual bytes", async () => {
    // A deadline bounds time, not bytes, and a mis-pointed base is a 95 MB object.
    const huge = "9".repeat(MAX_VERSION_BYTES + 1);
    const declared = deps({
      fetch: (async () =>
        new Response(huge, {
          headers: { "content-length": String(huge.length) },
        })) as unknown as typeof fetch,
    });
    expect((await maybeNotifyNewVersion(declared)).message).toBeUndefined();
    // Chunked responses declare no length, so the read itself must be bounded.
    const chunked = deps({
      fetch: (async () => {
        const res = new Response(huge);
        res.headers.delete("content-length");
        return res;
      }) as unknown as typeof fetch,
    });
    expect((await maybeNotifyNewVersion(chunked)).message).toBeUndefined();
  });

  it("stops pulling an oversized chunked body instead of buffering it", async () => {
    // The bound must apply while reading: buffering the whole object and rejecting
    // it afterwards still pays the memory. A reader that cancels on the cap pulls
    // a couple of chunks; `res.text()` pulls all 100.
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
      readState: stored(NOTICE_INTERVAL_MS + 1_000),
      fetch: (async () => new Response(stream)) as unknown as typeof fetch,
    });
    const r = await maybeNotifyNewVersion(d);
    expect(pulled).toBeLessThan(10);
    expect(cancelled).toBe(true);
    expect(r.message).toBeUndefined();
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
    expect(r.message).toBe(formatVersionNotice(CURRENT, LATEST));
  });

  it("trims the trailing newline the published file carries", async () => {
    const d = deps({
      fetch: (async () =>
        new Response(`${LATEST}\n`)) as unknown as typeof fetch,
    });
    expect((await maybeNotifyNewVersion(d)).message).toBe(
      formatVersionNotice(CURRENT, LATEST),
    );
  });

  it("reads a slashed record through the real parser and still asks one URL", async () => {
    // Through `parseInstallRecord`, not a hand-built record: the parser
    // canonicalizes `/install/`, so a pre-shaped object would assert a state the
    // real path cannot produce.
    const d = deps({
      readInstallRecord: async () =>
        parseInstallRecord(
          JSON.stringify({ ring: "stable", installUrl: `${INSTALL_URL}/` }),
        ),
    });
    await maybeNotifyNewVersion(d);
    expect(d.fetches()).toEqual([DEFAULT_VERSION_URL]);
  });

  it("names the release, which is one name", async () => {
    const d = deps();
    expect((await maybeNotifyNewVersion(d)).message).toBe(
      `A new wego is available: ${CURRENT} -> ${LATEST}. Run \`wego update -y\`.`,
    );
  });

  it("tells a renamed install to run the command it actually has", async () => {
    // `WEGO_CLI_BIN` installs the same release under another name, so
    // `wego update -y` would name a command that does not exist on that machine.
    const d = deps({ invokedAs: "mywego" });
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
 * Regression guard: an edge install once read the stable ring's version, found a
 * plain `X.Y.Z` outranking its own `X.Y.Z-edge.<sha>`, and nagged daily to
 * "update" to a version `update` then refused to install. Reading the recorded
 * ring fixes half of it; not ordering `-edge.<sha>` builds by semver (a coin
 * flip) is the other half.
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
    // foundations#74 rung 3: a fallback URL could point at a retired prefix
    // nothing advances and report "up to date" forever.
    expect(noticeChannel(null)).toBeNull();
  });

  it("normalizes a base that a hand-built record slipped past the parser", () => {
    // `parseInstallRecord` already canonicalizes `/install/`, so only a caller
    // that builds an `InstallRecord` itself reaches this. Kept because it is
    // cheap and prevents a doubled `//?dl=` in a URL.
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
    // The record says edge, so the stable `VERSION` object is never fetched.
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
    // The rejection must not escape into the caller (the notice is best-effort),
    // and an EACCES record refuses like a missing one rather than guessing.
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
  it("notifies on any DIFFERENCE for plain versions, in both directions", () => {
    expect(shouldNotify("0.4.2", "0.4.1")).toBe(true);
    // Identical is the only silent case.
    expect(shouldNotify("0.4.1", "0.4.1")).toBe(false);
  });

  // A rollback exists to get people off a build, and `update` follows bytes in
  // both directions, so the user has something to do either way. The wording
  // avoids calling it new (see the message tests below).
  it("notifies on a rollback, which it used to stay silent about", () => {
    expect(shouldNotify("0.4.0", "0.4.1")).toBe(true);
    expect(shouldNotify("1.2.2", "1.2.3")).toBe(true);
  });

  it("notifies on a DIFFERENT prerelease in either lexical direction", () => {
    // `4aeec3a2f` is the real successor of `e30454f2a` on `cli/edge` and sorts
    // below it, so ordering by semver would drop one direction.
    const older = "0.7.2-edge.e30454f2a";
    const newer = "0.7.2-edge.4aeec3a2f";
    expect(isNewerVersion(newer, older)).toBe(false);
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
    // (§9, no leading zeros). Strict parsing would silence the notice
    // permanently for those builds.
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

  // A rollback moves people off a bad build, and the notice is what tells them to
  // run `update`. `formatVersionNotice` would read "A new wego is available:
  // 1.2.3 -> 1.2.2", which is false. Asserted on the exact string because the
  // routing on `isNewerVersion` is what a refactor could silently invert.
  it("announces a rollback, without calling the older release new", async () => {
    const d = deps({
      version: "1.2.3",
      readInstallRecord: async () => RECORD,
      fetch: (async () => new Response("1.2.2\n")) as unknown as typeof fetch,
    });
    const r = await maybeNotifyNewVersion(d);
    expect(r.message).toBe(
      "Your wego channel now serves 1.2.2 (you have 1.2.3). Run `wego update -y`.",
    );
    expect(r.message).not.toContain("A new wego is available");
  });

  // Both wordings are pinned so neither can drift onto the other's case.
  it("still says 'a new wego is available' when the channel moved forward", async () => {
    const d = deps({
      version: "1.2.2",
      readInstallRecord: async () => RECORD,
      fetch: (async () => new Response("1.2.3\n")) as unknown as typeof fetch,
    });
    expect((await maybeNotifyNewVersion(d)).message).toBe(
      "A new wego is available: 1.2.2 -> 1.2.3. Run `wego update -y`.",
    );
  });
});
