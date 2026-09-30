---
"@signalridge/pi-statusline": patch
---

Include standalone Pi session usage entries, such as cache warming, in historical and live footer tokens, cache, and cost without counting an entry twice. Skip history copies when usage is hidden or the session leaf is unchanged, and inspect only appended entries when it advances.
