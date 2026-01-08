import { SkillGraph, DriftSnapshot } from "./skill-graph.js";
import { SkillStorage } from "./storage.js";

export class DriftTracker {
  private storage = new SkillStorage();

  async captureSnapshot(skill: SkillGraph) {
    const avgDuration = skill.nodes.reduce((sum, n) => sum + n.avgDurationMs, 0) / skill.nodes.length;

    // 1. Get baseline for this skill
    const allSnapshots = await this.storage.loadDrift();
    const skillSnapshots = allSnapshots
      .filter(s => s.skillId === skill.skillId)
      .sort((a, b) => a.timestamp - b.timestamp);

    const baseline = skillSnapshots[0];
    let deviationScore = 0;

    // 2. Calculate deviation if baseline exists
    if (baseline) {
        const confidenceDelta = Math.abs(skill.confidence - baseline.confidence);
        const durationDelta = Math.abs(avgDuration - baseline.avgDurationMs);
        const complexityDelta = Math.abs(skill.nodes.length - baseline.stepCount);

        // Weights for different aspects of deviation. These are tunable.
        const CONFIDENCE_WEIGHT = 0.5;
        const DURATION_WEIGHT = 0.3;
        const COMPLEXITY_WEIGHT = 0.2;

        // Normalize deltas to prevent large values from dominating the score.
        // A simple approach is to divide by the baseline value.
        const normConf = baseline.confidence > 0 ? confidenceDelta / baseline.confidence : confidenceDelta;
        const normDur = baseline.avgDurationMs > 0 ? durationDelta / baseline.avgDurationMs : durationDelta;
        const normComp = baseline.stepCount > 0 ? complexityDelta / baseline.stepCount : complexityDelta;

        deviationScore = (normConf * CONFIDENCE_WEIGHT) + (normDur * DURATION_WEIGHT) + (normComp * COMPLEXITY_WEIGHT);
    }

    const snapshot: DriftSnapshot = {
      skillId: skill.skillId,
      timestamp: Date.now(),
      confidence: skill.confidence,
      avgDurationMs: avgDuration,
      stepCount: skill.nodes.length,
      deviationScore: deviationScore
    };

    await this.storage.saveDriftSnapshot(snapshot);
  }

  async analyzeDrift(skillId: string): Promise<{
    confidenceTrend: number;
    speedTrend: number;
    complexityTrend: number;
  }> {
    const snapshots = (await this.storage.loadDrift())
      .filter(s => s.skillId === skillId)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (snapshots.length < 2) {
      return { confidenceTrend: 0, speedTrend: 0, complexityTrend: 0 };
    }

    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];

    return {
      confidenceTrend: last.confidence - first.confidence,
      speedTrend: last.avgDurationMs - first.avgDurationMs,
      complexityTrend: last.stepCount - first.stepCount
    };
  }
}
