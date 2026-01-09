import { GeminiOrchestrator } from "./agent/gemini-orchestrator.js";
import { MeshNode } from "./mcp/mesh-node.js";
import { config } from "dotenv";
import * as readline from "readline";

config();

async function bootstrap() {
  console.log("🚀 Starting AI Skill System...");

  // 1. Initialize API Keys
  const keys = Object.keys(process.env)
    .filter((key) => key.startsWith("GEMINI_KEY_"))
    .map((key) => process.env[key]!)
    .filter(Boolean);

  if (keys.length === 0) {
    throw new Error("Missing GEMINI_KEY_X in .env");
  }

  console.log(`✅ Loaded ${keys.length} API key(s)`);

  // 2. Start Mesh Node (optional, for remote control)
  if (process.env.ENABLE_MESH === "true") {
    const mesh = new MeshNode(parseInt(process.env.MESH_PORT || "8080"));
    await mesh.start();
    console.log("✅ Mesh Node started");
  } else {
    console.log("ℹ️  Mesh Node disabled (set ENABLE_MESH=true to enable)");
  }

  // 3. Determine mode from env: "voice" (hands-free), "text" (keyboard), or "hybrid" (both)
  const mode = (process.env.MODE || "text").toLowerCase() as "voice" | "text" | "hybrid";
  const useVoice = mode === "voice" || mode === "hybrid";
  
  console.log(`📋 Mode: ${mode.toUpperCase()}`);

  // 4. Initialize Orchestrator
  const agent = new GeminiOrchestrator(keys, { useLiveMode: useVoice });
  
  // 5. Connect to local Control Server
  console.log("🔌 Connecting to MCP server...");
  await agent.connectMCP("node", ["src/mcp/computer-control-server.ts"]);

  // 6. Voice mode: Connect Live API and start listening automatically
  if (useVoice) {
    console.log("🎤 Connecting to Gemini Live API...");
    try {
      await agent.connectLive();
      agent.startListening();
      console.log("✅ Voice mode active - just speak, no typing needed");
    } catch (err) {
      console.error("⚠️  Voice connection failed:", err instanceof Error ? err.message : err);
      if (mode === "voice") {
        console.log("❌ Voice-only mode failed. Set MODE=hybrid or MODE=text in .env");
        process.exit(1);
      }
      console.log("   Continuing with text-only mode");
    }
  }

  // 7. Text/Hybrid mode: Start readline interface
  if (mode === "text" || mode === "hybrid") {
    console.log("\n🧠 System Ready. Type commands (or 'exit' to quit):\n");
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> '
    });

    rl.prompt();

    rl.on('line', async (input: string) => {
      const command = input.trim();
      
      if (!command) {
        rl.prompt();
        return;
      }

      if (command.toLowerCase() === 'exit' || command.toLowerCase() === 'quit') {
        console.log("👋 Shutting down...");
        agent.disconnectLive();
        rl.close();
        process.exit(0);
      }

      // Execute command
      try {
        await agent.execute(command);
      } catch (err) {
        console.error("\n❌ Error:", err instanceof Error ? err.message : err);
      }

      console.log();
      rl.prompt();
    });

    rl.on('close', () => {
      agent.disconnectLive();
      console.log("\n👋 Goodbye!");
      process.exit(0);
    });
  } else {
    // Voice-only mode: just keep running
    console.log("\n🧠 Voice-only mode active. Speak to control. Press Ctrl+C to exit.\n");
    
    process.on('SIGINT', () => {
      console.log("\n👋 Shutting down...");
      agent.disconnectLive();
      process.exit(0);
    });
  }
}

bootstrap().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
