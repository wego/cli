import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthFailureRecord,
  buildAuthFailureRecord,
  recordAuthFailure,
} from "./auth-failure";
import { parseTokenError, TokenEndpointError } from "./oauth";

const NOW = new Date("2026-08-05T00:00:00.000Z");

describe("buildAuthFailureRecord", () => {
  it("copies the auth server's status + OAuth2 fields from a TokenEndpointError", () => {
    const err = parseTokenError(
      400,
      "Bad Request",
      JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
    );
    const record = buildAuthFailureRecord(err, "Not authenticated: …", NOW);
    expect(record).toEqual({
      at: "2026-08-05T00:00:00.000Z",
      grantType: "refresh_token",
      message: "Not authenticated: …",
      status: 400,
      statusText: "Bad Request",
      error: "invalid_grant",
      errorDescription: "revoked",
      bodySnippet: undefined,
    });
  });

  it("carries a non-OAuth2 body snippet through for the record", () => {
    const err = parseTokenError(502, "Bad Gateway", "<html>portal</html>");
    const record = buildAuthFailureRecord(err, "msg", NOW);
    expect(record.error).toBeUndefined();
    expect(record.bodySnippet).toBe("<html>portal</html>");
    expect(record.status).toBe(502);
  });

  it("records only the message for a non-HTTP error (network / timeout)", () => {
    const record = buildAuthFailureRecord(
      new TypeError("Unable to connect"),
      "Not authenticated: Unable to connect. Run `wego login`.",
      NOW,
    );
    expect(record).toEqual({
      at: "2026-08-05T00:00:00.000Z",
      grantType: "refresh_token",
      message: "Not authenticated: Unable to connect. Run `wego login`.",
    });
    expect(record.status).toBeUndefined();
  });

  it("never captures a refresh token — only a fixed set of non-secret keys", () => {
    const err = new TokenEndpointError({
      status: 400,
      statusText: "Bad Request",
      oauthError: "invalid_grant",
    });
    const record = buildAuthFailureRecord(err, "msg", NOW);
    // The builder takes no token argument, so a token cannot enter the record
    // by construction; assert the on-disk key set to keep that guarantee visible.
    const onDisk = JSON.parse(JSON.stringify(record));
    expect(Object.keys(onDisk).sort()).toEqual(
      ["at", "error", "grantType", "message", "status", "statusText"].sort(),
    );
  });
});

describe("recordAuthFailure", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wego-authfail-"));
    path = join(dir, "sub", "last-auth-failure.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const record: AuthFailureRecord = {
    at: NOW.toISOString(),
    grantType: "refresh_token",
    status: 400,
    error: "invalid_grant",
    message: "Not authenticated: …",
  };

  it("writes the record as 0600 JSON, creating the owner-only dir", async () => {
    await recordAuthFailure(path, record);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk).toMatchObject({ error: "invalid_grant", status: 400 });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("overwrites the single record on a second failure", async () => {
    await recordAuthFailure(path, record);
    await recordAuthFailure(path, { ...record, error: "invalid_client" });
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.error).toBe("invalid_client");
  });
});
