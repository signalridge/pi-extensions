import { Input } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { SafeInput } from "../src/input.js";
import { plain } from "../src/text.js";

const start = "\x1b[200~";
const end = "\x1b[201~";

test.each(Array.from({ length: 25 }, (_, i) => [1 + Math.floor(i / 5), 1 + (i % 5)]))(
  "native Input retains cursor/atomic Undo with paste markers split at %s/%s",
  (left, right) => {
    const native = new Input();
    const safe = new SafeInput(({ data }) => native.handleInput(data));
    safe.handleInput("abcd");
    safe.handleInput("\x01");
    for (const chunk of [start.slice(0, left), start.slice(left), "X\x1b[3", "1m\u202e\x03", end.slice(0, right)]) {
      safe.handleInput(chunk);
      expect(native.getValue()).toBe("abcd");
    }
    safe.handleInput(end.slice(right));
    expect(native.getValue()).toBe("Xabcd");
    safe.handleInput("Y");
    expect(native.getValue()).toBe("XYabcd");
    for (const before of ["Xabcd", "abcd", ""]) {
      safe.handleInput("\x1f");
      expect(native.getValue()).toBe(before);
    }
  },
);

test("raw DEL is native Backspace, while pasted DEL remains inert data", () => {
  const native = new Input();
  const safe = new SafeInput(({ data }) => native.handleInput(data));
  safe.handleInput("abcd");
  safe.handleInput("\x7f");
  expect(native.getValue()).toBe("abc");
  safe.handleInput(`${start}\x7f${end}`);
  expect(native.getValue()).toBe("abc");
});

test("split OSC/SGR/Unicode payloads stay data; nested paste starts do not restart or leak commands", () => {
  const native = new Input();
  const safe = new SafeInput(({ data }) => native.handleInput(data));
  const text = "中😀X\u202e\x1b[31m\x1b]52;c;secret\x07\x1b[A\x03";
  for (const unit of `${start}${text}${start}Z${end}`.split("")) safe.handleInput(unit);
  expect(native.getValue()).toBe("中😀XZ");
  expect(native.getValue()).toBe(plain(native.getValue()));
  safe.handleInput("\x1f");
  expect(native.getValue()).toBe("");
});

test("a paste and following submit in one input packet are separate native operations", () => {
  const native = new Input();
  let submitted: string | undefined;
  native.onSubmit = (value) => {
    submitted = value;
  };
  const safe = new SafeInput(({ data }) => native.handleInput(data));
  safe.handleInput(`${start}  exact\u202e  ${end}\r`);
  expect(submitted).toBe("  exact  ");
});

test("standalone Escape flushes, while complete native keys and safe Kitty printables are not rewritten", () => {
  vi.useFakeTimers();
  try {
    const dispatch = vi.fn();
    const safe = new SafeInput(dispatch);
    safe.handleInput("\x1b");
    expect(dispatch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(dispatch).toHaveBeenLastCalledWith({ kind: "key", data: "\x1b" });
    for (const key of ["\x1b[A", "\x1b[88u", "\x1b[127u", "中文", "\x1f", "\x1b[13;2u"]) {
      safe.handleInput(key);
      expect(dispatch).toHaveBeenLastCalledWith({ kind: "key", data: key });
    }
    const calls = dispatch.mock.calls.length;
    for (const unsafe of ["\u202e", "\x1b[8238u", "\x1b[27;1;8238~", "\x1b[55296u"]) safe.handleInput(unsafe);
    expect(dispatch).toHaveBeenCalledTimes(calls);
  } finally {
    vi.useRealTimers();
  }
});

test("CSI-u pasted newline/tab/CR decode before sanitization; malicious controls stay inert", () => {
  const dispatch = vi.fn();
  const safe = new SafeInput(dispatch);
  for (const unit of `${start}one\x1b[106;5utwo\x1b[73;5uthree\x1b[109;5ufour\x1b[99;5u\x1b[31m\x1b]52;c;secret\x07\u202e${end}`)
    safe.handleInput(unit);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ kind: "paste", data: `${start}one\ntwo    three\nfour${end}` });
});
