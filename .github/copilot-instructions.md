# Copilot Instructions for Squasher

Squasher is a VS Code extension that adds "Squash Commits" to the built-in Source Control Graph and Command Palette. Keep suggestions aligned with the conventions below.

## Project layout

- `src/extension.ts` — activation entry point. Registers `squasher.squashCommits` (graph context-menu command, receives `(focused, selected[])`) and `squasher.squashCommitsFromPalette` (QuickPick fallback). Do not add business logic here; delegate to `squash.ts`.
- `src/squash.ts` — core orchestration: topo-sort, contiguity validation against HEAD's first-parent, dirty-tree auto-stash, message prefill, `git reset --soft <oldest>^` + `git commit -F`, rollback to `ORIG_HEAD` on failure.
- `src/git.ts` — thin wrapper over the built-in `vscode.git` API (`getGitAPI`) and `child_process.spawn` (`execGit` / `execGitOrThrow`). All shelling out to `git` goes through these helpers.
- `src/messageEditor.ts` — opens an untitled `git-commit` document prefilled with concatenated messages and confirms via a modal dialog. Also exports `stripCommentLines`.
- `src/test/extension.test.ts` — Mocha suite run via `@vscode/test-cli`. Unit-test pure functions (`buildCombinedMessage`, `stripCommentLines`); do not require a real git repo.
- `package.json` — manifest. Bundler is esbuild (`esbuild.js`), output `dist/extension.js`.

## Conventions

- **Never call `git` directly** from outside `git.ts`. Use `execGit` (returns `{stdout, stderr, exitCode}`) for commands that may fail by design, and `execGitOrThrow` for commands that must succeed.
- **Do not use the Git extension's `Repository` methods to mutate history.** The public API lacks a raw exec, so we shell out. Use `Repository.rootUri.fsPath` as `cwd`.
- **Always validate before mutating.** Require ≥2 commits, not detached HEAD, contiguous suffix of HEAD first-parent. Surface failures via `vscode.window.showErrorMessage` with the `Squasher:` prefix.
- **Safety rails**: any mutating sequence must be wrapped so that a failure triggers `git reset --hard ORIG_HEAD`. Prompt (modal) before stashing dirty trees; pop the stash in a `finally` block.
- **User messages** start with `Squasher:` and are actionable. Avoid raw stderr dumps; trim and summarize.
- **Proposed APIs**: `contribSourceControlHistoryItemMenu` is enabled (required for the `scm/historyItem/context` menu contribution). This prevents Marketplace publishing — ship via VSIX / Insiders only until the proposal stabilizes. Add new proposals to `enabledApiProposals` in `package.json` and document the caveat in the README.

## Commit-selection semantics

- The graph context command is invoked with `(provider: ISCMProvider, ...historyItems: SourceControlHistoryItem[])` (VS Code passes `arg` = provider plus `getActionsContext()` = the focused history item). The Source Control Graph tree is single-select (`multipleSelectionSupport: false`), so expect exactly one history item.
- A `SourceControlHistoryItem.id` is the full commit SHA. Validate it matches `/^[0-9a-f]{7,40}$/i` before using (`provider.id` is literally `"git"`).
- Repository resolution: use `provider.rootUri` against `api.repositories`; fall back to the sole open repo.
- For a single-commit invocation, expand to `[commit..HEAD]` via `git rev-list --first-parent <hash>^..HEAD`, confirm via modal dialog, then delegate to the core squash.
- The palette fallback reads `git log -n 50` with null-separated format; keep the separator `\x00` so subjects with spaces/tabs survive.

## Squash mechanics (do not change without discussion)

1. `rev-list --no-walk --topo-order <hashes>` → reverse → oldest-first.
2. Validate newest === HEAD and `rev-list --first-parent -n N HEAD` matches selection.
3. Concatenate messages newest-first, each block prefixed with `# <short>`.
4. `git reset --soft <oldest>^`.
5. Write message to a temp file under `os.tmpdir()`, run `git commit -F <file> --allow-empty`, always delete the temp file.
6. On any error after step 4, attempt `git reset --hard ORIG_HEAD` and surface both errors.

## Style

- TypeScript strict. Prefer `readonly` arrays / properties on public shapes.
- 4-space indentation, single quotes, trailing semicolons (matches existing files).
- Export only what other modules need; keep helpers file-local.
- No new runtime dependencies without strong justification — prefer spawning `git` or using built-in Node/VS Code APIs.
- Respect ESLint (`npm run lint`). Do not disable rules inline without a comment explaining why.

## Build & test

- `npm run compile` → type-check + lint + esbuild bundle. Must pass before considering work done.
- `npm run watch` for iterative development.
- `npm test` runs the Mocha suite via `@vscode/test-cli`. Keep unit tests hermetic (no real git).

## Out of scope (reject politely if asked)

- Interactive rebase / reordering commits.
- Squashing across merge commits or non-contiguous ranges.
- Automatic `git push --force` (warn users instead).
- Replacing the built-in Git extension's commands.
