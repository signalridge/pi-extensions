---
"@signalridge/pi-statusline": patch
---

Stop labelling an extension status twice when its text starts with its key followed by a space, or is just the key in another case: `loop 1 · next 3m` rendered as `loop loop 1 · next 3m`. With an icon configured, the icon replaces the key, as it already does for `key: text`.
