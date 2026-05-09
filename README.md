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
        uses: sebl/sync-path-pr-action@v1
        with:
          source-repo: https://github.com/example/source-repo.git
          source-ref: main
          source-path: config/templates
          target-ref: main
          target-path: config/templates
          files: |
            app.yml
            nested/service.yml
          date-format: dd-mm-yyyy
```

For private source repositories, provide a clone URL or runner git configuration that can authenticate to that repository.

## Testing

For an end-to-end test in a repository that contains this action, add a manual workflow that creates a temporary source repository on the runner and uses `./`:

```yaml
name: Test sync path PR

on:
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Create test source repo
        run: |
          git init -b main /tmp/sync-source
          git -C /tmp/sync-source config user.name "Test"
          git -C /tmp/sync-source config user.email "test@example.com"
          mkdir -p /tmp/sync-source/templates
          echo "hello from source" > /tmp/sync-source/templates/example.txt
          git -C /tmp/sync-source add templates/example.txt
          git -C /tmp/sync-source commit -m "Add source file"

      - name: Run action
        uses: ./
        with:
          source-repo: /tmp/sync-source
          source-ref: main
          source-path: templates
          target-ref: main
          target-path: synced/templates
          files: |
            example.txt
```

Run it from the Actions tab. The first run should open a PR. Running it again without changing the source file should update/comment on the existing PR instead of opening another one.

## Pull Request Behavior

Pull request titles include the destination path, sync ID, and date:

```text
Sync config/templates (a1b2c3d4e5f6) - 09-05-2026
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
| `changed` | `true` when a new PR was created, otherwise `false`. |
| `pr-number` | Pull request number when a sync PR exists. |
| `pr-url` | Pull request URL when a sync PR exists. |

## Notes

The action only copies the listed files. It does not mirror directories or delete files from the destination that are not listed in `files`.

The default branch from the destination repository is used as the pull request base when `target-ref` is not set.
