import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Opens a real file on disk (<repoRoot>/.git/SQUASH_EDITMSG) prefilled with
 * the combined message. The user edits it like any other file:
 *
 *   - Save (Ctrl+S)  → resolves with the saved text (apply squash).
 *   - Close the tab  → resolves with undefined (cancel).
 *
 * This matches VS Code's own convention for COMMIT_EDITMSG / MERGE_MSG editing,
 * so the interaction is natural — no CodeLens, toast, or modal required.
 */
export async function promptForSquashMessage(repoRoot: string, prefilled: string, commitCount: number): Promise<string | undefined> {
    const gitDir = path.join(repoRoot, '.git');
    const msgPath = path.join(gitDir, 'SQUASH_EDITMSG');

    const initialContent =
        prefilled +
        `\n` +
        `# Save this file (Ctrl+S) to squash ${commitCount} commits.\n` +
        `# Close this editor to cancel. Lines starting with '#' are ignored.\n`;

    await fs.writeFile(msgPath, initialContent, 'utf8');

    const uri = vscode.Uri.file(msgPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    try {
        return await new Promise<string | undefined>((resolve) => {
            let settled = false;
            const disposables: vscode.Disposable[] = [];
            const settle = (value: string | undefined) => {
                if (settled) {
                    return;
                }
                settled = true;
                for (const d of disposables) {
                    d.dispose();
                }
                resolve(value);
            };

            disposables.push(
                vscode.workspace.onDidSaveTextDocument((saved) => {
                    if (saved.uri.toString() !== uri.toString()) {
                        return;
                    }
                    const cleaned = stripCommentLines(saved.getText()).trim();
                    if (cleaned.length === 0) {
                        vscode.window.showErrorMessage('Squasher: commit message is empty. Edit the file and save again, or close the tab to cancel.');
                        return;
                    }
                    settle(cleaned + '\n');
                }),
                vscode.workspace.onDidCloseTextDocument((closed) => {
                    if (closed.uri.toString() === uri.toString()) {
                        settle(undefined);
                    }
                }),
            );
        });
    } finally {
        // Close the editor if still open, then remove the scratch file.
        const stillOpen = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (stillOpen) {
            try {
                await vscode.window.showTextDocument(stillOpen, { preserveFocus: false });
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            } catch {
                /* ignore */
            }
        }
        fs.unlink(msgPath).catch(() => { /* ignore */ });
    }
}

export function stripCommentLines(text: string): string {
    return text
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('#'))
        .join('\n');
}
