import { describe, expect, test } from "bun:test";
import { planStep } from "./sequencer-runner.ts";
import type { PoolConfig } from "./pools-store.ts";

function poolWithQueue(walletNames: string[], action: PoolConfig["sequencer"]["action"]): Pick<PoolConfig, "sequencer"> {
  return {
    sequencer: {
      active: false,
      action,
      queue: walletNames.map((walletName) => ({ walletName })),
      schedule: { mode: "manual", interval_min_sec: 0, interval_max_sec: 0 },
      size: { min_sol: 0.001, max_sol: 0.001 },
      loop_mode: "loop",
    },
  };
}

describe("planStep", () => {
  test("plans buy-sell in prefix lane, then suffix lane order for new lane-major queues", () => {
    const pool = poolWithQueue(["cozy-prefix", "love-prefix", "cozy-suffix", "love-suffix"], "buy-sell");

    expect(Array.from({ length: 8 }, (_, cursor) => planStep(pool, cursor))).toEqual([
      { idx: 0, action: "buy" },
      { idx: 1, action: "buy" },
      { idx: 0, action: "sell" },
      { idx: 1, action: "sell" },
      { idx: 2, action: "buy" },
      { idx: 3, action: "buy" },
      { idx: 2, action: "sell" },
      { idx: 3, action: "sell" },
    ]);
  });

  test("plans buy-sell in prefix lane, then suffix lane order for old pair-major queues", () => {
    const pool = poolWithQueue(["cozy-prefix", "cozy-suffix", "love-prefix", "love-suffix"], "buy-sell");

    expect(Array.from({ length: 8 }, (_, cursor) => planStep(pool, cursor))).toEqual([
      { idx: 0, action: "buy" },
      { idx: 2, action: "buy" },
      { idx: 0, action: "sell" },
      { idx: 2, action: "sell" },
      { idx: 1, action: "buy" },
      { idx: 3, action: "buy" },
      { idx: 1, action: "sell" },
      { idx: 3, action: "sell" },
    ]);
  });
});
