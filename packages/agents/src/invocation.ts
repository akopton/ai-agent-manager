import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { RuntimeSecurityProfile } from '@ai-agent-manager/core';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentExecutionRequest,
  AgentOutputParser,
  CliInstallation,
  InvocationPreparation,
} from './contract.js';
import { detectCli, type CliDefinition } from './discovery.js';
import { buildChildEnvironment, digestEnvironment } from './environment.js';
import { cliModelIdSchema } from './model-selection.js';
import { findUnsafeLaunchArguments } from './security-profiles.js';

export const maxPromptBytes = 1024 * 1024;
export const maxTimeoutMs = 24 * 60 * 60 * 1000;

const executionRequestSchema = z
  .object({
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, 'must be an identifier'),
    prompt: z
      .string()
      .refine((value) => value.trim().length > 0, 'must not be empty')
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= maxPromptBytes,
        `must be at most ${maxPromptBytes} bytes`,
      )
      .refine((value) => !value.includes('\0'), 'must not contain NUL characters'),
    modelId: cliModelIdSchema,
    workingDirectory: z
      .string()
      .refine(
        (value) => !value.includes('\0') && isAbsolute(value) && normalize(value) === value,
        'must be an absolute, normalized path',
      ),
    timeoutMs: z.number().int().positive().max(maxTimeoutMs).optional(),
    resumeSessionId: z.undefined({ error: 'session resume is not supported' }).optional(),
  })
  .strict();

export type ValidExecutionRequest = z.output<typeof executionRequestSchema>;

export const parseExecutionRequest = (
  request: unknown,
): { ok: true; request: ValidExecutionRequest } | { ok: false; field: string; message: string } => {
  const parsed = executionRequestSchema.safeParse(request);
  if (parsed.success) {
    return { ok: true, request: parsed.data };
  }
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.') ?? '';
  return { ok: false, field, message: `${field || 'request'}: ${issue?.message ?? 'invalid'}` };
};

/** Everything that distinguishes one CLI adapter from another. */
export type AdapterSpecification = {
  definition: CliDefinition;
  securityProfile: RuntimeSecurityProfile;
  /** Fixed options appended after the profile arguments (output format only). */
  outputArguments: readonly string[];
  /** Fixed arguments after the model option (for example `-` to read the prompt from stdin). */
  trailingArguments: readonly string[];
  /**
   * Options the adapter never emits. Checked on the final argument list in addition to the
   * security deny list (for example automatic model fallback, resume, or CLI-managed worktrees).
   */
  forbiddenOptions: readonly string[];
  capabilities: (installation: CliInstallation) => AgentCapabilities;
  createOutputParser: (context: { explicitModel: boolean }) => AgentOutputParser;
};

/** Returns problems with a final argument list: security deny list plus adapter rules. */
export const findRejectedArguments = (
  specification: AdapterSpecification,
  args: readonly string[],
): string[] => {
  const problems = findUnsafeLaunchArguments(specification.definition.runtime, args);
  for (const argument of args) {
    const name = argument.startsWith('--') ? argument.split('=', 1)[0] : argument;
    if (name !== undefined && specification.forbiddenOptions.includes(name)) {
      problems.push(
        `${name}: not supported by the ${specification.definition.displayName} adapter`,
      );
    }
  }
  return problems;
};

const prepareExecution =
  (specification: AdapterSpecification): AgentAdapter['prepareExecution'] =>
  (installation, request: AgentExecutionRequest, options = {}): InvocationPreparation => {
    const { definition, securityProfile } = specification;
    const parsed = parseExecutionRequest(request);
    if (!parsed.ok) {
      if (parsed.field === 'resumeSessionId') {
        return { ok: false, code: 'resume_unsupported', message: parsed.message };
      }
      return {
        ok: false,
        code: parsed.field === 'modelId' ? 'model_invalid' : 'invalid_request',
        message: parsed.message,
      };
    }
    const valid = parsed.request;
    if (installation.runtime !== definition.runtime) {
      return {
        ok: false,
        code: 'installation_mismatch',
        message: `The installation is for ${installation.runtime}, not ${definition.runtime}.`,
      };
    }
    if (valid.modelId !== null && !installation.detectedOptions.includes('--model')) {
      return {
        ok: false,
        code: 'model_selection_unsupported',
        message: `${definition.displayName} ${installation.version} does not list --model; only the Default model can be used.`,
      };
    }
    const args = [
      ...securityProfile.launchArguments,
      ...specification.outputArguments,
      ...(valid.modelId === null ? [] : ['--model', valid.modelId]),
      ...specification.trailingArguments,
    ];
    const problems = findRejectedArguments(specification, args);
    if (problems.length > 0) {
      return { ok: false, code: 'unsafe_arguments', message: problems.join('; ') };
    }
    const environment = buildChildEnvironment(
      options.sourceEnvironment ?? process.env,
      definition.environmentNames,
    );
    return {
      ok: true,
      plan: Object.freeze({
        runtime: definition.runtime,
        authorization: 'required',
        executablePath: installation.executablePath,
        args: Object.freeze(args),
        profileArguments: Object.freeze([...securityProfile.launchArguments]),
        launchProfileId: securityProfile.id,
        cwd: valid.workingDirectory,
        promptTransport: 'stdin',
        modelId: valid.modelId,
        environmentNames: Object.freeze(Object.keys(environment).sort()),
        invocation: Object.freeze({
          executable: Object.freeze({
            path: installation.executablePath,
            ...installation.fingerprint,
          }),
          arguments: Object.freeze([...args]),
          environmentDigest: digestEnvironment(environment),
        }),
      }),
    };
  };

export const createAdapter = (specification: AdapterSpecification): AgentAdapter =>
  Object.freeze({
    runtime: specification.definition.runtime,
    securityProfile: specification.securityProfile,
    detect: (options) => detectCli(specification.definition, options),
    capabilities: specification.capabilities,
    prepareExecution: prepareExecution(specification),
    createOutputParser: specification.createOutputParser,
    buildEnvironment: (source: NodeJS.ProcessEnv) =>
      buildChildEnvironment(source, specification.definition.environmentNames),
  });
