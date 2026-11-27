# Changesets

Merging and releasing are two steps (Dustin, 2026-11-13). A pull request never sets the version or writes CHANGELOG.md;
it adds a changeset, a short Markdown file here that says what changed and how big the change is:

    npx changeset            # asks patch, minor or major, then the text
    npx changeset --empty    # a change with nothing to release (CI, docs, tests)

Write the text as the CHANGELOG entry it becomes. CI fails a pull request with none.

A release is its own pull request, and nobody makes it by hand. Once a day devkit's release-batch workflow runs
`npx changeset version` for every package with changesets waiting, checks the consumers against the candidate and opens
"Release X.Y.Z", which merges itself when its checks pass. Merging it is the release: `.github/workflows/release.yml`
tags `vX.Y.Z`, publishes the GitHub release and starts the consumer bumps. Everything merged that day goes out in one
release, so the consumers repin once. An urgent release is a manual run of devkit's release-batch workflow with this
repository's name as its input.
