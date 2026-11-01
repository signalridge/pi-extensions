# Changelog

## 1.2.0

- Initial experimental release: reversible secret obfuscation. Secrets from secret-looking environment variables, URL passwords, `pi-secrets.json` (user, and project when trusted) and built-in vendor token patterns are replaced with deterministic keyed placeholders in each provider request, restored in tool-call arguments before execution, and summarized by `/secrets` as counts only. Adapted from oh-my-pi.
