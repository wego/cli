import { describe, expect, it } from "bun:test";
import {
  assertLoopback,
  assertSecureUrl,
  defaultCredentialsPath,
  defaultInstallRecordPath,
  installScope,
  legacyScopeDir,
  loadCliConfig,
  requireClientId,
} from "./config";

/** Run `body` as though the binary on disk were named `name`. `process.execPath`
 *  is what `installScope` reads (a compiled Bun binary's `argv[1]` is the useless
 *  `/$bunfs/...`), and it is assignable, so this drives the real wiring rather
 *  than a parallel copy of the rule. */
function asCommand<T>(name: string, body: () => T): T {
  const real = process.execPath;
  process.execPath = `/home/u/.local/bin/${name}`;
  try {
    return body();
  } finally {
    process.execPath = real;
  }
}

const REQUIRED = {
  WEGO_AUTH_AUTHORIZE_URL: "https://auth.wegostaging.com/authorize",
  WEGO_AUTH_TOKEN_URL: "https://auth.wegostaging.com/token",
  WEGO_CLI_CLIENT_ID: "cli-abc",
  WEGO_API_URL: "http://localhost:3001",
};

const env = (overrides: Record<string, string> = {}) => ({
  ...REQUIRED,
  ...overrides,
});

describe("loadCliConfig", () => {
  it("requires environment-specific values when no release config is baked", () => {
    expect(() => loadCliConfig({}, {})).toThrow(/WEGO_AUTH_AUTHORIZE_URL/);
    expect(() =>
      loadCliConfig({ ...REQUIRED, WEGO_CLI_CLIENT_ID: "" }, {}),
    ).toThrow(/WEGO_CLI_CLIENT_ID/);
    const c = loadCliConfig(env(), {});
    expect(c.authorizeUrl).toBe("https://auth.wegostaging.com/authorize");
    expect(c.tokenUrl).toBe("https://auth.wegostaging.com/token");
    expect(c.scopes).toBe("openid profile users");
    expect(c.apiBaseUrl).toBe("http://localhost:3001");
    expect(c.redirectPath).toBe("/callback");
    expect(c.redirectPort).toBe(0);
    expect(c.clientId).toBe("cli-abc");
  });

  it("honors env overrides", () => {
    const c = loadCliConfig(
      env({
        WEGO_CLI_CLIENT_ID: "cli-abc",
        WEGO_API_URL: "https://api.wego.com",
        WEGO_AUTH_AUTHORIZE_URL: "https://auth.example/authorize",
        WEGO_CLI_SCOPES: "openid api",
        WEGO_CREDENTIALS_PATH: "/tmp/creds.json",
      }),
    );
    expect(c.clientId).toBe("cli-abc");
    expect(c.apiBaseUrl).toBe("https://api.wego.com");
    expect(c.authorizeUrl).toBe("https://auth.example/authorize");
    expect(c.scopes).toBe("openid api");
    expect(c.credentialsPath).toBe("/tmp/creds.json");
  });

  it("uses baked build defaults when no runtime env is set (published binary)", () => {
    // The real binaries inline these into BUILD via `bun build --env`; here we
    // inject them to exercise the same merge (build value > DEFAULTS).
    const c = loadCliConfig(
      {},
      {
        authorizeUrl: "https://auth.wegostaging.com/authorize",
        tokenUrl: "https://auth.wegostaging.com/token",
        clientId: "baked-staging-client",
        apiBaseUrl: "https://api.wegostaging.com",
      },
    );
    expect(c.authorizeUrl).toBe("https://auth.wegostaging.com/authorize");
    expect(c.tokenUrl).toBe("https://auth.wegostaging.com/token");
    expect(c.clientId).toBe("baked-staging-client");
    expect(c.apiBaseUrl).toBe("https://api.wegostaging.com");
  });

  it("lets a runtime env var override a baked build default", () => {
    const c = loadCliConfig(
      {
        WEGO_CLI_CLIENT_ID: "runtime-wins",
        WEGO_API_URL: "https://api.wego.com",
      },
      {
        authorizeUrl: "https://auth.wegostaging.com/authorize",
        tokenUrl: "https://auth.wegostaging.com/token",
        clientId: "baked-staging-client",
        apiBaseUrl: "https://api.wegostaging.com",
      },
    );
    expect(c.clientId).toBe("runtime-wins");
    expect(c.apiBaseUrl).toBe("https://api.wego.com");
  });

  it("honors loopback overrides (fixed port + bare path)", () => {
    const c = loadCliConfig(
      env({
        WEGO_CLI_REDIRECT_PORT: "9000",
        WEGO_CLI_REDIRECT_PATH: "",
      }),
    );
    expect(c.redirectPort).toBe(9000);
    // Empty string is an intentional override (bare redirect_uri), not a default.
    expect(c.redirectPath).toBe("");
  });

  it("does not validate loopback settings (whoami/logout must not break on a login-only env var)", () => {
    // loadCliConfig never throws on a malformed loopback override — validation
    // is deferred to assertLoopback, called only by login.
    expect(() =>
      loadCliConfig(env({ WEGO_CLI_REDIRECT_PORT: "abc" })),
    ).not.toThrow();
    expect(() =>
      loadCliConfig(env({ WEGO_CLI_REDIRECT_PATH: "callback" })),
    ).not.toThrow();
  });

  it("derives the credentials path from XDG_CONFIG_HOME", () => {
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: "/x/cfg" })).toBe(
      "/x/cfg/wego/credentials.json",
    );
  });

  it("scopes the default credentials dir by an explicitly passed scope", () => {
    // The scope is a parameter so `index.ts` can pass the target-aware one for the
    // credentials while passing the bare install scope for the rest; these two are
    // the historical `wego` / `wegostaging` leaves, unchanged.
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: "/x/cfg" }, "wego")).toBe(
      "/x/cfg/wego/credentials.json",
    );
    expect(
      defaultCredentialsPath({ XDG_CONFIG_HOME: "/x/cfg" }, "wegostaging"),
    ).toBe("/x/cfg/wegostaging/credentials.json");
  });

  it("loadCliConfig scopes the default credentials path by the COMMAND NAME, not the baked flavor", () => {
    // The install's identity is the name it is invoked as: a second, renamed
    // install of the same release keeps its own store, and the baked flavor - the
    // release identity - does not decide where anyone's tokens live.
    const c = asCommand("wego-next", () =>
      loadCliConfig(env({ XDG_CONFIG_HOME: "/x/cfg" }), {
        flavor: "wego",
      }),
    );
    expect(c.credentialsPath).toBe("/x/cfg/wego-next/credentials.json");
    // Same binary, invoked under the default name: the historical path, unchanged.
    expect(
      asCommand("wego", () =>
        loadCliConfig(env({ XDG_CONFIG_HOME: "/x/cfg" }), { flavor: "wego" }),
      ).credentialsPath,
    ).toBe("/x/cfg/wego/credentials.json");
  });

  it("loadCliConfig defaults to the wego dir when no flavor is baked", () => {
    const c = loadCliConfig(env({ XDG_CONFIG_HOME: "/x/cfg" }), {});
    expect(c.credentialsPath).toBe("/x/cfg/wego/credentials.json");
  });

  it("treats an empty/whitespace baked flavor as absent (source-path contract)", () => {
    // `WEGO_BUILD_FLAVOR=` survives `??`; it must NOT collapse the leaf to
    // `~/.config/credentials.json`. Empty and whitespace both fall back to wego.
    for (const flavor of ["", "   "]) {
      const c = loadCliConfig(env({ XDG_CONFIG_HOME: "/x/cfg" }), { flavor });
      expect(c.credentialsPath).toBe("/x/cfg/wego/credentials.json");
    }
  });

  it("WEGO_CREDENTIALS_PATH still wins over the flavor default", () => {
    const c = loadCliConfig(
      env({
        XDG_CONFIG_HOME: "/x/cfg",
        WEGO_CREDENTIALS_PATH: "/tmp/creds.json",
      }),
      { flavor: "wegostaging" },
    );
    expect(c.credentialsPath).toBe("/tmp/creds.json");
  });
});

describe("assertLoopback", () => {
  it("rejects a malformed WEGO_CLI_REDIRECT_PORT", () => {
    const bad = (v: string) => () =>
      assertLoopback(loadCliConfig(env({ WEGO_CLI_REDIRECT_PORT: v })));
    expect(bad("abc")).toThrow(/WEGO_CLI_REDIRECT_PORT/);
    expect(bad("1.5")).toThrow();
    expect(bad("70000")).toThrow();
  });

  it("rejects a WEGO_CLI_REDIRECT_PATH without a leading slash", () => {
    expect(() =>
      assertLoopback(
        loadCliConfig(env({ WEGO_CLI_REDIRECT_PATH: "callback" })),
      ),
    ).toThrow(/WEGO_CLI_REDIRECT_PATH/);
  });

  it("accepts a fixed port and a bare or slash-prefixed path", () => {
    expect(() =>
      assertLoopback(
        loadCliConfig(
          env({
            WEGO_CLI_REDIRECT_PORT: "9000",
            WEGO_CLI_REDIRECT_PATH: "",
          }),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      assertLoopback(loadCliConfig(env({ WEGO_CLI_REDIRECT_PATH: "/cb" }))),
    ).not.toThrow();
  });
});

describe("assertSecureUrl", () => {
  it("allows https and localhost http, rejects non-local http", () => {
    expect(() =>
      assertSecureUrl("https://auth.wego.com/x", "WEGO_AUTH_TOKEN_URL"),
    ).not.toThrow();
    expect(() =>
      assertSecureUrl("http://localhost:3001", "WEGO_API_URL"),
    ).not.toThrow();
    expect(() =>
      assertSecureUrl("http://127.0.0.1:3001", "WEGO_API_URL"),
    ).not.toThrow();
    expect(() =>
      assertSecureUrl("http://api.wego.com", "WEGO_API_URL"),
    ).toThrow(/WEGO_API_URL must be HTTPS/);
  });
});

describe("requireClientId", () => {
  it("returns the client id when set", () => {
    expect(
      requireClientId(loadCliConfig(env({ WEGO_CLI_CLIENT_ID: "cli-abc" }))),
    ).toBe("cli-abc");
  });

  it("throws a B1-referencing error when unset", () => {
    expect(() =>
      requireClientId({ ...loadCliConfig(env()), clientId: "" }),
    ).toThrow(/WEGO_CLI_CLIENT_ID/);
  });
});

describe("installScope", () => {
  it("is the name the binary was invoked as", () => {
    expect(installScope("/home/u/.local/bin/wego-next")).toBe("wego-next");
    expect(installScope("/home/u/.local/bin/wego")).toBe("wego");
  });

  it("strips a Windows .exe suffix so one install is one scope on every platform", () => {
    // Path SEPARATORS are the host's (`node:path` basename resolves to win32 on
    // Windows), so this asserts only the suffix rule, which is platform-free.
    expect(installScope("/home/u/wego-edge.exe")).toBe("wego-edge");
  });

  it("answers `wego` from source, keeping the historical source path", () => {
    // `bun run src/index.ts` reports the runtime as the exec path; a source run
    // must not invent a `bun` config dir.
    expect(installScope("/usr/local/bin/bun")).toBe("wego");
    expect(installScope("/usr/local/bin/node")).toBe("wego");
  });

  it("gives every per-install file the same scope", () => {
    const record = asCommand("wego-edge", () =>
      defaultInstallRecordPath({ XDG_CONFIG_HOME: "/x/cfg" }),
    );
    const creds = asCommand("wego-edge", () =>
      defaultCredentialsPath({ XDG_CONFIG_HOME: "/x/cfg" }),
    );
    expect(record).toBe("/x/cfg/wego-edge/install.json");
    expect(creds).toBe("/x/cfg/wego-edge/credentials.json");
  });
});

describe("legacyScopeDir", () => {
  it("is undefined for an install whose command name matches its release", () => {
    // Every default install: nothing moved, so there is nothing to point at.
    expect(
      asCommand("wego", () =>
        legacyScopeDir({ XDG_CONFIG_HOME: "/x/cfg" }, { flavor: "wego" }),
      ),
    ).toBeUndefined();
    expect(
      asCommand("wegostaging", () =>
        legacyScopeDir(
          { XDG_CONFIG_HOME: "/x/cfg" },
          { flavor: "wegostaging" },
        ),
      ),
    ).toBeUndefined();
  });

  it("names the flavor-keyed dir in the same root for a renamed install", () => {
    expect(
      asCommand("wego-next", () =>
        legacyScopeDir({ XDG_CONFIG_HOME: "/x/cfg" }, { flavor: "wego" }),
      ),
    ).toBe("/x/cfg/wego");
  });

  it("never points at the config root itself when no flavor is baked", () => {
    // An empty `WEGO_BUILD_FLAVOR` normalizes to `wego`, so the hint stays a
    // directory INSIDE the root rather than the root (which holds every other
    // tool's config).
    expect(
      asCommand("wego-next", () =>
        legacyScopeDir({ XDG_CONFIG_HOME: "/x/cfg" }, { flavor: "  " }),
      ),
    ).toBe("/x/cfg/wego");
  });
});
