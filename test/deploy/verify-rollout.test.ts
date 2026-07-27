import { describe, it, expect } from "vitest";
import { verifyRollout } from "../../src/deploy/verify-rollout.js";

const CANON = "cbuild-xyz";
const URL = "https://app-dev-abc.xano.io";

/** A monotonic fake clock: `now()` advances by exactly each `sleep(ms)`, so the
 *  deadline logic runs deterministically with no real timers. */
function fakeClock() {
  let t = 0;
  const delays: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number): Promise<void> => {
      delays.push(ms);
      t += ms;
    },
    delays,
    at: () => t,
  };
}

/** A fetch stub that returns the given canonical header (or none) per call, in order. */
function fetchReturning(...headers: (string | null)[]): { fn: typeof fetch; calls: () => number } {
  let i = 0;
  const fn = (async () => {
    const h = headers[Math.min(i, headers.length - 1)];
    i++;
    return new Response(null, { status: h ? 200 : 503, headers: h ? { "X-Xano-Canonical": h } : {} });
  }) as unknown as typeof fetch;
  return { fn, calls: () => i };
}

describe("verifyRollout", () => {
  it("returns live on the first GET when the header already matches", async () => {
    const clock = fakeClock();
    const { fn, calls } = fetchReturning(CANON);
    const res = await verifyRollout(URL, CANON, { fetchFn: fn, now: clock.now, sleep: clock.sleep });
    expect(res.live).toBe(true);
    expect(calls()).toBe(1);
    expect(clock.delays).toEqual([]); // never waited
  });

  it("keeps polling and returns live once the header matches on a later GET", async () => {
    const clock = fakeClock();
    const { fn, calls } = fetchReturning(null, null, CANON); // miss, miss, match
    const res = await verifyRollout(URL, CANON, { fetchFn: fn, now: clock.now, sleep: clock.sleep });
    expect(res.live).toBe(true);
    expect(calls()).toBe(3);
    expect(clock.delays).toEqual([1000, 1000]); // two fast-phase waits before the match
  });

  it("treats a thrown fetch (refused/hung) as a miss and keeps going", async () => {
    const clock = fakeClock();
    let i = 0;
    const fn = (async () => {
      if (i++ === 0) throw new Error("ECONNREFUSED");
      return new Response(null, { status: 200, headers: { "X-Xano-Canonical": CANON } });
    }) as unknown as typeof fetch;
    const res = await verifyRollout(URL, CANON, { fetchFn: fn, now: clock.now, sleep: clock.sleep });
    expect(res.live).toBe(true);
    expect(i).toBe(2);
  });

  it("treats a 503 with no canonical header as a miss and keeps going", async () => {
    const clock = fakeClock();
    const { fn, calls } = fetchReturning(null, CANON);
    const res = await verifyRollout(URL, CANON, { fetchFn: fn, now: clock.now, sleep: clock.sleep });
    expect(res.live).toBe(true);
    expect(calls()).toBe(2);
  });

  it("never counts a DIFFERENT build's canonical as live", async () => {
    const clock = fakeClock();
    const { fn } = fetchReturning("some-other-build");
    const res = await verifyRollout(URL, CANON, {
      fetchFn: fn,
      now: clock.now,
      sleep: clock.sleep,
      totalDeadlineMs: 5_000,
    });
    expect(res.live).toBe(false);
  });

  it("returns not-live at the deadline and does not poll past it", async () => {
    const clock = fakeClock();
    const { fn } = fetchReturning(null); // always a miss
    const res = await verifyRollout(URL, CANON, { fetchFn: fn, now: clock.now, sleep: clock.sleep });
    expect(res.live).toBe(false);
    expect(clock.at()).toBe(120_000); // stopped exactly at the total deadline, never beyond
  });

  it("uses the 1s cadence in the fast phase and 2s after it", async () => {
    const clock = fakeClock();
    const { fn } = fetchReturning(null); // always a miss → runs the full schedule
    await verifyRollout(URL, CANON, { fetchFn: fn, now: clock.now, sleep: clock.sleep });
    // First 30 waits are 1s (fast phase < 30s), the rest are 2s out to 120s.
    expect(clock.delays.slice(0, 30).every((d) => d === 1000)).toBe(true);
    expect(clock.delays.slice(30).every((d) => d === 2000)).toBe(true);
    // 30s of fast (30×1s) + 90s of slow (45×2s) = 75 total waits.
    expect(clock.delays.length).toBe(75);
  });

  it("fails closed when the expected canonical is empty (never matches a header-less response)", async () => {
    const clock = fakeClock();
    const { fn, calls } = fetchReturning(null);
    const res = await verifyRollout(URL, "", { fetchFn: fn, now: clock.now, sleep: clock.sleep });
    expect(res.live).toBe(false);
    expect(calls()).toBe(0); // bailed before any fetch
  });
});
