# Agent instructions

- Reply in the user's language and write project documentation in English.
- Read the relevant files before editing. Keep changes focused on the task.
- Stack: Bun, TypeScript in strict mode, OpenCode v2 (`@opencode/plugin`).
- Use Bun for dependencies and commands. Update `bun.lock` when changing dependencies.
- Local skills live in `.agents/skills/<skill-name>/SKILL.md`. Read the applicable skill before using it.
- Run `bun run typecheck` after changing code or dependencies. Verify the affected behavior; report any checks you could not run.
- Update the README when changing the project structure, commands, or plugin behavior.
- Do not add secrets, create commits, push, or publish without an explicit user request.

## Skill routing

- For creating, changing, debugging, reviewing, or migrating OpenCode plugins, read and use [opencode-plugins](.agents/skills/opencode-plugins/SKILL.md).
- For documentation tasks, use this skill when describing plugin APIs or loading behavior; ordinary prose edits do not require it.

## Commit conventions

Follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/). Write the description (the text after the type/scope) in Russian.

```text
<type>[optional scope][!]: <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.

Rules:

- Keep the description concise and imperative, in Russian, with no trailing period.
- Use `!` after the type/scope for breaking changes (for example `feat!: ...`) and mention `BREAKING CHANGE:` in the footer when relevant.
- Add a body or footer only when the description needs more context.

Examples:

- `feat: добавить стартовый плагин example`
- `fix: исправить загрузку локальных плагинов`
- `docs: обновить инструкции в README`
- `chore: обновить зависимости`
