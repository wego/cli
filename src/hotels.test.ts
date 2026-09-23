import { describe, expect, it } from "bun:test";
import { parseRoomsArgs, settleRates } from "./commands";
import { HOTELS } from "./verticals";

/**
 * The pure pieces behind `wego hotels …`: the `/rates` settle loop, the `rooms`
 * argument parser, and the stderr note an empty results page earns. What a caller
 * sees from the binary (exit codes, stdout JSON, stderr, what reaches the wire) is
 * `integration/hotels.test.ts`.
 */

const RATE_ID = "sid-1:hotels.wego.com:85481:abc123:7";

describe("settleRates", () => {
  /** A scripted rates read (the last snapshot repeats) that counts its reads and
   *  the spacing it was asked to sleep. */
  function reads(
    snapshot: (n: number) => {
      searchComplete?: boolean;
      rates?: unknown[];
    },
  ) {
    let n = 0;
    const sleeps: number[] = [];
    return {
      read: () => Promise.resolve(snapshot(++n)),
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      count: () => n,
      sleeps,
    };
  }

  it("converges once a non-empty rate count holds for four reads, 1.5 s apart", async () => {
    const r = reads(() => ({ searchComplete: true, rates: [{ id: RATE_ID }] }));
    const { state, snapshot } = await settleRates(r.read, r.sleep);
    expect(state).toBe("converged");
    expect(snapshot.rates).toEqual([{ id: RATE_ID }]);
    expect(r.count()).toBe(4);
    expect(r.sleeps).toEqual([1500, 1500, 1500]);
  });

  it("keeps reading while the rate count grows, even past searchComplete:true", async () => {
    const one = [{ id: "r-1" }];
    const three = [{ id: "r-1" }, { id: "r-2" }, { id: RATE_ID }];
    const r = reads((n) => ({
      searchComplete: true,
      rates: n === 1 ? one : three,
    }));
    const { state, snapshot } = await settleRates(r.read, r.sleep);
    // 1 growing read + 4 steady reads at the full depth.
    expect(r.count()).toBe(5);
    expect(snapshot.rates).toHaveLength(3);
    expect(state).toBe("converged");
  });

  it("an empty page with searchComplete:true twice converges as the definitive no-rates", async () => {
    const r = reads(() => ({ searchComplete: true, rates: [] }));
    const { state } = await settleRates(r.read, r.sleep);
    expect(r.count()).toBe(2);
    expect(state).toBe("converged");
  });

  it("a slow starter is not declared empty: rates landing late still converge", async () => {
    const r = reads((n) => ({
      searchComplete: false,
      rates: n <= 3 ? [] : [{ id: RATE_ID }],
    }));
    const { state, snapshot } = await settleRates(r.read, r.sleep);
    // 3 empty reads + 4 steady non-empty reads.
    expect(r.count()).toBe(7);
    expect(snapshot.rates).toHaveLength(1);
    expect(state).toBe("converged");
  });

  it("spends the ten-read budget on a page that stays empty and incomplete", async () => {
    const r = reads(() => ({ searchComplete: false, rates: [] }));
    const { state } = await settleRates(r.read, r.sleep);
    expect(r.count()).toBe(10);
    expect(state).toBe("budget_exhausted");
  });
});

describe("parseRoomsArgs", () => {
  it("takes the dates as positionals, the same shape as `hotels search`", () => {
    const plan = parseRoomsArgs([
      "85481",
      "2099-03-01",
      "2099-03-05",
      "--adults",
      "3",
    ]);
    expect(plan.searchId).toBeUndefined();
    expect(plan.createBody).toMatchObject({
      hotelId: 85481,
      checkIn: "2099-03-01",
      checkOut: "2099-03-05",
      adults: 3,
    });
  });

  it("mints the identical create from the positional and the flag spelling", () => {
    expect(parseRoomsArgs(["85481", "2099-03-01", "2099-03-05"])).toEqual(
      parseRoomsArgs([
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ]),
    );
  });

  it("carries --children-ages onto the minted create", () => {
    const plan = parseRoomsArgs([
      "85481",
      "--check-in",
      "2099-03-01",
      "--check-out",
      "2099-03-05",
      "--children",
      "2",
      "--children-ages",
      "0,17",
    ]);
    expect(plan.createBody?.childrenAges).toEqual([0, 17]);
  });
});

describe("HOTELS empty-page note", () => {
  type Snapshot = Parameters<typeof HOTELS.searchNote>[0];
  const page = (
    searchComplete: boolean,
    metadata: Record<string, unknown>,
    results: unknown[] = [],
  ) => ({ searchId: "sid-1", searchComplete, results, metadata }) as Snapshot;

  it("an incomplete empty page says the search is still settling, and how to wait", () => {
    const note =
      "No hotels have settled yet – re-run: wego hotels results sid-1 --wait";
    expect(HOTELS.searchNote(page(false, {}), "sid-1")).toBe(note);
    // `results` phrases it the same, bare or `--wait`: the note keys off the page.
    expect(
      HOTELS.resultsNote(page(false, {}), "sid-1", "budget_exhausted", true),
    ).toBe(note);
  });

  it("reports an authoritative no-match on a completed zero-candidate search", () => {
    const note = HOTELS.searchNote(page(true, { totalCandidates: 0 }), "sid-1");
    expect(note).toContain("no hotels match");
    expect(note).not.toContain("No hotels have settled yet");
  });

  it("says the FILTERS emptied it, not that no hotels exist", () => {
    const note = HOTELS.searchNote(
      page(true, { totalCandidates: 0, totalBeforeFilters: 415 }),
      "sid-1",
    );
    expect(note).toContain("none of the 415 hotels found match these filters");
    expect(note).toContain("the filters excluded them");
  });

  it("claims no bookable inventory only when nothing survived the join", () => {
    expect(
      HOTELS.searchNote(
        page(true, { totalCandidates: 0, totalBeforeFilters: 0 }),
        "sid-1",
      ),
    ).toContain("no Book-on-Wego bookable hotels surfaced");
  });

  it("says nothing on a completed empty PAGE over existing candidates (paged past the end)", () => {
    expect(
      HOTELS.searchNote(page(true, { totalCandidates: 12 }), "sid-1"),
    ).toBeUndefined();
  });

  it("makes no no-match claim when the candidate count is missing", () => {
    // `api.ts` degrades a negative or fractional count to undefined (its own
    // tests), so this is the shape a malformed count reaches the note in.
    expect(HOTELS.searchNote(page(true, {}), "sid-1") ?? "").not.toContain(
      "no hotels match",
    );
  });

  it("says nothing when the page carries hotels", () => {
    expect(
      HOTELS.searchNote(page(false, {}, [{ hotelId: 1 }]), "sid-1"),
    ).toBeUndefined();
  });
});
