# Git inspection and task worktrees

Read-only inspection of existing local Git repositories, plus a safe lifecycle for
task worktrees, through the native Git CLI.
Works with any hosting provider (GitHub, Gitea, plain SSH, local paths): no provider
SDKs or network access. Requires Git 2.36 or newer (`worktree list -z`,
`worktree add --reason`, `GIT_CONFIG_COUNT`); validated with Git 2.54.

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

The only mutating operations are the task worktree functions below. Committing,
pushing, fetching, merging, and deleting branches are not implemented.

## Task worktrees

```ts
import { createTaskWorktree, inspectTaskWorktree, removeTaskWorktree } from '@ai-agent-manager/git';
import { resolveRuntimePaths } from '@ai-agent-manager/database';

const worktree = await createTaskWorktree({
  repositoryPath: '/Users/me/repos/my project', // main working tree
  baseBranch: 'main', // existing local branch; nothing is fetched
  taskId: 'task-42', // [a-z0-9][a-z0-9_-]{0,63}
  // branchName: 'agent/task-42-login', // optional; defaults to agent/<taskId>
  worktreeRoot: resolveRuntimePaths().worktreeRoot,
});
// { taskId, branch, path, baseBranch, baseCommit, repository: { root, commonDir, key }, lockReason }

const target = {
  repositoryPath: worktree.repository.root,
  worktreePath: worktree.path,
  branchName: worktree.branch,
};
await inspectTaskWorktree(target); // { state, issues, head, workingTree, branchCommit, ... }
await removeTaskWorktree(target); // keeps the branch
```

The Git package does not read configuration itself; the worker passes the validated
`worktreeRoot` from `@ai-agent-manager/database`, which already keeps it apart from
the data root and database.

### Layout and isolation

Worktrees live at `<worktreeRoot>/<repository key>/<taskId>`, where the key is
`<directory-name-slug>-<first 12 hex chars of sha256(canonical common Git dir)>`.
Repositories with the same folder name get different keys; moving a repository
changes its key. Before anything is created:

- The repository must be the root of a main working tree (not bare, nested, or linked).
- Task IDs and branch names are validated (task IDs by a strict pattern; branch names
  by a local schema and `git check-ref-format`), so they cannot contain path traversal.
- The base branch is resolved to a full SHA from `refs/heads/<base>`; remote-tracking
  branches are not used. "Latest" means the latest local commit at creation time.
- The worktree root is created if missing (mode `0700`) and canonicalized. The root
  and the repository directory must be real directories (not symlinks) owned by the
  current user, and nothing may be inside the repository, its worktrees, or its Git
  directory. String prefixes are never trusted; symlinks are resolved and compared.
- The task branch must not exist, and the destination must not be registered as a
  worktree. Existing paths are never reused, emptied, overwritten, or renamed.
- The shared `<worktreeRoot>/<repository key>` directory is created if missing
  (tolerating a concurrent creation), validated as above, and never removed by this
  package, because other operations may be using it.

### Creation sequence

1. **Claim the destination** with an exclusive, non-recursive `mkdir` (mode `0700`) and
   record its identity (`dev`, `ino`, birth time). The claim is the existence check:
   any existing entry (directory, file, or dangling symlink), including one created
   concurrently by another process, fails with `DESTINATION_EXISTS` and is not touched.
   Without this, `git worktree add` would silently adopt an empty directory that
   appeared after a separate existence check.
2. `git update-ref refs/heads/<branch> <base SHA> ""`: create-only, so a branch that
   appeared concurrently is never overwritten. No upstream tracking config is written.
3. `git worktree add --lock --reason "ai-agent-manager task worktree: <branch>" -- <path> <branch>`.
   Git accepts the empty claimed directory. The lock protects the worktree from
   `git worktree prune`/`remove` and is the ownership marker that inspection and
   removal require.
4. The result is verified: the directory must still be the one claimed in step 1, and
   inspection must report `ready`, clean, and at the base SHA.

The main working tree's HEAD, index, files, and config are never touched. Nothing is
fetched, committed, or pushed, and a different base SHA is never retried silently.

Concurrent attempts for the same task lose at the claim (`DESTINATION_EXISTS`) or the
branch check (`BRANCH_EXISTS`); concurrent attempts for different tasks with the same
branch name lose at the create-only `update-ref` (`BRANCH_EXISTS`) and release their
own claim. Exactly one attempt wins.

### Failure handling

A claim is released only with a non-recursive `rmdir`, and only while the directory is
still empty and has the recorded identity. A directory written to or replaced by
another process is never removed.

| Failure                                                                                                                                                              | Result                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Invalid input, missing base, existing branch, unsafe path                                                                                                            | Error before anything is claimed or mutated.                                                        |
| Destination exists or appears concurrently                                                                                                                           | `DESTINATION_EXISTS`; the existing entry is untouched.                                              |
| `update-ref` refused because the branch already exists                                                                                                               | Claim released; `BRANCH_EXISTS`.                                                                    |
| `update-ref` fails and the branch does not exist                                                                                                                     | Claim released; `CREATE_FAILED`.                                                                    |
| `update-ref` fails but the branch exists (for example, after a timeout)                                                                                              | `RECOVERY_REQUIRED`; branch and claim preserved.                                                    |
| `worktree add` fails, nothing is registered, the destination is gone or is still our empty claim, and the branch still points at the base SHA and is not checked out | Claim released, then the branch is deleted with compare-and-delete. `CREATE_FAILED`.                |
| `worktree add` fails in any other state (directory written to or replaced, registration left, branch moved or checked out)                                           | `RECOVERY_REQUIRED` with `recovery` (branch commit, path existence, registration); nothing deleted. |
| Created but the directory is not the claimed one, or inspection fails                                                                                                | `RECOVERY_REQUIRED` with `inspection`; preserved.                                                   |

**Residual risk.** The claim proves that the destination directory itself was created by
this operation. It cannot stop another process running as the same user from writing
into that `0700` directory before Git checks that it is empty (Git then refuses) or
during checkout. If checkout then fails, Git itself removes the destination recursively,
as it does for any directory it was asked to populate. Agents and other writers must not
operate in a task worktree before `createTaskWorktree` returns.

### Inspection

`inspectTaskWorktree` is read-only and establishes ownership from Git's records,
never from the folder name: the path's worktree registration, its common Git
directory, its checked-out branch, and the lock reason. It returns `ready`,
`absent`, `branch_only` (removed, or creation interrupted before `worktree add`), or
`inconsistent` with `issues` such as `path_missing`, `not_registered`,
`different_repository`, `branch_mismatch`, `lock_missing`, `main_worktree`, or
`path_is_symlink`. Parent directories are canonicalized; the final path component is
never followed.

### Removal

`removeTaskWorktree` requires the repository, worktree path, and branch, and:

- Re-inspects; anything other than `ready` (including the main working tree, an
  unrelated or manually created worktree, a missing lock marker, or a symlinked path)
  fails with `NOT_VERIFIED`.
- Refuses with `WORKTREE_DIRTY` when there are modified, staged, untracked, or
  conflicted files, or Git-ignored files (which `git worktree remove` would delete
  silently, such as `.env` or build output) unless `allowIgnoredFiles: true`.
- Unlocks and runs a non-forced `git worktree remove`, which re-checks cleanliness. If
  Git refuses, the lock is restored and `REMOVE_FAILED` is returned.
- Never deletes the task branch, and never runs `git clean`, `git reset --hard`, or a
  recursive delete itself. Stop agents writing to the worktree before removing it.

### Mutating command safety

Mutating commands use the same environment as inspection (no inherited `GIT_*`
variables, no prompts, no lazy fetch, hooks disabled with `core.hooksPath=/dev/null`,
`core.fsmonitor=false`, no automatic GC/maintenance), with every configured filter
driver neutralized (checkout would otherwise run smudge filters from repository
config), plus `protocol.allow=never` and `submodule.recurse=false`. Tests confirm
that `post-checkout`, `reference-transaction`, and `post-index-change` hooks (from
`.git/hooks` or a repository-configured `core.hooksPath`), fsmonitor, and
clean/smudge filters do not run, while plain Git runs all of them in the same
fixture. Mutating commands default to a 120 s timeout. Consequently, files that
depend on filters (for example Git LFS) are checked out as their raw blobs.

## Tests

```sh
pnpm --filter @ai-agent-manager/git test
```

Tests create repositories, bare remotes, and linked worktrees only inside temporary
directories whose names contain spaces. Fixture Git commands ignore global and system
config, and only those directories are removed.
