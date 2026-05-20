import * as core from "@actions/core";
import * as github from "@actions/github";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertGitRepo,
  cloneSourceRepo,
  configureGitBot,
  hasGitChanges,
  runGit,
  withWorktree
} from "./git";
import {
  closeOldPr,
  createPullRequest,
  findLatestSyncPr,
  markExistingPrUpToDate
} from "./github-prs";
import {
  applySync,
  buildPrTitle,
  buildSyncIdentity,
  cleanRelativePath,
  formatUtcDate,
  parseFiles,
  slugify,
  targetGitPaths
} from "./sync";
import type { Inputs, ResolvedRefs, SyncIdentity } from "./sync";
import type { ExistingPr, Octokit, SyncPr } from "./github-prs";

// Wire GitHub Actions runtime inputs, context, and secrets into testable logic.
export async function run(): Promise<void> {
  const inputs = getInputs();

  core.setSecret(inputs.token);

  const octokit = github.getOctokit(inputs.token);
  const { owner, repo } = github.context.repo;
  const targetRef = inputs.targetRef || getDefaultTargetRef();
  const destinationRoot = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());

  await runSyncPathPrAction({
    inputs,
    octokit,
    owner,
    repo,
    targetRef,
    destinationRoot,
    now: new Date()
  });
}

// Read and validate action inputs before any network or git work begins.
function getInputs(): Inputs {
  const sourceRepo = core.getInput("source-repo", { required: true }).trim();
  if (!sourceRepo) {
    throw new Error("source-repo must not be empty.");
  }

  const sourceRef = core.getInput("source-ref").trim();
  const sourcePath = cleanRelativePath(
    core.getInput("source-path", { required: true }),
    "source-path",
    { allowDot: true }
  );
  const targetPath = cleanRelativePath(
    core.getInput("target-path", { required: true }),
    "target-path",
    { allowDot: true }
  );
  const targetRef = core.getInput("target-ref").trim();
  const files = parseFiles(core.getMultilineInput("files", { required: true }));
  const dateFormat = core.getInput("date-format") || "dd-mm-yyyy";
  const token = core.getInput("token", { required: true });

  return {
    sourceRepo,
    sourceRef,
    sourcePath,
    targetPath,
    targetRef,
    files,
    dateFormat,
    token
  };
}

// Resolve base ref from input, repository default branch, or current GitHub ref.
function getDefaultTargetRef(): string {
  const repository = github.context.payload.repository as
    | { default_branch?: string }
    | undefined;

  return repository?.default_branch || process.env.GITHUB_REF_NAME || "main";
}

// Coordinate clone, comparison, PR creation, and cleanup for one sync run.
export async function runSyncPathPrAction(args: {
  inputs: Inputs;
  octokit: Octokit;
  owner: string;
  repo: string;
  targetRef: string;
  destinationRoot: string;
  now: Date;
}): Promise<void> {
  await assertGitRepo(args.destinationRoot);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-path-pr-"));
  const sourceRoot = path.join(tempRoot, "source");

  try {
    const sourceRef = await cloneSourceRepo(
      args.inputs.sourceRepo,
      args.inputs.sourceRef,
      sourceRoot,
      args.destinationRoot
    );
    const refs = { sourceRef, targetRef: args.targetRef };
    const identity = buildSyncIdentity(args.inputs, refs);
    setResolvedSyncOutputs(identity, refs);

    const latestSyncPr = await findLatestSyncPr(
      args.octokit,
      args.owner,
      args.repo,
      identity.marker
    );

    const date = formatUtcDate(args.now, args.inputs.dateFormat);
    const title = buildPrTitle(identity, date);

    // Reuse matching open PR when applying current source produces no diff.
    if (latestSyncPr) {
      const existingPrIsCurrent = await existingPrHasCurrentSync(
        args.destinationRoot,
        sourceRoot,
        tempRoot,
        args.inputs,
        latestSyncPr
      );

      if (existingPrIsCurrent) {
        await markExistingPrUpToDate(
          args.octokit,
          args.owner,
          args.repo,
          latestSyncPr,
          title,
          identity,
          date
        );

        core.setOutput("pr-created", "false");
        core.setOutput("pr-replaced", "false");
        core.setOutput("pr-number", String(latestSyncPr.number));
        core.setOutput("pr-url", latestSyncPr.htmlUrl);
        core.info(`Existing PR #${latestSyncPr.number} is up to date.`);
        return;
      }
    }

    // Create fresh branch and PR only when base branch needs file updates.
    const createdPr = await createSyncPrIfNeeded({
      octokit: args.octokit,
      owner: args.owner,
      repo: args.repo,
      targetRef: args.targetRef,
      destinationRoot: args.destinationRoot,
      sourceRoot,
      tempRoot,
      inputs: args.inputs,
      refs,
      identity,
      date,
      title
    });

    // Close stale open PR when base already contains requested sync state.
    if (!createdPr) {
      if (latestSyncPr) {
        await closeOldPr({
          octokit: args.octokit,
          owner: args.owner,
          repo: args.repo,
          oldPr: latestSyncPr,
          reason: `Closing because \`${args.targetRef}\` already contains the current synced files.`
        });

        core.info(`Closed PR #${latestSyncPr.number} because \`${args.targetRef}\` already contains the synced files.`);
      }

      core.info("No changes found against the base branch. No PR created.");
      core.setOutput("pr-created", "false");
      core.setOutput("pr-replaced", "false");
      return;
    }

    // Close older matching PR after replacement PR exists.
    if (latestSyncPr) {
      await closeOldPr({
        octokit: args.octokit,
        owner: args.owner,
        repo: args.repo,
        oldPr: latestSyncPr,
        reason: `This sync PR has been replaced by #${createdPr.number} because it is no longer up to date.`
      });

      core.info(`Closed PR #${latestSyncPr.number} because its no longer up to date.`);
    }

    core.setOutput("pr-created", "true");
    core.setOutput("pr-replaced", latestSyncPr ? "true" : "false");
    core.setOutput("pr-number", String(createdPr.number));
    core.setOutput("pr-url", createdPr.htmlUrl);

    core.info(`Created PR #${createdPr.number}: ${createdPr.htmlUrl}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function setResolvedSyncOutputs(identity: SyncIdentity, refs: ResolvedRefs): void {
  core.setOutput("sync-id", identity.id);
  core.setOutput("source-ref", refs.sourceRef);
  core.setOutput("target-ref", refs.targetRef);
}

// Apply latest source files onto existing PR head and report if still current.
async function existingPrHasCurrentSync(
  destinationRoot: string,
  sourceRoot: string,
  tempRoot: string,
  inputs: Inputs,
  existingPr: ExistingPr
): Promise<boolean> {
  await runGit(destinationRoot, ["fetch", "origin", `pull/${existingPr.number}/head`]);
  const prHead = (await runGit(destinationRoot, ["rev-parse", "FETCH_HEAD"])).trim();
  const worktreePath = path.join(tempRoot, `existing-pr-${existingPr.number}`);

  return withWorktree(destinationRoot, worktreePath, prHead, async (worktreeRoot) => {
    await applySync(sourceRoot, worktreeRoot, inputs);
    return !(await hasGitChanges(worktreeRoot, targetGitPaths(inputs)));
  });
}

// Build, commit, push, and open a sync PR when target base has changes.
async function createSyncPrIfNeeded(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  targetRef: string;
  destinationRoot: string;
  sourceRoot: string;
  tempRoot: string;
  inputs: Inputs;
  refs: ResolvedRefs;
  identity: SyncIdentity;
  date: string;
  title: string;
}): Promise<SyncPr | undefined> {
  await runGit(args.destinationRoot, ["fetch", "origin", args.targetRef]);
  const targetHead = (await runGit(args.destinationRoot, ["rev-parse", "FETCH_HEAD"])).trim();

  const worktreePath = path.join(args.tempRoot, "base");
  const runPart =
    [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT]
      .filter(Boolean)
      .join("-") || String(Date.now());
  const branchDate = slugify(args.date);
  const branchName = `sync-path/${args.identity.branchSlug}-${args.identity.id}-${branchDate}-${runPart}`;
  let hasChanges = false;

  // Use disposable worktree so caller checkout remains untouched.
  await withWorktree(
    args.destinationRoot,
    worktreePath,
    targetHead,
    async (worktreeRoot) => {
      await configureGitBot(worktreeRoot);
      await applySync(args.sourceRoot, worktreeRoot, args.inputs);

      const paths = targetGitPaths(args.inputs);
      hasChanges = await hasGitChanges(worktreeRoot, paths);

      // Skip branch push and PR creation when sync already matches base.
      if (!hasChanges) {
        return;
      }

      await runGit(worktreeRoot, ["checkout", "-B", branchName]);
      await runGit(worktreeRoot, ["add", "--", ...paths]);
      await runGit(worktreeRoot, [
        "commit",
        "-m",
        `Sync ${args.identity.titlePath} from external repository`
      ]);
      await runGit(worktreeRoot, [
        "push",
        "--force-with-lease",
        "origin",
        `HEAD:refs/heads/${branchName}`
      ]);
    }
  );

  if (!hasChanges) {
    return undefined;
  }

  return createPullRequest({
    octokit: args.octokit,
    owner: args.owner,
    repo: args.repo,
    targetRef: args.targetRef,
    branchName,
    title: args.title,
    inputs: args.inputs,
    refs: args.refs,
    identity: args.identity,
    date: args.date
  });
}
