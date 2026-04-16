import * as vscode from 'vscode';
import { spawn } from 'child_process';

// Minimal shape of the built-in Git extension API (subset we need).
export interface GitRepository {
    readonly rootUri: vscode.Uri;
    readonly state: {
        readonly HEAD?: { readonly name?: string; readonly commit?: string };
        readonly workingTreeChanges: readonly unknown[];
        readonly indexChanges: readonly unknown[];
    };
}

export interface GitAPI {
    readonly repositories: readonly GitRepository[];
    getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
    readonly enabled: boolean;
    getAPI(version: 1): GitAPI;
}

export async function getGitAPI(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) {
        return undefined;
    }
    if (!ext.isActive) {
        await ext.activate();
    }
    if (!ext.exports.enabled) {
        return undefined;
    }
    return ext.exports.getAPI(1);
}

export interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

export async function execGit(
    cwd: string,
    args: string[],
    options: { input?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        const proc = spawn('git', args, {
            cwd,
            env: { ...process.env, ...options.env, GIT_OPTIONAL_LOCKS: '0' },
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            resolve({ stdout, stderr, exitCode: code ?? -1 });
        });

        if (options.input !== undefined) {
            proc.stdin.end(options.input);
        } else {
            proc.stdin.end();
        }
    });
}

export async function execGitOrThrow(cwd: string, args: string[], input?: string): Promise<string> {
    const result = await execGit(cwd, args, { input });
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout;
}
