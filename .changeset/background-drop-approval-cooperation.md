---
"@signalridge/pi-background": minor
---

Remove the cooperative launch review for the retired `@signalridge/pi-approvals` extension. `bash_background` and command-starting `monitor` no longer look for a human approval service or advertise an approval adapter, and the package no longer depends on `@signalridge/pi-approval-core`. Launch inputs are still revalidated against the registered schema and frozen before dispatch. Permission extensions that gate `bash` must keep covering `bash_background` and `monitor` explicitly.
