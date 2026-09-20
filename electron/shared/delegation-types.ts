/** Serializable contracts shared by desktop, MCP and main-process coordination. */
export type IntegrationPolicy = 'review' | 'automatic';
export type SessionProfile = 'ordinary' | 'child-review' | 'child-automatic';
export interface SessionCapabilities {
  profile: SessionProfile;
  canCreate: boolean;
  peers: boolean;
}

export interface SessionCaller {
  taskId: string;
  agentId: string;
  sessionInstanceId: string;
  capabilities: SessionCapabilities;
}

export interface TaskAuthorityInput {
  taskId: string;
  name: string;
  projectId: string;
  projectRoot: string;
  worktreePath: string;
  branchName: string;
  gitIsolation: 'worktree' | 'direct' | 'none';
  parentTaskId?: string;
  coordinatorMode?: boolean;
  delegationParent?: boolean;
  propagateSkipPermissions?: boolean;
  externalWorktree?: boolean;
  integrationPolicy?: IntegrationPolicy;
  delegationPaused?: boolean;
  agentCommand: string;
  agentArgs: string[];
  agentEnvFile?: string;
  dockerMode?: boolean;
  dockerImage?: string;
  verifyCommand?: string;
  maxConcurrentTasks?: number;
}

export interface ProjectDelegationPolicy {
  projectId: string;
  allowAgentTaskCreation: boolean;
  allowPeerAccess: boolean;
}

export interface DelegationSnapshot {
  branchName: string;
  headSha: string;
  changedFileCount: number;
}

export interface DelegateAssignment {
  parentTaskId: string;
  requestId: string;
  name: string;
  prompt: string;
  expectedBranch: string;
  expectedHeadSha: string;
  useLastCommit: boolean;
  agentCommand?: string;
  agentArgs?: string[];
  agentEnvFile?: string;
  propagateSkipPermissions?: boolean;
}

export interface DelegationAttempt {
  requestId: string;
  parentTaskId: string;
  name: string;
  status: 'starting' | 'failed' | 'created';
  taskId?: string;
  error?: string;
}

export interface PeerSession {
  agentId: string;
  sessionInstanceId: string;
  taskId: string;
  name: string;
  agentLabel: string;
  branchName: string;
  status: string;
}

export interface PeerMessage {
  deliveryId: string;
  sender: PeerSession;
  recipient: PeerSession;
  prompt: string;
  createdAt: string;
  state: 'waiting' | 'handled' | 'closed';
  reason?: string;
}

export interface DelegationReview {
  expectedCommit: string;
  expectedTargetBranch: string;
  expectedTargetCommit: string;
  diff: string;
}

export type DelegationRequest =
  | { action: 'register'; task: TaskAuthorityInput }
  | { action: 'unregister'; taskId: string }
  | { action: 'projectPolicy'; policy: ProjectDelegationPolicy }
  | { action: 'snapshot'; taskId: string }
  | { action: 'create'; assignment: DelegateAssignment }
  | { action: 'pause'; taskId: string; paused: boolean }
  | { action: 'review'; taskId: string }
  | { action: 'merge'; taskId: string; review: Omit<DelegationReview, 'diff'> }
  | { action: 'inbox'; taskId: string }
  | {
      action: 'handleMessage';
      deliveryId: string;
      agentId: string;
      sessionInstanceId: string;
      state: 'handled' | 'closed';
    }
  | { action: 'dismissAttempt'; parentTaskId: string; requestId: string }
  | { action: 'state'; taskId: string }
  | { action: 'closeParent'; taskId: string; deleteBranch?: boolean };

export interface DelegationState {
  attempts: DelegationAttempt[];
  messages: PeerMessage[];
  paused: boolean;
}

export type DelegationChanged =
  | { taskId: string; state: DelegationState }
  | { taskId: string; detachedChildIds: string[] };
