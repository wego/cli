/**
 * Per-scenario setup: a fresh home, the fakes it starts, and one check at the end
 * that neither side broke the contract and nothing unexpected was requested.
 */

import { afterEach, beforeEach, expect } from "bun:test";
import { type Fake, type FakeOptions, startFake } from "./fake";
import {
  type CliResult,
  type Home,
  makeHome,
  type RunOptions,
  wego,
} from "./wego";

export interface Scenario {
  readonly home: Home;
  /** Start the fake this scenario's binary talks to. */
  fake: (options?: FakeOptions) => Fake;
  /** Run the binary against the last fake started (or none). */
  run: (
    args: string[],
    opts?: Omit<RunOptions, "home" | "fake">,
  ) => Promise<CliResult>;
}

export function useScenario(): Scenario {
  let home: Home | undefined;
  let fakes: Fake[] = [];
  beforeEach(() => {
    home = makeHome();
    fakes = [];
  });
  afterEach(() => {
    const violations = fakes.flatMap((f) => f.violations);
    for (const f of fakes) f.stop();
    home?.cleanup();
    expect(violations).toEqual([]);
  });
  const current = (): Home => {
    if (!home) throw new Error("useScenario: no home outside a test");
    return home;
  };
  return {
    get home() {
      return current();
    },
    fake: (options) => {
      const f = startFake(options);
      fakes.push(f);
      return f;
    },
    run: (args, opts = {}) =>
      wego(args, { ...opts, home: current(), fake: fakes[fakes.length - 1] }),
  };
}
