---
setup:
  - bun install --frozen-lockfile
---

The only dependencies are dev tools from `bun.lock` (Biome, `@types/bun`, TypeScript);
`bun install --frozen-lockfile` puts them in `node_modules` without rewriting the lockfile.
The panel under `panel/` is plain JS served as-is, so there is no build step.

Checks, as the README's Develop section lists them: `bun test`, `bun run typecheck`
(`tsc --noEmit`), `bun run check` (`biome check .`).

Relies on outside the worktree: `bun` on `PATH` and network access to the npm registry
(or a warm bun cache). The tests read nothing from prifly or Windows; running the
extension itself needs a prifly host to load it.
