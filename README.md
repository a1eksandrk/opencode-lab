# opencode-lab

A collection of local TypeScript plugins for **OpenCode v2**. Bun manages dependencies and runs project commands.

## Plugins

| Plugin | Purpose |
| --- | --- |
| [model-fallback](plugins/model-fallback/README.md) | Retries a rate-limited subagent step on another configured model in the same child session. |
| [model-whitelist](plugins/model-whitelist/README.md) | Shows only an allowlist of models for selected providers. |

## Setup

Install [Bun](https://bun.com), then install the project dependencies:

```bash
bun install
```

## Project structure

```text
plugins/
  <plugin-id>/
    index.ts          # Plugin entrypoint
    package.json      # npm manifest: makes the plugin installable from git
    *.test.ts         # Unit and plugin-boundary tests next to the modules
    e2e/              # Opt-in integration fixtures and runner, when present
.agents/
  skills/             # Local agent skills
AGENTS.md             # Project instructions for agents
```

## Development

Each plugin lives in `plugins/<plugin-id>/index.ts` and exports an OpenCode v2 definition:

```ts
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "my-plugin",
  setup() {
    console.log("hello world");
  },
});
```

Run the type check:

```bash
bun run typecheck
```

Run plugin unit tests (colocated with the modules they cover):

```bash
bun test
```

The `model-fallback` integration suite requires OpenCode `2.3.2` on `PATH` and
runs directly with Bun. See its
[verification section](plugins/model-fallback/README.md#verification) for the
command, scope, and versions tested.

To load a plugin locally, add its directory to your project's `opencode.jsonc` (the path is relative to that config file):

```jsonc
{
  "plugins": ["./plugins/my-plugin"]
}
```

To install a released plugin, use its tag and the npm-compatible git
specification with a subdirectory selector:

```bash
opencode plugin add 'github:a1eksandrk/opencode-lab#model-whitelist/v1.0.0::path:plugins/model-whitelist'
```

Use `model-fallback/v1.0.0` and `plugins/model-fallback` for the other plugin.
These examples work once their corresponding tags have been pushed. `::path:`
requires a `package.json` in the target subdirectory. Reference the plugin in
config by the same git specification — a bare package name only works after
publishing the package to npm. Tags can be moved; use a full commit hash instead
when an immutable Git reference is required.

## Releasing plugins

Each plugin has an independent version in its `package.json` and a tag of the
form `<plugin-id>/v<major>.<minor>.<patch>`. GitHub Releases share one
repository-wide list; each tag identifies the plugin it releases. Tags point to
the entire repository commit, while `::path:` selects the plugin to install.

To release a plugin:

1. Update its `package.json` version, run the checks, and commit the changes.
2. Push the commit, then create and push the matching tag. For example:

   ```bash
   git tag model-whitelist/v1.0.0
   git push origin model-whitelist/v1.0.0
   ```

3. The release workflow checks that the tag matches the package version, runs
   typechecking and tests, and creates a GitHub Release. The workflow requires
   Actions to have permission to write repository contents. If a check fails,
   rerun it after resolving transient or permission issues. If the tagged code
   or version needs fixing, commit the fix and use a new version and tag; do not
   move an already published tag. Edit the release notes on GitHub to add
   plugin-specific changes.

For the initial releases, create and push both `model-whitelist/v1.0.0` and
`model-fallback/v1.0.0` after the release workflow and plugin changes have been
committed and pushed. Later releases can use different versions. The workflow
accepts stable three-component versions only; it does not publish to npm or
mark a plugin release as the repository-wide latest release.

OpenCode loads the plugins; this project has no standalone application to run. See the [OpenCode v2 plugin documentation](https://dev.opencode.ai/v2/docs/build/plugins/) for the API and loading instructions.

## Working with agents

Project instructions live in [AGENTS.md](AGENTS.md). Before making changes, agents read the relevant files and applicable skills. After making changes, they verify the result and report the checks performed.

The [opencode-plugins skill](.agents/skills/opencode-plugins/SKILL.md) covers plugin development, current documentation, and verification. `AGENTS.md` routes plugin tasks to this skill.

Add new skills in `.agents/skills/<skill-name>/SKILL.md`. Each `SKILL.md` should describe the skill's purpose, when to use it, steps, and checks.
