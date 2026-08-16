# pi-herdr-state

Signalridge's resume-safe Pi lifecycle reporter for herdr. It is best-effort and self-disables unless the herdr environment is present.

The reporter follows the Herdr 0.8+ protocol-v8 bundled Pi integration. It sends `pane.report_agent_session` with the current absolute session path (or ID fallback), includes the supported `session_start_source`, and attaches that same session reference to every `pane.report_agent` state report. It reports only from Pi's TTY mode.

This package is the single owner for the `herdr:pi` source. Keep Herdr's bundled `pi` integration uninstalled; installing both reporters causes competing lifecycle updates.

## Install

```bash
pi install npm:@signalridge/pi-herdr-state
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-herdr-state
```

## Migrating from the legacy package

`@signalridge/herdr-pi-state` was published before the repository naming convention changed. npm package names cannot be renamed; uninstall the legacy package from Pi before installing this replacement. The runtime identifiers (`herdr:pi`, `HERDR_PI_*`, and `~/.pi/agent/herdr-pi-state.log`) remain unchanged.
