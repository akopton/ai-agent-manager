import { createHash } from 'node:crypto';
import {
  trustedLocalExecutionAuthorizationSchema,
  type TrustedLocalExecutionAuthorization,
} from '@ai-agent-manager/core';

/**
 * In-process provenance and single use for Trusted Local authorizations (SEC-02c).
 *
 * A Zod schema proves only that an object is well formed, not that the Trusted Local gate issued
 * it. The gate therefore registers every authorization it issues here, together with the run it
 * was issued for, and the launch boundary redeems it exactly once:
 *
 * - **Provenance.** Only authorization IDs registered in this process are accepted. An object
 *   deserialized from a REST body, a database row, IPC or another process, or built by hand, was
 *   never registered here. A restarted worker starts with an empty registry, so every
 *   authorization issued before the restart is invalid.
 * - **Integrity.** The redeemed object must have the same canonical digest as the issued one.
 * - **Run binding.** The launch request must carry the same `runId` and prompt (compared by
 *   SHA-256 digest; the prompt itself is never stored).
 * - **Single use.** Redemption removes the entry synchronously before any other check, so copies,
 *   serialized forms, concurrent launches and retries after a failed launch are all refused.
 * - **Expiry and capacity.** An entry is unusable once it is older than the launch boundary's
 *   freshness limit plus clock skew. At most `maxPendingAuthorizations` entries wait to be
 *   redeemed; beyond that, registration fails and the gate denies (fail closed).
 *
 * **Scope: this is an in-process mechanism.** It guards against untrusted *data* crossing a
 * boundary, not against hostile code already running in the worker process: JavaScript modules
 * share one address space, and such code could claim the issuer before the gate, call the launch
 * boundary's dependencies directly, or spawn processes itself. If anything claims the issuer
 * before the gate, the gate cannot register and every Trusted Local launch fails closed. The
 * gate and the launch boundary must also share **one** instance of this module; two copies of
 * `@ai-agent-manager/agents` in one process (for example mixed `dist` and `src` resolution) make
 * every Trusted Local launch fail closed.
 *
 * The issuer is exported only through the restricted subpath
 * `@ai-agent-manager/agents/trusted-local-issuer`, which ESLint allows only in the orchestrator's
 * Trusted Local gate.
 */

export type TrustedLocalRunBinding = {
  /** The run the authorization is issued for (`AgentExecutionRequest.runId`). */
  runId: string;
  /** The exact prompt that will be written to stdin; only its digest is retained. */
  prompt: string;
};

/** Registers one gate-issued authorization. Returns `false` when it cannot be registered. */
export type TrustedLocalIssuer = (
  authorization: TrustedLocalExecutionAuthorization,
  binding: TrustedLocalRunBinding,
) => boolean;

export type TrustedLocalRedemption = { ok: true } | { ok: false; message: string };

type IssuanceRecord = {
  digest: string;
  runId: string;
  promptDigest: string;
  registeredAt: number;
};

/**
 * How long an unredeemed entry stays usable: the launch boundary's default authorization age
 * (60 s) plus its tolerated clock skew (5 s). The launch boundary also checks `checkedAt` itself.
 */
export const issuanceLifetimeMs = 65_000;
/** Upper bound of unredeemed authorizations; further registrations are refused (fail closed). */
export const maxPendingAuthorizations = 256;

export type IssuanceRegistryOptions = {
  /** Milliseconds since the epoch. */
  now: () => number;
  lifetimeMs: number;
  maxPending: number;
};

export type IssuanceRegistry = {
  register: TrustedLocalIssuer;
  redeem: (
    authorization: TrustedLocalExecutionAuthorization,
    run: TrustedLocalRunBinding,
  ) => TrustedLocalRedemption;
  /** Number of unexpired, unredeemed entries. */
  pendingCount: () => number;
};

const sha256 = (text: string): string =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** JSON with object keys sorted at every level, so key order cannot change the digest. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const digestAuthorization = (authorization: TrustedLocalExecutionAuthorization): string =>
  sha256(canonicalJson(authorization));

/**
 * Creates an issuance registry. The process-wide registry below is the only one production code
 * uses; separate instances exist for tests of expiry and capacity.
 *
 * @internal Not exported from any package entry point.
 */
export const createIssuanceRegistry = (options: IssuanceRegistryOptions): IssuanceRegistry => {
  const pending = new Map<string, IssuanceRecord>();
  // A clock that moved backwards also invalidates the entry (fail closed).
  const expired = (record: IssuanceRecord, now: number): boolean =>
    now - record.registeredAt > options.lifetimeMs || now < record.registeredAt;
  const prune = (now: number): void => {
    for (const [id, record] of pending) {
      if (expired(record, now)) pending.delete(id);
    }
  };

  const register: TrustedLocalIssuer = (authorization, binding) => {
    const now = options.now();
    prune(now);
    const parsed = trustedLocalExecutionAuthorizationSchema.safeParse(authorization);
    if (
      !parsed.success ||
      typeof binding.runId !== 'string' ||
      typeof binding.prompt !== 'string' ||
      pending.has(parsed.data.authorizationId) ||
      pending.size >= options.maxPending
    ) {
      return false;
    }
    pending.set(parsed.data.authorizationId, {
      digest: digestAuthorization(parsed.data),
      runId: binding.runId,
      promptDigest: sha256(binding.prompt),
      registeredAt: now,
    });
    return true;
  };

  const redeem: IssuanceRegistry['redeem'] = (authorization, run) => {
    const now = options.now();
    const record = pending.get(authorization.authorizationId);
    // Removed before anything is compared, so even a mismatching attempt uses it up.
    pending.delete(authorization.authorizationId);
    prune(now);
    if (record === undefined || expired(record, now)) {
      return {
        ok: false,
        message:
          'The Trusted Local authorization was not issued by the Trusted Local gate in this process, was already used, or expired. Authorize again for every launch.',
      };
    }
    if (record.digest !== digestAuthorization(authorization)) {
      return {
        ok: false,
        message: 'The Trusted Local authorization differs from the one the gate issued.',
      };
    }
    if (record.runId !== run.runId || record.promptDigest !== sha256(run.prompt)) {
      return {
        ok: false,
        message: 'The launch request is not the run or prompt the authorization was issued for.',
      };
    }
    return { ok: true };
  };

  const pendingCount = (): number => {
    prune(options.now());
    return pending.size;
  };

  return { register, redeem, pendingCount };
};

const processRegistry = createIssuanceRegistry({
  now: () => Date.now(),
  lifetimeMs: issuanceLifetimeMs,
  maxPending: maxPendingAuthorizations,
});
let issuerClaimed = false;

/**
 * Returns the issuer the first time it is called in this process and `null` afterwards. Only the
 * orchestrator's Trusted Local gate may call it (restricted subpath, enforced by ESLint).
 */
export const claimTrustedLocalIssuer = (): TrustedLocalIssuer | null => {
  if (issuerClaimed) {
    return null;
  }
  issuerClaimed = true;
  return processRegistry.register;
};

/**
 * Consumes a Trusted Local authorization for one launch.
 *
 * @internal Used only by the launch boundary; not exported from any package entry point.
 */
export const redeemTrustedLocalAuthorization = processRegistry.redeem;
