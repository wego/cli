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
 * foundations#74 rung 3: update follows a recorded ring. One describe block per
 * claim:
 *
 *  1. the installer records which ring it installed from, in config, not in the
 *     binary;
 *  2. `wego update` follows that record, and nothing baked decides where the
 *     bytes come from;
 *  3. a missing record refuses rather than guesses.
 *
 * Claim 1 spans two apps that share no code, so each pins the same literal: the
 * fixture below is byte-for-byte what `apps/api`'s installer script writes, and
 * `apps/api/src/routes/install.test.ts` asserts the script emits it.
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
 * Records every URL fetched. `--check`-shaped: this suite asks where a followed
 * ring reads from and whether an unrecorded one reads at all, so nothing writes a
 * binary (download, verify and swap are covered in `update.test.ts`).
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
    installUrl: "https://api.wego.com/install",
    platform: "linux",
    arch: "x64",
    execPath: EXEC_PATH,
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      fetched.push(url);
      const manifest = `${await sha256Hex(current)}  wego-linux-x64\n`;
      // A real signature over these bytes, so this suite reads through the same
      // fail-closed verification production does (foundations#74 rung 9).
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
    // Guards against re-introducing a channel URL compiled into the binary, which
    // would make a published binary impossible to re-point without a rebuild.
    // Asserted as booleans, not `not.toContain`, so a failure prints the claim
    // rather than the whole module.
    const source = await Bun.file(
      new URL("./update.ts", import.meta.url),
    ).text();
    expect(source.includes("WEGO_BUILD_DOWNLOAD_BASE_URL")).toBe(false);
    expect(source.includes("downloadBaseUrl")).toBe(false);
    // No env read at all: in a compiled binary a baked value and a live env var
    // are the same read, so a poisoned environment could re-point it.
    expect(source.includes("process.env")).toBe(false);
  });
});

describe("wego update follows the recorded ring", () => {
  it("reads the ring's assets through the recorded install endpoint", async () => {
    const { deps, fetched } = checkDeps();
    expect(await update(["--check"], deps)).toBe(EXIT.OK);
    expect(fetched).toEqual([
      "https://api.wego.com/install?dl=SHA256SUMS.txt&ring=latest",
      // Fetched before the manifest is read (foundations#74 rung 9).
      "https://api.wego.com/install?dl=SHA256SUMS.txt.sigstore.json&ring=latest&sig=1",
    ]);
  });

  it("follows a DIFFERENT recorded ring to a different endpoint", async () => {
    // Two installs of the same bytes follow whatever each one recorded.
    const { deps, fetched } = checkDeps({
      readInstallRecord: async () => ({
        ring: "staging",
        installUrl: "https://api.wegostaging.com/install",
      }),
    });
    expect(await update(["--check"], deps)).toBe(EXIT.OK);
    expect(fetched).toEqual([
      "https://api.wegostaging.com/install?dl=SHA256SUMS.txt&ring=staging",
      // Fetched before the manifest is read (foundations#74 rung 9).
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
    // A bare ?dl= resolves against the deploy's configured channel, so a `next`
    // install would receive stable's bytes on its next update, a swap nothing
    // catches because update decides on a checksum difference, not a version.
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
    // The record is a plain local file: anyone able to write it could otherwise
    // redirect the download to a plaintext host.
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
    expect(err.join("\n")).toContain(RECORD_PATH);
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
    // `/install/` names the same endpoint; rejecting it would break both `update`
    // and the version notice over a spelling the user cannot tell apart.
    const record = parseInstallRecord(
      '{"ring":"stable","installUrl":"https://api.wego.com/install/"}',
    );
    expect(record).toEqual({
      ring: "stable",
      installUrl: "https://api.wego.com/install",
    });
  });

  it("still refuses a path that only LOOKS like a slashed /install", () => {
    // Accepting one trailing slash must not widen into accepting a doubled one or
    // a deeper path.
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
    // `new URL()` resolves `..` before `pathname` is read, so each of these
    // presents as `/install/` while the raw string still carries the traversal,
    // which could reach `ringAssetUrl` as `…/install/extra/..?dl=VERSION`.
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
    // password. Suspicious input is refused, not quietly rewritten.
    expect(
      parseInstallRecord(
        '{"ring":"stable","installUrl":"https://u:p@api.wego.com/install"}',
      ),
    ).toBeNull();
  });

  it("keeps a non-default port through canonicalization", () => {
    // Rebuilding from `origin` must not lose the port.
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
    // The single place a fallback could be added; the message must name no ring.
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

  it("refuses without speculating about where the record might be", () => {
    // One config scope, so there is no other directory a record could be in.
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
    // record and nothing to refuse.
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
 * Issue #1751: the skill base follows the recorded ring too. The origin is
 * compiled in (a trust anchor); the ring comes from the record (policy that must
 * move with a promote).
 */
describe("the skill channel is composed, not baked", () => {
  const ORIGIN = "https://store123.public.blob.vercel-storage.com";

  it("composes the store origin with the recorded ring", () => {
    expect(skillBaseForRing(ORIGIN, "stable")).toBe(`${ORIGIN}/skill/stable`);
    expect(skillBaseForRing(ORIGIN, "next")).toBe(`${ORIGIN}/skill/next`);
  });

  it("composes a ring this binary has never heard of", () => {
    // Not an allowlist: a binary must be able to follow a well-formed ring added
    // after it shipped (see `RING_NAME`).
    expect(skillBaseForRing(ORIGIN, "canary")).toBe(`${ORIGIN}/skill/canary`);
  });

  it("normalizes a trailing slash on the baked origin", () => {
    expect(skillBaseForRing(`${ORIGIN}/`, "stable")).toBe(
      `${ORIGIN}/skill/stable`,
    );
  });

  it("yields no base when either half is missing", () => {
    // An unbaked build and an install with no record: never a guessed channel.
    expect(skillBaseForRing(undefined, "stable")).toBe(undefined);
    expect(skillBaseForRing(ORIGIN, undefined)).toBe(undefined);
    expect(skillBaseForRing(undefined, undefined)).toBe(undefined);
    // An empty origin must read as unbaked, not compose `/skill/stable` against
    // nothing.
    expect(skillBaseForRing("", "stable")).toBe(undefined);
  });

  it("refuses a ring that is not one flat pointer segment", () => {
    // The recorded half can be hand-edited, so it stays constrained to
    // `RING_NAME`: it may name a different path under the pinned origin, but never
    // reach a different host, escape the prefix, or smuggle a query.
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
    const ring = "stable";
    expect(skillBaseForRing(ORIGIN, ring)?.endsWith(`/${ring}`)).toBe(true);
  });
});
