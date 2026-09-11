import { describe, expect, it } from "bun:test";
import { defaultInstallRecordPath } from "./config";
import { EXIT } from "./error-report";
import { signManifest, TEST_ROOT_PEM } from "./release-signing/testing/fixture";
import {
  followRecordedRing,
  INSTALL_RECORD_FILE,
  parseInstallRecord,
  ringAssetUrl,
  skillBaseForRing,
} from "./ring-follow";
import { type UpdateDeps, update } from "./update";

/**
 * foundations#74 rung 3 — update follows a RECORDED ring.
 *
 * The rung's three claims, one describe block each:
 *
 *  1. the installer records which ring it installed from, in CONFIG, not in the
 *     binary;
 *  2. `wego update` follows that record — the record, and nothing baked, decides
 *     where the bytes come from;
 *  3. a missing record REFUSES rather than guesses.
 *
 * Claim 1 spans two apps that share no code by design, so each side pins the same
 * literal: the fixture below is byte-for-byte what `apps/api`'s installer script
 * writes, and `apps/api/src/routes/install.test.ts` asserts the script emits it.
 * If one side changes the shape, the other side's suite fails.
 */

/** Exactly what the installer script writes (see the file header). */
const INSTALLER_RECORD_JSON = `{
  "ring": "latest",
  "installUrl": "https://api.wego.com/install"
}
`;

const EXEC_PATH = "/home/u/.local/bin/wego";
const RECORD_PATH = "/home/u/.config/wego/install.json";

const enc = (s: string) => new TextEncoder().encode(s);

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

/**
 * `update` deps over an in-memory install, recording every URL fetched. Deliberately
 * `--check`-shaped: this suite asks WHERE a followed ring reads from and WHETHER an
 * unrecorded one reads at all, so nothing here needs to write a binary (the
 * download/verify/swap half is `update.test.ts`'s).
 */
function checkDeps(overrides: Partial<UpdateDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fetched: string[] = [];
  const current = enc("RUNNING-BINARY");
  const deps: UpdateDeps = {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    version: "0.6.4",
    fromSource: false,
    installRecordPath: RECORD_PATH,
    readInstallRecord: async () => parseInstallRecord(INSTALLER_RECORD_JSON),
    flavor: "wego",
    installUrl: "https://api.wego.com/install",
    platform: "linux",
    arch: "x64",
    execPath: EXEC_PATH,
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      fetched.push(url);
      const manifest = `${await sha256Hex(current)}  wego-linux-x64\n`;
      // The signed build record the manifest has to come with (foundations#74 rung
      // 9): a real signature over these exact bytes, so this suite keeps reading
      // through the same fail-closed path production does.
      const body =
        new URL(url).searchParams.get("sig") === "1"
          ? JSON.stringify(await signManifest(enc(manifest)))
          : manifest;
      return {
        ok: true,
        status: 200,
        text: async () => body,
        arrayBuffer: async () => new Uint8Array(enc(body)).buffer,
      } as Response;
    }) as unknown as typeof fetch,
    gunzip: (data) => data,
    hashFile: async () => sha256Hex(current),
    writeFile: async () => {
      throw new Error("must not write on --check");
    },
    chmod: async () => {},
    rename: async () => {
      throw new Error("must not swap on --check");
    },
    rm: async () => {},
    clearQuarantine: async () => {},
    confirm: async () => false,
    tempPath: `${EXEC_PATH}.tmp`,
    sweepTemps: async () => {},
    trustedRootsPem: TEST_ROOT_PEM,
    ...overrides,
  };
  return { deps, out, err, fetched };
}

describe("the recorded ring lives in config, not in the binary", () => {
  it("stores the record beside the other flavor-scoped config files", () => {
    expect(defaultInstallRecordPath({ XDG_CONFIG_HOME: "/cfg" }, "wego")).toBe(
      `/cfg/wego/${INSTALL_RECORD_FILE}`,
    );
    // Flavor-scoped, so the two flavors' installs never overwrite each other's ring.
    expect(
      defaultInstallRecordPath({ XDG_CONFIG_HOME: "/cfg" }, "wegostaging"),
    ).toBe("/cfg/wegostaging/install.json");
  });

  it("parses exactly what the installer script writes", () => {
    expect(parseInstallRecord(INSTALLER_RECORD_JSON)).toEqual({
      ring: "latest",
      installUrl: "https://api.wego.com/install",
    });
  });

  it("keeps no build-baked download base in the self-update path", async () => {
    // The mutation this rung exists to prevent: re-introducing a channel URL
    // compiled into the artifact. `update.ts` must resolve its source from the
    // RECORD alone — a baked base is what made a published binary impossible to
    // re-point without a rebuild.
    // Asserted as booleans, not `not.toContain`, so a failure prints the claim
    // rather than the whole module.
    const source = await Bun.file(
      new URL("./update.ts", import.meta.url),
    ).text();
    expect(source.includes("WEGO_BUILD_DOWNLOAD_BASE_URL")).toBe(false);
    expect(source.includes("downloadBaseUrl")).toBe(false);
    // No env read at all here: a baked value and a live env var are the same read
    // in a compiled binary, which is how a poisoned environment could re-point it.
    expect(source.includes("process.env")).toBe(false);
  });
});

describe("wego update follows the recorded ring", () => {
  it("reads the ring's assets through the recorded install endpoint", async () => {
    const { deps, fetched } = checkDeps();
    expect(await update(["--check"], deps)).toBe(EXIT.OK);
    expect(fetched).toEqual([
      "https://api.wego.com/install?dl=SHA256SUMS.txt&ring=latest",
      // The record is fetched before those bytes are READ, never after they are
      // trusted (foundations#74 rung 9).
      "https://api.wego.com/install?dl=SHA256SUMS.txt.sigstore.json&ring=latest&sig=1",
    ]);
  });

  it("follows a DIFFERENT recorded ring to a different endpoint", async () => {
    // The point of a record: two installs of the same bytes follow whatever each
    // one recorded. Nothing about the binary decides this.
    const { deps, fetched } = checkDeps({
      readInstallRecord: async () => ({
        ring: "staging",
        installUrl: "https://api.wegostaging.com/install",
      }),
    });
    expect(await update(["--check"], deps)).toBe(EXIT.OK);
    expect(fetched).toEqual([
      "https://api.wegostaging.com/install?dl=SHA256SUMS.txt&ring=staging",
      // The record is fetched before those bytes are READ, never after they are
      // trusted (foundations#74 rung 9).
      "https://api.wegostaging.com/install?dl=SHA256SUMS.txt.sigstore.json&ring=staging&sig=1",
    ]);
  });

  it("names the followed ring in what it reports", async () => {
    const { deps, out } = checkDeps();
    expect(await update(["--check"], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toContain("ring latest");
  });

  it("strips a trailing slash before appending the ?dl= marker", () => {
    const decision = followRecordedRing({
      record: { ring: "next", installUrl: "https://api.wego.com/install/" },
      recordPath: RECORD_PATH,
      reinstallHint: "hint",
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(ringAssetUrl(decision.base, "SHA256SUMS.txt", decision.ring)).toBe(
      "https://api.wego.com/install?dl=SHA256SUMS.txt&ring=next",
    );
  });

  it("sends the recorded ring, so a ring install cannot drift to the deploy's own channel", () => {
    // The whole point of the record (rung 3) is that the pointer is a fact on the
    // machine; a bare ?dl= would resolve against whatever channel the DEPLOY was
    // configured with, so a `next` install would receive stable's bytes on its
    // next update - a checksum-clean swap nothing downstream can catch, because
    // update decides on a checksum difference and never on a version.
    expect(
      ringAssetUrl("https://api.wego.com/install", "wego-darwin-arm64", "next"),
    ).toBe("https://api.wego.com/install?dl=wego-darwin-arm64&ring=next");
  });

  it("percent-encodes both the asset and the ring", () => {
    expect(ringAssetUrl("https://api.wego.com/install", "a b", "r+1")).toBe(
      "https://api.wego.com/install?dl=a%20b&ring=r%2B1",
    );
  });

  it("refuses a recorded endpoint that is not HTTPS", async () => {
    // The record is a plain local file, so it is an input: anyone able to write it
    // could otherwise redirect the download to a plaintext host.
    const { deps, err, fetched } = checkDeps({
      readInstallRecord: async () => ({
        ring: "latest",
        installUrl: "http://evil.example/install",
      }),
    });
    expect(await update(["--check"], deps)).toBe(EXIT.PERMANENT);
    expect(err.join("\n")).toMatch(/HTTPS/);
    expect(fetched).toEqual([]);
  });
});

describe("a missing record refuses rather than guesses", () => {
  it("refuses with no record at all, and fetches nothing", async () => {
    const { deps, err, fetched } = checkDeps({
      readInstallRecord: async () => null,
    });
    expect(await update([], deps)).toBe(EXIT.PERMANENT);
    expect(err.join("\n")).toMatch(/refusing to guess which ring/);
    // Names the file, so the user can see what is missing…
    expect(err.join("\n")).toContain(RECORD_PATH);
    // …and the one command that writes it.
    expect(err.join("\n")).toContain("/install | bash");
    expect(fetched).toEqual([]);
  });

  it("refuses on --check too, rather than reporting from a guessed ring", async () => {
    const { deps, fetched } = checkDeps({
      readInstallRecord: async () => null,
    });
    expect(await update(["--check"], deps)).toBe(EXIT.PERMANENT);
    expect(fetched).toEqual([]);
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["not JSON", "{ nope"],
    ["a JSON array", "[]"],
    ["missing the ring", '{"installUrl":"https://api.wego.com/install"}'],
    ["missing the install URL", '{"ring":"latest"}'],
    [
      "an empty ring",
      '{"ring":"","installUrl":"https://api.wego.com/install"}',
    ],
    [
      "a ring with a path separator",
      '{"ring":"../latest","installUrl":"https://api.wego.com/install"}',
    ],
    [
      "an uppercase ring",
      '{"ring":"Latest","installUrl":"https://api.wego.com/install"}',
    ],
    [
      "an install URL that is not a URL",
      '{"ring":"latest","installUrl":"nope"}',
    ],
    [
      "an install URL carrying a query",
      '{"ring":"latest","installUrl":"https://api.wego.com/install?dl=evil"}',
    ],
    [
      "an install URL whose path is not /install",
      '{"ring":"latest","installUrl":"https://api.wego.com/other"}',
    ],
    [
      "an install URL with only a host, no /install path",
      '{"ring":"latest","installUrl":"https://api.wego.com"}',
    ],
  ])("reads %s as no record", (_label, body) => {
    expect(parseInstallRecord(body)).toBeNull();
  });

  it("accepts a trailing slash on /install and canonicalizes it", () => {
    // `/install/` names the same endpoint, so rejecting it would refuse a record a
    // person could plausibly hand-write - and the refusal would brick BOTH `update`
    // and the new-version notice while telling the user nothing, since the two
    // spellings look identical to them. Canonicalizing at the parse boundary is not
    // "guessing a ring": rung 3's refusal is about an ABSENT ring, not a slash.
    const record = parseInstallRecord(
      '{"ring":"stable","installUrl":"https://api.wego.com/install/"}',
    );
    expect(record).toEqual({
      ring: "stable",
      installUrl: "https://api.wego.com/install",
    });
  });

  it("still refuses a path that only LOOKS like a slashed /install", () => {
    // The isolating cases: accepting one trailing slash must not widen into
    // accepting a doubled one or a deeper path, both of which are real malformation
    // rather than a spelling of the same endpoint.
    for (const url of [
      "https://api.wego.com/install//",
      "https://api.wego.com/install/extra",
      "https://api.wego.com/installer",
    ]) {
      expect(
        parseInstallRecord(`{"ring":"stable","installUrl":"${url}"}`),
        url,
      ).toBeNull();
    }
  });

  it("refuses a DOT SEGMENT that `new URL()` would resolve to /install", () => {
    // The trap that accepting `/install/` opened, and the reason the canonical value
    // is rebuilt from the parsed URL rather than stripped off the raw string:
    // `new URL()` resolves `..` BEFORE `pathname` is read, so each of these presents
    // as `/install/` and passed the endpoint check, while the raw string a consumer
    // would build from still carried the traversal - reaching `ringAssetUrl` as
    // `…/install/extra/..?dl=VERSION`.
    for (const url of [
      "https://api.wego.com/install/extra/..",
      "https://api.wego.com/foo/../install/",
      "https://api.wego.com/./install",
    ]) {
      expect(
        parseInstallRecord(`{"ring":"stable","installUrl":"${url}"}`),
        url,
      ).toBeNull();
    }
  });

  it("refuses credentials rather than dropping them in canonicalization", () => {
    // `url.origin` omits userinfo, so canonicalizing would silently discard a
    // password. This field refuses a query and a fragment for the same reason:
    // suspicious input is not quietly rewritten.
    expect(
      parseInstallRecord(
        '{"ring":"stable","installUrl":"https://u:p@api.wego.com/install"}',
      ),
    ).toBeNull();
  });

  it("keeps a non-default port through canonicalization", () => {
    // Rebuilding from `origin` must not lose the port: a record naming a
    // host:port endpoint has to keep addressing it.
    expect(
      parseInstallRecord(
        '{"ring":"stable","installUrl":"https://api.wego.com:8443/install/"}',
      ),
    ).toEqual({
      ring: "stable",
      installUrl: "https://api.wego.com:8443/install",
    });
  });

  it("refuses every unusable record the same way, with no default ring", () => {
    // One decision function, so there is a single place a fallback could be
    // smuggled in — and it has no branch that invents a ring.
    const decision = followRecordedRing({
      record: null,
      recordPath: RECORD_PATH,
      reinstallHint: "curl -fsSL https://api.wego.com/install | bash",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.message).toContain(RECORD_PATH);
    expect(decision.message).toContain(
      "curl -fsSL https://api.wego.com/install | bash",
    );
    expect(decision.message).not.toMatch(/latest|staging|stable/);
  });

  it("names the directory a renamed install's files moved from, and still refuses", () => {
    // The scope moved from the flavor-keyed dir to the command-name one, so a
    // renamed install that predates the change looks unconfigured. The refusal
    // gains one sentence naming the old directory - a HINT on the way out, never a
    // second place to read a record from: adopting a record found in a directory
    // this install no longer owns is how `wego-next` ends up following `wego`'s
    // ring, which is the exact drift the record exists to prevent.
    const decision = followRecordedRing({
      record: null,
      recordPath: "/home/u/.config/wego-next/install.json",
      reinstallHint: "curl -fsSL https://api.wego.com/install | bash",
      movedFrom: "/home/u/.config/wego",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.message).toContain(
      "/home/u/.config/wego-next/install.json",
    );
    expect(decision.message).toContain("/home/u/.config/wego");
    // Still a refusal, and still names the only way to obtain a record.
    expect(decision.message).toContain("refusing to guess");
    expect(decision.message).toContain(
      "curl -fsSL https://api.wego.com/install | bash",
    );
  });

  it("says nothing about a moved directory for an install whose scope never moved", () => {
    // Every default install: `movedFrom` is absent and the message is the one it
    // has always been, with no speculative "did you rename it?" noise.
    const decision = followRecordedRing({
      record: null,
      recordPath: RECORD_PATH,
      reinstallHint: "hint",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.message).not.toMatch(/moved|invoked as/);
  });

  it("still reports a from-source run as a reinstall, not a missing ring", async () => {
    // A source run has no installed binary to replace, so there is nothing to
    // record and nothing to refuse — the pre-existing hint must survive.
    const { deps, out, err } = checkDeps({
      fromSource: true,
      readInstallRecord: async () => null,
    });
    expect(await update([], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toMatch(/running from source/);
    expect(err).toEqual([]);
  });
});

/**
 * Issue #1751 — the SKILL channel follows the recorded ring too.
 *
 * The binary axis got this treatment at rung 3; the skill axis kept a whole URL
 * baked, and drifted the same way within two days of the channel rename. These
 * assert the split that removes the class: origin is compiled in (a trust anchor),
 * ring comes from the record (policy that must move with a promote).
 */
describe("the skill channel is composed, not baked", () => {
  const ORIGIN = "https://store123.public.blob.vercel-storage.com";

  it("composes the store origin with the recorded ring", () => {
    expect(skillBaseForRing(ORIGIN, "stable")).toBe(`${ORIGIN}/skill/stable`);
    expect(skillBaseForRing(ORIGIN, "next")).toBe(`${ORIGIN}/skill/next`);
  });

  it("composes a ring this binary has never heard of", () => {
    // Deliberately NOT an allowlist. A binary that refused a well-formed pointer
    // added after it shipped could not follow it — the same reasoning `RING_NAME`
    // carries. A ring nothing is published on simply 404s into the embedded copy,
    // which is why `edge` needs no channel of its own.
    expect(skillBaseForRing(ORIGIN, "canary")).toBe(`${ORIGIN}/skill/canary`);
  });

  it("normalizes a trailing slash on the baked origin", () => {
    expect(skillBaseForRing(`${ORIGIN}/`, "stable")).toBe(
      `${ORIGIN}/skill/stable`,
    );
  });

  it("yields no base when either half is missing", () => {
    // Both are degradations to the embedded copy, never a guessed channel:
    // an unbaked build (from source) and an install with no record.
    expect(skillBaseForRing(undefined, "stable")).toBe(undefined);
    expect(skillBaseForRing(ORIGIN, undefined)).toBe(undefined);
    expect(skillBaseForRing(undefined, undefined)).toBe(undefined);
    // `""` is what `build-release.ts` bakes when the Environment has no origin —
    // it must read as unbaked, not compose `/skill/stable` against nothing.
    expect(skillBaseForRing("", "stable")).toBe(undefined);
  });

  it("refuses a ring that is not one flat pointer segment", () => {
    // The recorded half is the one an operator could hand-edit, so it stays
    // constrained to `RING_NAME`. It may name a different PATH under the pinned
    // origin; it may never reach a different host, escape the prefix, or smuggle a
    // query — which is what keeps `skill-remote.ts`'s one-origin claim true.
    for (const bad of [
      "../cli/stable",
      "stable/../../etc",
      "sta ble",
      "STABLE",
      "stable?x=1",
      "//evil.example.com",
      "",
    ]) {
      expect(skillBaseForRing(ORIGIN, bad)).toBe(undefined);
    }
  });

  it("puts the ring where a reader of the URL can see it", () => {
    // The marker records the ring and the guard compares it; a base whose last
    // segment were anything but that ring would put the two back out of step.
    const ring = "stable";
    expect(skillBaseForRing(ORIGIN, ring)?.endsWith(`/${ring}`)).toBe(true);
  });
});
