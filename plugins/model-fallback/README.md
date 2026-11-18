# model-fallback

An OpenCode v2 plugin that retries a rate-limited subagent step on another
configured model **inside the same child session**. It keeps the child
conversation, completed tool calls, and the parent invocation intact; it never
restarts the subagent, replays the prompt, or starts a new child.

Rules belong to models; a switch belongs to one session. A fallback entry is
configured for a source model, and only the child whose native retry reports
`429` is switched. A parent or any other session on the same model keeps its
selection.

## Install

From git (the directory is a self-contained npm package):

```bash
opencode plugin add 'github:a1eksandrk/opencode-lab#model-fallback/v1.0.0::path:plugins/model-fallback'
```

The tag must exist on GitHub before installing. Reference the plugin in config
by the same git specification; a bare package
name (`opencode-model-fallback`) only resolves after publishing to npm.

## Configuration

Load the plugin directory and pass an ordered fallback list per source model:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/model-fallback",
      "options": {
        "fallback": {
          "provider-a/model-x": [
            "provider-b/model-y#high",
            "provider-c/model-z"
          ]
        }
      }
    }
  ]
}
```

- A source key is exactly `providerID/modelID`. Use the IDs shown by OpenCode;
  model IDs may contain `/`, and the provider is split at the first `/`.
- A source matches every variant of that model. Do not put a `#variant` in a
  source key.
- A target is `providerID/modelID` or `providerID/modelID#variant`.
- A bare target uses the target model's default. An explicit `#variant` must be
  declared by the target model. Effort and other options are never inherited
  from the source.
- Self-targets (the same provider and model as the source) are ignored, and
  identical target references are deduplicated while preserving order.
- Malformed entries are diagnosed and skipped; valid sibling entries stay
  active. A missing or empty mapping is a no-op.

## Behavior

- The trigger is the host's native `retry` hook with `error.status === 429` in a
  child session whose selected model is a configured source or the current
  target of that child's chain. The plugin does not observe or replace HTTP
  requests. If OpenCode handles an error without calling `retry`, the plugin
  does nothing. If it calls `retry`, the same model-scoped rule applies
  regardless of what initiated that retry.
- A root session, an unknown session, a non-`429` error, or a retry whose model
  no longer matches the child's selection leaves the incoming decision
  untouched. A stale retry or a failed session lookup does not by itself discard
  an existing chain.
- After a confirmed `session.switchModel`, the plugin requests
  `{ retry: true, delay: 0 }`. The next request retries the step in the same
  child with its existing history and tool results. The plugin never calls
  `session.prompt`, creates a child, proxies requests, or rewrites messages.
- The chain is built only from the original source's ordered list. A target's
  own mapping is never expanded. The cursor advances only after a confirmed
  switch, so an entry skipped before a takeover is not reconsidered and the
  chain does not bounce back to the source.
- Targets are resolved against the active model inventory. A missing or disabled
  model, or an unavailable explicit variant, is skipped with a bounded
  diagnostic. If no candidate can take over before the first successful switch,
  the native decision is left unchanged. If the inventory cannot be read, the
  plugin does not switch.
- After a successful takeover, a later qualifying `429` with no remaining
  candidate stops the retry so OpenCode delivers the terminal child error. The
  host's own retry budget remains authoritative.
- A successful fallback stays active for later steps in that child. A fresh
  child starts on the configured source, and a follow-up sent to an existing
  child by `sessionID` keeps its stored model. Changing the child's model
  outside the plugin ends ownership of the old chain instead of overriding the
  new selection.
- At most one routing decision runs per child. An interruption or deletion
  invalidates a pending decision, and plugin unload closes the router before any
  asynchronous cleanup. An invalidated operation cannot switch a model, publish
  a retry decision, or update chain state even if its switch request completes
  later. An interruption preserves an already confirmed chain, but does not
  retain a chain that never took over. If the host already committed a switch,
  the plugin does not roll it back.
- Routing state is in memory, bounded, and dropped on session deletion and
  plugin unload. A reload does not restore a chain or change a stored model.

## Limits

- Only HTTP status `429` is treated as a rate limit. There is no fallback for
  network errors or `5xx`, no custom `Retry-After` policy, no workspace-wide
  cooldown, and no UI.
- The retry hook does not distinguish the original request from an auxiliary
  one. Because rules are model-scoped, a child `retry(429)` for an auxiliary
  request on a mapped model can also take over.
- OpenCode has no atomic selection-and-switch call. The post-switch check
  reduces, but cannot eliminate, the race between a host-side switch and a newer
  manual selection.
- Cross-provider fallback is supported at the plugin layer, including an
  OpenAI-compatible source falling back to a native Anthropic driver.

## Troubleshooting

Diagnostics are printed with the `[model-fallback]` prefix.

- **A `429` in a root session did not fall back.** Root sessions are out of
  scope by design; only child sessions are handled.
- **The plugin did not switch.** Check that the source key exactly matches
  `providerID/modelID`, that the target still appears in the active model list,
  and that an explicit `#variant` is declared by the target. Failed session or
  inventory lookups and externally changed selections leave the native decision
  untouched.
- **A fallback was skipped.** The model may be disabled or filtered by another
  plugin, for example `model-whitelist`. A target that recovers after the chain
  moved past it is not reconsidered.
- **The child stayed on the fallback.** This is expected for later steps and for
  follow-ups to the existing child. Start a fresh subagent to use the configured
  source again.

## Verification

Versions tested: OpenCode `2.3.2` with `@opencode/plugin` `2.1.3`.

From the repository root:

```bash
bun run typecheck
bun test
opencode --version
bun run plugins/model-fallback/e2e/run.ts
```

`bun test` runs the colocated unit and plugin-boundary tests and never starts
OpenCode. The integration runner requires OpenCode `2.3.2` on `PATH`, creates an
isolated temporary project with local mock providers, and removes it afterwards.
It covers:

- the core same-child retry, including one completed `read`, one subagent
  invocation, one parent report, the original tool result, and an unchanged
  parent model;
- root and non-`429` native behavior;
- an ordered two-step chain and terminal exhaustion;
- a fresh and a resumed child;
- cross-provider selection with an explicit variant, and a missing variant
  falling through to the next target.

Run one scenario with its name, for example `core`:

```bash
bun run plugins/model-fallback/e2e/run.ts core
```

To check the packaged artifact, pack the plugin from its directory and point the
runner at the extracted package:

```bash
cd plugins/model-fallback
bun pm pack --dry-run
PACK_DIR=$(mktemp -d)
bun pm pack --destination "$PACK_DIR"
cd ../..
tar -xzf "$PACK_DIR/opencode-model-fallback-1.0.0.tgz" -C "$PACK_DIR"
MODEL_FALLBACK_PLUGIN_DIR="$PACK_DIR/package" \
  bun run plugins/model-fallback/e2e/run.ts core
rm -rf "$PACK_DIR"
```

Use a fresh directory outside the repository and remove it afterwards. The
runner prints the plugin directory it loaded; confirm it is the extracted
package, not the workspace directory.
