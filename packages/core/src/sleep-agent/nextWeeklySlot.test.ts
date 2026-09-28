import { describe, expect, it } from "vitest";

import { nextWeeklySlot } from "./index.js";

describe("nextWeeklySlot", () => {
  it("nimmt den kommenden Sonntag, wenn heute Mittwoch ist", () => {
    const now = new Date(2026, 8, 30, 12, 0); // Mi 30.09.2026
    const next = nextWeeklySlot(now, 0, 4, 30);
    expect(next.getDay()).toBe(0);
    expect(next.getDate()).toBe(4);
    expect(next.getMonth()).toBe(9);
    expect([next.getHours(), next.getMinutes()]).toEqual([4, 30]);
  });

  it("nimmt heute, wenn der Slot heute noch bevorsteht", () => {
    const now = new Date(2026, 9, 4, 1, 0); // So 04.10.2026 01:00
    expect(nextWeeklySlot(now, 0, 4, 30).getDate()).toBe(4);
  });

  it("springt eine Woche weiter, wenn der Slot heute vorbei ist", () => {
    const now = new Date(2026, 9, 4, 4, 30); // So 04.10.2026 genau 04:30
    expect(nextWeeklySlot(now, 0, 4, 30).getDate()).toBe(11);
  });
});
