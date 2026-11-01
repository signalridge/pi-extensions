---
"@signalridge/pi-secrets": minor
---

Initial experimental release: reversible secret obfuscation. Secret-looking environment values, URL passwords, vendor-prefixed tokens and configured literals or patterns are replaced by deterministic placeholders in provider-bound context, and placeholders in tool-call arguments are restored to real values just before the tool runs. Contextual pattern discoveries are retained for subsequent literal matches, and only placeholders actually issued by the registry exempt their contents from redaction. Verified placeholder overlaps are excluded before pattern discovery as well as replacement, so repeated obfuscation does not learn placeholders as new secrets or inflate source counts. Stored session entries are never changed; `/secrets` reports counts only. Adapted from oh-my-pi's secret obfuscation.
