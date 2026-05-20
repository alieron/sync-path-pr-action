# Sync Path PR

Sync selected files from an external git repository into the current repository and open a pull request when the destination is out of date.

The source repository can be any repository that `git clone` can read, including non-GitHub repositories. Each sync is tracked by a stable ID derived from the source repository, source ref, source path, target ref, target path, and file list, so multiple workflows can sync different directories or branches without colliding.

## Usage

```yaml
name: Sync external files

on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  sync:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Sync files
        uses: alieron/sync-path-pr-action@v1.0.0
        with:
          source-repo: https://github.com/example/source-repo.git
          source-ref: main
          source-path: config/templates
          target-path: config/templates
          files: |
            app.yml
            nested/service.yml
          date-format: dd-mm-yyyy
```

The destination repository must allow GitHub Actions to create pull requests. In repository settings, enable the workflow permission that lets GitHub Actions create and approve pull requests.

For private source repositories, provide a clone URL or runner git configuration that can authenticate to that repository.

Do not use a branch ref such as `@master` or `@main` to consume this action. The default branch does not contain the generated `dist` bundle. Use a release tag such as `@v1.0.0`, or enable the major tag option during release and use `@v1`.

## Notes

The action only copies the listed files. It does not mirror directories or delete files from the destination that are not listed in `files`.

The default branch from the destination repository is used as the pull request base when `target-ref` is not set.

## Pull Request Behavior

Pull request titles include the destination path, sync ID, and date:

```text
Sync <target-path> (<sync-id>) - <date>
```

If an existing sync PR is still current, the action comments that it is up to date and updates the date in the title. If the existing sync PR is stale, the action opens a new PR, comments on the old PR with a link to the new PR, then closes the old PR. New PRs do not reference older PRs.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `source-repo` | Yes | N/A | Git clone URL or path for the source repository. |
| `source-ref` | No | Source repository default branch | Branch, tag, or commit SHA to copy from in the source repository. |
| `source-path` | Yes | N/A | Directory path inside the source repository that contains the files. |
| `target-path` | Yes | N/A | Directory path inside this repository where the files are copied. |
| `target-ref` | No | Destination repository default branch | Branch to use as the pull request base in this repository. |
| `files` | Yes | N/A | Newline-separated list of files to sync, relative to `source-path` and `target-path`. |
| `date-format` | No | `dd-mm-yyyy` | UTC date format used in pull request titles, branches, comments, and bodies. Supported tokens are `dd`, `mm`, `yy`, and `yyyy`. |
| `token` | No | `${{ github.token }}` | GitHub token used to create pull requests, update titles, add comments, and delete replaced sync branches in the destination repository. |

## Outputs

| Output | Description |
| --- | --- |
| `pr-created` | `true` when a new PR was created, otherwise `false`. |
| `pr-replaced` | `true` when a stale existing sync PR was replaced by a new PR, otherwise `false`. |
| `pr-number` | Pull request number when a sync PR exists. |
| `pr-url` | Pull request URL when a sync PR exists. |
| `sync-id` | Stable identifier for this sync configuration. |
| `source-ref` | Resolved source ref copied from the source repository. |
| `target-ref` | Destination ref used as the pull request base. |

## Releasing

The action bundle is built only by the release workflow. To publish a release:

1. Open the **Release** workflow in the Actions tab.
2. Run it with a version tag, for example `v1.0.0`.
3. Enable `update-major-tag` only when you intentionally want to move the matching major tag, for example `v1`.

The workflow runs typechecking, creates or updates the matching release branch, builds `dist`, commits that bundle only on the release branch, pushes the release tag, and optionally moves the major tag. For example, `v1.2.3` is committed and tagged on `release/v1`. It does not publish `dist` to the default branch.
