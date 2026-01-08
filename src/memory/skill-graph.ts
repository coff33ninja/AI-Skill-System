export interface SkillNode {
  id: string;
  tool: string;              // MCP tool name
  avgDurationMs: number;
  successCount: number;
  failureCount: number;
}

export interface SkillEdge {
  from: string;
  to: string;
  weight: number;            // execution frequency
  successRate: number;       // 0-1
  avgTransitionMs: number;
}

export interface SkillGraph {
  skillId: string;
  description: string;
  tags: string[];
  nodes: SkillNode[];
  edges: SkillEdge[];
  createdAt: number;
  lastUsed: number;
  totalExecutions: number;
  confidence: number;        // 0-1
}

export interface DriftSnapshot {
  skillId: string;
  timestamp: number;
  confidence: number;
  avgDurationMs: number;
  stepCount: number;
  deviationScore: number;    // how different from baseline
}

export interface ExecutionTrace {
  traceId: string;
  skillId?: string;
  steps: Array<{
    tool: string;
    timestamp: number;
    durationMs: number;
    success: boolean;
    params?: any;
  }>;
  outcome: 'success' | 'failure' | 'aborted';
}
