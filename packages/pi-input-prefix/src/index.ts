import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

import {
  detachLeadingShellBang,
  highlightLeadingSlashToken,
  injectPromptSymbol,
  type Paint,
  resolvePromptMarker,
  wrapWithRoundedBorder,
} from "./render.js";

// Rounded, theme-following input textbox for Pi. Four columns of padding
// reserve room for a `>`/`!` prompt token, while a render post-pass turns
// Pi's horizontal rules into a rounded box. Native editing, autocomplete,
// history, IME, app shortcuts, and the active Pi theme remain intact.
//
// Override the normal prompt glyph with PI_INPUT_PREFIX. A single-cell glyph
// is required so the visual overlay does not disturb Pi's cursor math.
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
  muted: Paint;
  shell: Paint;
  slashToken: Paint;
}

class RoundedPromptEditor extends CustomEditor {
  private readonly colors: EditorColors;
  private detachedShellPrompt = false;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    const focus = theme.selectList.selectedText;
    const colors: EditorColors = {
      normal: theme.borderColor,
      focus,
      muted: theme.selectList.description,
      shell: focus,
      slashToken: (text) => `${BOLD}${focus(text)}${RESET}`,
    };
    super(tui, theme, keybindings, { paddingX: EDITOR_PADDING });
    this.colors = colors;
  }

  // Pi copies the default editor's padding immediately after the custom editor
  // factory returns. Keep four columns even when that default is 0.
  setPaddingX(padding: number): void {
    super.setPaddingX(Math.max(EDITOR_PADDING, padding));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Only the first rendered shell row moves: its bang is overlaid in the
    // padding and its remaining text shifts left one cell. Wrapping, scrolling,
    // autocomplete, and grapheme hit-testing remain owned by the base editor.
    const mapped =
      this.detachedShellPrompt && event.y === 1
        ? { ...event, x: event.x < EDITOR_PADDING ? EDITOR_PADDING : event.x + 1 }
        : event;
    // Start at the base prototype (including inherited methods), never this override.
    const base = CustomEditor.prototype as CustomEditor & {
      handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
    };
    return base.handleMouse?.call(this, mapped);
  }

  render(width: number): string[] {
    this.detachedShellPrompt = false;
    const original = super.render(width);
    if (original.length < 3) return original;

    try {
      const lines = [...original];
      const text = this.getText();
      const isShell = text.startsWith("!");
      const isSlashCommand = !isShell && text.trimStart().startsWith("/");
      // Follow the active Pi theme: default border at rest, accent for slash
      // commands and shell mode.
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
          const detached = detachLeadingShellBang(firstContent);
          lines[firstContentIndex] = detached.line;
          this.detachedShellPrompt = detached.detached;

          const bang = border("!");
          prompt = detached.cursorOnPrompt
            ? `${detached.hardwareCursorMarker}${INVERSE_ON}${bang}${INVERSE_OFF}`
            : bang;
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

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => new RoundedPromptEditor(tui, theme, keybindings));
  });
}
