import { createHash } from 'node:crypto';
import {
  conversationTurnAuthorizationSchema,
  type ConversationTurnAuthorization,
} from '@ai-agent-manager/core';

/**
 * In-process provenance and single use for conversation turn authorizations (C2). It follows the
 * Trusted Local execution registry (`trusted-local-issuance.ts`) but is a **separate** registry
 * for a separate authorization type, so neither kind can be redeemed by the other launch boundary.
 *
 * - Only the orchestrator's conversation gate can register (the issuer is claimed once, through
 *   the restricted subpath `@ai-agent-manager/agents/conversation-issuer`).
 * - `startConversationTurn` redeems an authorization exactly once, for the same turn ID and the
 *   same prompt (compared by SHA-256; the prompt is never stored), with an identical canonical
 *   digest, within `conversationIssuanceLifetimeMs`.
 * - Deserialized, hand-built, copied, altered, replayed or expired authorizations are refused.
 *
 * This is protection against untrusted **data** crossing a boundary, not against hostile code in
 * the worker process.
 */

export type ConversationTurnBinding = { turnId: string; prompt: string };

export type ConversationIssuer = (
  authorization: ConversationTurnAuthorization,
  binding: ConversationTurnBinding,
) => boolean;

export type ConversationRedemption = { ok: true } | { ok: false; message: string };

export const conversationIssuanceLifetimeMs = 65_000;
export const maxPendingConversationAuthorizations = 64;

type IssuanceRecord = {
  digest: string;
  turnId: string;
  promptDigest: string;
  registeredAt: number;
};

const sha256 = (text: string): string =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

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

export type ConversationIssuanceRegistry = {
  register: ConversationIssuer;
  redeem: (
    authorization: ConversationTurnAuthorization,
    binding: ConversationTurnBinding,
  ) => ConversationRedemption;
};

/**
 * @internal Separate instances exist only for tests; production uses the process registry below.
 */
export const createConversationIssuanceRegistry = (options: {
  now: () => number;
  lifetimeMs: number;
  maxPending: number;
}): ConversationIssuanceRegistry => {
  const pending = new Map<string, IssuanceRecord>();
  const expired = (record: IssuanceRecord, now: number): boolean =>
    now - record.registeredAt > options.lifetimeMs || now < record.registeredAt;
  const prune = (now: number): void => {
    for (const [id, record] of pending) {
      if (expired(record, now)) pending.delete(id);
    }
  };

  const register: ConversationIssuer = (authorization, binding) => {
    const now = options.now();
    prune(now);
    const parsed = conversationTurnAuthorizationSchema.safeParse(authorization);
    if (
      !parsed.success ||
      typeof binding.turnId !== 'string' ||
      typeof binding.prompt !== 'string' ||
      binding.turnId !== parsed.data.turnId ||
      pending.has(parsed.data.authorizationId) ||
      pending.size >= options.maxPending
    ) {
      return false;
    }
    pending.set(parsed.data.authorizationId, {
      digest: sha256(canonicalJson(parsed.data)),
      turnId: binding.turnId,
      promptDigest: sha256(binding.prompt),
      registeredAt: now,
    });
    return true;
  };

  const redeem: ConversationIssuanceRegistry['redeem'] = (authorization, binding) => {
    const now = options.now();
    const record = pending.get(authorization.authorizationId);
    // Removed before anything is compared, so even a mismatching attempt uses it up.
    pending.delete(authorization.authorizationId);
    prune(now);
    if (record === undefined || expired(record, now)) {
      return {
        ok: false,
        message:
          'The conversation authorization was not issued by the conversation gate in this process, was already used, or expired.',
      };
    }
    if (record.digest !== sha256(canonicalJson(authorization))) {
      return { ok: false, message: 'The conversation authorization differs from the issued one.' };
    }
    if (record.turnId !== binding.turnId || record.promptDigest !== sha256(binding.prompt)) {
      return {
        ok: false,
        message: 'The launch is not the turn or prompt the authorization was issued for.',
      };
    }
    return { ok: true };
  };

  return { register, redeem };
};

const processRegistry = createConversationIssuanceRegistry({
  now: () => Date.now(),
  lifetimeMs: conversationIssuanceLifetimeMs,
  maxPending: maxPendingConversationAuthorizations,
});
let issuerClaimed = false;

/** Returns the issuer once per process, `null` afterwards. Only the conversation gate calls it. */
export const claimConversationIssuer = (): ConversationIssuer | null => {
  if (issuerClaimed) {
    return null;
  }
  issuerClaimed = true;
  return processRegistry.register;
};

/** @internal Used only by `startConversationTurn`. */
export const redeemConversationAuthorization = processRegistry.redeem;
