import { Key, type KeyId } from "@earendil-works/pi-tui";
import type { Question, QuestionAnswer } from "../src/normalize.js";

export interface CapturedDialog {
  component: {
    render(width: number): string[];
    handleInput(data: string): void;
    dispose?(): void;
    focused?: boolean;
  };
  result: QuestionAnswer[] | undefined;
}

export function makeQuestions(overrides: Partial<Question> = {}): Question[] {
  return [
    {
      id: "choice",
      header: "Choice",
      question: "Which route should be used?",
      options: [
        { label: "Fast", value: "fast", description: "Optimizes for speed." },
        { label: "Safe", value: "safe", description: "Optimizes for safety." },
      ],
      multiSelect: false,
      allowOther: true,
      ...overrides,
    },
  ];
}

export function keybindings() {
  const bindings: Record<string, KeyId> = {
    "tui.select.up": Key.up,
    "tui.select.down": Key.down,
    "tui.select.pageUp": Key.pageUp,
    "tui.select.pageDown": Key.pageDown,
    "tui.select.confirm": Key.enter,
    "tui.select.cancel": Key.escape,
  };
  return {
    matches(data: string, key: string): boolean {
      return bindings[key] !== undefined && data === keyData(bindings[key]);
    },
    getKeys(key: string): readonly string[] {
      return bindings[key] === undefined ? [] : [String(bindings[key])];
    },
  };
}

function keyData(key: KeyId): string {
  switch (key) {
    case "up":
      return "\u001b[A";
    case "down":
      return "\u001b[B";
    case "pageUp":
      return "\u001b[5~";
    case "pageDown":
      return "\u001b[6~";
    case "enter":
      return "\r";
    case "escape":
      return "\u001b";
    default:
      return key;
  }
}

export function fakeTui() {
  return { terminal: { rows: 24 }, requestRender() {} } as never;
}

export function fakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as never;
}
