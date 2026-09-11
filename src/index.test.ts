import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliConfig } from "./config";
import { buildRealDeps, helpText, type RunDeps, run } from "./index";
import { loadTestCliConfig } from "./test-config";

function deps() {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: RunDeps = {
    loadConfig: () => loadTestCliConfig(),
    io: { log: (m) => out.push(m), error: (m) => err.push(m) },
    login: () => {
      calls.push("login");
      return Promise.resolve(0);
    },
    whoami: () => {
      calls.push("whoami");
      return Promise.resolve(0);
    },
    places: (_config, args) => {
      calls.push(`places:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    info: (_config, args) => {
      calls.push(`info:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    flights: (_config, args) => {
      calls.push(`flights:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    hotels: (_config, args) => {
      calls.push(`hotels:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    feedback: (_config, args) => {
      calls.push(`feedback:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    skill: (args) => {
      calls.push(`skill:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    update: (args) => {
      calls.push(`update:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    uninstall: (args) => {
      calls.push(`uninstall:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    config: (args) => {
      calls.push(`config:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    telemetry: (args) => {
      calls.push(`telemetry:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    sendTelemetry: (args) => {
      calls.push(`sendTelemetry:${args.join(" ")}`);
      return Promise.resolve(0);
    },
    logout: () => {
      calls.push("logout");
      return Promise.resolve(0);
    },
  };
  return { d, calls, out, err };
}

const argv = (cmd?: string) => ["bun", "wego", ...(cmd ? [cmd] : [])];

describe("run (command dispatch)", () => {
  it("dispatches login / whoami / logout", async () => {
    for (const cmd of ["login", "whoami", "logout"]) {
      const { d, calls } = deps();
      expect(await run(argv(cmd), d)).toBe(0);
      expect(calls).toEqual([cmd]);
    }
  });

  // Note: `places` dispatch + arg handling is covered behaviorally through
  // `run(argv, …)` in commands.test.ts (real handler, stubbed network), so it is
  // not re-asserted here against a command stub — that would couple to the
  // "forward the raw args tail" contract an internals migration may change.

  it("prints the version", async () => {
    const { d, out } = deps();
    expect(await run(argv("version"), d)).toBe(0);
    // Semver X.Y.Z with an optional prerelease suffix — the baked version comes
    // from the release tag (`0.1.1`, or `0.1.1-rc.1` for a prerelease tag), and
    // a from-source run stamps `0.0.0-dev`.
    expect(out.join("")).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("prints help with no command", async () => {
    const { d, out } = deps();
    expect(await run(argv(), d)).toBe(0);
    expect(out.join("")).toMatch(/Usage:/);
  });

  // Golden matrix (issue #1119): the root already handled every help form
  // correctly before the fix — pinned here alongside the group/leaf matrix in
  // commands.test.ts / hotels.test.ts so the root isn't the one untested gap.
  for (const help of ["help", "-h", "--help"]) {
    it(`prints help for \`${help}\`: stdout, exit 0, empty stderr`, async () => {
      const { d, out, err } = deps();
      expect(await run(argv(help), d)).toBe(0);
      expect(out.join("")).toMatch(/Usage:/);
      expect(err.length).toBe(0);
    });
  }

  for (const cmd of ["login", "whoami", "logout", "version"]) {
    for (const help of ["--help", "-h", "help"]) {
      it(`${cmd} ${help}: prints its own usage, exit 0, does not dispatch`, async () => {
        const { d, calls, out, err } = deps();
        expect(await run([...argv(cmd), help], d)).toBe(0);
        expect(out.join("")).toMatch(new RegExp(`^Usage: wego ${cmd}`));
        expect(calls).toEqual([]);
        expect(err.length).toBe(0);
      });
    }
  }

  for (const cmd of ["whoami", "logout", "version"]) {
    it(`${cmd} rejects an unknown flag with its usage, exit 2, does not dispatch`, async () => {
      const { d, calls, err } = deps();
      expect(await run([...argv(cmd), "--frobnicate"], d)).toBe(2);
      expect(err.join("")).toMatch(
        new RegExp(`^Unknown option: --frobnicate\\nUsage: wego ${cmd}`),
      );
      expect(calls).toEqual([]);
    });
  }

  it("config loads on first read, never on a --help path, so help works with no backend configured", async () => {
    for (const cmd of [
      ["flights", "--help"],
      ["flights", "results", "--help"],
      ["hotels", "rooms", "-h"],
      ["info", "holidays", "help"],
      ["places", "--help"],
      ["feedback", "--help"],
    ]) {
      const { d, calls } = deps();
      d.loadConfig = () => {
        throw new Error("WEGO_API_URL is required for source usage");
      };
      expect(await run([...argv(), ...cmd], d)).toBe(0);
      expect(calls).toEqual([`${cmd[0]}:${cmd.slice(1).join(" ")}`]);
    }
    for (const cmd of [
      ["feedback", "--message", "help"],
      ["places", "--locale", "help", "dubai"],
      ["flights", "results", "abc"],
    ]) {
      const { d } = deps();
      let loads = 0;
      const real = loadTestCliConfig();
      d.loadConfig = () => {
        loads += 1;
        return real;
      };
      const handler = (config: CliConfig) => {
        expect(config.apiBaseUrl).toBe(real.apiBaseUrl);
        expect(config.credentialsPath).toBe(real.credentialsPath);
        return Promise.resolve(0);
      };
      d.feedback = handler;
      d.places = handler;
      d.flights = handler;
      expect(await run([...argv(), ...cmd], d)).toBe(0);
      expect(loads).toBe(1);
    }
  });

  it("a real call with no config still fails the way main() maps it, not inside the command", async () => {
    const { d, calls } = deps();
    d.loadConfig = () => {
      throw new Error("WEGO_API_URL is required for source usage");
    };
    for (const cmd of [
      ["flights", "results", "abc"],
      ["places", "dubai"],
      ["feedback", "--message", "x"],
    ]) {
      expect(run([...argv(), ...cmd], d)).rejects.toThrow(/WEGO_API_URL/);
    }
    expect(calls).toEqual([]);
  });

  for (const help of ["-h", "--help", "help"]) {
    it(`help ${help}: prints the root help, exit 0`, async () => {
      const { d, out, err } = deps();
      expect(await run([...argv("help"), help], d)).toBe(0);
      expect(out.join("")).toMatch(/^wego – Wego API CLI/);
      expect(err.length).toBe(0);
    });
  }

  it("help rejects a stray argument, exit 2", async () => {
    const { d, err } = deps();
    expect(await run([...argv("help"), "extra"], d)).toBe(2);
    expect(err.join("")).toMatch(/^Unexpected argument: extra\n/);
  });

  it("errors and exits 2 (usage) on an unknown command", async () => {
    const { d, err } = deps();
    expect(await run(argv("frobnicate"), d)).toBe(2); // EXIT.USAGE
    expect(err.join("")).toMatch(/Unknown command: frobnicate/);
  });

  it("dispatches skill with the raw args tail (no config)", async () => {
    const { d, calls } = deps();
    expect(await run([...argv("skill"), "install", "-y"], d)).toBe(0);
    expect(calls).toEqual(["skill:install -y"]);
  });

  it("dispatches telemetry with the raw args tail (no config)", async () => {
    const { d, calls } = deps();
    expect(await run([...argv("telemetry"), "disable"], d)).toBe(0);
    expect(calls).toEqual(["telemetry:disable"]);
  });

  it("dispatches config with the raw args tail (no config object – local file only)", async () => {
    const { d, calls } = deps();
    expect(await run([...argv("config"), "set", "currency", "SAR"], d)).toBe(0);
    expect(calls).toEqual(["config:set currency SAR"]);
  });

  it("dispatches a bare `config` (defaults to list inside the command)", async () => {
    const { d, calls } = deps();
    expect(await run([...argv("config")], d)).toBe(0);
    expect(calls).toEqual(["config:"]);
  });

  it("dispatches the hidden telemetry sender through the same seam", async () => {
    // The detached child re-enters here; it is deliberately absent from help.
    const { d, calls } = deps();
    expect(await run([...argv("send-telemetry"), '{"a":1}'], d)).toBe(0);
    expect(calls).toEqual(['sendTelemetry:{"a":1}']);
  });
});

describe("helpText", () => {
  const commands = [
    "login",
    "whoami",
    "logout",
    "places",
    "info",
    "flights",
    "hotels",
    "config",
    "feedback",
    "skill",
    "update",
    "uninstall",
    "telemetry",
    "version",
  ];

  it("is an index: names every command under any invoked name, no flag rows", () => {
    for (const prog of ["wego", "wego-linux-x64", "mywego"]) {
      const text = helpText(prog);
      for (const cmd of commands) {
        expect(text).toMatch(new RegExp(`^ {2}${cmd} `, "m"));
      }
      expect(text).toContain(`Run ${prog} <command> --help for flags.`);
      expect(text).not.toMatch(/^\s+--/m);
      expect(text).not.toContain("STAGING-TESTING");
      expect(text).not.toContain("send-telemetry");
    }
  });

  it("says Research Preview up front, and names the flavor's own feedback command", () => {
    expect(helpText("wego")).toContain(
      "wego – Wego API CLI (Research Preview)",
    );
    expect(helpText("wegostaging")).toContain("`wegostaging feedback`");
  });

  // The target axis is deliberately UNDOCUMENTED here. `--target` and
  // `WEGO_TARGET` still work — they are stripped before dispatch and resolved in
  // `target.ts` — but help is a public surface, and staging and local are
  // backends no public user can reach. Naming them there only invites a support
  // question about a product we do not offer. `src/target.test.ts` owns the
  // proof that the axis still resolves; this asserts only that help stays quiet
  // about it.
  it("keeps the run-time target axis out of help, and keeps the user controls in", () => {
    const text = helpText("wego");
    expect(text).not.toContain("--target");
    expect(text).not.toContain("WEGO_TARGET");
    expect(text).not.toContain("staging");
    expect(text).toContain("WEGO_CLI_TELEMETRY");
    expect(text).toContain("WEGO_CREDENTIALS_PATH");
  });
});

describe("buildRealDeps (real wiring, no network)", () => {
  it("wires commands that can run without a browser or network", async () => {
    const d = buildRealDeps();
    // Invalid source configuration fails before command wiring can start a
    // loopback server or make a network call.
    expect(() => loadTestCliConfig({ WEGO_CLI_CLIENT_ID: "" })).toThrow(
      /WEGO_CLI_CLIENT_ID/,
    );
    // whoami short-circuits when there are no stored credentials.
    expect(
      await d.whoami(
        loadTestCliConfig({
          WEGO_CREDENTIALS_PATH: "/nonexistent/dir/creds.json",
        }),
      ),
    ).toBe(3); // auth: not logged in
    // places with a query but no stored credentials short-circuits the same way.
    expect(
      await d.places(
        loadTestCliConfig({
          WEGO_CREDENTIALS_PATH: "/nonexistent/dir/creds.json",
        }),
        ["dubai"],
      ),
    ).toBe(3); // auth: not logged in
    // places with no query is a usage error before any network/credential work.
    expect(
      await d.places(
        loadTestCliConfig({
          WEGO_CREDENTIALS_PATH: "/nonexistent/dir/creds.json",
        }),
        [],
      ),
    ).toBe(2); // usage: missing query
    // skill `path` is a pure read of the wired deps (no fs write, no network).
    expect(await d.skill(["path"])).toBe(0);
    // logout just clears the (absent) file.
    expect(
      await d.logout(
        loadTestCliConfig({
          WEGO_CREDENTIALS_PATH: join(tmpdir(), "wego-logout-test.json"),
        }),
      ),
    ).toBe(0);
  });
});
