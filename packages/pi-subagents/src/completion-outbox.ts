/**
 * Completion delivery at parent boundaries, adapted from tintinweb/pi-subagents
 * 2f8dd3a3a16fcbad7a5105cbfacb1b722fe04c24 (MIT; package LICENSE retained).
 * Keep local grouped joins and ownership checks rather than importing its runtime.
 */
import type { NotificationDetails } from "./types.js";

export const NOTIFICATION_HOLD_MS = 200;
export interface OutboxMessage { content: string; details: NotificationDetails }
export interface OutboxItem {
  ids: string[];
  build(ids: readonly string[]): OutboxMessage | undefined;
}

/** Owned pending results stay cancellable until handed to Pi. */
export class CompletionOutbox {
  private items: OutboxItem[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retired = false;
  constructor(
    private readonly send: (message: OutboxMessage) => void,
    private readonly parentRunning: () => boolean,
  ) {}
  add(item: OutboxItem): void {
    if (this.retired) return;
    for (const id of item.ids) this.cancel(id);
    this.items.push({ ...item, ids: [...item.ids] });
    if (!this.parentRunning()) this.arm();
  }
  cancel(id: string): void {
    for (const item of this.items) item.ids = item.ids.filter((candidate) => candidate !== id);
    this.items = this.items.filter((item) => item.ids.length > 0);
    if (this.items.length === 0) { clearTimeout(this.timer); this.timer = undefined; }
  }
  onTurnEnd(stopReason: string | undefined): void {
    if (stopReason !== "aborted" && stopReason !== "error") this.flush(true);
  }
  onAgentEnd(): void {
    if (!this.retired && this.items.length > 0) this.arm();
  }
  dispose(): void {
    this.retired = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.items = [];
  }
  private arm(): void {
    if (this.retired || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(false); }, NOTIFICATION_HOLD_MS);
  }
  private flush(boundary: boolean): void {
    if (this.retired || (!boundary && this.parentRunning())) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.items;
    this.items = [];
    const messages: OutboxMessage[] = [];
    const retained: OutboxItem[] = [];
    const failed: OutboxItem[] = [];
    for (const item of batch) {
      try {
        const message = item.build(item.ids);
        if (message) { messages.push(message); retained.push(item); }
      } catch { failed.push(item); }
    }
    if (this.retired) return;
    this.items.unshift(...failed);
    if (messages.length === 0) return;
    try {
      this.send(combine(messages));
    } catch {
      if (this.retired) return;
      // No polling/retry loop. Another parent boundary may retry unhanded work.
      const newer = new Set(this.items.flatMap((item) => item.ids));
      this.items.unshift(...retained.map((item) => ({ ...item, ids: item.ids.filter((id) => !newer.has(id)) })).filter((item) => item.ids.length));
    }
  }
}
function combine(messages: OutboxMessage[]): OutboxMessage {
  if (messages.length === 1) return messages[0];
  const [first, ...others] = messages.flatMap(({ details: { others, ...own } }) => [own, ...(others ?? [])]);
  return { content: `${messages.length} background result batches completed.\n\n${messages.map((message) => message.content).join("\n\n")}`, details: { ...first, others } };
}
