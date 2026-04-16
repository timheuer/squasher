import * as vscode from 'vscode';
import { getGitAPI, execGit, execGitOrThrow, GitRepository } from './git';
import { squashCommits } from './squash';

// Arguments passed to commands contributed to `scm/historyItem/context`:
//   (provider: ISCMProvider, ...historyItems: SourceControlHistoryItem[])
// The provider's rootUri identifies the repository; each history item's `id`
// is the full commit SHA.
interface ScmProviderArg {
	readonly id?: string;
	readonly rootUri?: vscode.Uri;
}

interface HistoryItemArg {
	readonly id?: string;
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'squasher.squashCommits',
			async (provider?: ScmProviderArg, ...historyItems: HistoryItemArg[]) => {
				const hashes = historyItems
					.map((i) => i?.id)
					.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{7,40}$/i.test(id));

				if (hashes.length === 0) {
					vscode.window.showErrorMessage('Squasher: no commit selected.');
					return;
				}

				const api = await getGitAPI();
				if (!api) {
					vscode.window.showErrorMessage('Squasher: the built-in Git extension is not available.');
					return;
				}

				const repo = resolveRepository(api.repositories, provider?.rootUri);
				if (!repo) {
					vscode.window.showErrorMessage('Squasher: could not determine which Git repository these commits belong to.');
					return;
				}

				// The Source Control Graph tree is single-select
				// (multipleSelectionSupport: false), so we almost always receive
				// exactly one commit. Expand the selection to include every commit
				// from the picked one up to HEAD along first-parent, then let the
				// user trim the range via QuickPick before mutating history.
				let hashesToSquash = hashes;
				if (hashesToSquash.length === 1) {
					const expanded = await expandToHead(repo, hashesToSquash[0]);
					if (!expanded) {
						return;
					}
					if (expanded.length < 2) {
						vscode.window.showInformationMessage(
							'Squasher: that commit is already HEAD. Right-click an older commit (further down the graph) — Squasher combines that commit with everything above it up to HEAD.'
						);
						return;
					}
					const trimmed = await pickRangeFromHead(expanded);
					if (!trimmed) {
						return;
					}
					hashesToSquash = trimmed;
				}

				await squashCommits(repo, hashesToSquash);
			}
		),

		vscode.commands.registerCommand('squasher.squashCommitsFromPalette', async () => {
			const api = await getGitAPI();
			if (!api || api.repositories.length === 0) {
				vscode.window.showErrorMessage('Squasher: no Git repositories open.');
				return;
			}

			let repo: GitRepository | undefined;
			if (api.repositories.length === 1) {
				repo = api.repositories[0];
			} else {
				const pick = await vscode.window.showQuickPick(
					api.repositories.map((r) => ({ label: r.rootUri.fsPath, repo: r })),
					{ placeHolder: 'Select a Git repository' }
				);
				repo = pick?.repo;
			}
			if (!repo) {
				return;
			}

			const hashes = await pickCommits(repo);
			if (!hashes || hashes.length < 2) {
				return;
			}
			await squashCommits(repo, hashes);
		})
	);
}

function resolveRepository(repos: readonly GitRepository[], rootUri: vscode.Uri | undefined): GitRepository | undefined {
	if (rootUri) {
		const match = repos.find((r) => r.rootUri.fsPath === rootUri.fsPath);
		if (match) {
			return match;
		}
	}
	return repos.length === 1 ? repos[0] : undefined;
}

interface PreviewCommit {
	readonly hash: string;
	readonly short: string;
	readonly subject: string;
}

/**
 * Given a single commit, return [oldest, ..., HEAD] — the full range from that
 * commit up to HEAD along the first-parent path, with subject lines for
 * preview. Returns undefined if the commit is not an ancestor of HEAD.
 */
async function expandToHead(repo: GitRepository, hash: string): Promise<PreviewCommit[] | undefined> {
	const cwd = repo.rootUri.fsPath;

	// Reject root commits early — `<root>^` is not a valid revision and the
	// squash mechanic (`git reset --soft <oldest>^`) requires a parent.
	const parentCheck = await execGit(cwd, ['rev-parse', '--verify', '--quiet', `${hash}^`]);
	if (parentCheck.exitCode !== 0) {
		vscode.window.showErrorMessage(
			'Squasher: that commit is the root commit (it has no parent), so there is nothing to squash it into. Squasher cannot rewrite the root commit; use `git rebase --root -i` from the terminal if you need that.'
		);
		return undefined;
	}

	try {
		const out = await execGitOrThrow(cwd, [
			'rev-list',
			'--first-parent',
			'--pretty=format:%H%x00%h%x00%s',
			`${hash}^..HEAD`,
		]);
		// rev-list with --pretty emits a `commit <sha>` line followed by the
		// formatted line. Filter the format lines (those containing our \0).
		const newestFirst: PreviewCommit[] = out
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.includes('\u0000'))
			.map((l) => {
				const [full, short, subject] = l.split('\u0000');
				return { hash: full, short, subject };
			});
		if (newestFirst.length === 0) {
			vscode.window.showErrorMessage('Squasher: selected commit is not reachable from HEAD on the current branch.');
			return undefined;
		}
		return newestFirst.reverse(); // oldest-first
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Squasher: failed to compute commit range. ${msg}`);
		return undefined;
	}
}

/**
 * Let the user trim the squash range via a multi-pick QuickPick. All commits
 * start selected; the user can uncheck the oldest end to shrink the range.
 *
 * Squashing requires HEAD to be included and the selection to be contiguous
 * (squash core will reject gaps), so we validate on accept and return hashes
 * oldest-first. Returns undefined if the user cancels or the selection is
 * invalid.
 */
async function pickRangeFromHead(expandedOldestFirst: PreviewCommit[]): Promise<string[] | undefined> {
	// Display newest-first (HEAD on top) to match the graph's orientation.
	const newestFirst = expandedOldestFirst.slice().reverse();

	type Item = vscode.QuickPickItem & { readonly hash: string; readonly indexFromHead: number };
	const items: Item[] = newestFirst.map((c, i) => ({
		label: `${c.short}  ${c.subject}`,
		description: i === 0 ? '$(git-commit) HEAD' : undefined,
		hash: c.hash,
		indexFromHead: i,
	}));

	const qp = vscode.window.createQuickPick<Item>();
	qp.title = 'Squash Commits';
	qp.placeholder = 'Uncheck commits at the bottom to shrink the range. HEAD must stay selected.';
	qp.canSelectMany = true;
	qp.ignoreFocusOut = true;
	qp.matchOnDescription = true;
	qp.items = items;
	qp.selectedItems = items;

	return new Promise<string[] | undefined>((resolve) => {
		let resolved = false;
		const finish = (result: string[] | undefined) => {
			if (resolved) {
				return;
			}
			resolved = true;
			qp.hide();
			qp.dispose();
			resolve(result);
		};

		qp.onDidAccept(() => {
			const picked = qp.selectedItems.slice().sort((a, b) => a.indexFromHead - b.indexFromHead);

			if (picked.length < 2) {
				vscode.window.showWarningMessage('Squasher: select at least two commits to squash.');
				return;
			}
			if (picked[0].indexFromHead !== 0) {
				vscode.window.showWarningMessage('Squasher: HEAD (the top commit) must be included in the squash.');
				return;
			}
			// Contiguity: indices must be 0..N-1 with no gaps.
			for (let i = 0; i < picked.length; i++) {
				if (picked[i].indexFromHead !== i) {
					vscode.window.showWarningMessage('Squasher: selection must be contiguous — you cannot skip commits in the middle.');
					return;
				}
			}

			// Return oldest-first (what squashCommits expects).
			finish(picked.slice().reverse().map((p) => p.hash));
		});

		qp.onDidHide(() => finish(undefined));
		qp.show();
	});
}

async function pickCommits(repo: GitRepository): Promise<string[] | undefined> {
	const cwd = repo.rootUri.fsPath;
	const LIMIT = 50;
	let raw: string;
	try {
		raw = await execGitOrThrow(cwd, ['log', '-n', String(LIMIT), '--pretty=format:%H%x00%h%x00%s%x00%an']);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Squasher: failed to read git log. ${msg}`);
		return undefined;
	}

	const items = raw.split('\n').filter(Boolean).map((line) => {
		const [hash, short, subject, author] = line.split('\0');
		return {
			label: `${short}  ${subject}`,
			description: author,
			hash,
		};
	});

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: 'Select 2+ contiguous commits (newest first) to squash',
		matchOnDescription: true,
	});
	if (!picked || picked.length < 2) {
		return undefined;
	}
	return picked.map((p) => p.hash);
}

export function deactivate() { /* noop */ }

