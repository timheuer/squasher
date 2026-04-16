# Squasher

Squash multiple local Git commits into one, directly from the VS Code Source Control Graph.

## Features

- **Right-click in the Source Control Graph**: multi-select commits (Ctrl+click) and choose **Squash Commits**.
- **Command Palette fallback**: run **Squasher: Squash Commits...** to pick commits from a list.
- Opens the concatenated commit messages in an editor so you can craft the final message.
- Runs `git reset --soft <oldest>^` followed by `git commit -F <message>` - with automatic rollback to `ORIG_HEAD` on failure.
- Prompts to auto-stash / pop uncommitted changes so the working tree is clean for the squash.

## Requirements

- VS Code 1.93+ with the built-in Git extension enabled.
- `git` available on the `PATH`.

## Installation

Squasher relies on the `contribSourceControlHistoryItemMenu` **proposed API**, so it cannot be published to the VS Code Marketplace until that API stabilizes. In the meantime, install the signed VSIX from the [GitHub Releases](https://github.com/timheuer/squasher/releases) page:

1. Download `squasher-<version>.vsix` from the latest release.
2. Install it — either via **Extensions view → … menu → Install from VSIX…** or:

   ```pwsh
   code --install-extension squasher-<version>.vsix
   ```

3. Launch VS Code with proposed APIs enabled for this extension:

   ```pwsh
   code --enable-proposed-api timheuer.squasher
   ```

   Add that flag to your shortcut/launcher so you don't have to type it every time.

## Limitations

- Selected commits must be **contiguous** and end at the current `HEAD` of a named branch. Use interactive rebase for mid-history or non-contiguous squashes.
- The **root commit** cannot be the oldest commit in a squash (it has no parent to reset to). Use `git rebase --root -i` for that.
- Merge commits are not supported.
- The Source Control Graph view is single-select only (a VS Code limitation), so right-click squashes always run from the picked commit up to `HEAD`. Use the Command Palette (`Squasher: Squash Commits...`) for an explicit multi-pick.
- If the commits have already been pushed, you will need to force-push afterwards — Squasher does not do this automatically.
- The Source Control Graph context menu relies on the `scm/historyItem/context` menu id. The Command Palette command works regardless.

## Credits

- Extension icon: <a href="https://www.flaticon.com/free-icons/squash" title="squash icons">Squash icons created by Umeicon - Flaticon</a>.
