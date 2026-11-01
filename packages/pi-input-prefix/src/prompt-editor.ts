import type { EditorComponent, EditorTheme } from "@earendil-works/pi-tui";

import {
  detachLeadingShellBang,
  FAKE_CURSOR_END,
  FAKE_CURSOR_START,
  highlightLeadingSlashToken,
  injectPromptSymbol,
  type Paint,
  resolvePromptMarker,
  wrapWithRoundedBorder,
} from "./render.js";

const PROMPT_MARKER = resolvePromptMarker(process.env.PI_INPUT_PREFIX);
const EDITOR_PADDING = 4;
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";

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
}

interface EditorColors {
  normal: Paint;
  focus: Paint;
  shell: Paint;
  slashToken: Paint;
}

// Observe the native protected render hook only when available. Never read or
// duplicate its private scroll/edit/paste state, or bypass an inherited hook.
interface NativeViewHooks {
  renderTopBorder?: (width: number, hiddenLineCount: number) => string;
  handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

const decoratedEditors = new WeakSet<EditorComponent>();

/** Cosmetic view on the original editor: all editing stays on its native receiver. */
export class PromptEditorView {
  private readonly colors: EditorColors;
  private detachedShellPrompt = false;
  private hiddenLineCount: number | undefined;

  constructor(
    private readonly editor: EditorComponent,
    theme: EditorTheme,
  ) {
    const focus = theme.selectList.selectedText;
    this.colors = {
      normal: theme.borderColor,
      focus,
      shell: focus,
      slashToken: (text) => `${BOLD}${focus(text)}${RESET}`,
    };
  }

  decorate(): EditorComponent {
    const editor = this.editor;
    if (decoratedEditors.has(editor)) return editor;
    decoratedEditors.add(editor);

    const nativeRender = editor.render.bind(editor);
    const nativePadding = editor.setPaddingX?.bind(editor);
    const hooks = editor as unknown as NativeViewHooks;
    const nativeTopBorder =
      typeof hooks.renderTopBorder === "function" ? hooks.renderTopBorder.bind(editor) : undefined;
    const nativeMouse = typeof hooks.handleMouse === "function" ? hooks.handleMouse.bind(editor) : undefined;

    if (nativePadding) {
      // Pi copies default padding after the factory returns. Keep the floor
      // then too, while still calling inherited customization on its receiver.
      editor.setPaddingX = (padding) => nativePadding(Math.max(EDITOR_PADDING, padding));
      editor.setPaddingX(EDITOR_PADDING);
    }
    if (nativeTopBorder) {
      hooks.renderTopBorder = (width, hiddenLineCount) => {
        this.hiddenLineCount = hiddenLineCount;
        return nativeTopBorder(width, hiddenLineCount);
      };
    }
    hooks.handleMouse = (event) => {
      // Only the semantic shell start moves. Wrapping, autocomplete and
      // grapheme hit-testing remain owned by the original native handler.
      const mapped =
        this.detachedShellPrompt && event.y === 1
          ? { ...event, x: event.x < EDITOR_PADDING ? EDITOR_PADDING : event.x + 1 }
          : event;
      return nativeMouse?.(mapped);
    };
    editor.render = (width) => {
      this.detachedShellPrompt = false;
      this.hiddenLineCount = undefined;
      return this.render(nativeRender(width));
    };
    return editor;
  }

  private render(original: string[]): string[] {
    if (original.length < 3) return original;

    try {
      const lines = [...original];
      const text = this.editor.getText();
      const isShell = text.startsWith("!");
      const isSlashCommand = !isShell && text.trimStart().startsWith("/");
      const border = isShell ? this.colors.shell : isSlashCommand ? this.colors.focus : this.colors.normal;

      let prompt = PROMPT_MARKER;
      const firstContentIndex = 1;
      const firstContent = lines[firstContentIndex];

      if (firstContent !== undefined) {
        if (isSlashCommand) {
          const highlighted = highlightLeadingSlashToken(firstContent, this.colors.slashToken);
          if (highlighted !== undefined) lines[firstContentIndex] = highlighted;
        }

        if (isShell) {
          const bang = border("!");
          prompt = bang;
          if (this.hiddenLineCount === 0) {
            const detached = detachLeadingShellBang(firstContent);
            lines[firstContentIndex] = detached.line;
            this.detachedShellPrompt = detached.detached;
            if (detached.cursorOnPrompt) {
              // Re-emit the cursor in the form the host drew it, so pi-tui 1.2+
              // still applies its own software-cursor setting to the prompt cell.
              prompt = detached.fakeCursor
                ? `${detached.hardwareCursorMarker}${FAKE_CURSOR_START}${bang}${FAKE_CURSOR_END}`
                : `${detached.hardwareCursorMarker}${INVERSE_ON}${bang}${INVERSE_OFF}`;
            }
          }
        }

        const withPrompt = injectPromptSymbol(lines[firstContentIndex] ?? "", prompt);
        if (withPrompt !== undefined) lines[firstContentIndex] = withPrompt;
      }

      const label = isShell ? ` ${BOLD}${border("! shell mode")}${RESET} ` : undefined;
      return wrapWithRoundedBorder(lines, border, { label });
    } catch {
      // Cosmetic rendering must never make the editor unusable.
      this.detachedShellPrompt = false;
      return original;
    }
  }
}
