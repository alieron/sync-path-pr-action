import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type Inputs = {
  sourceRepo: string;
  sourceRef: string;
  sourcePath: string;
  targetPath: string;
  targetRef: string;
  files: string[];
  dateFormat: string;
  token: string;
};

export type ResolvedRefs = {
  sourceRef: string;
  targetRef: string;
};

export type SyncIdentity = {
  id: string;
  marker: string;
  titlePath: string;
  branchSlug: string;
};

// Copy requested files from source tree to destination tree after validating inputs.
export async function applySync(
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

// Normalize multiline or comma-separated file input into unique safe repo paths.
export function parseFiles(rawFiles: string[]): string[] {
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

// Reject absolute, parent-traversal, empty, and .git paths before filesystem use.
export function cleanRelativePath(
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

// Convert synced file list into git pathspecs inside target path.
export function targetGitPaths(inputs: Inputs): string[] {
  return inputs.files.map((file) => joinRepoPath(inputs.targetPath, file));
}

// Join target base and relative file while preserving repository root target.
export function joinRepoPath(base: string, file: string): string {
  return base === "." ? file : `${base}/${file}`;
}

// Build stable sync identity used for PR markers, titles, and branch names.
export function buildSyncIdentity(inputs: Inputs, refs: ResolvedRefs): SyncIdentity {
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

// Pick concise path label for PR titles, including root-level syncs.
export function displayPathForTitle(inputs: Inputs): string {
  if (inputs.targetPath !== ".") {
    return inputs.targetPath;
  }

  const topLevelFiles = [...new Set(inputs.files.map((file) => file.split("/")[0]))];

  return topLevelFiles.length === 1 ? topLevelFiles[0] : "repository-root";
}

// Convert arbitrary path text into branch-safe slug with bounded length.
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return slug || "repository-root";
}

// Build user-facing PR title from sync identity and formatted date.
export function buildPrTitle(identity: SyncIdentity, date: string): string {
  return `Sync ${identity.titlePath} (${identity.id}) - ${date}`;
}

// Format UTC date using supported dd, mm, yy, and yyyy tokens.
export function formatUtcDate(date: Date, format: string): string {
  const values: Record<string, string> = {
    dd: String(date.getUTCDate()).padStart(2, "0"),
    mm: String(date.getUTCMonth() + 1).padStart(2, "0"),
    yy: String(date.getUTCFullYear()).slice(-2),
    yyyy: String(date.getUTCFullYear())
  };

  return format.replace(/yyyy|yy|dd|mm/g, (token) => values[token]);
}

// Build PR body containing hidden sync marker plus human-readable sync details.
export function buildPrBody(
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

// Hide credentials embedded in source repository URLs before logging or hashing.
export function redactGitUrl(value: string): string {
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
