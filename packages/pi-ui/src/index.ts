import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface BorderedComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
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

class BorderAdapter implements BorderedComponent {
  private readonly inner: BorderedComponent;
  private readonly borderColor: (text: string) => string;
  private focusedValue = false;

  constructor(inner: BorderedComponent, borderColor: (text: string) => string) {
    this.inner = inner;
    this.borderColor = borderColor;
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
    if (hasBorderRules(lines)) return lines;
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
