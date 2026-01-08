import { ExecutionTrace, SkillGraph, SkillNode, SkillEdge } from "./skill-graph.js";
import { SkillStorage } from "./storage.js";

export class SkillRecorder {
  private traces = new Map<string, ExecutionTrace>();
  public storage = new SkillStorage(); // Made public for drift tracking

  startTrace(traceId: string) {
    this.traces.set(traceId, {
      traceId,
      steps: [],
      outcome: 'success'
    });
    console.log(`📝 Started trace: ${traceId}`);
  }

  recordStep(traceId: string, tool: string, success: boolean, durationMs: number, params?: any) {
    const trace = this.traces.get(traceId);
    if (!trace) {
      console.warn(`⚠️  Trace ${traceId} not found, cannot record step`);
      return;
    }

    trace.steps.push({
      tool,
      timestamp: Date.now(),
      durationMs,
      success,
      params
    });

    console.log(`  📌 Recorded: ${tool} (${success ? '✅' : '❌'}, ${durationMs}ms)`);
  }

  async finalizeTrace(traceId: string, outcome: ExecutionTrace['outcome']) {
    const trace = this.traces.get(traceId);
    if (!trace) {
      console.warn(`⚠️  Trace ${traceId} not found, cannot finalize`);
      return;
    }

    if (trace.steps.length === 0) {
      console.log(`⚠️  Trace ${traceId} has no steps, skipping skill creation`);
      this.traces.delete(traceId);
      return;
    }

    trace.outcome = outcome;

    const skills = await this.storage.loadSkills();
    let skillToProcess: SkillGraph | undefined;

    // 1. Match existing skill
    for (const skill of skills) {
      const similarity = this.computeSimilarity(skill, trace);
      if (similarity > 0.7) {
        console.log(`🔗 Matched existing skill: ${skill.skillId} (similarity: ${similarity.toFixed(2)})`);
        skillToProcess = skill;
        break;
      }
    }

    // 2. Create if no match, otherwise reinforce
    if (!skillToProcess) {
      skillToProcess = this._createNewSkill(trace);
      console.log(`✨ Created new skill: ${skillToProcess.skillId}`);
      console.log(`   Description: ${skillToProcess.description}`);
    } else {
      this._reinforceSkill(skillToProcess, trace);
      console.log(`💪 Reinforced skill: ${skillToProcess.skillId}`);
      console.log(`   Confidence: ${skillToProcess.confidence.toFixed(2)}, Executions: ${skillToProcess.totalExecutions}`);
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

    // Build a mapping of tool sequence position for better matching
    const traceSequence = trace.steps.map(s => s.tool);
    const skillSequence = skill.nodes.map(n => n.tool);

    // Match steps by position in sequence (handles repeated tools)
    for (let i = 0; i < trace.steps.length; i++) {
      const step = trace.steps[i];
      
      // Find node by position if sequences match
      if (i < skill.nodes.length && skillSequence[i] === step.tool) {
        const node = skill.nodes[i];
        const total = node.successCount + node.failureCount;
        node.avgDurationMs = (node.avgDurationMs * total + step.durationMs) / (total + 1);
        if (step.success) node.successCount++; 
        else node.failureCount++;
      }
    }

    // Reinforce edges
    for (let i = 0; i < trace.steps.length - 1; i++) {
      const fromIndex = i;
      const toIndex = i + 1;

      if (fromIndex < skill.nodes.length && toIndex < skill.nodes.length) {
        const fromNodeId = skill.nodes[fromIndex].id;
        const toNodeId = skill.nodes[toIndex].id;

        const edge = skill.edges.find(e => e.from === fromNodeId && e.to === toNodeId);

        if (edge) {
          const success = trace.steps[i].success && trace.steps[i + 1].success;
          const newSuccessRate = success ? 1 : 0;
          
          edge.weight++;
          edge.successRate = edge.successRate * (1 - alpha) + newSuccessRate * alpha;

          const transitionMs = trace.steps[i + 1].timestamp - trace.steps[i].timestamp;
          edge.avgTransitionMs = (edge.avgTransitionMs * (edge.weight - 1) + transitionMs) / edge.weight;
        }
      }
    }
  }

  private computeSimilarity(skill: SkillGraph, trace: ExecutionTrace): number {
    const skillTools = skill.nodes.map(n => n.tool);
    const traceTools = trace.steps.map(s => s.tool);

    // Must be same length for similarity match
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