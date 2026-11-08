# One change across several repositories of a workspace

When one feature touches several repositories of a JERRY workspace (for example api, shop and admin), write
one plan, not one per repository:

- Submit it from the repository that leads the change (`repoPath`); its globs go in `scope.include`.
- `repositoryScopes`: one entry per other repository, with `repository` (its absolute root) and its own
  `include` / `exclude` globs, relative to that repository.
- `repositories`: every repository's absolute root. `crossRepoDependencies`: the contracts between them and
  the order of the changes.
- Each change and step names its `repository` (absolute root). Every repository gets only its own changes.
- JERRY refuses repositories outside the workspace, ones that are not projects, and globs that leave their
  repository. The user approves the whole plan once.
