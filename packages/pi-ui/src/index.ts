import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

// Structural native mouse contract: older supported hosts do not export these types.
interface TuiMouseEvent {
  type: "press" | "release" | "move" | "drag" | "click" | "wheel";
  button: "left" | "middle" | "right" | "none";
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  wheelDelta?: number;
  clickCount?: number;
}

interface TuiMouseEventResult {
  handled?: boolean;
  capture?: boolean;
  focus?: boolean;
  render?: boolean;
  target?: { component: BorderedComponent };
}

export interface BorderedComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate(): void;
  dispose?(): void;
  waitForPending?(): Promise<void>;
  wantsKeyRelease?: boolean;
  focused?: boolean;
  readonly __piTuiKitScreen?: true;
}

type BorderTheme = { fg(color: "border", text: string): string };
type CustomFactory<T> = (
  tui: unknown,
  theme: BorderTheme,
  keybindings: unknown,
  done: (result: T) => void,
) => BorderedComponent | Promise<BorderedComponent>;

export type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];

const wrappedUIs = new WeakSet<object>();

/**
 * Wrap a custom component with Pi's standard top and bottom border rules.
 * Components that already render a top and bottom rule are left unchanged.
 */
export function borderedComponent(
  component: BorderedComponent,
  borderColor: (text: string) => string,
): BorderedComponent {
  return new BorderAdapter(component, borderColor);
}

/**
 * Return an Extension UI context whose custom components receive the shared
 * border treatment. Native select/confirm/input/editor methods are untouched;
 * Pi already owns their dialog framing and RPC protocol.
 */
export function wrapCustomUi(ui: ExtensionUIContext): ExtensionUIContext {
  if (wrappedUIs.has(ui)) return ui;

  const custom = ((factory: CustomFactory<unknown>, options?: CustomOptions) =>
    ui.custom<unknown>((tui, theme, keybindings, done) => {
      const created = factory(tui, theme, keybindings, done);
      const border = (component: BorderedComponent): BorderedComponent =>
        borderedComponent(component, (text) => theme.fg("borderAccent", text));
      return isPromiseLike(created) ? created.then(border) : border(created);
    }, options)) as ExtensionUIContext["custom"];

  const wrapped = new Proxy(ui, {
    get(target, property, receiver) {
      if (property === "custom") return custom;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  wrappedUIs.add(wrapped);
  return wrapped;
}

/**
 * Preserve a context's identity while replacing only its UI custom method.
 * This is useful when passing a command context into a menu library.
 */
export function withBorderedCustomUi<T extends { ui: ExtensionUIContext }>(context: T): T {
  const ui = wrapCustomUi(context.ui);
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === "ui") return ui;
      return Reflect.get(target, property, receiver);
    },
  });
}

export function hasBorderRules(lines: readonly string[]): boolean {
  const nonEmpty = lines
    .map(stripVTControlCharacters)
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonEmpty.length < 2) return false;
  return isRule(nonEmpty[0] ?? "") && isRule(nonEmpty.at(-1) ?? "");
}

// Keep native ancestry without inheriting the newer Container-only dispatch
// return type. This adapter also supports passive and non-container components.
const BorderContainer: new () => Pick<Container, "children" | "addChild"> = Container;

class BorderAdapter extends BorderContainer implements BorderedComponent {
  private readonly inner: BorderedComponent;
  private readonly borderColor: (text: string) => string;
  private focusedValue = false;
  private addedBorders = false;
  private contentHeight = 0;
  private ownsMouseGesture = false;
  handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

  constructor(inner: BorderedComponent, borderColor: (text: string) => string) {
    super();
    // Native overlay ancestry uses instanceof Container, not structural children.
    // Container exists throughout the supported Pi range; mouse types do not.
    this.addChild(inner);
    Object.defineProperty(this, "handleMouse", { value: undefined, writable: true, configurable: true });
    this.inner = inner;
    this.borderColor = borderColor;
    // Keep keyboard-only components passive, including on older Pi versions.
    if (typeof inner.handleMouse === "function") {
      this.handleMouse = (event) => {
        // A new press ends any prior adapter-owned gesture even on a border.
        if (event.type === "press") this.ownsMouseGesture = false;
        const continuing = this.ownsMouseGesture && (event.type === "drag" || event.type === "release");
        if (
          this.addedBorders &&
          !continuing &&
          (this.contentHeight === 0 || event.y < 1 || event.y > this.contentHeight)
        ) {
          return undefined;
        }
        try {
          const result = this.inner.handleMouse?.(
            this.addedBorders
              ? { ...event, y: event.y - 1, height: Math.max(0, Math.min(this.contentHeight, event.height - 1)) }
              : event,
          );
          // Descendant dispatch targets receive their release directly from Pi;
          // only retain gestures whose subsequent events return to this adapter.
          const target = result?.target?.component;
          if (target && target !== this) this.ownsMouseGesture = false;
          else if (result?.capture || (event.type === "press" && (result?.handled || result?.focus))) {
            this.ownsMouseGesture = true;
          }
          return result;
        } finally {
          if (event.type === "release") this.ownsMouseGesture = false;
        }
      };
    }
    if ("focused" in inner) {
      Object.defineProperty(this, "focused", {
        configurable: true,
        enumerable: true,
        get: () => this.focusedValue,
        set: (value: boolean) => {
          this.focusedValue = value;
          (this.inner as BorderedComponent & { focused?: boolean }).focused = value;
        },
      });
    }
    if (inner.__piTuiKitScreen === true) {
      Object.defineProperty(this, "__piTuiKitScreen", { configurable: true, value: true });
    }
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.inner.wantsKeyRelease;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = this.inner.render(safeWidth);
    this.contentHeight = lines.length;
    this.addedBorders = !hasBorderRules(lines);
    if (!this.addedBorders) return lines;
    const rule = this.borderColor("─".repeat(safeWidth));
    return [rule, ...lines, rule];
  }

  handleInput(data: string): void {
    this.inner.handleInput?.(data);
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  dispose(): void {
    this.ownsMouseGesture = false;
    this.inner.dispose?.();
  }

  async waitForPending(): Promise<void> {
    await this.inner.waitForPending?.();
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function isRule(line: string): boolean {
  if (line.length < 2) return false;
  return /^[\u2500\u2501\u2504\u2505\u2550\u250c\u2510\u2514\u2518\u256d\u256e\u2570\u256f\-=_+*]+$/u.test(line);
}
