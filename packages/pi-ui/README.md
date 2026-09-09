# @signalridge/pi-ui

Shared UI primitives for Signalridge Pi extensions.

## Bordered custom UI

Pi's native `ctx.ui.select()`, `confirm()`, `input()`, and `editor()` dialogs already own their terminal framing and RPC protocol. For extension-owned `ctx.ui.custom()` surfaces, use `withBorderedCustomUi()` when passing a context to a menu or UI library:

```ts
import { withBorderedCustomUi } from "@signalridge/pi-ui";

await runMenu(withBorderedCustomUi(ctx), menu, options);
```

The adapter adds the standard Pi top and bottom border rules to custom components that do not already render them. The outer rule uses the theme's `borderAccent` color (purple in the Signalridge themes). Existing bordered components are detected and are not double-framed. Keyboard input, focus, invalidation, disposal, overlay options, and RPC behavior are forwarded unchanged. On mouse-capable Pi versions, pointer events are forwarded with coordinates adjusted for added border rows; those rules are not content hit targets. Existing borders retain their original mouse geometry and handlers retain their capture/focus results.

Use `borderedComponent()` when a package owns the custom factory directly. Persistent widgets, footers, and deliberately full-screen views are not dialogs and should not be wrapped automatically.

This package has no Pi manifest and is not loaded as an extension by itself. It is a normal library dependency of packages that use it.
