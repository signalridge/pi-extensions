import assert from "node:assert/strict";

/** Existing warning contracts remain exact after validating the new closed suffix. */
export function withoutDiagnosticSummary(message: string): string {
  const start = message.indexOf(" Last stage:");
  if (start < 0) return message;
  assert.match(
    message.slice(start),
    /^ Last stage: (auth|payload|fetch|headers|first_body|wire_terminal|provider_done|completion_wait|fold_done); \d+\/\d+ folds, \d+ HTTP attempts, \d+ ms; timeout=(none|stage|operation), stage\/total=\d+\/\d+ ms\. See \/codex-compact diagnostics\.$/,
  );
  return message.slice(0, start);
}
export function withoutDiagnosticSummaries<T extends { message: string }>(notifications: T[]): T[] {
  return notifications.map((notification) => ({
    ...notification,
    message: withoutDiagnosticSummary(notification.message),
  }));
}
