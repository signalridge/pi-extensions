import { afterEach, expect, it, vi } from "vitest";
import { commandCharacter, DraftInput } from "../src/draft-input.js";
import { modelJson } from "../src/state.js";
import { display } from "../src/ui.js";

afterEach(() => vi.useRealTimers());
it.each([
  ["\x1b[97u", "a"],
  ["\x1b[101u", "e"],
  ["\x1b[115u", "s"],
  ["\x1b[100u", "d"],
  ["\x1b[68u", "D"],
  ["\x1b[100;2u", "D"],
  ["\x1b[100:68;2u", "D"],
  ["\x1b[63u", "?"],
  ["\x1b[121u", "y"],
  ["\x1b[112u", "p"],
  ["\x1b[110u", "n"],
  ["\x1b[110;2u", "N"],
  ["\x1b[100;3u", undefined],
  ["\x1b[100;5u", undefined],
  ["\x1b[100;9u", undefined],
  ["\x1b[100;1:3u", undefined],
  ["\x1b[200~a\x1b[201~", undefined],
])("decodes character command %j as %j", (data, expected) => {
  expect(commandCharacter(data ?? "")).toBe(expected);
});
it("disposes ambiguous paste-prefix timers and discards buffered input", () => {
  vi.useFakeTimers();
  const dispatch = vi.fn();
  const input = new DraftInput(display, dispatch);
  input.handleInput("\x1b[20");
  expect(vi.getTimerCount()).toBe(1);
  input.dispose();
  expect(vi.getTimerCount()).toBe(0);
  input.handleInput("0~late\x1b[201~");
  vi.advanceTimersByTime(100);
  expect(dispatch).not.toHaveBeenCalled();
});
it("keeps Escape separate from a subsequent complete key while still consuming split paste", () => {
  vi.useFakeTimers();
  const dispatch = vi.fn();
  const input = new DraftInput(display, dispatch);
  input.handleInput("\x1b");
  input.handleInput("\x1b[H");
  expect(dispatch.mock.calls).toEqual([
    ["\x1b", false],
    ["\x1b[H", false],
  ]);
  dispatch.mockClear();
  for (const chunk of ["\x1b", "[20", "0~", "a", "\x1b[201~"]) input.handleInput(chunk);
  expect(dispatch.mock.calls).toEqual([["\x1b[200~a\x1b[201~", true]]);
  input.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("filters encoded unsafe printable keys without replacing native keyboard semantics", () => {
  const dispatch = vi.fn();
  const input = new DraftInput(display, dispatch);
  input.handleInput("\x1b[8238u");
  input.handleInput("\x1b[27;1;8238~");
  expect(dispatch).not.toHaveBeenCalled();
  input.handleInput("\x1b[88u");
  input.handleInput("\x1b[127u");
  input.handleInput("\x7f");
  expect(dispatch.mock.calls).toEqual([
    ["\x1b[88u", false],
    ["\x1b[127u", false],
    ["\x7f", false],
  ]);
  input.dispose();
});
it("tool/model JSON escapes bidi instructions without changing task data or CJK", () => {
  const value = { title: "中文👩‍💻\u202e task", description: "\x1b]52;c;test\x07" };
  const encoded = modelJson(value);
  expect(encoded).not.toContain("\u202e");
  expect(encoded).not.toContain("\x1b");
  expect(encoded).toContain("\\u202e");
  expect(encoded).toContain("中文👩‍💻");
  expect(JSON.parse(encoded)).toEqual(value);
});
it("inert display removes OSC, bidi and cursor instructions but retains CJK and joined emoji", () => {
  const text = "中文👩‍💻\nnext";
  expect(display(text)).toBe(text);
  expect(display(`\x1b]52;c;test\x07\x1b[2J\u202e${text}`)).toBe(text);
});
