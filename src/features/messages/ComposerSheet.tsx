import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { spring } from "motion";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowSquareOutIcon,
  SidebarRightIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { DialogBarMaterial } from "../../shared/design-system/ui/DialogBarMaterial";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useFinalFocusUnlessMoved } from "../../shared/design-system/ui/finalFocus";
import type { ComposerOverlayHost } from "./composer-overlay";
import {
  type InlineThreadIntroStep,
  IntroSpotlight,
} from "./InlineThreadIntro";
import styles from "./ComposerSheet.module.css";
import messageStyles from "./Messages.module.css";

/** Where the sheet's top may reach, measured where container units can't
 * say: the dock's bottom, and the top edge of the view it reads over, in the
 * window. A top-level view's edge is its pane's, and the sheet stays 8rem
 * below the window's top; a view inside another sheet is that sheet's
 * padding box, as tall as it is now. CSS turns these into the sheet's
 * maximum height, and into how far details stretch to cover the sheet
 * beneath. The dock's height is the composer's, which the sheet folds into. */
function dockGeometry(dock: HTMLElement): CSSProperties {
  const box = dock.getBoundingClientRect();
  const outer = dock.parentElement?.closest<HTMLElement>(
    "[data-details-sheet-surface]",
  );
  const viewTop = outer
    ? outer.getBoundingClientRect().top + outer.clientTop
    : (dock.parentElement ?? dock).getBoundingClientRect().top;
  return {
    "--composer-height": `${box.height}px`,
    "--dock-bottom": `${box.bottom}px`,
    "--view-top": `${viewTop}px`,
  } as CSSProperties;
}

/** The top-level scrim dims the conversation's panel, which is not the
 * dock's containing block, so it is placed in the window: over the panel's
 * outer surface, clipped to the panel's own region. Joined panels share
 * their shell's rounded shape; their inner panels have no radius. A scrim
 * inside another sheet is placed by CSS. */
function scrimGeometry(dock: HTMLElement): CSSProperties {
  const pane = dock.parentElement ?? dock;
  const surface =
    pane.closest<HTMLElement>("[data-buzz-surface][data-joined]") ??
    pane.closest<HTMLElement>("[data-buzz-surface]") ??
    pane;
  const box = surface.getBoundingClientRect();
  const style = getComputedStyle(surface);
  const clip = (
    pane.closest<HTMLElement>("[data-overlay-boundary]") ?? pane
  ).getBoundingClientRect();
  // A region edge at the surface's border extends through that border.
  const inset = (distance: number, border: string) =>
    distance <= Number.parseFloat(border) ? 0 : distance;
  return {
    "--scrim-top": `${box.top}px`,
    "--scrim-left": `${box.left}px`,
    "--scrim-width": `${box.width}px`,
    "--scrim-height": `${box.height}px`,
    "--scrim-radius": style.borderRadius,
    "--scrim-inset": [
      inset(clip.top - box.top, style.borderTopWidth),
      inset(box.right - clip.right, style.borderRightWidth),
      inset(box.bottom - clip.bottom, style.borderBottomWidth),
      inset(clip.left - box.left, style.borderLeftWidth),
    ]
      .map((value) => `${value}px`)
      .join(" "),
  } as CSSProperties;
}

/** Follows the dock while the sheet is mounted: the composer grows as a reply
 * is typed, and the pane resizes with the window and its splits. */
function useDockGeometry(dock: HTMLElement, mounted: boolean) {
  const measure = () => ({
    sheet: dockGeometry(dock),
    scrim: dock.parentElement?.closest("[data-details-sheet-surface]")
      ? {}
      : scrimGeometry(dock),
  });
  const [style, setStyle] = useState(measure);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure reads only the dock.
  useLayoutEffect(() => {
    if (!mounted) return;
    const update = () => setStyle(measure());
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(dock);
    if (dock.parentElement) observer?.observe(dock.parentElement);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [dock, mounted]);
  return style;
}

/** A thread's sheet takes the height the details over its reply box read
 * at, so it can grow to sit just behind them. */
const CoveredSheetContext = createContext<
  ((height: number | undefined) => void) | undefined
>(undefined);

/** Reports what the details read at to the sheet they are stacked over: their
 * header, text and the composer's space, not their box, which stretches to
 * cover that sheet. A panel doesn't report; the page sets `tall` for it. */
function useCoveringHeight(
  surface: HTMLElement | null,
  content: RefObject<HTMLElement | null>,
  composerSpace: RefObject<HTMLElement | null>,
  report: ((height: number | undefined) => void) | undefined,
) {
  useLayoutEffect(() => {
    const read = content.current;
    const space = composerSpace.current;
    if (!surface || !read || !space || !report) return;
    const measure = () =>
      report(
        read.getBoundingClientRect().height +
          space.getBoundingClientRect().height +
          surface.offsetHeight -
          surface.clientHeight,
      );
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(read);
    observer?.observe(space);
    return () => {
      observer?.disconnect();
      report(undefined);
    };
  }, [surface, content, composerSpace, report]);
}

/** The details over a thread's reply box, for the thread's sheet: how tall
 * they read, and `report`, which they tell it through. CSS gives the sheet
 * its height under them; this grows it there from the height it has, on the
 * curve the details open on, so its old box never cuts them off. A
 * min-height transition doesn't: it runs from 0, far below the sheet, which
 * waits and then jumps. */
function useCovering(popup: RefObject<HTMLElement | null>) {
  const [covering, setCovering] = useState<number>();
  const reported = useRef<number>(undefined);
  // The sheet's height as details began to cover it.
  const before = useRef<number>(undefined);
  const report = useCallback(
    (height: number | undefined) => {
      if (height !== undefined && reported.current === undefined)
        before.current = popup.current?.getBoundingClientRect().height;
      reported.current = height;
      setCovering(height);
    },
    [popup],
  );
  const covered = covering !== undefined;
  useLayoutEffect(() => {
    const element = popup.current;
    const from = before.current;
    before.current = undefined;
    if (
      !covered ||
      !element ||
      from === undefined ||
      typeof element.animate !== "function" ||
      immediate()
    )
      return;
    const timing = growthTiming(element, true);
    // No end keyframe: it ends where CSS has the sheet by then, which
    // follows the details as what they read arrives.
    const animation = element.animate([{ minHeight: `${from}px`, offset: 0 }], {
      ...timing,
      easing: held(timing.easing),
    });
    return () => animation.cancel();
  }, [popup, covered]);
  return { covering, report };
}

const immediate = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.hasAttribute("data-keyboard-navigation");

/** Motion tokens, read where the sheet paints so scaled themes agree. */
function token(element: Element, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}
const milliseconds = (value: string) =>
  value.endsWith("ms")
    ? Number.parseFloat(value)
    : Number.parseFloat(value) * 1000;

/** How long a sheet takes to open or fold, and on what curve: a spring as it
 * opens, where the engine can run one. */
function growthTiming(element: Element, open: boolean) {
  const duration = milliseconds(
    token(
      element,
      open ? "--duration-settle" : "--duration-fast",
      open ? "220ms" : "150ms",
    ),
  );
  // Motion generates a native linear() spring curve for WAAPI.
  const curve = spring({ duration, bounce: 0.25, keyframes: [0, 1] });
  const springEasing = curve
    .toString()
    .slice(curve.toString().indexOf(" ") + 1);
  return {
    duration,
    easing:
      open && CSS.supports("animation-timing-function", springEasing)
        ? springEasing
        : token(element, "--easing-enter", "cubic-bezier(0.23, 1, 0.32, 1)"),
  };
}

/** A linear() curve held at its end from where it first passes it. A sheet
 * opening on the spring is whole from there on, its overshoot clipped away;
 * what moves with it stops there too, rather than springing past. */
function held(easing: string) {
  const stops =
    /^linear\((.*)\)$/.exec(easing)?.[1]?.split(",").map(Number) ?? [];
  const over = stops.findIndex((stop) => stop > 1);
  const last = stops[over - 1];
  const next = stops[over];
  if (last === undefined || next === undefined || stops.some(Number.isNaN))
    return easing;
  const step = 100 / (stops.length - 1);
  const passes = (over - 1 + (1 - last) / (next - last)) * step;
  return `linear(${[
    ...stops
      .slice(0, over)
      .map((stop, index) => `${stop} ${(index * step).toFixed(2)}%`),
    `1 ${passes.toFixed(2)}%`,
    "1",
  ].join(", ")})`;
}

/** Grows the sheet up out of the composer as it opens and folds it back down
 * into the composer as it closes. Base UI owns the unmount timing. A media
 * sheet uses an interruptible CSS transition instead. */
function useGrowth() {
  const last = useRef<{ open: boolean; animation?: Animation }>(undefined);
  return (element: HTMLElement, open: boolean, mounting = false) => {
    if (mounting) last.current = undefined;
    const previous = last.current;
    if (previous?.open === open) return;
    // Keep layout at its final size; reveal the surface without stretching
    // its text or editor.
    const painted = getComputedStyle(element);
    const shownClip = painted.clipPath;
    previous?.animation?.cancel();
    last.current = { open };
    if (typeof element.animate !== "function" || immediate()) return;
    const radius = painted.borderRadius;
    const composerHeight = Number.parseFloat(
      token(element, "--composer-height", "0px"),
    );
    const gap = token(element, "--sheet-gap", "8px");
    const composerRadius = token(element, "--composer-radius", radius);
    // Start at the composer's exact outline; the editor itself never scales.
    const folded = `inset(max(0px, calc(100% - ${composerHeight}px - ${gap})) ${gap} ${gap} round ${composerRadius})`;
    const expanded = `inset(0px 0px 0px round ${radius})`;
    const from = previous
      ? shownClip === "none"
        ? expanded
        : shownClip
      : folded;
    last.current.animation = element.animate(
      [{ clipPath: from }, { clipPath: open ? expanded : folded }],
      { ...growthTiming(element, open), fill: open ? "none" : "forwards" },
    );
  };
}

/** Crossfades the view's own composer into the sheet's, in place, without
 * moving focus or draft ownership. A close that interrupts the opening
 * reverses from the painted opacity rather than jumping. */
export function useComposerHandoff(
  sheet: HTMLElement | null,
  source: HTMLElement,
  open: boolean,
  enabled: boolean,
) {
  const interrupted = useRef<{
    target: HTMLElement;
    opacity: string;
    sourceOpacity: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (!sheet || !enabled) return;
    let animations: Animation[] = [];
    let started = false;
    let editor: HTMLElement | null = null;
    const start = () => {
      const target = sheet.querySelector<HTMLElement>(
        "[data-message-composer]",
      );
      if (!target || started) return;
      started = true;
      editor = target;
      if (immediate() || typeof target.animate !== "function") {
        if (open) source.dataset.composerCovered = "";
        return;
      }
      const options: KeyframeAnimationOptions = {
        duration: milliseconds(
          token(sheet, open ? "--duration-settle" : "--duration-fast", "220ms"),
        ),
        easing: token(
          sheet,
          "--easing-enter",
          "cubic-bezier(0.23, 1, 0.32, 1)",
        ),
        fill: "both",
      };
      const prior =
        interrupted.current?.target === target ? interrupted.current : null;
      interrupted.current = null;
      const incoming = target.animate(
        [
          { opacity: prior?.opacity ?? (open ? 0 : 1) },
          { opacity: open ? 1 : 0 },
        ],
        options,
      );
      const outgoing = source.animate(
        [
          { opacity: prior?.sourceOpacity ?? (open ? 1 : 0) },
          { opacity: open ? 0 : 1 },
        ],
        options,
      );
      animations = [incoming, outgoing];
      incoming.onfinish = () => {
        if (!open) return;
        source.dataset.composerCovered = "";
        for (const animation of animations) animation.cancel();
      };
    };
    start();
    // A thread's reply box, or media's comment box, arrives after its verified
    // root, independently of the sheet's render.
    const observer = new MutationObserver(start);
    if (!started) observer.observe(sheet, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      interrupted.current =
        editor && animations.some((item) => item.playState === "running")
          ? {
              target: editor,
              opacity: getComputedStyle(editor).opacity,
              sourceOpacity: getComputedStyle(source).opacity,
            }
          : null;
      for (const animation of animations) animation.cancel();
      delete source.dataset.composerCovered;
    };
  }, [sheet, source, open, enabled]);
}

/** The header every sheet shares: its title, with what leads it and its
 * description, and its actions before Close. */
export function SheetHeader({
  title,
  description,
  leading,
  closeLabel,
  headerActions,
  material,
  covered,
  onMoveToTab,
  onOpenAsTab,
  spotlight,
  onSpotlightAnchor,
}: {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  closeLabel: string;
  headerActions?: ReactNode;
  /** The progressive material behind it, for a reader that runs beneath. */
  material: boolean;
  /** Details cover it: its actions can't be reached, so they take no focus. */
  covered?: boolean | undefined;
  onMoveToTab?: (() => void) | undefined;
  onOpenAsTab?: (() => void) | undefined;
  spotlight?: InlineThreadIntroStep | undefined;
  onSpotlightAnchor?: ((element: HTMLElement | null) => void) | undefined;
}) {
  return (
    <header className={`buzz-dialog-header ${styles.header}`}>
      {material && <DialogBarMaterial className={styles.headerMaterial} />}
      <div className={styles.byline}>
        {leading}
        <BaseDialog.Title
          className={`text-label ${styles.name}`}
          data-spotlight={spotlight === 1 || undefined}
        >
          {spotlight === undefined ? (
            title
          ) : (
            <IntroSpotlight
              shape="pill"
              active={spotlight === 1}
              anchorRef={onSpotlightAnchor}
            >
              {title}
            </IntroSpotlight>
          )}
        </BaseDialog.Title>
        {description && (
          <BaseDialog.Description
            className={`buzz-dialog-description ${styles.time}`}
          >
            {description}
          </BaseDialog.Description>
        )}
      </div>
      <div className="buzz-dialog-header-actions" inert={covered}>
        {headerActions}
        {onOpenAsTab && (
          <IconButton
            aria-label="Open as tab"
            title="Open as tab"
            variant="glass"
            shape="round"
            size="compact"
            icon={<ArrowSquareOutIcon size={16} aria-hidden="true" />}
            onClick={onOpenAsTab}
          />
        )}
        {onMoveToTab && (
          <IntroSpotlight
            shape="ring"
            active={spotlight === 2}
            anchorRef={onSpotlightAnchor}
          >
            <IconButton
              aria-label="Move to side panel"
              // An intro step names it while it points here.
              title={spotlight === undefined ? "Move to side panel" : undefined}
              variant="glass"
              shape="round"
              size="compact"
              icon={<SidebarRightIcon size={16} aria-hidden="true" />}
              onClick={onMoveToTab}
            />
          </IntroSpotlight>
        )}
        <BaseDialog.Close
          render={
            <IconButton
              aria-label={closeLabel}
              variant="glass"
              shape="round"
              size="compact"
              icon={<XIcon size={16} aria-hidden="true" />}
            />
          }
        />
      </div>
    </header>
  );
}

/** The dialog every sheet is: non-modal, so the rest of the app stays
 * interactive; only its own scrim dismisses it on an outside press, and
 * moving focus never does. Once closed, focus returns to what opened it. */
export function SheetRoot({
  open,
  onOpenChange,
  onClosed,
  finalFocus,
  popup,
  backdrop,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onClosed(): void;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  popup: RefObject<HTMLElement | null>;
  backdrop: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        if (
          !next &&
          (details.reason === "focus-out" ||
            (details.reason === "outside-press" &&
              details.event?.target !== backdrop.current))
        ) {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        onClosed();
        const active = document.activeElement;
        if (active === document.body || popup.current?.contains(active))
          finalFocus?.current?.focus({ preventScroll: true });
      }}
    >
      {children}
    </BaseDialog.Root>
  );
}

/** A dialog that rises out of its view's composer, drawn in the composer's
 * dock and placed around it, which stays in place below it so a reply can be
 * written while reading. A thread brings its own reply box, which takes the
 * composer's place; a panel covers the composer at full height. Over a
 * thread's reply box, either stacks over the thread's sheet, whose edge shows
 * above it. */
export function ComposerSheet({
  open,
  onOpenChange,
  host,
  title,
  description,
  leading,
  closeLabel = "Close",
  finalFocus,
  children,
  containsComposer = false,
  readerOnly = false,
  tall = false,
  onClosed,
  onMoveToTab,
  onOpenAsTab,
  spotlight,
  onSpotlightAnchor,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  host: ComposerOverlayHost;
  title: ReactNode;
  description?: ReactNode;
  /** Shown before the title, such as its author's avatar. */
  leading?: ReactNode;
  closeLabel?: string;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  children: ReactNode;
  /** A thread supplies its own reply box in place of the view's composer. */
  containsComposer?: boolean;
  /** A panel: it takes the full height and covers the composer, which it
   * leaves untouched underneath. */
  readerOnly?: boolean;
  /** Takes the full height while true, as a thread does under a panel, and
   * fits its content again after. */
  tall?: boolean;
  /** Once a close has finished its motion. */
  onClosed?: (() => void) | undefined;
  /** Hands what this sheet reads to a side-pane tab. */
  onMoveToTab?: (() => void) | undefined;
  /** Closes this sheet and opens what it reads as a tab. */
  onOpenAsTab?: (() => void) | undefined;
  /** The intro step pointing into this sheet: 1 its title, 2 Move to side
   * panel. */
  spotlight?: InlineThreadIntroStep | undefined;
  /** Receives the element the current intro step points at. */
  onSpotlightAnchor?: ((element: HTMLElement | null) => void) | undefined;
}) {
  const { composer, dock } = host;
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const style = useDockGeometry(dock, mounted);
  useCoveredComposer(composer, mounted, containsComposer, readerOnly);
  useComposerHandoff(surface, composer, open, containsComposer);
  const content = useRef<HTMLDivElement | null>(null);
  const composerSpace = useRef<HTMLDivElement | null>(null);
  useCoveringHeight(
    surface,
    content,
    composerSpace,
    useContext(CoveredSheetContext),
  );
  const popup = useRef<HTMLDivElement | null>(null);
  // Details stacked over this sheet's reply box, and how tall they read.
  const { covering, report } = useCovering(popup);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const grown = useRef<HTMLDivElement | null>(null);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  const grow = useGrowth();
  // Later changes reverse whatever motion is running.
  useLayoutEffect(() => {
    if (popup.current) grow(popup.current, open);
  });
  return (
    <SheetRoot
      open={open}
      onOpenChange={onOpenChange}
      onClosed={() => {
        setMounted(false);
        onClosed?.();
      }}
      finalFocus={finalFocus}
      popup={popup}
      backdrop={backdrop}
    >
      <BaseDialog.Portal
        container={dock}
        className={messageStyles.detailsSheetLayer}
        data-details-sheet=""
      >
        <BaseDialog.Backdrop
          ref={backdrop}
          forceRender
          className={styles.scrim}
          style={style.scrim}
        />
        <BaseDialog.Popup
          ref={(element) => {
            // React reattaches this callback each render; grow once per mount.
            if (element && element !== grown.current) {
              grown.current = element;
              setSurface(element);
              grow(element, true, true);
            }
            popup.current = element;
            focus.ref(element);
          }}
          className={styles.sheet}
          data-details-sheet-surface=""
          data-contained-composer={containsComposer || undefined}
          data-reader-only={readerOnly || undefined}
          data-tall={tall || undefined}
          data-covered={covering === undefined ? undefined : ""}
          // Threads and details fit their content and grow with it, up to the
          // maximum; a panel takes the full height (`data-reader-only`).
          data-height="content"
          style={
            covering === undefined
              ? style.sheet
              : ({
                  ...style.sheet,
                  "--covering-height": `${covering}px`,
                } as CSSProperties)
          }
          // A thread places focus in its reply box; a reader takes it itself.
          initialFocus={containsComposer ? false : popup}
          finalFocus={focus.finalFocus}
          // A panel under its header shows that header's material once
          // scrolled.
          onScrollCapture={
            readerOnly
              ? (event) =>
                  event.currentTarget.toggleAttribute(
                    "data-scrolled",
                    event.target instanceof Element &&
                      event.target.scrollTop > 0,
                  )
              : undefined
          }
        >
          <div ref={content} className={styles.content}>
            <SheetHeader
              title={title}
              description={description}
              leading={leading}
              closeLabel={closeLabel}
              material={containsComposer || readerOnly}
              covered={covering !== undefined}
              onMoveToTab={onMoveToTab}
              onOpenAsTab={onOpenAsTab}
              spotlight={spotlight}
              onSpotlightAnchor={onSpotlightAnchor}
            />
            <div className={`buzz-dialog-body ${styles.body}`}>
              <div className={styles.reader}>
                {/* Only a thread's sheet has a reply box to stack over. */}
                <CoveredSheetContext
                  value={containsComposer ? report : undefined}
                >
                  {children}
                </CoveredSheetContext>
              </div>
            </div>
          </div>
          {/* The composer shows through here, inside the sheet's ring. */}
          {!containsComposer && !readerOnly && (
            <div
              ref={composerSpace}
              className={styles.composerSpace}
              aria-hidden="true"
            />
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </SheetRoot>
  );
}

/** The view's own composer stays usable under a details reader; a sheet's
 * reply box replaces it, and a panel covers it, keeping its text. */
export function useCoveredComposer(
  composer: HTMLElement,
  mounted: boolean,
  containsComposer: boolean,
  readerOnly: boolean,
) {
  useLayoutEffect(() => {
    if (!mounted || (!containsComposer && !readerOnly)) return;
    if (readerOnly) composer.dataset.composerCovered = "";
    const inert = composer.inert;
    composer.inert = true;
    return () => {
      composer.inert = inert;
      if (readerOnly) delete composer.dataset.composerCovered;
    };
  }, [composer, mounted, containsComposer, readerOnly]);
}
