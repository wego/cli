import { describe, expect, it } from "bun:test";
import type { HotelsDeps } from "./commands";
import type { CliConfig } from "./config";
import {
  type Created,
  DEFAULT_SETTLE_BUDGET,
  type Engine,
  type EngineDeps,
  type EngineOutcome,
  runResults,
  runSearch,
  type SearchVertical,
  type SettleBudget,
  type SettleSignals,
  settle,
} from "./search-engine";
import { FLIGHTS, HOTELS } from "./verticals";

const noSleep = () => Promise.resolve();

/** A scripted sequence of snapshots (the last repeats) that counts reads. */
function sequence<S>(snapshots: S[]): {
  read: () => Promise<S>;
  reads: () => number;
} {
  let reads = 0;
  return {
    read: () => {
      const s = snapshots[Math.min(reads, snapshots.length - 1)];
      reads++;
      return Promise.resolve(s);
    },
    reads: () => reads,
  };
}

type CountSnap = {
  count?: number;
  items?: boolean;
  complete?: boolean;
  /** Items in the raw snapshot, before filter/sort/page, which a real vertical
   *  reads from a pre-filter metadata count. */
  snapshotItems?: boolean;
};

const COUNT_SIGNALS: SettleSignals<CountSnap> = {
  count: (s) => s.count,
  hasItems: (s) => s.items === true,
  isComplete: (s) => s.complete === true,
};

/** Signals for a vertical that distinguishes the raw snapshot from the filtered
 *  page, as flights does when `snapshotTripCount` is present. */
const CANDIDATE_SIGNALS: SettleSignals<CountSnap> = {
  ...COUNT_SIGNALS,
  hasSnapshotItems: (s) => s.snapshotItems === true,
};

const FAST_BUDGET: SettleBudget = {
  maxRereads: 4,
  baseDelayMs: 1,
  maxDelayMs: 1,
};

describe("settle", () => {
  it("converges on an authoritative isComplete (hotels-style terminal)", async () => {
    const seq = sequence<CountSnap>([{ complete: true }]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("converged");
    expect(seq.reads()).toBe(1);
  });

  it("converges when a non-zero count holds equal across two reads", async () => {
    const seq = sequence<CountSnap>([
      { count: 0 },
      { count: 3, items: true },
      { count: 3, items: true },
    ]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("converged");
    expect(out.snapshot.count).toBe(3);
    expect(seq.reads()).toBe(3);
  });

  it("a transient count drop resets the baseline – never converges on a decrease", async () => {
    const seq = sequence<CountSnap>([
      { count: 0 },
      { count: 12, items: true },
      { count: 10, items: true },
      { count: 10, items: true },
    ]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("converged");
    expect(out.snapshot.count).toBe(10);
    expect(seq.reads()).toBe(4); // only after 10 == 10, not at 12 → 10
  });

  it("a stable non-zero count over an empty page rides to budget_exhausted", async () => {
    // Real shape: a one-fare snapshot at offset=1 returns count:1 with fares:[].
    const seq = sequence<CountSnap>([{ count: 1 }]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("budget_exhausted");
    expect(seq.reads()).toBe(1 + FAST_BUDGET.maxRereads);
  });

  it("converges on an empty page when the SNAPSHOT holds items (filter matched nothing)", async () => {
    // `--booking-types wego` on a BoW-less route, or `--page 20` past the end.
    const seq = sequence<CountSnap>([
      { count: 5000, items: false, snapshotItems: true },
    ]);
    const out = await settle(seq.read, CANDIDATE_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("converged");
    expect(seq.reads()).toBe(2); // needed one re-read to see the count hold
  });

  it("keeps polling an empty page when the SNAPSHOT is empty too (cold search)", async () => {
    const seq = sequence<CountSnap>([
      { count: 1, items: false, snapshotItems: false },
    ]);
    const out = await settle(seq.read, CANDIDATE_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("budget_exhausted");
    expect(seq.reads()).toBe(1 + FAST_BUDGET.maxRereads);
  });

  it("an authoritative isComplete terminates once the count confirms", async () => {
    const seq = sequence<CountSnap>([
      { count: 7, complete: true },
      { count: 7, complete: true },
    ]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("converged");
    expect(seq.reads()).toBe(2);
  });

  it("an authoritative isComplete still terminates on an empty page", async () => {
    // complete + steady zero count is the authoritative no-inventory
    const seq = sequence<CountSnap>([
      { count: 0, complete: true, items: false, snapshotItems: false },
      { count: 0, complete: true, items: false, snapshotItems: false },
    ]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("converged");
    expect(seq.reads()).toBe(2);
  });

  it("falls back to item-presence when the count is absent (flights card / legacy)", async () => {
    const seq = sequence<CountSnap>([{ items: false }, { items: true }]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("converged");
    expect(seq.reads()).toBe(2);
  });

  it("exhausts the budget when the count never stabilizes (1 + maxRereads reads)", async () => {
    const seq = sequence<CountSnap>([
      { count: 1 },
      { count: 2 },
      { count: 3 },
      { count: 4 },
      { count: 5 },
      { count: 6 },
      { count: 7 },
    ]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("budget_exhausted");
    expect(seq.reads()).toBe(1 + FAST_BUDGET.maxRereads);
  });

  it("a stable-at-zero count is 'still accruing', not converged", async () => {
    const seq = sequence<CountSnap>([{ count: 0 }]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("budget_exhausted");
  });

  it("backs off on the documented rising delay, capped at maxDelayMs", async () => {
    // Every other test injects a no-op sleep, so only this one catches a
    // constant, uncapped or off-by-one delay schedule.
    const waits: number[] = [];
    const recordSleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    let n = 0;
    const read = () => Promise.resolve<CountSnap>({ count: ++n }); // never stable
    const out = await settle(
      read,
      COUNT_SIGNALS,
      DEFAULT_SETTLE_BUDGET,
      recordSleep,
    );
    expect(out.state).toBe("budget_exhausted");
    expect(waits.length).toBe(DEFAULT_SETTLE_BUDGET.maxRereads);
    expect(waits.slice(0, 4)).toEqual([300, 600, 900, 1200]);
    // (reread+1)·300 reaches 3000 at reread 9.
    expect(waits[9]).toBe(3000);
    expect(waits[10]).toBe(3000);
    expect(waits[11]).toBe(3000);
    expect(Math.max(...waits)).toBe(DEFAULT_SETTLE_BUDGET.maxDelayMs);
  });

  it("isComplete does not terminate while the count still moves", async () => {
    const seq = sequence<CountSnap>([
      { complete: true, count: 5 },
      { complete: true, count: 9 },
      { complete: true, count: 9 },
    ]);
    const out = await settle(seq.read, COUNT_SIGNALS, FAST_BUDGET, noSleep);
    expect(out.state).toBe("converged");
    expect(out.snapshot.count).toBe(9);
    expect(seq.reads()).toBe(3);
  });
});

describe("vertical signals (the flights↔hotels difference)", () => {
  it("HOTELS supplies the optional completion capability", () => {
    const complete = {
      searchComplete: true,
      metadata: { totalCandidates: 0 },
      results: [],
    };
    expect(HOTELS.signals.isComplete?.(complete)).toBe(true);
    expect(
      HOTELS.signals.isComplete?.({
        searchComplete: false,
        metadata: {},
        results: [],
      }),
    ).toBe(false);
    expect(
      HOTELS.signals.count({ metadata: { snapshotCandidateCount: 7 } }),
    ).toBe(7);
  });

  it("FLIGHTS explains an empty page by whether the SNAPSHOT holds trips", () => {
    const meta = (snapshotTripCount: number) => ({
      page: 1,
      pageSize: 10,
      resultCount: 0,
      totalCandidates: 0,
      hasMore: false,
      snapshotFareCount: 5000,
      snapshotTripCount,
    });
    const snap = (snapshotTripCount: number) => ({
      searchId: "s",
      currencyCode: "USD",
      metadata: meta(snapshotTripCount),
      results: [],
    });
    expect(FLIGHTS.searchNote(snap(4364), "S1")).toMatch(
      /none match these filters/,
    );
    expect(FLIGHTS.searchNote(snap(0), "S1")).toMatch(/have settled yet/);
  });

  it("FLIGHTS omits the completion capability (no way to ask 'is it complete?')", () => {
    expect(FLIGHTS.signals.isComplete).toBeUndefined();
    const meta = {
      page: 1,
      pageSize: 10,
      resultCount: 0,
      totalCandidates: 0,
      hasMore: false,
    };
    expect(
      FLIGHTS.signals.count({
        searchId: "s",
        currencyCode: "USD",
        metadata: { ...meta, snapshotFareCount: 4 },
        results: [],
      }),
    ).toBe(4);
    expect(
      FLIGHTS.signals.count({
        searchId: "s",
        currencyCode: "USD",
        metadata: meta,
        results: [],
      }),
    ).toBeUndefined();
  });
});

// --- runSearch / runResults with a fake engine + vertical -------------------

type FakeSnap = { results: unknown[]; count?: number };

interface FakeDeps extends EngineDeps {
  out: string[];
  err: string[];
}

function fakeEngine(): { eng: Engine<FakeDeps>; deps: FakeDeps } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: FakeDeps = {
    out,
    err,
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    sleep: noSleep,
  };
  return {
    deps,
    eng: {
      config: { apiBaseUrl: "http://x" } as unknown as CliConfig,
      deps,
      withAccessToken: async (call) => ({
        ok: true,
        value: await call("tok", undefined),
      }),
    },
  };
}

function fakeVertical(
  snapshots: FakeSnap[],
): SearchVertical<FakeSnap, undefined, undefined, FakeDeps> {
  const seq = sequence(snapshots);
  return {
    signals: {
      count: (s) => s.count,
      hasItems: (s) => s.results.length > 0,
    },
    create: (): Promise<EngineOutcome<Created<undefined>>> =>
      Promise.resolve({
        ok: true,
        value: {
          searchId: "sid",
          extra: { echoed: true },
          readQuery: undefined,
        },
      }),
    readAfterCreate: seq.read,
    readResults: seq.read,
    searchNote: (s) => (s.results.length === 0 ? "empty-search" : undefined),
    resultsNote: (_s, _id, state, wait) =>
      wait && state === "budget_exhausted" ? "still-accruing" : undefined,
    createdRecoveryHint: () => undefined,
  };
}

describe("runSearch", () => {
  it("blocks to settled, stamps `settled`, and merges the create's extra fields", async () => {
    const { eng, deps } = fakeEngine();
    const code = await runSearch(
      fakeVertical([
        { results: [], count: 0 },
        { results: [{}], count: 2 },
        { results: [{}], count: 2 },
      ]),
      undefined,
      FAST_BUDGET,
      eng,
    );
    expect(code).toBe(0);
    const printed = JSON.parse(deps.out[0]) as {
      settled: string;
      echoed: boolean;
    };
    expect(printed.settled).toBe("converged");
    expect(printed.echoed).toBe(true);
    expect(deps.err).toHaveLength(0);
  });

  it("emits the vertical's empty-page note when the settled page is empty", async () => {
    const { eng, deps } = fakeEngine();
    await runSearch(
      fakeVertical([{ results: [], count: 0 }]),
      undefined,
      FAST_BUDGET,
      eng,
    );
    expect(deps.err).toContain("empty-search");
  });
});

describe("runResults", () => {
  it("a bare read is one snapshot stamped `unsettled`", async () => {
    const { eng, deps } = fakeEngine();
    const seq = sequence<FakeSnap>([
      { results: [{}], count: 1 },
      { results: [{}], count: 1 },
    ]);
    let reads = 0;
    const vertical = {
      ...fakeVertical([]),
      readResults: () => {
        reads++;
        return seq.read();
      },
    };
    await runResults(vertical, "sid", undefined, false, FAST_BUDGET, eng);
    expect(reads).toBe(1);
    expect((JSON.parse(deps.out[0]) as { settled: string }).settled).toBe(
      "unsettled",
    );
  });

  it("--wait settles and stamps the terminal state", async () => {
    const { eng, deps } = fakeEngine();
    await runResults(
      fakeVertical([
        { results: [{}], count: 3 },
        { results: [{}], count: 3 },
      ]),
      "sid",
      undefined,
      true,
      FAST_BUDGET,
      eng,
    );
    expect((JSON.parse(deps.out[0]) as { settled: string }).settled).toBe(
      "converged",
    );
  });

  it("--wait budget_exhausted triggers the vertical's results note", async () => {
    const { eng, deps } = fakeEngine();
    await runResults(
      fakeVertical([
        { results: [], count: 1 },
        { results: [], count: 2 },
        { results: [], count: 3 },
        { results: [], count: 4 },
        { results: [], count: 5 },
        { results: [], count: 6 },
      ]),
      "sid",
      undefined,
      true,
      FAST_BUDGET,
      eng,
    );
    expect(deps.err).toContain("still-accruing");
  });

  it("propagates the exit code when the authed read fails", async () => {
    const { deps } = fakeEngine();
    const eng: Engine<FakeDeps> = {
      config: { apiBaseUrl: "http://x" } as unknown as CliConfig,
      deps,
      withAccessToken: async () => ({ ok: false, code: 4 }),
    };
    const code = await runResults(
      fakeVertical([{ results: [] }]),
      "sid",
      undefined,
      false,
      FAST_BUDGET,
      eng,
    );
    expect(code).toBe(4);
    expect(deps.out).toHaveLength(0);
  });
});

describe("HOTELS.create", () => {
  it("surfaces the create's echoed occupancy + resolved site pair in `extra`", async () => {
    const deps = {
      log: () => {},
      error: () => {},
      sleep: noSleep,
      loadSettings: async () => ({}),
      createHotelSearch: () =>
        Promise.resolve({
          searchId: "h1",
          occupancy: { adults: 2, childrenAges: [11], rooms: 1 },
          siteCode: "AE",
          siteCodeSource: "explicit" as const,
        }),
    } as unknown as HotelsDeps;
    const eng: Engine<HotelsDeps> = {
      config: { apiBaseUrl: "http://x" } as unknown as CliConfig,
      deps,
      withAccessToken: async (call) => ({
        ok: true,
        // Market "AE" from the id_token, no explicit --site → source "account".
        value: await call("tok", "AE"),
      }),
    };
    const created = await HOTELS.create(eng, {
      checkIn: "2099-01-01",
      checkOut: "2099-01-02",
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.searchId).toBe("h1");
      expect(created.value.extra).toEqual({
        // No flag and no stored currency, so the API's USD default decides.
        currencyCodeSource: "default",
        occupancy: { adults: 2, childrenAges: [11], rooms: 1 },
        siteCode: "AE",
        siteCodeSource: "account",
      });
    }
  });
});

describe("DEFAULT_SETTLE_BUDGET", () => {
  it("is the one shared 12 / 300ms / 3s budget (issue #1084 decision)", () => {
    expect(DEFAULT_SETTLE_BUDGET).toEqual({
      maxRereads: 12,
      baseDelayMs: 300,
      maxDelayMs: 3000,
    });
  });
});
