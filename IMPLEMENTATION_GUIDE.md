# 🧠 AI Skill System - Implementation Guide

## System Architecture

This is a sophisticated AI system that enables Gemini to learn, remember, and improve at computer control tasks through procedural memory graphs and temporal drift analysis.

### Core Components

#### 1. **Gemini Orchestrator** (`src/agent/gemini-orchestrator.ts`)
- Manages API key rotation across multiple Gemini keys
- Interfaces with Gemini 1.5 Pro using live API
- Routes tool calls through MCP protocol
- Records execution traces for learning

**Key Features:**
- Load-balanced key pool
- Automatic key rotation to prevent rate limiting
- Trace recording for skill reinforcement

#### 2. **MCP Computer Control Server** (`src/mcp/computer-control-server.ts`)
- Provides stdio-based MCP interface to Gemini
- Implements time-limited control grants
- Manages screen observation and user input

**Available Tools:**
```
- control_enable(durationMs)  - Grant timed access to computer
- control_disable()           - Revoke access immediately
- control_status()            - Check current permissions
- screen_observe()            - Capture screenshot as base64 image
- mouse_move(x, y)            - Smooth cursor movement
- mouse_click(button, double)  - Click input
- keyboard_type(text)         - Type text naturally
- keyboard_shortcut(keys)     - Execute hotkeys (e.g., "control+c")
```

#### 3. **Skill Memory System** (`src/memory/`)

**SkillGraph** - Directed graph representation of learned procedures:
- Nodes: Individual tool invocations with timing statistics
- Edges: Transitions between tools with success rates
- Metadata: Confidence, execution count, tags

**SkillRecorder** - Converts execution traces into skill graphs:
- Records step-by-step execution
- Matches traces against existing skills
- Creates new skills from novel sequences
- Reinforces successful patterns using exponential moving average

**DriftTracker** - Monitors temporal changes in skill performance:
- Confidence erosion over time
- Execution speed changes (faster vs slower)
- Complexity growth/reduction
- Deviation scoring from baseline

#### 4. **Mesh Nodes** (`src/mcp/mesh-node.ts`)
- WebSocket-based remote execution infrastructure
- Allows orchestrator to control multiple machines
- Enables distributed skill execution

#### 5. **Consent Manager** (`src/agent/consent-manager.ts`)
- Machine pairing via cryptographic tokens
- 24-hour default grant windows
- Prevents unauthorized hardware access

---

## Getting Started

### Prerequisites
- Node.js 18+
- Gemini API keys (1-3 recommended)
- Windows/Mac/Linux with screen capture support

### Installation

```bash
cd ai-skill-system
npm install
cp .env.example .env
```

### Configuration

Edit `.env`:

```bash
# Required: Your Gemini API keys
GEMINI_KEY_1=AIzaSyDj7wXPf...
GEMINI_KEY_2=AIzaSyDj7wXPh...
GEMINI_KEY_3=AIzaSyDj7wXPi...

# Optional: Machine identity
MACHINE_ID=desktop-primary
MACHINE_NAME=My Computer

# Optional: Control parameters
CONTROL_TIMEOUT_MS=300000  # 5 minutes default
REQUIRE_CONFIRMATION=true

# Optional: Mesh node
MESH_PORT=8080
```

### Running the System

**Terminal 1: Start MCP Server**
```bash
npm run mcp
```

**Terminal 2: Run Orchestrator**
```bash
npm run agent
```

**Terminal 3: View Drift Visualization**
```bash
npm run viz
```

---

## Workflow Example

### 1. First Execution

```typescript
await orchestrator.execute(
  "Enable control, take a screenshot, and tell me what you see"
);
```

The system:
1. Calls `control_enable(300000)` - grants 5 min of control
2. Calls `screen_observe()` - captures screenshot
3. Returns description to Gemini
4. Records the execution trace
5. Creates a new skill: `skill_1704897234567`

### 2. Reinforcement

When the same task is executed again successfully:
- The trace matches the existing skill (>70% similarity)
- Confidence increases: `confidence = 0.5 * 0.9 + 1.0 * 0.1 = 0.55`
- Edge weights increase
- Success rates are reinforced

### 3. Drift Analysis

Over time, drift tracking shows:
- Confidence improvement/degradation
- Execution speed changes
- Complexity evolution

View in the web dashboard:
```bash
open src/viz/drift-viewer.html
```

---

## Skill Graph Structure

### Example Skill

```json
{
  "skillId": "skill_1704897234567",
  "description": "Sequence: control_enable → screen_observe → control_disable",
  "tags": ["observation", "screenshot"],
  "nodes": [
    {
      "id": "control_enable_0",
      "tool": "control_enable",
      "avgDurationMs": 5,
      "successCount": 5,
      "failureCount": 0
    },
    {
      "id": "screen_observe_1",
      "tool": "screen_observe",
      "avgDurationMs": 1250,
      "successCount": 5,
      "failureCount": 0
    },
    {
      "id": "control_disable_2",
      "tool": "control_disable",
      "avgDurationMs": 2,
      "successCount": 5,
      "failureCount": 0
    }
  ],
  "edges": [
    {
      "from": "control_enable_0",
      "to": "screen_observe_1",
      "weight": 5,
      "successRate": 1.0,
      "avgTransitionMs": 50
    },
    {
      "from": "screen_observe_1",
      "to": "control_disable_2",
      "weight": 5,
      "successRate": 1.0,
      "avgTransitionMs": 10
    }
  ],
  "createdAt": 1704897234567,
  "lastUsed": 1704897400000,
  "totalExecutions": 5,
  "confidence": 0.68
}
```

---

## API Key Rotation Strategy

The key pool implements:
1. **Load tracking** - counts concurrent requests
2. **Staleness** - prefers keys not recently used
3. **Balanced distribution** - prevents single key exhaustion

```typescript
const pool = new GeminiKeyPool([key1, key2, key3]);

// Automatically selects least-loaded, least-recently-used key
const key = pool.next();

// After request completes
pool.release(key);
```

---

## Extending the System

### Adding New Tools

Edit `src/mcp/computer-control-server.ts`:

```typescript
server.setRequestHandler("tools/list", async () => ({
  tools: [
    // ... existing tools ...
    {
      name: "my_new_tool",
      description: "Does something cool",
      inputSchema: {
        type: "object",
        properties: {
          param1: { type: "string" }
        },
        required: ["param1"]
      }
    }
  ]
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;
  
  // ... existing cases ...
  
  case "my_new_tool": {
    // Your implementation
    return {
      content: [{ type: "text", text: "Result" }]
    };
  }
});
```

### Custom Memory Analysis

Edit `src/memory/drift-tracker.ts` to add custom drift metrics:

```typescript
async customAnalysis(skillId: string) {
  const snapshots = await this.storage.loadDrift();
  // Your analysis logic
  return customMetrics;
}
```

---

## Troubleshooting

### Issue: "No Gemini API keys found"
- Check `.env` file exists
- Verify `GEMINI_KEY_1` is set
- Ensure no quotes around keys

### Issue: "MCP connection timeout"
- Verify computer-control-server is running
- Check node.js version (needs 18+)
- Ensure no port conflicts on stdio

### Issue: "Control not enabled"
- Call `control_enable()` before any interactions
- Check expiry time hasn't passed
- Grant longer duration with `control_enable(600000)`

### Issue: "Screenshot quality low"
- Update screenshot-desktop: `npm install screenshot-desktop@latest`
- Check display scaling on Windows
- Reduce screen resolution if needed

---

## Performance Tips

1. **Key Pool Size**: Use 3+ keys for heavy load
2. **Control Timeout**: Balance between safety and efficiency
3. **Trace Batch**: Record traces in batches for I/O efficiency
4. **Skill Similarity**: Adjust threshold (currently 0.7) for looser matching

---

## Security Considerations

⚠️ **Important**: This system grants keyboard & mouse control to an AI agent.

**Recommended Safeguards:**
1. Use in isolated VM or dedicated machine
2. Enable confirmation mode: `REQUIRE_CONFIRMATION=true`
3. Use short timeout windows: `CONTROL_TIMEOUT_MS=30000`
4. Monitor logs for unexpected tool calls
5. Keep machine pairing tokens secure
6. Rotate API keys regularly

---

## Building & Deployment

### Build TypeScript
```bash
npm run build
```

### Run Compiled Version
```bash
node dist/mcp/computer-control-server.js
node dist/agent/gemini-orchestrator.js
```

### Docker (Future)
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/index.js"]
```

---

## Project Structure Summary

```
ai-skill-system/
├── src/
│   ├── mcp/
│   │   ├── computer-control-server.ts  # MCP stdio server
│   │   └── mesh-node.ts                # WebSocket relay
│   ├── agent/
│   │   ├── gemini-orchestrator.ts      # Main agent logic
│   │   ├── key-pool.ts                 # Key rotation
│   │   └── consent-manager.ts          # Machine pairing
│   ├── memory/
│   │   ├── skill-graph.ts              # Type definitions
│   │   ├── recorder.ts                 # Trace→graph conversion
│   │   ├── drift-tracker.ts            # Temporal analysis
│   │   └── storage.ts                  # Persistence
│   ├── viz/
│   │   └── drift-viewer.html           # Web dashboard
│   └── index.ts                        # Bootstrap
├── data/                               # Runtime storage
│   ├── skills.json                     # Learned procedures
│   ├── drift.json                      # Historical metrics
│   └── consent-tokens.json             # Machine tokens
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## Advanced Topics

### Skill Similarity Matching
The system uses simple sequence matching:
```
Similarity = (matching_tool_count) / (max_sequence_length)
```

For fuzzy matching, enhance with:
- Semantic tool similarity (embedding-based)
- Parameter compatibility analysis
- Success rate weighting

### Drift Scoring
Current implementation: simple deltas

Future enhancements:
- Z-score anomaly detection
- Seasonal decomposition
- Kalman filtering for smoothing

### Distributed Execution
Mesh nodes enable:
- Multi-machine task distribution
- Load balancing
- Redundancy and failover

---

## Contributing

To extend this system:
1. Create feature branch
2. Add tests for new components
3. Update type definitions in `skill-graph.ts`
4. Document in FEATURES.md
5. Submit PR with examples

---

## License

MIT - See LICENSE file for details

---

## References

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Gemini API Docs](https://ai.google.dev/)
- [Robotjs Documentation](https://robotjs.io/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
