---
name: opencode-plugins
description: Create, modify, debug, review, or migrate OpenCode v2 plugins in this repository. Also use when documenting plugin APIs or loading behavior.
---

# OpenCode v2 plugins

## Documentation

Read the current official pages relevant to the task before choosing APIs:

- [Plugin API and lifecycle](https://dev.opencode.ai/v2/docs/build/plugins/): setup, context, hooks, transforms, tools, providers, and models.
- [Configuration and loading](https://dev.opencode.ai/v2/docs/plugins): local paths, discovery, options, and reloads.
- [V1 migration](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1/): porting old entrypoints and hooks.
- [CLI plugins](https://dev.opencode.ai/v2/docs/build/plugins/cli/): terminal UI extensions.
- [RPC](https://dev.opencode.ai/v2/docs/build/plugins/rpc/): custom plugin methods and events.

Check `package.json`, the target plugin, and installed declarations under `node_modules/@opencode/plugin/dist/`. If current docs differ from the installed API, explain the mismatch and use compatible APIs; do not silently upgrade dependencies.

## Implementation

Use `plugins/<plugin-id>/index.ts` for server plugins. Keep IDs stable; they identify plugin storage and diagnostics. Start from the Promise API:

```ts
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "my-plugin",
  setup() {
    console.log("hello world");
  },
});
```

- Initialize and register behavior in `setup(ctx)`. Return cleanup for owned timers, subscriptions, and processes.
- Register hooks, tools, and transforms through the relevant context domain. Do not return a v1 hooks object or import `@opencode-ai/plugin`.
- Keep transform callbacks synchronous and repeatable. Fetch external data before a transform; call the relevant domain's `reload()` when captured data changes.
- Use `ctx.provider.transform` for provider definitions and source inventories; use `ctx.model.transform` for model policy and overrides.
- For terminal UI work, follow the CLI guide and use `@opencode/plugin/tui`; keep its entrypoint separate from server behavior.

## Loading and verification

`plugins/` at the repo root is not auto-discovered; only `.opencode/plugins/` (and `~/.config/opencode/plugins/`) loads automatically. For a local smoke test, point a test project's `opencode.jsonc` at the plugin directory using `"plugins": ["/absolute/path/to/plugins/my-plugin"]`. OpenCode requires configured local paths to be directories; a path to a single file is skipped. Relative entries resolve from the containing config file. Use a test config rather than changing user-wide settings.

Run `bun run typecheck`, then verify the requested behavior in OpenCode v2. Confirm the plugin ID appears in the active plugin list and exercise affected hooks or transforms. If resources are owned, verify cleanup on reload or unload. A direct `setup()` call checks initialization only; it does not prove host integration. Report which checks ran and any unavailable runtime checks.
