import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execGit, execGitOrThrow, GitRepository } from './git';
import { promptForSquashMessage } from './messageEditor';

export interface CommitInfo {
    readonly hash: string;
    readonly message: string;
}

/**
 * Sort commit hashes from oldest to newest using topological order.
 * Accepts partial/short hashes; returns full hashes.
 */
export async function topoSortHashes(cwd: string, hashes: string[]): Promise<string[]> {
    if (hashes.length === 0) {
        return [];
    }
    // rev-list --no-walk --topo-order emits newest-first by default.
    const out = await execGitOrThrow(cwd, ['rev-list', '--no-walk', '--topo-order', ...hashes]);
    const newestFirst = out.split('\n').map((l) => l.trim()).filter(Boolean);
    return newestFirst.reverse(); // oldest-first
}

/**
 * Validate that the selected (sorted oldest-first) commits form a contiguous
 * suffix of HEAD's first-parent history, i.e. newest === HEAD, and each
 * subsequent commit is the first parent of the previous one.
 */
export async function validateContiguousFromHead(cwd: string, sortedOldestFirst: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (sortedOldestFirst.length < 2) {
        return { ok: false, reason: 'Select at least two commits to squash.' };
    }
    const head = (await execGitOrThrow(cwd, ['rev-parse', 'HEAD'])).trim();
    const newest = sortedOldestFirst[sortedOldestFirst.length - 1];
    if (newest !== head) {
        return { ok: false, reason: 'Squash requires the newest selected commit to be HEAD.' };
    }

    // Walk from HEAD backwards via first-parent for N-1 steps; each step must
    // match the next (older) selected commit.
    const needed = sortedOldestFirst.length;
    const walkOut = await execGitOrThrow(cwd, ['rev-list', '--first-parent', `-n`, String(needed), 'HEAD']);
    const walk = walkOut.split('\n').map((l) => l.trim()).filter(Boolean); // newest-first
    if (walk.length < needed) {
        return { ok: false, reason: 'Not enough history to squash the selected commits.' };
    }
    const walkOldestFirst = walk.reverse();
    for (let i = 0; i < needed; i++) {
        if (walkOldestFirst[i] !== sortedOldestFirst[i]) {
            return { ok: false, reason: 'Selected commits are not contiguous on the current branch. Use interactive rebase instead.' };
        }
    }
    return { ok: true };
}

export async function getCommitMessages(cwd: string, hashesOldestFirst: string[]): Promise<CommitInfo[]> {
    const result: CommitInfo[] = [];
    for (const hash of hashesOldestFirst) {
        const msg = await execGitOrThrow(cwd, ['log', '-n', '1', '--format=%B', hash]);
        result.push({ hash, message: msg.replace(/\n+$/, '') });
    }
    return result;
}

/**
 * Build a prefilled commit message from selected commits.
 * Newest first, separated by blank lines. Each commit's short hash is a
 * leading comment so users can see provenance while editing.
 */
export function buildCombinedMessage(commitsOldestFirst: CommitInfo[]): string {
    const newestFirst = [...commitsOldestFirst].reverse();
    const blocks = newestFirst.map((c) => {
        const short = c.hash.slice(0, 7);
        return `# ${short}\n${c.message}`;
    });
    return blocks.join('\n\n') + '\n';
}

async function isWorkingTreeDirty(cwd: string): Promise<boolean> {
    const out = await execGitOrThrow(cwd, ['status', '--porcelain']);
    return out.trim().length > 0;
}

async function isDetachedHead(cwd: string): Promise<boolean> {
    const res = await execGit(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
    return res.exitCode !== 0;
}

export async function squashCommits(repo: GitRepository, hashes: string[]): Promise<void> {
    const cwd = repo.rootUri.fsPath;

    if (hashes.length < 2) {
        vscode.window.showErrorMessage('Squasher: select at least two commits to squash.');
        return;
    }

    if (await isDetachedHead(cwd)) {
        vscode.window.showErrorMessage('Squasher: cannot squash in a detached HEAD state. Check out a branch first.');
        return;
    }

    const sorted = await topoSortHashes(cwd, hashes);
    const validation = await validateContiguousFromHead(cwd, sorted);
    if (!validation.ok) {
        vscode.window.showErrorMessage(`Squasher: ${validation.reason}`);
        return;
    }

    // Dirty tree handling: offer to stash.
    let stashed = false;
    if (await isWorkingTreeDirty(cwd)) {
        const choice = await vscode.window.showWarningMessage(
            'Working tree has uncommitted changes. Stash them before squashing?',
            { modal: true },
            'Stash and Continue',
            'Cancel'
        );
        if (choice !== 'Stash and Continue') {
            return;
        }
        const stashRes = await execGit(cwd, ['stash', 'push', '--include-untracked', '-m', 'squasher-autostash']);
        if (stashRes.exitCode !== 0) {
            vscode.window.showErrorMessage(`Squasher: failed to stash changes: ${stashRes.stderr.trim()}`);
            return;
        }
        stashed = true;
    }

    const commits = await getCommitMessages(cwd, sorted);
    const prefilled = buildCombinedMessage(commits);
    const message = await promptForSquashMessage(cwd, prefilled, commits.length);
    if (message === undefined) {
        if (stashed) {
            await execGit(cwd, ['stash', 'pop']);
        }
        return;
    }

    const oldest = sorted[0];

    try {
        // Reset to parent of oldest, keeping changes staged.
        await execGitOrThrow(cwd, ['reset', '--soft', `${oldest}^`]);

        // Write message to a temp file and commit.
        const tmpFile = path.join(os.tmpdir(), `squasher-msg-${Date.now()}.txt`);
        await fs.writeFile(tmpFile, message, 'utf8');
        try {
            await execGitOrThrow(cwd, ['commit', '-F', tmpFile, '--allow-empty']);
        } finally {
            fs.unlink(tmpFile).catch(() => { /* ignore */ });
        }

        vscode.window.showInformationMessage(`Squasher: combined ${commits.length} commits into one.`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Squasher: squash failed, attempting rollback. ${msg}`);
        const rollback = await execGit(cwd, ['reset', '--hard', 'ORIG_HEAD']);
        if (rollback.exitCode !== 0) {
            vscode.window.showErrorMessage(`Squasher: rollback failed. Repository state may be inconsistent. ${rollback.stderr.trim()}`);
        }
    } finally {
        if (stashed) {
            const pop = await execGit(cwd, ['stash', 'pop']);
            if (pop.exitCode !== 0) {
                vscode.window.showWarningMessage(`Squasher: could not automatically pop stashed changes. Run 'git stash pop' manually. ${pop.stderr.trim()}`);
            }
        }
    }
}
