import {
  getHead,
  listBranches,
  listRemotes,
  type GitRemote,
  type HeadState,
  type LocalBranch,
} from './refs.js';
import {
  validateRepository,
  type RepositoryInvalidReason,
  type RepositoryLocation,
  type ValidateRepositoryOptions,
} from './repository.js';
import { getWorkingTreeStatus, type WorkingTreeStatus } from './status.js';

export type RepositoryInspection =
  | {
      valid: true;
      repository: RepositoryLocation;
      head: HeadState;
      branches: LocalBranch[];
      /** May be empty: a repository without remotes is still a valid repository. */
      remotes: GitRemote[];
      workingTree: WorkingTreeStatus;
    }
  | { valid: false; reason: RepositoryInvalidReason; message: string; root?: string };

/**
 * Validates `path` and, if it is a Git working tree, collects HEAD, branches, remotes, and status
 * from its root. This reports repository facts only; whether the repository is eligible as an AI
 * Agent Manager project (for example, requiring a remote or base branch) is decided elsewhere.
 */
export const inspectRepository = async (
  path: string,
  options: ValidateRepositoryOptions = {},
): Promise<RepositoryInspection> => {
  const validation = await validateRepository(path, options);
  if (!validation.valid) {
    return validation;
  }
  const commandOptions = { timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes };
  const { root } = validation.repository;
  const [head, branches, remotes, workingTree] = await Promise.all([
    getHead(root, commandOptions),
    listBranches(root, commandOptions),
    listRemotes(root, commandOptions),
    getWorkingTreeStatus(root, commandOptions),
  ]);
  return { valid: true, repository: validation.repository, head, branches, remotes, workingTree };
};
