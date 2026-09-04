---
"@signalridge/pi-agent-guidance": patch
"@signalridge/pi-analytics": patch
"@signalridge/pi-btw": patch
"@signalridge/pi-codex-compact": patch
"@signalridge/pi-files-widget": patch
"@signalridge/pi-github-pr": patch
"@signalridge/pi-goal": patch
"@signalridge/pi-input-history": patch
"@signalridge/pi-lsp": patch
"@signalridge/pi-plan-mode": patch
"@signalridge/pi-ralph-wiggum": patch
"@signalridge/pi-recall": patch
"@signalridge/pi-stamp": patch
"@signalridge/pi-subagents": patch
"@signalridge/pi-usage-extension": patch
"@signalridge/pi-worktree": patch
---

Converge every README on one house style: plain sentence-case headings, no
decorative emoji.

Ten packages carried an emoji heading scheme inherited from their upstream
forks while the other nineteen used plain headings, so the same monorepo
rendered as two unrelated projects on npmjs.com. Headings are now emoji-free
and titles are sentence case.

Also removes the `Keywords` section from those ten. It duplicated each
package's `package.json` `keywords` field, which is what npm actually indexes,
and no plain-style README carried one. `Installation` is now `Install`
everywhere.

Headings that were Title Case are sentence case too, so one convention now
covers the whole monorepo. Existing in-page anchor links are unaffected:
GitHub lowercases heading slugs already.

Documentation only — no runtime change.
