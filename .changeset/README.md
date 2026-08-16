# Changesets

Add a changeset for every pull request that changes published package behavior:

```bash
bun run changeset
```

Select each affected package and its SemVer bump. Explicitly named changesets are the primary release
input. Packages version independently; fixed and linked release groups are intentionally empty. With
`updateInternalDependencies` and `bumpVersionsWithWorkspaceProtocolOnly=false`, Changesets may also
automatically add dependent package releases and update dependency ranges. Changesets are consumed by
the Actions workflow's Version Packages PR.

Experimental packages are not ignored globally. They release only when an explicit changeset names
them, so select them deliberately. Documentation, tests, and repository-only tooling usually do not
need a changeset.
