import * as core from "@actions/core";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Verify destination workspace is a git work tree before modifying branches.
export async function assertGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
}

// Clone source repository, resolving default branch when source ref omitted.
export async function cloneSourceRepo(
  sourceRepo: string,
  sourceRef: string,
  sourceRoot: string,
  destinationRoot: string
): Promise<string> {
  if (sourceRef) {
    await cloneSourceRepoAtRef(sourceRepo, sourceRef, sourceRoot);
    return sourceRef;
  }

  try {
    await runGit(destinationRoot, ["clone", "--depth", "1", "--", sourceRepo, sourceRoot]);
  } catch (error) {
    core.warning("Shallow source clone failed; retrying with a full clone.");
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await runGit(destinationRoot, ["clone", "--", sourceRepo, sourceRoot]);
  }

  return resolveCheckedOutRef(sourceRoot);
}

// Fetch specific source ref into a detached checkout to support branches, tags, and SHAs.
async function cloneSourceRepoAtRef(
  sourceRepo: string,
  sourceRef: string,
  sourceRoot: string
): Promise<void> {
  await fs.mkdir(sourceRoot, { recursive: true });
  await runGit(sourceRoot, ["init"]);
  await runGit(sourceRoot, ["remote", "add", "origin", sourceRepo]);

  try {
    await runGit(sourceRoot, ["fetch", "--depth", "1", "origin", sourceRef]);
  } catch (error) {
    core.warning(`Shallow fetch of source ref ${sourceRef} failed; retrying with a full fetch.`);
    await runGit(sourceRoot, ["fetch", "origin", sourceRef]);
  }

  await runGit(sourceRoot, ["checkout", "--detach", "FETCH_HEAD"]);
}

// Return checked-out branch name, falling back to short SHA for detached HEADs.
async function resolveCheckedOutRef(sourceRoot: string): Promise<string> {
  try {
    const branchName = (await runGit(sourceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    if (branchName) {
      return branchName;
    }
  } catch {
    // Detached HEAD is valid for unusual source repositories.
  }

  return (await runGit(sourceRoot, ["rev-parse", "--short", "HEAD"])).trim();
}

// Configure commits to appear as standard GitHub Actions bot commits.
export async function configureGitBot(cwd: string): Promise<void> {
  await runGit(cwd, ["config", "user.name", "github-actions[bot]"]);
  await runGit(cwd, [
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com"
  ]);
}

// Detect whether selected pathspecs have tracked or untracked changes.
export async function hasGitChanges(cwd: string, paths: string[]): Promise<boolean> {
  const stdout = await runGit(cwd, ["status", "--porcelain=v1", "--", ...paths]);
  return stdout.trim().length > 0;
}

// Create temporary detached worktree and always remove it after callback completes.
export async function withWorktree<T>(
  repoRoot: string,
  worktreePath: string,
  ref: string,
  callback: (worktreeRoot: string) => Promise<T>
): Promise<T> {
  await fs.rm(worktreePath, { recursive: true, force: true });
  await runGit(repoRoot, ["worktree", "add", "--detach", worktreePath, ref]);

  try {
    return await callback(worktreePath);
  } finally {
    await removeWorktree(repoRoot, worktreePath);
  }
}

// Remove worktree through git first, then force-delete path if cleanup fails.
async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch (error: any) {
    core.warning(`Could not remove worktree ${worktreePath}: ${error.message}`);
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
}

// Run git command and surface stderr as debug output for action logs.
export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024
  });

  if (stderr.trim()) {
    core.debug(stderr);
  }

  return stdout;
}
