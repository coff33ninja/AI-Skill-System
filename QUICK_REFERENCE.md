# 🚀 AI Skill System - Quick Reference

## One-Minute Setup

```bash
# 1. Configure
cp .env.example .env
# Edit GEMINI_KEY_1, GEMINI_KEY_2, GEMINI_KEY_3

# 2. Build
npm run build

# 3. Run (3 terminals)
npm run mcp        # Terminal 1
npm run agent      # Terminal 2  
npm run viz        # Terminal 3 (opens browser)
```

## Core Concepts

### Gemini Orchestrator
- Manages API keys (load-balanced rotation)
- Connects to MCP server via stdio
- Records execution traces
- Calls Gemini 1.5 Pro for reasoning

### MCP Server
Provides 8 tools to Gemini:
- **control_enable()** - Grant permission (time-limited)
- **control_disable()** - Revoke permission
- **screen_observe()** - Screenshot
- **mouse_move(x, y)** - Move cursor
- **mouse_click()** - Click
- **keyboard_type(text)** - Type
- **keyboard_shortcut(keys)** - Hotkey
- **control_status()** - Check permissions

### Skill Graph
Directed graph of learned procedures:
- **Nodes** = individual tool calls
- **Edges** = transitions between tools
- **Confidence** = success probability (0-1)
- **Stored** in `data/skills.json`

### Drift Tracking
Monitors how skills change over time:
- Confidence erosion/growth
- Execution speed (slower/faster)
- Complexity (more/fewer steps)
- Visualized in web dashboard

## File Structure

```
src/
├── agent/
│   ├── gemini-orchestrator.ts   (Main AI)
│   ├── key-pool.ts              (Key rotation)
│   └── consent-manager.ts       (Security)
├── mcp/
│   ├── computer-control-server.ts  (Local tools)
│   └── mesh-node.ts             (Remote relay)
├── memory/
│   ├── skill-graph.ts           (Types)
│   ├── recorder.ts              (Trace→skill)
│   ├── storage.ts               (Persistence)
│   └── drift-tracker.ts         (Analytics)
├── viz/
│   └── drift-viewer.html        (Dashboard)
└── index.ts                     (Bootstrap)

data/
├── skills.json                  (Learned skills)
├── drift.json                   (Drift metrics)
└── consent-tokens.json          (Machine auth)
```

## Key Configuration

```env
# Required
GEMINI_KEY_1=your_key

# Optional but recommended
GEMINI_KEY_2=another_key
GEMINI_KEY_3=backup_key

# Security
CONTROL_TIMEOUT_MS=300000       # 5 minutes
REQUIRE_CONFIRMATION=true        # Gate control

# Identity
MACHINE_ID=desktop-1
MACHINE_NAME=My Computer

# Networking
MESH_PORT=8080
```

## Common Patterns

### Initialize Orchestrator
```typescript
const agent = new GeminiOrchestrator([
  process.env.GEMINI_KEY_1,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3
].filter(Boolean));

await agent.connectMCP("node", ["dist/mcp/computer-control-server.js"]);
```

### Execute Task
```typescript
await agent.execute("Enable control, take screenshot, describe desktop");
```

### Record Execution
```typescript
const recorder = new SkillRecorder();
recorder.startTrace(traceId);
recorder.recordStep(traceId, "mouse_click", true, 50);
await recorder.finalizeTrace(traceId, 'success');
```

### Analyze Drift
```typescript
const driftTracker = new DriftTracker();
const trends = await driftTracker.analyzeDrift(skillId);
console.log(trends); // { confidenceTrend, speedTrend, complexityTrend }
```

## Important Concepts

### Control Grants
- Time-limited permission to control computer
- Default: 5 minutes (configurable)
- Must call `control_enable()` before actions
- Automatically expires after timeout
- Can be manually revoked with `control_disable()`

### Skill Matching
- New traces compared against stored skills
- Similarity = (matching tools count) / (max sequence length)
- Threshold: 70% (0.7)
- If match found: reinforce, else: create new

### Confidence Reinforcement
- Uses exponential moving average (EMA)
- Alpha = 0.1 (10% weight to new outcome)
- Success = 1.0, failure = 0.0
- Formula: `new_confidence = old * 0.9 + outcome * 0.1`

### Mesh Nodes
- WebSocket servers for remote execution
- Allow orchestrator to control multiple machines
- Message format: `{ type: 'EXECUTE_TOOL', tool, args, id }`
- Response: `{ type: 'RESULT', id, result }`

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No keys found | Check `.env` file exists, has GEMINI_KEY_1 |
| MCP won't connect | Verify computer-control-server.ts exists |
| Control not enabled | Call `control_enable()` first, check timeout |
| Low skill confidence | Run successful tasks multiple times |
| Drift dashboard empty | Execute tasks to generate `data/drift.json` |

## Performance Notes

- Key pool automatically load-balances across keys
- Skill similarity matching is O(n*m) - optimize if >1000 skills
- Drift snapshots accumulated in memory then flushed to JSON
- Web dashboard loads all drift.json at once - consider pagination for >1000 points

## Security Notes

⚠️ **This system grants mouse/keyboard control to an AI agent**

Recommended safeguards:
1. Use in isolated VM or test machine
2. Set `CONTROL_TIMEOUT_MS` to short duration (30-60s)
3. Enable `REQUIRE_CONFIRMATION=true` for production
4. Keep API keys in secure .env file (never commit)
5. Monitor console for unexpected tool calls
6. Rotate API keys periodically
7. Use separate keys for dev/prod

## Advanced Tips

### Custom Tools
Add new tools in `computer-control-server.ts`:
```typescript
case "my_tool": {
  // Your logic
  return { content: [{ type: "text", text: result }] };
}
```

### Skill Inspection
```typescript
const storage = new SkillStorage();
const skills = await storage.loadSkills();
skills.forEach(s => console.log(s.skillId, s.confidence, s.totalExecutions));
```

### Drift Export
```typescript
const drift = await storage.loadDrift();
// Export to CSV/analytics tool
```

### Skill Recommendation
```typescript
// Find highest-confidence skill
const best = skills.reduce((a, b) => 
  a.confidence > b.confidence ? a : b
);
```

## What's Next?

1. ✅ Run it! (`npm run mcp` + `npm run agent`)
2. ✅ Give it tasks to learn
3. ✅ Watch skills develop in drift viewer
4. ✅ Extend with custom tools
5. ✅ Deploy to mesh nodes for distributed execution

---

**Built with ❤️ for the future of AI-assisted automation**
