# Git inspection

Read-only inspection of existing local Git repositories through the native Git CLI.
Works with any hosting provider (GitHub, Gitea, plain SSH, local paths): no provider
SDKs or network access. Requires Git 2.31 or newer (`--path-format`,
`GIT_CONFIG_COUNT`); validated with Git 2.54.

## API

```ts
import {
  getHead,
  getWorkingTreeStatus,
  hasLocalBranch,
  inspectRepository,
  listBranches,
  listRemotes,
  validateRepository,
} from '@ai-agent-manager/git';

const validation = await validateRepository('/Users/me/repos/my project');
if (validation.valid) {
  const { root, isLinkedWorktree, commonDir } = validation.repository;
  await getHead(root); // { kind: 'branch' | 'unborn' | 'detached', ... }
  await listBranches(root); // [{ name, commit }]
  await listRemotes(root); // [{ name, fetchUrls, pushUrls }], possibly empty
  await hasLocalBranch(root, 'main'); // boolean
  await getWorkingTreeStatus(root); // { isClean, staged, unstaged, untracked, conflicted }
}

await inspectRepository(path); // validation plus all of the above in one result
```

- Paths must be absolute. Each function accepts `{ timeoutMs, maxOutputBytes }`
  (defaults: 10 s and 16 MiB per Git command).
- `validateRepository` returns `{ valid: false, reason, message }` for expected
  outcomes: `invalid_path`, `not_found`, `not_directory`, `not_git_repository`,
  `bare_repository`, `inside_git_directory`, `not_repository_root`, `unsafe_ownership`.
- **Nested paths:** by default a directory inside a working tree is rejected as
  `not_repository_root`, and the result includes the `root` to use instead. Pass
  `allowNestedPath: true` to accept it; `isRoot` then distinguishes the two.
- Linked worktrees (whose `.git` is a file) are valid working trees.
  `isLinkedWorktree` and `commonDir` identify the repository that owns them.
- Unexpected failures throw `GitCommandError` with a `code` (`GIT_UNAVAILABLE`,
  `GIT_FAILED`, `GIT_TIMEOUT`, `GIT_OUTPUT_LIMIT`), arguments, exit code, signal and
  stderr. Invalid arguments throw `GitInputError` before Git runs.

**Repository validity is not project eligibility.** A repository without remotes, or
with HEAD detached or unborn, is still valid. Whether it may be registered as an AI
Agent Manager project (for example, requiring a remote or an existing base branch) is
a later, separate decision.

## Read-only guarantees

Inspection runs only `rev-parse`, `symbolic-ref`, `for-each-ref`, `show-ref`,
`config --get-regexp`, and `status`. It never runs `fetch`, `pull`, `checkout`,
`reset`, `clean`, `add`, `commit`, `push`, `branch`, or `worktree`, and never writes
config. Tests check that inspecting a repository leaves every file under it,
including `.git`, byte-for-byte unchanged.

Every command is started with `spawn`, an argument array and `shell: false`, with the
repository as `cwd`; the process working directory is never changed. In addition:

- Inherited `GIT_*` variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
  `GIT_CONFIG_*`, ...) are removed, so the caller's environment cannot redirect
  inspection.
- `GIT_OPTIONAL_LOCKS=0`: `status` does not refresh or rewrite the index.
- `GIT_NO_LAZY_FETCH=1` and `GIT_TERMINAL_PROMPT=0`: no network fetches of missing
  partial-clone objects and no credential prompts.
- Config is forced through `GIT_CONFIG_COUNT` (keys and values are never parsed from a
  combined string): `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `gc.auto=0`,
  `maintenance.auto=false`.
- Before `status`, every configured `filter.<driver>` has its `clean`, `smudge`, and
  `process` commands set to empty and `required=false`. Repository config, which an
  agent working in a linked worktree can modify, could otherwise make `status`
  execute arbitrary commands through fsmonitor or clean filters. Tests confirm that
  an unprotected `git status` runs them and that inspection does not.
- Only built-in subcommands are invoked; Git aliases cannot override built-ins.
- `status` uses `--ignore-submodules=dirty`, so it does not run inside submodules.
  Changed submodule commits are reported, but uncommitted changes inside a submodule
  are not.
- Remote URLs are returned as data, never executed. Credentials in HTTP(S)/FTP(S)
  URLs are redacted (`https://***@host/...`). `url.*.insteadOf` rewrites are not applied.
- Git's `safe.directory` ownership check is respected, never overridden; refusal is
  reported as `unsafe_ownership`. User global config is still read (for example,
  for `safe.directory`), but it cannot re-enable the overrides above.
- Output is parsed from machine-readable formats (`status --porcelain=v2 -z`,
  NUL-separated `config` and `for-each-ref` output), so paths with spaces, newlines,
  leading dashes, or non-ASCII characters are handled.

Future mutating operations (creating branches and worktrees, committing, pushing)
are not part of this package yet. They will need their own explicit identity checks
(expected common dir, branch, and base SHA), confirmation, and tests against
disposable repositories and local bare remotes.

## Tests

```sh
pnpm --filter @ai-agent-manager/git test
```

Tests create repositories, bare remotes, and linked worktrees only inside temporary
directories whose names contain spaces. Fixture Git commands ignore global and system
config, and only those directories are removed.
