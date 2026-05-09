import * as core from "@actions/core";
import * as github from "@actions/github";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Inputs = {
  sourceRepo: string;
  sourceRef: string;
  sourcePath: string;
  targetPath: string;
  targetRef: string;
  files: string[];
  dateFormat: string;
  token: string;
};

type ResolvedRefs = {
  sourceRef: string;
  targetRef: string;
};

type SyncIdentity = {
  id: string;
  marker: string;
  titlePath: string;
  branchSlug: string;
};

type ExistingPr = {
  number: number;
  htmlUrl: string;
  headRefName: string;
  headRepoFullName: string | null;
  title: string;
  createdAt: string;
};

async function run(): Promise<void> {
  const inputs = getInputs();

  core.setSecret(inputs.token);

  const octokit = github.getOctokit(inputs.token);
  const { owner, repo } = github.context.repo;
  const targetRef = inputs.targetRef || getDefaultTargetRef();
  const destinationRoot = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());

  await assertGitRepo(destinationRoot);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-path-pr-"));
  const sourceRoot = path.join(tempRoot, "source");

  try {
    const sourceRef = await cloneSourceRepo(
      inputs.sourceRepo,
      inputs.sourceRef,
      sourceRoot,
      destinationRoot
    );
    const refs = { sourceRef, targetRef };
    const identity = buildSyncIdentity(inputs, refs);

    const latestSyncPr = await findLatestSyncPr(
      octokit,
      owner,
      repo,
      identity.marker
    );

    const date = formatUtcDate(new Date(), inputs.dateFormat);
    const title = buildPrTitle(identity, date);

    if (latestSyncPr) {
      const existingPrIsCurrent = await existingPrHasCurrentSync(
        destinationRoot,
        sourceRoot,
        tempRoot,
        inputs,
        latestSyncPr
      );

      if (existingPrIsCurrent) {
        await markExistingPrUpToDate(
          octokit,
          owner,
          repo,
          latestSyncPr,
          title,
          identity,
          date
        );

        core.setOutput("changed", "false");
        core.setOutput("pr-number", String(latestSyncPr.number));
        core.setOutput("pr-url", latestSyncPr.htmlUrl);
        core.info(`Existing PR #${latestSyncPr.number} is up to date.`);
        return;
      }
    }

    const createdPr = await createSyncPrIfNeeded({
      octokit,
      owner,
      repo,
      targetRef,
      destinationRoot,
      sourceRoot,
      tempRoot,
      inputs,
      refs,
      identity,
      date,
      title
    });

    if (!createdPr) {
      if (latestSyncPr) {
        await closeOldPr({
          octokit,
          owner,
          repo,
          oldPr: latestSyncPr,
          reason: `Closing because \`${targetRef}\` already contains the current synced files.`
        });
      }

      core.info("No changes found against the base branch. No PR created.");
      core.setOutput("changed", "false");
      return;
    }

    if (latestSyncPr) {
      await closeOldPr({
        octokit,
        owner,
        repo,
        oldPr: latestSyncPr,
        reason: `This sync PR has been replaced by #${createdPr.number} because it is no longer up to date.`
      });
    }

    core.setOutput("changed", "true");
    core.setOutput("pr-number", String(createdPr.number));
    core.setOutput("pr-url", createdPr.htmlUrl);

    core.info(`Created PR #${createdPr.number}: ${createdPr.htmlUrl}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

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

function parseFiles(rawFiles: string[]): string[] {
  const files = rawFiles
    .flatMap((line) => line.split(","))
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => cleanRelativePath(file, "files"));

  const uniqueFiles = [...new Set(files)].sort();

  if (uniqueFiles.length === 0) {
    throw new Error("files must contain at least one file path.");
  }

  return uniqueFiles;
}

function cleanRelativePath(
  value: string,
  inputName: string,
  options: { allowDot?: boolean } = {}
): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");

  if (!normalized || normalized === ".") {
    if (options.allowDot) {
      return ".";
    }

    throw new Error(`${inputName} must not be empty.`);
  }

  if (path.posix.isAbsolute(normalized)) {
    throw new Error(`${inputName} must be a relative path.`);
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("..")) {
    throw new Error(`${inputName} must not contain '..'.`);
  }

  if (parts.includes(".git")) {
    throw new Error(`${inputName} must not include .git.`);
  }

  return path.posix.normalize(normalized).replace(/\/$/, "");
}

function getDefaultTargetRef(): string {
  const repository = github.context.payload.repository as
    | { default_branch?: string }
    | undefined;

  return repository?.default_branch || process.env.GITHUB_REF_NAME || "main";
}

function buildSyncIdentity(inputs: Inputs, refs: ResolvedRefs): SyncIdentity {
  const id = createHash("sha256")
    .update(
      JSON.stringify({
        sourceRepo: redactGitUrl(inputs.sourceRepo),
        sourceRef: refs.sourceRef,
        sourcePath: inputs.sourcePath,
        targetRef: refs.targetRef,
        targetPath: inputs.targetPath,
        files: inputs.files
      })
    )
    .digest("hex")
    .slice(0, 12);

  const titlePath = displayPathForTitle(inputs);

  return {
    id,
    marker: `<!-- sync-path-pr-action:id=${id} -->`,
    titlePath,
    branchSlug: slugify(titlePath)
  };
}

function displayPathForTitle(inputs: Inputs): string {
  if (inputs.targetPath !== ".") {
    return inputs.targetPath;
  }

  const topLevelFiles = [...new Set(inputs.files.map((file) => file.split("/")[0]))];

  return topLevelFiles.length === 1 ? topLevelFiles[0] : "repository-root";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return slug || "repository-root";
}

function buildPrTitle(identity: SyncIdentity, date: string): string {
  return `Sync ${identity.titlePath} (${identity.id}) - ${date}`;
}

function formatUtcDate(date: Date, format: string): string {
  const values: Record<string, string> = {
    dd: String(date.getUTCDate()).padStart(2, "0"),
    mm: String(date.getUTCMonth() + 1).padStart(2, "0"),
    yy: String(date.getUTCFullYear()).slice(-2),
    yyyy: String(date.getUTCFullYear())
  };

  return format.replace(/yyyy|yy|dd|mm/g, (token) => values[token]);
}

async function assertGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
}

async function cloneSourceRepo(
  sourceRepo: string,
  sourceRef: string,
  sourceRoot: string,
  destinationRoot: string
): Promise<string> {
  if (sourceRef) {
    await cloneSourceRepoAtRef(sourceRepo, sourceRef, sourceRoot, destinationRoot);
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

async function cloneSourceRepoAtRef(
  sourceRepo: string,
  sourceRef: string,
  sourceRoot: string,
  destinationRoot: string
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

async function configureGitBot(cwd: string): Promise<void> {
  await runGit(cwd, ["config", "user.name", "github-actions[bot]"]);
  await runGit(cwd, [
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com"
  ]);
}

async function findLatestSyncPr(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  marker: string
): Promise<ExistingPr | undefined> {
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100
  });

  const matching = prs
    .filter((pr) => pr.body?.includes(marker))
    .map((pr) => ({
      number: pr.number,
      htmlUrl: pr.html_url,
      headRefName: pr.head.ref,
      headRepoFullName: pr.head.repo?.full_name ?? null,
      title: pr.title,
      createdAt: pr.created_at
    }));

  return matching.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
}

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

async function markExistingPrUpToDate(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  existingPr: ExistingPr,
  title: string,
  identity: SyncIdentity,
  date: string
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: existingPr.number,
    body: `This sync PR is up to date as of ${date} for \`${identity.titlePath}\` (${identity.id}).`
  });

  if (existingPr.title !== title) {
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: existingPr.number,
      title
    });
  }
}

async function createSyncPrIfNeeded(args: {
  octokit: ReturnType<typeof github.getOctokit>;
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
}): Promise<{ number: number; htmlUrl: string } | undefined> {
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

  await withWorktree(
    args.destinationRoot,
    worktreePath,
    targetHead,
    async (worktreeRoot) => {
      await configureGitBot(worktreeRoot);
      await applySync(args.sourceRoot, worktreeRoot, args.inputs);

      const paths = targetGitPaths(args.inputs);
      hasChanges = await hasGitChanges(worktreeRoot, paths);

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

  const created = await args.octokit.rest.pulls.create({
    owner: args.owner,
    repo: args.repo,
    base: args.targetRef,
    head: branchName,
    title: args.title,
    body: buildPrBody(args.inputs, args.refs, args.identity, args.date)
  });

  return {
    number: created.data.number,
    htmlUrl: created.data.html_url
  };
}

function buildPrBody(
  inputs: Inputs,
  refs: ResolvedRefs,
  identity: SyncIdentity,
  date: string
): string {
  const lines = [
    identity.marker,
    `Sync ID: \`${identity.id}\``,
    "",
    `Syncs files into \`${inputs.targetPath}\` from \`${redactGitUrl(inputs.sourceRepo)}:${inputs.sourcePath}\`.`,
    `Source ref: \`${refs.sourceRef}\``,
    `Target ref: \`${refs.targetRef}\``,
    `Date: \`${date}\``
  ];

  lines.push("", "Files:", ...inputs.files.map((file) => `- \`${file}\``));

  return lines.join("\n");
}

function redactGitUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }

    return parsed.toString();
  } catch {
    return value;
  }
}

async function closeOldPr(args: {
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  oldPr: ExistingPr;
  reason: string;
}): Promise<void> {
  await args.octokit.rest.issues.createComment({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.oldPr.number,
    body: args.reason
  });

  await args.octokit.rest.pulls.update({
    owner: args.owner,
    repo: args.repo,
    pull_number: args.oldPr.number,
    state: "closed"
  });

  if (args.oldPr.headRepoFullName !== `${args.owner}/${args.repo}`) {
    return;
  }

  try {
    await args.octokit.rest.git.deleteRef({
      owner: args.owner,
      repo: args.repo,
      ref: `heads/${args.oldPr.headRefName}`
    });
  } catch (error: any) {
    core.warning(`Could not delete old branch ${args.oldPr.headRefName}: ${error.message}`);
  }
}

async function applySync(
  sourceRoot: string,
  destinationRoot: string,
  inputs: Inputs
): Promise<void> {
  const absoluteSourcePath = path.join(sourceRoot, inputs.sourcePath);
  const sourcePathStat = await fs.stat(absoluteSourcePath).catch(() => undefined);

  if (!sourcePathStat) {
    throw new Error(`Source path does not exist: ${inputs.sourcePath}`);
  }

  if (!sourcePathStat.isDirectory()) {
    throw new Error(`Source path must be a directory: ${inputs.sourcePath}`);
  }

  for (const file of inputs.files) {
    const absoluteSourceFile = path.join(absoluteSourcePath, file);
    const absoluteTargetFile = path.join(destinationRoot, inputs.targetPath, file);
    const sourceFileStat = await fs.stat(absoluteSourceFile).catch(() => undefined);

    if (!sourceFileStat) {
      throw new Error(`Listed file does not exist in the source repository: ${file}`);
    }

    if (!sourceFileStat.isFile()) {
      throw new Error(`Listed path must be a file: ${file}`);
    }

    await fs.mkdir(path.dirname(absoluteTargetFile), { recursive: true });
    await fs.copyFile(absoluteSourceFile, absoluteTargetFile);
  }
}

function targetGitPaths(inputs: Inputs): string[] {
  return inputs.files.map((file) => joinRepoPath(inputs.targetPath, file));
}

function joinRepoPath(base: string, file: string): string {
  return base === "." ? file : `${base}/${file}`;
}

async function hasGitChanges(cwd: string, paths: string[]): Promise<boolean> {
  const stdout = await runGit(cwd, ["status", "--porcelain=v1", "--", ...paths]);
  return stdout.trim().length > 0;
}

async function withWorktree<T>(
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

async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch (error: any) {
    core.warning(`Could not remove worktree ${worktreePath}: ${error.message}`);
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024
  });

  if (stderr.trim()) {
    core.debug(stderr);
  }

  return stdout;
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
