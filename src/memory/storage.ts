import { readFile, writeFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { SkillGraph, DriftSnapshot } from "./skill-graph.js";

export class SkillStorage {
  private skillsPath = "./data/skills.json";
  private driftPath = "./data/drift.json";

  constructor() {
    this.ensureDataDir();
  }

  private ensureDataDir() {
    if (!existsSync("./data")) {
      mkdirSync("./data", { recursive: true });
    }
  }

  async loadSkills(): Promise<SkillGraph[]> {
    try {
      const data = await readFile(this.skillsPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async saveSkill(skill: SkillGraph) {
    const skills = await this.loadSkills();
    const idx = skills.findIndex(s => s.skillId === skill.skillId);
    
    if (idx >= 0) {
      skills[idx] = skill;
    } else {
      skills.push(skill);
    }

    await writeFile(this.skillsPath, JSON.stringify(skills, null, 2));
  }

  async loadDrift(): Promise<DriftSnapshot[]> {
    try {
      const data = await readFile(this.driftPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async saveDriftSnapshot(snapshot: DriftSnapshot) {
    const snapshots = await this.loadDrift();
    snapshots.push(snapshot);
    await writeFile(this.driftPath, JSON.stringify(snapshots, null, 2));
  }
}
