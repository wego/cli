import { describe, expect, it } from "bun:test";
import { EXIT } from "./error-report";
import { TELEMETRY_EVENT, TELEMETRY_SENDER_COMMAND } from "./telemetry";
import {
  postTelemetryEvent,
  runTelemetrySender,
  spawnTelemetrySender,
  type TelemetryPayload,
} from "./telemetry-send";

const KEY = "phc_testkeytestkeytestkeytestkeytest";

const event = (): TelemetryPayload => ({
  event: TELEMETRY_EVENT,
  distinct_id: "227935",
  timestamp: "2026-07-30T00:00:00.000Z",
  properties: { command: "whoami", exit_code: 0 },
});

/** A `fetch` stand-in that records every call and answers with `status`. */
function recordingFetch(status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("postTelemetryEvent", () => {
  it("posts to PostHog's capture endpoint with the key in the body", async () => {
    const f = recordingFetch();
    expect(
      await postTelemetryEvent(event(), { posthogKey: KEY, fetch: f.impl }),
    ).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("https://us.i.posthog.com/i/v0/e/");
    const body = JSON.parse(String(f.calls[0]?.init?.body));
    expect(body.api_key).toBe(KEY);
    expect(body.event).toBe(TELEMETRY_EVENT);
    expect(body.distinct_id).toBe("227935");
    expect(body.properties.command).toBe("whoami");
  });

  it("honors an injected host without doubling the slash", async () => {
    const f = recordingFetch();
    await postTelemetryEvent(event(), {
      posthogKey: KEY,
      host: "https://eu.i.posthog.com/",
      fetch: f.impl,
    });
    expect(f.calls[0]?.url).toBe("https://eu.i.posthog.com/i/v0/e/");
  });

  it("reports a non-ok response as a failure without throwing", async () => {
    const f = recordingFetch(500);
    expect(
      await postTelemetryEvent(event(), { posthogKey: KEY, fetch: f.impl }),
    ).toBe(false);
  });

  it("swallows a network failure – a firewalled endpoint must change nothing", async () => {
    const failing = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    expect(
      await postTelemetryEvent(event(), { posthogKey: KEY, fetch: failing }),
    ).toBe(false);
  });

  it("makes exactly one attempt, with no retry", async () => {
    const f = recordingFetch(503);
    await postTelemetryEvent(event(), { posthogKey: KEY, fetch: f.impl });
    expect(f.calls).toHaveLength(1);
  });
});

describe("runTelemetrySender", () => {
  it("posts the payload it was handed and always exits 0", async () => {
    const f = recordingFetch();
    expect(
      await runTelemetrySender([JSON.stringify(event())], {
        posthogKey: KEY,
        fetch: f.impl,
      }),
    ).toBe(EXIT.OK);
    expect(f.calls).toHaveLength(1);
  });

  it("sends nothing when no key is baked", async () => {
    const f = recordingFetch();
    expect(
      await runTelemetrySender([JSON.stringify(event())], { fetch: f.impl }),
    ).toBe(EXIT.OK);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ["no argument", undefined],
    ["unparseable JSON", "{not json"],
    ["a wrong event name", JSON.stringify({ ...event(), event: "other" })],
    ["a missing distinct_id", JSON.stringify({ ...event(), distinct_id: "" })],
  ])("rejects %s and still exits 0", async (_label, raw) => {
    const f = recordingFetch();
    const args = raw === undefined ? [] : [raw];
    expect(
      await runTelemetrySender(args, { posthogKey: KEY, fetch: f.impl }),
    ).toBe(EXIT.OK);
    expect(f.calls).toHaveLength(0);
  });
});

describe("runTelemetrySender (identity is not taken from argv)", () => {
  it("overrides a forged distinct_id and device_id with this machine's own", async () => {
    // Any local caller can run `wego send-telemetry '<payload>'`; without this
    // they could attribute events to someone else's account.
    const f = recordingFetch();
    const forged = JSON.stringify({
      ...event(),
      distinct_id: "999999",
      properties: { command: "login", device_id: "someone-elses-machine" },
    });
    expect(
      await runTelemetrySender([forged], {
        posthogKey: KEY,
        fetch: f.impl,
        resolveIdentity: async () => ({
          distinctId: "227935",
          deviceId: "my-machine",
        }),
      }),
    ).toBe(EXIT.OK);
    const body = JSON.parse(String(f.calls[0]?.init?.body));
    expect(body.distinct_id).toBe("227935");
    expect(body.properties.device_id).toBe("my-machine");
    // The command shape still comes from the payload; it is allowlisted upstream.
    expect(body.properties.command).toBe("login");
  });

  it("drops the anonymous marker when it re-resolves a logged-in identity", async () => {
    // The parent built this as logged-out; by the time the child ran, a uid was
    // available. Keeping the marker would suppress the person for a real account.
    const f = recordingFetch();
    const anonymous = JSON.stringify({
      ...event(),
      distinct_id: "dev-1",
      properties: { command: "login", $process_person_profile: false },
    });
    await runTelemetrySender([anonymous], {
      posthogKey: KEY,
      fetch: f.impl,
      resolveIdentity: async () => ({
        distinctId: "227935",
        deviceId: "dev-1",
      }),
    });
    const body = JSON.parse(String(f.calls[0]?.init?.body));
    expect(body.distinct_id).toBe("227935");
    expect(body.properties.$process_person_profile).toBeUndefined();
  });

  it("adds the anonymous marker when it re-resolves a logged-out identity", async () => {
    const f = recordingFetch();
    await runTelemetrySender([JSON.stringify(event())], {
      posthogKey: KEY,
      fetch: f.impl,
      resolveIdentity: async () => ({
        distinctId: "dev-1",
        deviceId: "dev-1",
      }),
    });
    const body = JSON.parse(String(f.calls[0]?.init?.body));
    expect(body.distinct_id).toBe("dev-1");
    expect(body.properties.$process_person_profile).toBe(false);
  });

  it("still posts when identity cannot be resolved", async () => {
    const f = recordingFetch();
    await runTelemetrySender([JSON.stringify(event())], {
      posthogKey: KEY,
      fetch: f.impl,
      resolveIdentity: async () => {
        throw new Error("EACCES");
      },
    });
    expect(f.calls).toHaveLength(1);
  });
});

describe("spawnTelemetrySender", () => {
  /** A spawn stand-in recording argv, what was written to stdin, and unrefs. */
  function recordingSpawn() {
    const commands: string[][] = [];
    const written: string[] = [];
    let ended = 0;
    let unrefs = 0;
    const spawn = (command: string[]) => {
      commands.push(command);
      return {
        stdin: {
          write: (d: string) => written.push(d),
          end: () => ended++,
        },
        unref: () => unrefs++,
      };
    };
    return {
      spawn,
      commands,
      written,
      ended: () => ended,
      unrefs: () => unrefs,
    };
  }

  it("re-spawns this binary with the hidden subcommand and no payload in argv", async () => {
    const r = recordingSpawn();
    await spawnTelemetrySender("{}", {
      execPath: "/usr/local/bin/wego",
      spawn: r.spawn,
    });
    expect(r.commands).toEqual([
      ["/usr/local/bin/wego", TELEMETRY_SENDER_COMMAND],
    ]);
  });

  it("passes the payload down stdin, and flushes it", async () => {
    // argv is world-readable via `ps`; the payload carries distinct_id.
    const r = recordingSpawn();
    const payload = JSON.stringify(event());
    await spawnTelemetrySender(payload, {
      execPath: "/usr/local/bin/wego",
      spawn: r.spawn,
    });
    expect(r.written).toEqual([payload]);
    expect(r.ended()).toBe(1);
    expect(r.commands.flat().join(" ")).not.toContain("distinct_id");
  });

  it("never puts the key in the child's arguments", async () => {
    const r = recordingSpawn();
    await spawnTelemetrySender(JSON.stringify(event()), {
      execPath: "/usr/local/bin/wego",
      spawn: r.spawn,
    });
    expect(r.commands.flat().join(" ")).not.toContain("phc_");
  });

  it("unrefs the child, so the parent can exit without waiting", async () => {
    const r = recordingSpawn();
    await spawnTelemetrySender("{}", {
      execPath: "/usr/local/bin/wego",
      spawn: r.spawn,
    });
    expect(r.unrefs()).toBe(1);
  });

  it("swallows a spawn failure – telemetry must never fail the real command", async () => {
    await expect(
      spawnTelemetrySender("{}", {
        execPath: "/usr/local/bin/wego",
        spawn: () => {
          throw new Error("ENOENT");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("reads the payload from stdin when argv carries none", async () => {
    const f = recordingFetch();
    expect(
      await runTelemetrySender([], {
        posthogKey: KEY,
        fetch: f.impl,
        readStdin: async () => JSON.stringify(event()),
      }),
    ).toBe(EXIT.OK);
    expect(f.calls).toHaveLength(1);
  });

  it("sends nothing when stdin is empty or unreadable", async () => {
    const f = recordingFetch();
    await runTelemetrySender([], {
      posthogKey: KEY,
      fetch: f.impl,
      readStdin: async () => "",
    });
    await runTelemetrySender([], {
      posthogKey: KEY,
      fetch: f.impl,
      readStdin: async () => {
        throw new Error("EPIPE");
      },
    });
    expect(f.calls).toHaveLength(0);
  });
});
