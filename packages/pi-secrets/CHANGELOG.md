# Changelog

## 1.3.0
### Minor Changes

- da9ed0f: Initial experimental release: reversible secret obfuscation. Secret-looking environment values, URL passwords, vendor-prefixed tokens and configured literals or patterns are replaced by deterministic placeholders in provider-bound context, and placeholders in tool-call arguments are restored to real values just before the tool runs. Contextual pattern discoveries are retained for subsequent literal matches, and only placeholders actually issued by the registry exempt their contents from redaction. Verified placeholder overlaps are excluded before pattern discovery as well as replacement, so repeated obfuscation does not learn placeholders as new secrets or inflate source counts. Stored session entries are never changed; `/secrets` reports counts only. Adapted from oh-my-pi's secret obfuscation.

### Patch Changes

- da9ed0f: Discover validated secrets across the whole provider-bound conversation before rewriting, so later contextual matches protect earlier bare values on the first request without changing stored input or replay counts. Apply value-aware safe labels before retaining pattern discoveries and issuing placeholders, including overlapping matches. Obfuscate bash execution full-output paths before Pi appends them to truncated command output.

## 1.2.0

- Initial experimental release: reversible secret obfuscation. Secrets from secret-looking environment variables, URL passwords, `pi-secrets.json` (user, and project when trusted) and built-in vendor token patterns are replaced with deterministic keyed placeholders in each provider request, restored in tool-call arguments before execution, and summarized by `/secrets` as counts only. Adapted from oh-my-pi.
