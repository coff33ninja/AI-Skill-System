import { GeminiOrchestrator } from "./agent/gemini-orchestrator.js";
import { MeshNode } from "./mcp/mesh-node.js";
import { config } from "dotenv";

config();

async function bootstrap() {
  console.log("🚀 Starting AI Skill System...");

  // 1. Initialize API Keys
  const keys = [
    process.env.GEMINI_KEY_1,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3
  ].filter(Boolean) as string[];

  if (keys.length === 0) {
    throw new Error("Missing GEMINI_KEY_X in .env");
  }

  // 2. Start Mesh Node (optional, for remote control)
  const mesh = new MeshNode(parseInt(process.env.MESH_PORT || "8080"));
  await mesh.start();

  // 3. Initialize Orchestrator
  const agent = new GeminiOrchestrator(keys);
  
  // 4. Connect to local Control Server
  await agent.connectMCP("node", ["dist/mcp/computer-control-server.js"]);

  console.log("🧠 System Ready. Waiting for commands...");
  
  // Example loop
  process.stdin.on("data", async (data) => {
    const input = data.toString().trim();
    if (input) {
      try {
        await agent.execute(input);
      } catch (err) {
        console.error("Execution error:", err);
      }
    }
  });
}

bootstrap().catch(console.error);
