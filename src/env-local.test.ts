import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourceEnvLocal, parseDotenv } from "./env-local";

describe("parseDotenv", () => {
  it("parses KEY=VALUE, skipping comments and blanks", () => {
    expect(parseDotenv("# comment\n\nA=1\nB=two\n")).toEqual({
      A: "1",
      B: "two",
    });
  });

  it("strips an optional `export ` and surrounding quotes", () => {
    expect(parseDotenv(`export A="x y"\nB='z'\n`)).toEqual({
      A: "x y",
      B: "z",
    });
  });

  it("keeps `=` and URLs in the value intact", () => {
    expect(
      parseDotenv("URL=https://auth.wegostaging.com/oauth?a=b&c=d\n").URL,
    ).toBe("https://auth.wegostaging.com/oauth?a=b&c=d");
  });

  it("ignores malformed keys and value-less lines", () => {
    expect(parseDotenv("1BAD=x\nNOEQUALS\n=novalue\nOK=1\n")).toEqual({
      OK: "1",
    });
  });
});

describe("loadSourceEnvLocal", () => {
  function withTempEnvFile(contents: string, fn: (path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "wego-envlocal-"));
    const path = join(dir, ".env.local");
    writeFileSync(path, contents);
    try {
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("no-ops when the file is absent (compiled-binary case)", () => {
    const env: Record<string, string | undefined> = {};
    const res = loadSourceEnvLocal(
      join(tmpdir(), "definitely-missing", ".env.local"),
      env,
    );
    expect(res.loaded).toBe(false);
    expect(res.keys).toEqual([]);
    expect(env).toEqual({});
  });

  it("applies absent keys from the file", () => {
    withTempEnvFile(
      "WEGO_CLI_CLIENT_ID=abc\nWEGO_API_URL=http://localhost:3001\n",
      (path) => {
        const env: Record<string, string | undefined> = {};
        const res = loadSourceEnvLocal(path, env);
        expect(res.loaded).toBe(true);
        expect(env.WEGO_CLI_CLIENT_ID).toBe("abc");
        expect(env.WEGO_API_URL).toBe("http://localhost:3001");
        expect(res.keys.sort()).toEqual(["WEGO_API_URL", "WEGO_CLI_CLIENT_ID"]);
      },
    );
  });

  it("never overwrites an already-set key (real env / direnv wins)", () => {
    withTempEnvFile("WEGO_API_URL=http://localhost:3001\n", (path) => {
      const env: Record<string, string | undefined> = {
        WEGO_API_URL: "https://api.wegostaging.com",
      };
      const res = loadSourceEnvLocal(path, env);
      expect(env.WEGO_API_URL).toBe("https://api.wegostaging.com");
      expect(res.keys).toEqual([]);
    });
  });
});
