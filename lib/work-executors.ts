import type { ArtifactResolver } from "./artifact";
import type { Bucket } from "./bucket";
import type { WorkDefinition, WorkItem } from "./work-queue";

export type WorkExecutorContext = {
  artifacts?: ArtifactResolver;
  backend: Bucket;
  maxAttempts: number;
  publishEvent(data: Record<string, unknown>): Promise<void>;
  work: WorkItem;
};

export type WorkExecutor = {
  claimOrder: number;
  execute(context: WorkExecutorContext): Promise<boolean>;
  work: WorkDefinition;
};

const executors = new Map<string, WorkExecutor>();

export function registerWorkExecutor(executor: WorkExecutor) {
  const existing = executors.get(executor.work.name);
  if (existing && existing !== executor) {
    throw new Error(`Work executor already registered: ${executor.work.name}`);
  }
  executors.set(executor.work.name, executor);
  return executor;
}

export function listWorkExecutors() {
  return [...executors.values()].sort((left, right) => left.claimOrder - right.claimOrder || left.work.name.localeCompare(right.work.name));
}

export function clearWorkExecutors() {
  executors.clear();
}
