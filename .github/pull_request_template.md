## What and why

<!-- What does this change do, and why? Link the issue it fixes: "Fixes #123". -->

## How was it tested?

<!-- bun run test, manual steps in bun run dev, screenshots for UI changes. -->

## Checklist

- [ ] `bun run test` and `bun run build` pass
- [ ] Follows the hard rules in [CLAUDE.md](../CLAUDE.md) (IPC only via preload, commands registry, no `Promise.all` in `src/main`, theme tokens instead of hex colors)
- [ ] Docs updated if behaviour changed (`docs/FEATURES.md`, a guide in `docs/guides/`, `docs/CODEBASE.md`)
- [ ] `CHANGELOG.md` updated under "Unreleased" for user-facing changes
