# opencode-plugins

A collection of local TypeScript plugins for **OpenCode v2**. Bun manages dependencies and runs project commands.

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

Run plugin tests:

```bash
bun test
```

To load a plugin, add its directory to your project's `opencode.jsonc` (the path is relative to that config file):

```jsonc
{
  "plugins": ["./plugins/my-plugin"]
}
```

OpenCode loads the plugins; this project has no standalone application to run. See the [OpenCode v2 plugin documentation](https://dev.opencode.ai/v2/docs/build/plugins/) for the API and loading instructions.

## Working with agents

Project instructions live in [AGENTS.md](AGENTS.md). Before making changes, agents read the relevant files and applicable skills. After making changes, they verify the result and report the checks performed.

The [opencode-plugins skill](.agents/skills/opencode-plugins/SKILL.md) covers plugin development, current documentation, and verification. `AGENTS.md` routes plugin tasks to this skill.

Add new skills in `.agents/skills/<skill-name>/SKILL.md`. Each `SKILL.md` should describe the skill's purpose, when to use it, steps, and checks.
