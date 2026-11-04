import { z } from 'zod';

export const workerStates = ['idle', 'starting', 'running', 'stopping', 'stopped'] as const;

export const workerStateSchema = z.enum(workerStates);

export type WorkerState = z.infer<typeof workerStateSchema>;

export const shutdownSignals = ['SIGINT', 'SIGTERM'] as const;

export const shutdownSignalSchema = z.enum(shutdownSignals);

export type ShutdownSignal = z.infer<typeof shutdownSignalSchema>;
