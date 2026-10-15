// Pure parts of the product tour: step types, popover placement and the
// "seen" bookkeeping. Kept DOM-free so they can be unit tested in node.
import type { MessageKey } from "../../i18n/core";

export type Placement = "top" | "bottom" | "left" | "right";

// What the surrounding app lets a step do before it is shown.
export type TourHost = {
  setView?: (view: string) => void;
};

export type TourStep = {
  id: string;
  // CSS selector, preferably `[data-tour="..."]`. Steps without a target
  // (or whose target is missing) render as a centered dialog.
  target?: string;
  title: MessageKey;
  body: MessageKey;
  placement?: Placement | "auto";
  // Runs before the step is shown, e.g. `({ setView }) => setView?.("Calendar")`
  // to switch the visible hub section; the target is awaited afterwards.
  before?: (host: TourHost) => void | Promise<void>;
};

export type Tour = {
  id: string;
  // Bump to show a reworked tour again to users who saw an older one.
  version: number;
  steps: TourStep[];
};

export type Rect = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };

export type Position = {
  placement: Placement;
  top: number;
  left: number;
  // Distance of the arrow tip from the card's top (left/right placements)
  // or left edge (top/bottom placements).
  arrow: number;
};

const opposite: Record<Placement, Placement> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};
const autoOrder: Placement[] = ["bottom", "top", "right", "left"];

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

// Room left for the card on each side of the target.
function space(target: Rect, viewport: Size, gap: number) {
  return {
    top: target.top - gap,
    bottom: viewport.height - (target.top + target.height) - gap,
    left: target.left - gap,
    right: viewport.width - (target.left + target.width) - gap,
  } satisfies Record<Placement, number>;
}

// Picks the preferred side, flips to the opposite one when the card would
// leave the viewport, then tries the remaining sides and finally falls back
// to whichever side has the most room.
export function choosePlacement(
  target: Rect,
  card: Size,
  viewport: Size,
  preferred: Placement | "auto" = "auto",
  gap = 14,
  margin = 12,
): Placement {
  const room = space(target, viewport, gap);
  const needed = (side: Placement) =>
    (side === "top" || side === "bottom" ? card.height : card.width) + margin;
  const order: Placement[] =
    preferred === "auto"
      ? autoOrder
      : [
          preferred,
          opposite[preferred],
          ...autoOrder.filter(
            (side) => side !== preferred && side !== opposite[preferred],
          ),
        ];
  return (
    order.find((side) => room[side] >= needed(side)) ??
    autoOrder.reduce((best, side) => (room[side] > room[best] ? side : best))
  );
}

export function computePosition(
  target: Rect,
  card: Size,
  viewport: Size,
  preferred: Placement | "auto" = "auto",
  gap = 14,
  margin = 12,
): Position {
  const placement = choosePlacement(
    target,
    card,
    viewport,
    preferred,
    gap,
    margin,
  );
  const centerX = target.left + target.width / 2;
  const centerY = target.top + target.height / 2;
  const maxLeft = viewport.width - margin - card.width;
  const maxTop = viewport.height - margin - card.height;
  let top: number;
  let left: number;
  if (placement === "top" || placement === "bottom") {
    left = clamp(centerX - card.width / 2, margin, maxLeft);
    top =
      placement === "bottom"
        ? target.top + target.height + gap
        : target.top - gap - card.height;
    top = clamp(top, margin, maxTop);
  } else {
    top = clamp(centerY - card.height / 2, margin, maxTop);
    left =
      placement === "right"
        ? target.left + target.width + gap
        : target.left - gap - card.width;
    left = clamp(left, margin, maxLeft);
  }
  const edge = 18;
  const arrow =
    placement === "top" || placement === "bottom"
      ? clamp(centerX - left, edge, card.width - edge)
      : clamp(centerY - top, edge, card.height - edge);
  return { placement, top, left, arrow };
}

// The highlighted cutout: the target grown by `padding`, kept on screen.
export function spotlightRect(target: Rect, padding = 6): Rect {
  return {
    top: target.top - padding,
    left: target.left - padding,
    width: target.width + padding * 2,
    height: target.height + padding * 2,
  };
}

// "Seen" state lives in localStorage per user and tour version for now.
// A server-side flag on the user can replace this once tours need to follow
// people across devices.
type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

export function tourStorageKey(
  tourId: string,
  version: number,
  userId: string,
) {
  return `tour:${tourId}:v${version}:${userId}`;
}

export function hasSeenTour(
  store: KeyValueStore | undefined,
  tour: Pick<Tour, "id" | "version">,
  userId: string,
) {
  try {
    return (
      store?.getItem(tourStorageKey(tour.id, tour.version, userId)) != null
    );
  } catch {
    // Blocked storage: treat as seen so the tour never nags in a loop.
    return true;
  }
}

export function markTourSeen(
  store: KeyValueStore | undefined,
  tour: Pick<Tour, "id" | "version">,
  userId: string,
  now = new Date(),
) {
  try {
    store?.setItem(
      tourStorageKey(tour.id, tour.version, userId),
      now.toISOString(),
    );
  } catch {
    // Private mode or full storage; the tour can simply show again.
  }
}
