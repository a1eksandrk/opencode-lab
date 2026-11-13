# model-whitelist

An OpenCode v2 plugin that shows only an allowlist of models for selected
providers. Providers not listed are left untouched, so you don't have to
enumerate every model of a provider just to hide a few.

## Configuration

Load the plugin directory and pass options via `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/model-whitelist",
      "options": {
        "whitelist": {
          "openai": ["gpt-4o", "gpt-4o-mini"],
          "anthropic": ["claude-sonnet-5-5"]
        }
      }
    }
  ]
}
```

`whitelist` maps a provider ID to the model IDs to keep.

## Behavior

- For each provider listed in `whitelist`, only the listed model IDs remain;
  every other model is removed.
- An empty array hides every model of that provider.
- Providers not listed in `whitelist` are left unchanged.
- Matching is an exact, case-sensitive comparison against `model.id`.
- Entries that don't match any model are ignored silently.

## Notes

- Composite model IDs (for example OpenRouter's
  `openrouter/anthropic/claude-sonnet-4-5`) must be written in full.
- Options are read once when the plugin loads; changing `whitelist` requires
  reloading the plugin or session.
