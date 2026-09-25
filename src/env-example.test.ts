import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertSecureUrl,
  CLI_ENV_VARS,
  loadCliConfig,
  requireClientId,
} from "./config";
import { parseDotenv } from "./env-local";

/**
 * Env keys declared in a dotenv-style file, active (`KEY=…`) or commented
 * (`# KEY=…`), since a typo in a commented example var is just as misleading.
 * Anchored at line start so an inline comment (e.g. a URL after the value)
 * never matches.
 */
function declaredEnvKeys(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.match(/^#?\s*([A-Z][A-Z0-9_]+)\s*=/)?.[1])
    .filter((key): key is string => key !== undefined);
}

function activeEnv(path: string): Map<string, string> {
  return new Map(
    readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.match(/^([A-Z][A-Z0-9_]+)\s*=\s*(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1], match[2]]),
  );
}

describe(".env.local.example", () => {
  it("declares only env vars loadCliConfig recognizes (typo guard)", () => {
    const recognized = new Set<string>(CLI_ENV_VARS);
    const unknown = declaredEnvKeys(
      join(import.meta.dir, "..", ".env.local.example"),
    ).filter((key) => !recognized.has(key));
    expect(unknown).toEqual([]);
  });

  it("provides every public value needed by the source CLI runtime", () => {
    const env = activeEnv(join(import.meta.dir, "..", ".env.local.example"));
    for (const key of [
      "WEGO_AUTH_AUTHORIZE_URL",
      "WEGO_AUTH_TOKEN_URL",
      "WEGO_CLI_CLIENT_ID",
      "WEGO_API_URL",
      "WEGO_CLI_SCOPES",
    ]) {
      expect(env.get(key), `${key} must be active and non-empty`).toBeTruthy();
    }

    const config = loadCliConfig(Object.fromEntries(env));
    assertSecureUrl(config.authorizeUrl, "WEGO_AUTH_AUTHORIZE_URL");
    assertSecureUrl(config.tokenUrl, "WEGO_AUTH_TOKEN_URL");
    assertSecureUrl(config.apiBaseUrl, "WEGO_API_URL");
    expect(requireClientId(config)).toBe(config.clientId);
  });

  // The template declares the optional vars explicitly, so a straight `cp`
  // leaves nothing behind a hidden default. Each literal is bound to its code
  // default so the template cannot drift from `loadCliConfig`. `redirectPort` is
  // compared as a string because the example is dotenv text ("0") while the
  // parsed config is a number (0).
  it("declares the explicit optionals equal to their code defaults (doc/code binding)", () => {
    const active = parseDotenv(
      readFileSync(join(import.meta.dir, "..", ".env.local.example"), "utf8"),
    );
    const requiredEnv = { ...active };
    delete requiredEnv.WEGO_CLI_SCOPES;
    delete requiredEnv.WEGO_CLI_REDIRECT_PATH;
    delete requiredEnv.WEGO_CLI_REDIRECT_PORT;
    const codeDefaults = loadCliConfig(requiredEnv, {});
    expect(active.WEGO_CLI_SCOPES).toBe(codeDefaults.scopes);
    expect(active.WEGO_CLI_REDIRECT_PATH).toBe(codeDefaults.redirectPath);
    expect(active.WEGO_CLI_REDIRECT_PORT).toBe(
      String(codeDefaults.redirectPort),
    );
  });
});
