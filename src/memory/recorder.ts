import { ExecutionTrace, SkillGraph, SkillNode, SkillEdge } from "./skill-graph.js";
import { SkillStorage } from "./storage.js";

export class SkillRecorder {
  private traces = new Map<string, ExecutionTrace>();
  private storage = new SkillStorage();

  startTrace(traceId: string) {
    this.traces.set(traceId, {
      traceId,
      steps: [],
      outcome: 'success'
    });
  }

  recordStep(traceId: string, tool: string, success: boolean, durationMs: number, params?: any) {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    trace.steps.push({
      tool,
      timestamp: Date.now(),
      durationMs,
      success,
      params
    });
  }

  async finalizeTrace(traceId: string, outcome: ExecutionTrace['outcome']) {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    trace.outcome = outcome;

    const skills = await this.storage.loadSkills();
    let skillToProcess: SkillGraph | undefined;

    // 1. Match existing skill
    for (const skill of skills) {
      const similarity = this.computeSimilarity(skill, trace);
      if (similarity > 0.7) { // TODO: Make threshold configurable
        skillToProcess = skill;
        break;
      }
    }

    // 2. Create if no match, otherwise reinforce
    if (!skillToProcess) {
      skillToProcess = this._createNewSkill(trace);
    } else {
      this._reinforceSkill(skillToProcess, trace);
    }
    
    // 3. Save
    await this.storage.saveSkill(skillToProcess);

    this.traces.delete(traceId);
  }

  private _createNewSkill(trace: ExecutionTrace): SkillGraph {
    return {
      skillId: `skill_${Date.now()}`,
      description: this.inferDescription(trace),
      tags: [],
      nodes: trace.steps.map((s, i) => ({
        id: `${s.tool}_${i}`,
        tool: s.tool,
        avgDurationMs: s.durationMs,
        successCount: s.success ? 1 : 0,
        failureCount: s.success ? 0 : 1
      })),
      edges: this.buildEdges(trace),
      createdAt: Date.now(),
      lastUsed: Date.now(),
      totalExecutions: 1,
      confidence: trace.outcome === 'success' ? 0.5 : 0.2
    };
  }

  private buildEdges(trace: ExecutionTrace): SkillEdge[] {
    const edges: SkillEdge[] = [];
    
    for (let i = 0; i < trace.steps.length - 1; i++) {
      const from = `${trace.steps[i].tool}_${i}`;
      const to = `${trace.steps[i + 1].tool}_${i + 1}`;
      const transitionMs = trace.steps[i + 1].timestamp - trace.steps[i].timestamp;

      edges.push({
        from,
        to,
        weight: 1,
        successRate: trace.steps[i].success && trace.steps[i + 1].success ? 1 : 0.5,
        avgTransitionMs: transitionMs
      });
    }

    return edges;
  }

  private _reinforceSkill(skill: SkillGraph, trace: ExecutionTrace) {
    skill.totalExecutions++;
    skill.lastUsed = Date.now();

    const alpha = 0.1;
    const outcomeScore = trace.outcome === 'success' ? 1 : 0;
    skill.confidence = skill.confidence * (1 - alpha) + outcomeScore * alpha;

    // This simplistic node matching only works if a tool is used once per skill
    for (const step of trace.steps) {
        const node = skill.nodes.find(n => n.tool === step.tool);
        if (node) {
            const total = node.successCount + node.failureCount;
            node.avgDurationMs = (node.avgDurationMs * total + step.durationMs) / (total + 1);
            if(step.success) node.successCount++; else node.failureCount++;
        }
    }

    for (let i = 0; i < trace.steps.length - 1; i++) {
      const fromTool = trace.steps[i].tool;
      const toTool = trace.steps[i+1].tool;

      // This simplistic edge matching only works if a tool is used once per skill
      const edge = skill.edges.find(e => e.from.startsWith(fromTool) && e.to.startsWith(toTool));

      if (edge) {
        const success = trace.steps[i].success && trace.steps[i+1].success;
        const newSuccessRate = success ? 1 : 0;
        
        edge.weight++;
        edge.successRate = edge.successRate * (1 - alpha) + newSuccessRate * alpha;

        const transitionMs = trace.steps[i + 1].timestamp - trace.steps[i].timestamp;
        edge.avgTransitionMs = (edge.avgTransitionMs * (edge.weight - 1) + transitionMs) / edge.weight;
      }
    }
  }

  private computeSimilarity(skill: SkillGraph, trace: ExecutionTrace): number {
    const skillTools = skill.nodes.map(n => n.tool);
    const traceTools = trace.steps.map(s => s.tool);

    if (skillTools.length !== traceTools.length) return 0;

    let matches = 0;
    for (let i = 0; i < skillTools.length; i++) {
      if (skillTools[i] === traceTools[i]) matches++;
    }

    return matches / skillTools.length;
  }

  private inferDescription(trace: ExecutionTrace): string {
    const tools = trace.steps.map(s => s.tool).join(" → ");
    return `Sequence: ${tools}`;
  }
}