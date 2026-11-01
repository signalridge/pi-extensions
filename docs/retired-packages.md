# Retired packages

A retired package is removed from this repository and receives no further
releases. Its published npm versions stay installable; the npm package is
marked deprecated with a pointer to its replacement. Retirement is not a
version bump of any remaining package.

Retire a package when another owner covers its job better — the host itself, an
official integration, or a sibling package — or when it no longer earns its
maintenance. Remove its directory, every documentation and script reference,
and record it here with the last published version and a migration path.

| Package | Last version | Retired | Replacement | Migration |
| --- | --- | --- | --- | --- |
| `@signalridge/pi-herdr-state` | 1.3.3 | 2026-11 | herdr's bundled Pi integration | Remove the package from Pi, then run `herdr integration install pi`. Load only one reporter for the `herdr:pi` source. |
| `@signalridge/pi-approvals` | 1.3.0 | 2026-11 | A permission extension such as `@gotgenes/pi-permission-system`, or a command blocker such as `cc-safety-net` | Remove the package from Pi. `pi-background` and `pi-subagents` no longer look for its service. |
| `@signalridge/pi-approval-core` | 1.3.0 | 2026-11 | — (library of `pi-approvals`) | Nothing to do; no remaining package depends on it. |

## Notes

### `pi-approvals` and `pi-approval-core`

`pi-approvals` reviewed individual local mutations from cooperating tools, but
only after an explicit native-backend certification flag and with a live
adapter for every noncanonical command or mutation tool. Its fail-closed gate
therefore denied ordinary tools from other extensions that had no adapter, so
it could not be enabled in most real tool loadouts, and it stayed experimental.
Permission extensions that apply policy to every tool call cover the common
need without per-tool adapters. Keeping it meant cooperation code in
`pi-background` and `pi-subagents` that ran only when the service was loaded;
that code is removed with it. `pi-approval-core` existed only to share the
service contracts and reviewed tool factories.

### `pi-herdr-state`

herdr ships and versions its own Pi integration and updates it together with
its socket protocol, so a second implementation can only lag behind it. The
bundled integration reports session identity and `working`/`blocked`/`idle`
state from TUI sessions, and consumes `herdr:blocked` events on `pi.events`.
It does not translate Pi's native dialog events into `blocked`; an extension
that blocks on a dialog and wants herdr to show it emits `herdr:blocked`
itself.
