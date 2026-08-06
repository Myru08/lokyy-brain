import { describe, expect, it } from "vitest";
import {
  DISMISS_KEY,
  dismiss,
  isDismissed,
  undismiss,
  type DismissStorage,
} from "./dismissal.js";

function memoryStorage(seed: Record<string, string> = {}): DismissStorage {
  const data = { ...seed };
  return {
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

describe("banner dismissal (AC#5)", () => {
  it("hides the version that was dismissed", () => {
    const storage = memoryStorage();
    expect(isDismissed("v1.12", storage)).toBe(false);
    dismiss("v1.12", storage);
    expect(isDismissed("v1.12", storage)).toBe(true);
  });

  it("does NOT hide a newer version — dismissing v1.12 must not silence v1.13", () => {
    const storage = memoryStorage();
    dismiss("v1.12", storage);
    expect(isDismissed("v1.13", storage)).toBe(false);
  });

  it("treats `v1.12` and `1.12` as the same dismissal", () => {
    const storage = memoryStorage();
    dismiss("1.12", storage);
    expect(isDismissed("v1.12", storage)).toBe(true);
  });

  it("never hides an unknown version", () => {
    const storage = memoryStorage({ [DISMISS_KEY]: "1.12" });
    expect(isDismissed(null, storage)).toBe(false);
    expect(isDismissed("", storage)).toBe(false);
  });

  it("undismiss lifts the dismissal for exactly that version", () => {
    const storage = memoryStorage();
    dismiss("v1.12", storage);
    undismiss("1.12", storage);
    expect(isDismissed("v1.12", storage)).toBe(false);
  });

  it("undismiss leaves a dismissal for a different version untouched", () => {
    const storage = memoryStorage();
    dismiss("v1.12", storage);
    undismiss("v1.13", storage);
    expect(isDismissed("v1.12", storage)).toBe(true);
  });

  it("survives storage being unavailable", () => {
    expect(isDismissed("1.12", null)).toBe(false);
    expect(() => dismiss("1.12", null)).not.toThrow();
    const throwing: DismissStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(isDismissed("1.12", throwing)).toBe(false);
    expect(() => dismiss("1.12", throwing)).not.toThrow();
  });
});
