---
"@signalridge/pi-todo": patch
---

Avoid repeatedly serializing unchanged native history with bounded, value-validated canonical fingerprint memoization. Validate array identity explicitly and exclude native raw JSON and boxed primitives even when their prototypes or descriptors look like plain data. Reuse exact canonical disk-line digests without weakening fresh ownership, ancestry, header, file-identity or durability verification.
