/**
 * The entrypoint: version, help, dispatch errors, and help that works with no
 * backend configured at all.
 */

import { describe, expect, it } from "bun:test";
import { useScenario } from "./harness/scenario";
import { makeHome, wego } from "./harness/wego";

const s = useScenario();

/** A release binary bakes the prod endpoints, so "no backend" only exists for an
 *  unbaked one; that is what a source run and a pull request's build are. */
const baked = await (async () => {
  const home = makeHome();
  try {
    return (await wego(["version"], { home })).out.trim() !== "0.0.0-dev";
  } finally {
    home.cleanup();
  }
})();

/** No endpoint at all: what a source run with no `.env.local` has. */
const NO_BACKEND = {
  WEGO_API_URL: "",
  WEGO_AUTH_AUTHORIZE_URL: "",
  WEGO_AUTH_TOKEN_URL: "",
  WEGO_CLI_CLIENT_ID: "",
};

describe("the entrypoint", () => {
  it("prints the version as semver on stdout", async () => {
    const result = await s.run(["version"]);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  for (const args of [[], ["help"], ["-h"], ["--help"]]) {
    it(`prints the root help for \`wego ${args.join(" ")}\`: stdout, exit 0`, async () => {
      const result = await s.run(args);
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/Usage:/);
      expect(result.err).toBe("");
    });
  }

  for (const help of ["-h", "--help", "help"]) {
    it(`help ${help}: prints the root help, exit 0`, async () => {
      const result = await s.run(["help", help]);
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/^wego – Wego API CLI/);
      expect(result.err).toBe("");
    });
  }

  it("help rejects a stray argument, exit 2", async () => {
    const result = await s.run(["help", "extra"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/^Unexpected argument: extra\n/);
  });

  it("exits 2 on an unknown command and names it", async () => {
    const result = await s.run(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/Unknown command: frobnicate/);
  });

  for (const cmd of ["login", "whoami", "logout", "version"]) {
    for (const help of ["--help", "-h", "help"]) {
      it(`${cmd} ${help}: its own usage on stdout, exit 0, nothing run`, async () => {
        const fake = s.fake();
        const result = await s.run([cmd, help]);
        expect(result.code).toBe(0);
        expect(result.out).toMatch(new RegExp(`^Usage: wego ${cmd}`));
        expect(result.err).toBe("");
        expect(fake.seen).toEqual([]);
        expect(fake.tokenRequests).toEqual([]);
      });
    }
  }

  for (const cmd of ["whoami", "logout", "version"]) {
    it(`${cmd} rejects an unknown flag with its usage, exit 2`, async () => {
      const fake = s.fake();
      const result = await s.run([cmd, "--frobnicate"]);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(
        new RegExp(`^Unknown option: --frobnicate\\nUsage: wego ${cmd}`),
      );
      expect(fake.seen).toEqual([]);
    });
  }

  it("answers every --help with no backend configured", async () => {
    for (const args of [
      ["flights", "--help"],
      ["flights", "results", "--help"],
      ["hotels", "rooms", "-h"],
      ["info", "holidays", "help"],
      ["places", "--help"],
      ["feedback", "--help"],
      // The ways out of a bad install must answer even when nothing else can.
      ["update", "--help"],
      ["uninstall", "--help"],
      ["skill", "--help"],
    ]) {
      const result = await s.run(args, { env: NO_BACKEND });
      expect({ args, code: result.code }).toEqual({ args, code: 0 });
      expect(result.out).toMatch(/Usage:/);
    }
  });

  it("lists the skill's installs with no backend configured", async () => {
    const result = await s.run(["skill", "list"], { env: NO_BACKEND });
    expect(result.code).toBe(0);
    expect(result.err).not.toMatch(/is required for source usage/);
  });

  it.skipIf(baked)(
    "reads a flag value that happens to be `help` as a value, not a help request",
    async () => {
      // `--locale help` asks for the locale "help"; it must reach the config load
      // (and fail there, with no backend), not print usage.
      const result = await s.run(["places", "--locale", "help", "dubai"], {
        env: NO_BACKEND,
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toBe("");
      expect(result.err).toMatch(/is required for source usage/);
    },
  );

  it.skipIf(baked)(
    "fails a real call with no backend configured, naming what is missing",
    async () => {
      for (const args of [
        ["flights", "results", "abc"],
        ["places", "dubai"],
        ["feedback", "--message", "x"],
      ]) {
        const result = await s.run(args, { env: NO_BACKEND });
        expect(result.code).not.toBe(0);
        expect(result.out).toBe("");
        expect(result.err).toMatch(/is required for source usage/);
      }
    },
  );
});
