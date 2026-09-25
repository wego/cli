import { describe, expect, it } from "bun:test";
import { openBrowser, openCommand, type SpawnFn } from "./browser";

const URL_WITH_AMP =
  "https://auth.wego.com/authorize?response_type=code&client_id=x&redirect_uri=y";

describe("openBrowser", () => {
  it("spawns the platform opener without throwing (best-effort)", () => {
    // A fake spawn keeps the test from opening a real browser tab.
    const child = { on: () => child, unref: () => {} };
    const spawnFn: SpawnFn = () => child;
    expect(() =>
      openBrowser("https://example.com/login", spawnFn),
    ).not.toThrow();
  });

  it("swallows a spawn throw (missing launcher) – degrades to copy-paste", () => {
    // A synchronous spawn failure must not propagate; the URL is printed too.
    const spawnFn: SpawnFn = () => {
      throw new Error("no launcher");
    };
    expect(() =>
      openBrowser("https://example.com/login", spawnFn),
    ).not.toThrow();
  });
});

describe("openCommand", () => {
  it("opens via rundll32 on win32 (no cmd shell parsing of & or %)", () => {
    // rundll32's URL handler takes the URL as a literal argv, so the `&`
    // separators and the percent-encoded redirect_uri survive intact.
    const [cmd, args] = openCommand(
      "win32",
      "https://auth.wego.com/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1",
    );
    expect(cmd).toBe("rundll32");
    expect(args).toEqual([
      "url.dll,FileProtocolHandler",
      "https://auth.wego.com/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1",
    ]);
  });

  it("passes the URL verbatim to the POSIX opener", () => {
    expect(openCommand("darwin", URL_WITH_AMP)).toEqual([
      "open",
      [URL_WITH_AMP],
    ]);
    expect(openCommand("linux", URL_WITH_AMP)).toEqual([
      "xdg-open",
      [URL_WITH_AMP],
    ]);
  });
});
