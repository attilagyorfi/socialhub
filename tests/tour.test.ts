import { describe, expect, it } from "vitest";
import {
  choosePlacement,
  computePosition,
  hasSeenTour,
  markTourSeen,
  spotlightRect,
  tourStorageKey,
} from "../apps/web/components/tour/logic";
import { tours } from "../apps/web/components/tour/tours";
import { namespaces } from "../apps/web/i18n/registry";

const viewport = { width: 1440, height: 900 };
const card = { width: 360, height: 200 };

describe("tour placement", () => {
  it("keeps the preferred side when the card fits", () => {
    const target = { top: 20, left: 900, width: 200, height: 40 };
    expect(choosePlacement(target, card, viewport, "bottom")).toBe("bottom");
  });

  it("flips to the opposite side near the viewport edge", () => {
    const target = { top: 820, left: 600, width: 120, height: 40 };
    expect(choosePlacement(target, card, viewport, "bottom")).toBe("top");
    const nearRight = { top: 400, left: 1300, width: 100, height: 40 };
    expect(choosePlacement(nearRight, card, viewport, "right")).toBe("left");
  });

  it("tries the remaining sides before falling back to the roomiest", () => {
    // A tall element filling the height only leaves room to its right.
    const tall = { top: 0, left: 0, width: 236, height: 900 };
    expect(choosePlacement(tall, card, viewport, "bottom")).toBe("right");
    expect(choosePlacement(tall, card, viewport, "auto")).toBe("right");
    // Nothing fits on a tiny screen: the side with the most room wins.
    const small = { width: 300, height: 300 };
    const middle = { top: 100, left: 100, width: 100, height: 60 };
    expect(choosePlacement(middle, card, small, "auto")).toBe("bottom");
  });

  it("centers the card on the target and clamps it inside the viewport", () => {
    const target = { top: 20, left: 1380, width: 40, height: 40 };
    const position = computePosition(target, card, viewport, "bottom");
    expect(position.placement).toBe("bottom");
    expect(position.top).toBe(20 + 40 + 14);
    // Clamped to the right margin instead of overflowing.
    expect(position.left).toBe(1440 - 12 - 360);
    // The arrow still points at the target's center.
    expect(position.left + position.arrow).toBe(1400);
  });

  it("positions side placements vertically centered", () => {
    const target = { top: 300, left: 18, width: 200, height: 40 };
    const position = computePosition(target, card, viewport, "right");
    expect(position).toMatchObject({
      placement: "right",
      left: 18 + 200 + 14,
      top: 320 - 100,
      arrow: 100,
    });
  });

  it("keeps the arrow off the rounded corners", () => {
    const target = { top: 0, left: 0, width: 10, height: 10 };
    const position = computePosition(target, card, viewport, "bottom");
    expect(position.arrow).toBeGreaterThanOrEqual(18);
  });

  it("pads the spotlight around the target", () => {
    expect(spotlightRect({ top: 10, left: 20, width: 30, height: 40 })).toEqual(
      { top: 4, left: 14, width: 42, height: 52 },
    );
  });
});

describe("tour seen state", () => {
  const memory = () => {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  };
  const tour = { id: "welcome", version: 2 };

  it("keys the flag by tour, version and user", () => {
    expect(tourStorageKey("welcome", 2, "user-1")).toBe(
      "tour:welcome:v2:user-1",
    );
  });

  it("remembers a seen tour per user and version", () => {
    const store = memory();
    expect(hasSeenTour(store, tour, "user-1")).toBe(false);
    markTourSeen(store, tour, "user-1", new Date("2026-01-01T00:00:00Z"));
    expect(store.values.get("tour:welcome:v2:user-1")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(hasSeenTour(store, tour, "user-1")).toBe(true);
    expect(hasSeenTour(store, tour, "user-2")).toBe(false);
    expect(hasSeenTour(store, { ...tour, version: 3 }, "user-1")).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(hasSeenTour(blocked, tour, "user-1")).toBe(true);
    expect(() => markTourSeen(blocked, tour, "user-1")).not.toThrow();
    expect(hasSeenTour(undefined, tour, "user-1")).toBe(false);
  });
});

describe("tour registry", () => {
  it("uses unique step ids and translated copy", () => {
    for (const tour of Object.values(tours)) {
      const ids = tour.steps.map((step) => step.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const step of tour.steps) {
        for (const key of [step.title, step.body]) {
          const name = key.slice("tour.".length);
          expect(namespaces.tour.en).toHaveProperty([name]);
          expect(namespaces.tour.hu).toHaveProperty([name]);
        }
      }
    }
  });
});
