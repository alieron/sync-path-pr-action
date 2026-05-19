import * as core from "@actions/core";
import * as github from "@actions/github";
import { buildPrBody } from "./sync.js";
import type { Inputs, ResolvedRefs, SyncIdentity } from "./sync.js";

export type ExistingPr = {
  number: number;
  htmlUrl: string;
  headRefName: string;
  headRepoFullName: string | null;
  title: string;
  createdAt: string;
};

export type SyncPr = {
  number: number;
  htmlUrl: string;
};

export type Octokit = ReturnType<typeof github.getOctokit>;

// Find newest open PR carrying this sync marker.
export async function findLatestSyncPr(
  octokit: Octokit,
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

// Comment on current PR and update title when date changed.
export async function markExistingPrUpToDate(
  octokit: Octokit,
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

// Open pull request for pushed sync branch and return compact PR identity.
export async function createPullRequest(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  targetRef: string;
  branchName: string;
  title: string;
  inputs: Inputs;
  refs: ResolvedRefs;
  identity: SyncIdentity;
  date: string;
}): Promise<SyncPr> {
  const created = await args.octokit.rest.pulls.create({
    owner: args.owner,
    repo: args.repo,
    base: args.targetRef,
    head: args.branchName,
    title: args.title,
    body: buildPrBody(args.inputs, args.refs, args.identity, args.date)
  });

  return {
    number: created.data.number,
    htmlUrl: created.data.html_url
  };
}

// Close superseded PR and delete its branch when branch belongs to target repo.
export async function closeOldPr(args: {
  octokit: Octokit;
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
