# @signalridge/pi-ui

Shared UI primitives for Signalridge Pi extensions.

## Bordered custom UI

Pi's native `ctx.ui.select()`, `confirm()`, `input()`, and `editor()` dialogs already own their terminal framing and RPC protocol. For extension-owned `ctx.ui.custom()` surfaces, use `withBorderedCustomUi()` when passing a context to a menu or UI library:

```ts
import { withBorderedCustomUi } from "@signalridge/pi-ui";

await runMenu(withBorderedCustomUi(ctx), menu, options);
```

The adapter adds the standard Pi top and bottom border rules to custom components that do not already render them. The outer rule uses the theme's `borderAccent` color (purple in the Signalridge themes). Existing bordered components are detected and are not double-framed. Input, focus, invalidation, disposal, overlay options, and RPC behavior are forwarded unchanged.

Use `borderedComponent()` when a package owns the custom factory directly. Persistent widgets, footers, and deliberately full-screen views are not dialogs and should not be wrapped automatically.

This package has no Pi manifest and is not loaded as an extension by itself. It is a normal library dependency of packages that use it.
