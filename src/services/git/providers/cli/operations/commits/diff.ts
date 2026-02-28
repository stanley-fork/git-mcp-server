/**
 * @fileoverview CLI provider git diff operation
 * @module services/git/providers/cli/operations/commits/diff
 */

import type { RequestContext } from '@/utils/index.js';

import type {
  GitDiffOptions,
  GitDiffResult,
  GitOperationContext,
} from '../../../../types.js';
import {
  buildGitCommand,
  mapGitError,
  parseGitDiffStat,
} from '../../utils/index.js';

/**
 * Execute git diff to show changes.
 *
 * @param options - Diff options
 * @param context - Operation context
 * @param execGit - Function to execute git commands
 * @returns Diff result
 */
export async function executeDiff(
  options: GitDiffOptions,
  context: GitOperationContext,
  execGit: (
    args: string[],
    cwd: string,
    ctx: RequestContext,
  ) => Promise<{ stdout: string; stderr: string }>,
): Promise<GitDiffResult> {
  try {
    // Separate flags from path args to ensure correct ordering.
    // Git requires: git diff [flags] [commits] -- [paths]
    // Flags (including --stat) must come before '--', paths after.
    const flags: string[] = [];
    const pathArgs: string[] = [];

    if (options.staged) {
      flags.push('--cached');
    }

    if (options.nameOnly) {
      flags.push('--name-only');
    }

    if (options.unified !== undefined) {
      flags.push(`--unified=${options.unified}`);
    }

    if (options.commit1) {
      flags.push(options.commit1);
    }

    if (options.commit2) {
      flags.push(options.commit2);
    }

    if (options.paths?.length) {
      pathArgs.push('--', ...options.paths);
    }

    // If stat-only mode requested, return stat output
    if (options.stat) {
      const statFlags = flags.filter(
        (f) => f !== '--name-only' && !f.startsWith('--unified='),
      );
      const statCmd = buildGitCommand({
        command: 'diff',
        args: [...statFlags, '--stat', ...pathArgs],
      });
      const statResult = await execGit(
        statCmd,
        context.workingDirectory,
        context.requestContext,
      );
      const stats = parseGitDiffStat(statResult.stdout);

      // Include untracked files in stat output
      let untrackedStatOutput = '';
      let untrackedFileCount = 0;
      if (options.includeUntracked) {
        const untrackedFiles = await getUntrackedFiles(execGit, context);
        for (const file of untrackedFiles) {
          const result = await execUntrackedDiff(execGit, context, file, true);
          if (result) {
            untrackedStatOutput += result;
            untrackedFileCount++;
          }
        }
      }

      const untrackedStats = untrackedStatOutput
        ? parseGitDiffStat(untrackedStatOutput)
        : { totalAdditions: 0, totalDeletions: 0 };

      return {
        diff: statResult.stdout + untrackedStatOutput,
        filesChanged: stats.files.length + untrackedFileCount,
        insertions: stats.totalAdditions + untrackedStats.totalAdditions,
        deletions: stats.totalDeletions + untrackedStats.totalDeletions,
        binary:
          statResult.stdout.includes('Binary files') ||
          untrackedStatOutput.includes('Binary files'),
      };
    }

    // Get diff content
    const args = [...flags, ...pathArgs];
    const diffCmd = buildGitCommand({ command: 'diff', args });
    const diffResult = await execGit(
      diffCmd,
      context.workingDirectory,
      context.requestContext,
    );

    // If includeUntracked, get untracked files and append their diff
    let untrackedDiff = '';
    let untrackedFileCount = 0;
    if (options.includeUntracked) {
      const untrackedFiles = await getUntrackedFiles(execGit, context);
      untrackedFileCount = untrackedFiles.length;

      for (const file of untrackedFiles) {
        if (options.nameOnly) {
          untrackedDiff += `${file}\n`;
        } else {
          const result = await execUntrackedDiff(execGit, context, file, false);
          if (result) {
            untrackedDiff += result;
          }
        }
      }
    }

    // Combine tracked and untracked diffs
    const combinedDiff = diffResult.stdout + untrackedDiff;

    // For name-only mode, count files from output
    if (options.nameOnly) {
      const files = combinedDiff.split('\n').filter((line) => line.trim());
      return {
        diff: combinedDiff,
        filesChanged: files.length,
        binary: false,
      };
    }

    // Get diff stats for full diff mode
    const statFlags = flags.filter(
      (f) => f !== '--name-only' && !f.startsWith('--unified='),
    );
    const statCmd = buildGitCommand({
      command: 'diff',
      args: [...statFlags, '--stat', ...pathArgs],
    });
    const statResult = await execGit(
      statCmd,
      context.workingDirectory,
      context.requestContext,
    );

    const stats = parseGitDiffStat(statResult.stdout);
    const hasBinary = combinedDiff.includes('Binary files');

    return {
      diff: combinedDiff,
      filesChanged: stats.files.length + untrackedFileCount,
      insertions: stats.totalAdditions,
      deletions: stats.totalDeletions,
      binary: hasBinary,
    };
  } catch (error) {
    throw mapGitError(error, 'diff');
  }
}

/**
 * Get list of untracked files in the working directory.
 */
async function getUntrackedFiles(
  execGit: (
    args: string[],
    cwd: string,
    ctx: RequestContext,
  ) => Promise<{ stdout: string; stderr: string }>,
  context: GitOperationContext,
): Promise<string[]> {
  const lsFilesCmd = buildGitCommand({
    command: 'ls-files',
    args: ['--others', '--exclude-standard'],
  });
  const lsFilesResult = await execGit(
    lsFilesCmd,
    context.workingDirectory,
    context.requestContext,
  );
  return lsFilesResult.stdout.split('\n').filter((f) => f.trim());
}

/**
 * Get diff output for a single untracked file (shown as new file).
 * Returns the diff string, or null if extraction failed.
 *
 * @param stat - If true, return --stat output instead of full diff
 */
async function execUntrackedDiff(
  execGit: (
    args: string[],
    cwd: string,
    ctx: RequestContext,
  ) => Promise<{ stdout: string; stderr: string }>,
  context: GitOperationContext,
  file: string,
  stat: boolean,
): Promise<string | null> {
  // git diff --no-index exits with code 1 when files differ, which is expected
  try {
    const untrackedCmd = buildGitCommand({
      command: 'diff',
      args: ['--no-index', ...(stat ? ['--stat'] : []), '/dev/null', file],
    });
    const result = await execGit(
      untrackedCmd,
      context.workingDirectory,
      context.requestContext,
    );
    return result.stdout;
  } catch (err: unknown) {
    // git diff --no-index exits with code 1 when files differ
    // The error message format is: "Exit Code: N\nStderr: ...\nStdout: ..."
    if (err instanceof Error) {
      const stdoutMatch = err.message.match(/\nStdout: ([\s\S]*)$/);
      if (stdoutMatch?.[1]) {
        return stdoutMatch[1];
      }
    }
    return null;
  }
}
