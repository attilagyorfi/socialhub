"use client";
// In-house guided product tour (Shepherd-style, no dependency: Shepherd.js
// is AGPL). Tours are declared in ./tours.ts; steps point at elements marked
// with `data-tour="..."`.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CircleHelp, X } from "lucide-react";
import { useT } from "../../i18n";
import {
  computePosition,
  hasSeenTour,
  markTourSeen,
  spotlightRect,
  type Position,
  type Rect,
  type Tour,
  type TourHost,
} from "./logic";
import { tours, type TourId } from "./tours";

type TourContextValue = {
  start: (tourId: TourId) => void;
  stop: () => void;
  active: TourId | undefined;
};
type TourSetup = {
  // Undefined until the hub data has loaded; auto-start waits for it.
  userId?: string;
  autoStart?: TourId;
  host?: TourHost;
};
const TourContext = createContext<
  (TourContextValue & { configure: (setup: TourSetup) => void }) | undefined
>(undefined);

function useTourContext() {
  const context = useContext(TourContext);
  if (!context) throw new Error("useTour must be used inside TourProvider");
  return context;
}

export function useTour(): TourContextValue {
  const { start, stop, active } = useTourContext();
  return { start, stop, active };
}

// Called by the hub shell: who the user is, which tour to show on first
// visit and what steps may do (e.g. switch the visible section).
export function useTourSetup({ userId, autoStart, host }: TourSetup) {
  const { configure } = useTourContext();
  const setView = host?.setView;
  useEffect(() => {
    configure({ userId, autoStart, host: { setView } });
  }, [configure, userId, autoStart, setView]);
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<TourId>();
  const [index, setIndex] = useState(0);
  const [userId, setUserId] = useState<string>();
  const [autoStart, setAutoStart] = useState<TourId>();
  const hostRef = useRef<TourHost>({});
  const configure = useCallback((setup: TourSetup) => {
    hostRef.current = setup.host ?? {};
    setUserId(setup.userId);
    setAutoStart(setup.autoStart);
  }, []);
  const start = useCallback(
    (tourId: TourId) => {
      if (userId) markTourSeen(browserStorage(), tours[tourId], userId);
      setIndex(0);
      setActive(tourId);
    },
    [userId],
  );
  const stop = useCallback(() => setActive(undefined), []);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || !userId || autoStarted.current) return;
    autoStarted.current = true;
    // Automated browsers (Playwright) must not be blocked by the overlay.
    if (navigator.webdriver) return;
    if (hasSeenTour(browserStorage(), tours[autoStart], userId)) return;
    start(autoStart);
  }, [autoStart, userId, start]);
  const value = useMemo(
    () => ({ start, stop, active, configure }),
    [start, stop, active, configure],
  );
  return (
    <TourContext.Provider value={value}>
      {children}
      {active && (
        <TourOverlay
          key={active}
          tour={tours[active]}
          index={index}
          onIndex={setIndex}
          onClose={stop}
          hostRef={hostRef}
        />
      )}
    </TourContext.Provider>
  );
}

export function TourButton({ tourId = "welcome" }: { tourId?: TourId }) {
  const { t } = useT();
  const { start } = useTour();
  return (
    <button
      type="button"
      className="icon-button"
      data-tour="tour-button"
      title={t("tour.button")}
      aria-label={t("tour.button")}
      onClick={() => start(tourId)}
    >
      <CircleHelp size={18} />
    </button>
  );
}

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const visible = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  return element?.getClientRects().length ? element : null;
};
const focusable =
  "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
// Under this width the card becomes a bottom sheet.
const SHEET_WIDTH = 640;

type Shown = { index: number; element: HTMLElement | null };
type Layout = { sheet: boolean; spot?: Rect; position?: Position };

function TourOverlay({
  tour,
  index,
  onIndex,
  onClose,
  hostRef,
}: {
  tour: Tour;
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  hostRef: React.RefObject<TourHost>;
}) {
  const { t } = useT();
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  // The step on screen; it switches only once the next step's target is
  // resolved, so the card never shows copy next to the wrong element.
  const [shown, setShown] = useState<Shown>();
  const [layout, setLayout] = useState<Layout>();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  const requested = tour.steps[index];
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await requested.before?.(hostRef.current ?? {});
      } catch {
        // A failing preparation must not trap the user in the tour.
      }
      let element: HTMLElement | null = null;
      // The target may render a few frames after `before` switched views.
      for (let frame = 0; requested.target && frame < 20; frame++) {
        if (cancelled) return;
        element = visible(requested.target);
        if (element) break;
        await nextFrame();
      }
      if (cancelled) return;
      element?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: reducedMotion() ? "auto" : "smooth",
      });
      setShown({ index, element });
    })();
    return () => {
      cancelled = true;
    };
  }, [requested, index, hostRef]);

  const element = shown?.element;
  useEffect(() => {
    if (!element) return;
    element.setAttribute("data-tour-active", "");
    return () => element.removeAttribute("data-tour-active");
  }, [element]);

  const step = shown ? tour.steps[shown.index] : undefined;
  useLayoutEffect(() => {
    if (!shown) return;
    let frame = 0;
    const measure = () => {
      const card = cardRef.current;
      if (!card) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const sheet = viewport.width < SHEET_WIDTH;
      const target = shown.element;
      if (!target?.isConnected || !target.getClientRects().length) {
        setLayout({ sheet });
        return;
      }
      const box = target.getBoundingClientRect();
      const rect = {
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
      };
      setLayout({
        sheet,
        spot: spotlightRect(rect),
        position: sheet
          ? undefined
          : computePosition(
              rect,
              { width: card.offsetWidth, height: card.offsetHeight },
              viewport,
              tour.steps[shown.index].placement,
            ),
      });
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    const observer = new ResizeObserver(update);
    if (cardRef.current) observer.observe(cardRef.current);
    if (shown.element) observer.observe(shown.element);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, { capture: true });
      observer.disconnect();
    };
  }, [shown, tour]);

  const current = shown?.index ?? 0;
  const last = current === tour.steps.length - 1;
  const next = useCallback(() => {
    if (last) onClose();
    else onIndex(current + 1);
  }, [last, current, onClose, onIndex]);
  const back = useCallback(() => {
    if (current > 0) onIndex(current - 1);
  }, [current, onIndex]);

  // Focus only once the card is visible; hidden elements cannot take focus.
  const ready = !!layout && !!step;
  useEffect(() => {
    if (ready) primaryRef.current?.focus({ preventScroll: true });
  }, [ready, shown]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const card = cardRef.current;
      if (!card) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      } else if (event.key === "Tab") {
        const items = Array.from(card.querySelectorAll<HTMLElement>(focusable));
        const first = items[0];
        const final = items.at(-1);
        const inside = card.contains(document.activeElement);
        if (!inside || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          (event.shiftKey ? final : first)?.focus();
        } else if (!event.shiftKey && document.activeElement === final) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [next, back, onClose]);

  const sheet = layout?.sheet ?? false;
  const centered = !layout?.spot && !sheet;
  const position = layout?.position;
  const placement = position?.placement;
  return createPortal(
    <div className="tour-root">
      <div
        className={`tour-blocker${layout?.spot ? "" : " dim"}`}
        onClick={() => primaryRef.current?.focus()}
      />
      {layout?.spot && (
        <div
          className="tour-spotlight"
          aria-hidden="true"
          style={{
            top: layout.spot.top,
            left: layout.spot.left,
            width: layout.spot.width,
            height: layout.spot.height,
          }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-tour-step={step?.id}
        className={[
          "tour-card",
          sheet && "sheet",
          centered && "centered",
          placement && `placement-${placement}`,
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          visibility: layout && step ? "visible" : "hidden",
          ...(position && {
            top: position.top,
            left: position.left,
            ["--tour-arrow" as string]: `${position.arrow}px`,
          }),
        }}
      >
        {placement && <span className="tour-arrow" aria-hidden="true" />}
        <div className="tour-card-head">
          <span className="tour-counter">
            {t("tour.counter", {
              current: current + 1,
              total: tour.steps.length,
            })}
          </span>
          <button
            type="button"
            className="icon-button tour-close"
            aria-label={t("tour.close")}
            title={t("tour.close")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <h2 id={titleId}>{step && t(step.title)}</h2>
        <p id={bodyId}>{step && t(step.body)}</p>
        <div className="tour-dots" aria-hidden="true">
          {tour.steps.map((item, position) => (
            <span
              key={item.id}
              className={position === current ? "active" : ""}
            />
          ))}
        </div>
        <div className="tour-actions">
          {!last && (
            <button type="button" className="text-button" onClick={onClose}>
              {t("tour.skip")}
            </button>
          )}
          <span className="tour-actions-end">
            {current > 0 && (
              <button type="button" onClick={back}>
                {t("tour.back")}
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              className="primary"
              onClick={next}
            >
              {last ? t("tour.finish") : t("tour.next")}
            </button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
