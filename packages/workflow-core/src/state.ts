import type { WorkflowRunStatus, WorkflowStepStatus } from './types.js';

const RUN_TRANSITIONS: Readonly<Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>> = {
  queued: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted'],
  waiting_approval: ['running', 'failed', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

const STEP_TRANSITIONS: Readonly<Record<WorkflowStepStatus, readonly WorkflowStepStatus[]>> = {
  pending: ['running', 'failed', 'skipped'],
  running: ['running', 'waiting_approval', 'succeeded', 'failed'],
  waiting_approval: ['running', 'failed'],
  succeeded: [],
  failed: [],
  skipped: [],
};

export class WorkflowStateError extends Error {
  readonly code = 'invalid_state_transition';

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowStateError';
  }
}

export function canTransitionRun(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionStep(from: WorkflowStepStatus, to: WorkflowStepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new WorkflowStateError(`非法运行状态转换：${from} → ${to}`);
  }
}

export function assertStepTransition(from: WorkflowStepStatus, to: WorkflowStepStatus): void {
  if (!canTransitionStep(from, to)) {
    throw new WorkflowStateError(`非法步骤状态转换：${from} → ${to}`);
  }
}
