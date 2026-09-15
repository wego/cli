import { describe, expect, it } from "bun:test";
import {
  assertLoopback,
  assertSecureUrl,
  defaultCredentialsPath,
  defaultInstallRecordPath,
  loadCliConfig,
  requireClientId,
} from "./config";

/** Run `body` as though the binary on disk were named `name`. `process.execPath`
 *  is the only thing that ever varied the config scope, and it is assignable, so
 *  this drives the real wiring rather than a parallel copy of the rule. */
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
    // The scope is still a parameter so `index.ts` can pass the target-aware one
    // for the credentials while passing the bare `wego` for the rest. Only the
    // DEFAULT stopped varying.
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: "/x/cfg" }, "wego")).toBe(
      "/x/cfg/wego/credentials.json",
    );
    expect(
      defaultCredentialsPath(
        { XDG_CONFIG_HOME: "/x/cfg" },
        "wego/auth.wegostaging.com",
      ),
    ).toBe("/x/cfg/wego/auth.wegostaging.com/credentials.json");
  });

  it("loadCliConfig does not let the command name move the credentials path", () => {
    // Nothing about the invocation decides where anyone's tokens live. Under the
    // name-keyed rule this first case answered `/x/cfg/wego-next/...`, which is
    // how a copied binary came up logged out.
    const c = asCommand("wego-next", () =>
      loadCliConfig(env({ XDG_CONFIG_HOME: "/x/cfg" }), {}),
    );
    expect(c.credentialsPath).toBe("/x/cfg/wego/credentials.json");
    expect(
      asCommand("wego", () =>
        loadCliConfig(env({ XDG_CONFIG_HOME: "/x/cfg" }), {}),
      ).credentialsPath,
    ).toBe("/x/cfg/wego/credentials.json");
  });

  it("loadCliConfig puts credentials under the wego dir", () => {
    const c = loadCliConfig(env({ XDG_CONFIG_HOME: "/x/cfg" }), {});
    expect(c.credentialsPath).toBe("/x/cfg/wego/credentials.json");
  });

  it("WEGO_CREDENTIALS_PATH still wins over the default", () => {
    const c = loadCliConfig(
      env({
        XDG_CONFIG_HOME: "/x/cfg",
        WEGO_CREDENTIALS_PATH: "/tmp/creds.json",
      }),
      {},
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

  it("allows the reserved .localhost suffix over http, and only it", () => {
    // Portless serves the local `apps/api` at `api.localhost`, and a linked
    // worktree at a branch-prefixed name under the same suffix. Since the
    // `local` target went, `WEGO_API_URL` is the only way to name either, so a
    // rule that knew only the three literals would reject every developer's
    // setup. RFC 6761 reserves the suffix for loopback; nothing routable has it.
    expect(() =>
      assertSecureUrl("http://api.localhost", "WEGO_API_URL"),
    ).not.toThrow();
    expect(() =>
      assertSecureUrl("http://rung2-api.localhost:3001", "WEGO_API_URL"),
    ).not.toThrow();
    // A routable host that merely *contains* the word is not the suffix, and a
    // remote host is still refused: the access token travels to the API.
    expect(() =>
      assertSecureUrl("http://localhost.evil.com", "WEGO_API_URL"),
    ).toThrow(/WEGO_API_URL must be HTTPS/);
    expect(() =>
      assertSecureUrl("http://notlocalhost", "WEGO_API_URL"),
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

describe("the config scope", () => {
  it("is `wego` whatever the binary on disk is called", () => {
    // The whole point of the constant. Under the old name-keyed rule these two
    // resolved to `/x/cfg/wego-next/...` and `/x/cfg/wego-edge/...`, so a copied
    // binary silently owned a different login, ring record and opt-out.
    for (const name of ["wego", "wego-next", "wego-edge", "mywego"]) {
      expect(
        asCommand(name, () =>
          defaultCredentialsPath({ XDG_CONFIG_HOME: "/x/cfg" }),
        ),
      ).toBe("/x/cfg/wego/credentials.json");
    }
  });

  it("gives every per-install file the same scope", () => {
    const record = asCommand("wego-edge", () =>
      defaultInstallRecordPath({ XDG_CONFIG_HOME: "/x/cfg" }),
    );
    const creds = asCommand("wego-edge", () =>
      defaultCredentialsPath({ XDG_CONFIG_HOME: "/x/cfg" }),
    );
    expect(record).toBe("/x/cfg/wego/install.json");
    expect(creds).toBe("/x/cfg/wego/credentials.json");
  });

  it("is unaffected by a Windows .exe suffix", () => {
    expect(
      asCommand("wego.exe", () =>
        defaultCredentialsPath({ XDG_CONFIG_HOME: "/x/cfg" }),
      ),
    ).toBe("/x/cfg/wego/credentials.json");
  });

  it("stays inside the config root, never the root itself", () => {
    // The old empty-flavor guard, kept as the property it was protecting: a
    // scope that collapsed to "" would put credentials.json next to every other
    // tool's config.
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: "/x/cfg" })).toBe(
      "/x/cfg/wego/credentials.json",
    );
  });
});
