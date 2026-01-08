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

  // 3. Initialize Orchestrator
  const useLiveMode = process.env.ENABLE_LIVE === "true";
  const agent = new GeminiOrchestrator(keys, { useLiveMode });
  
  // 4. Connect to local Control Server
  console.log("🔌 Connecting to MCP server...");
  await agent.connectMCP("node", ["src/mcp/computer-control-server.ts"]);

  // 5. Connect to Live API if enabled (for TTS/STT)
  if (useLiveMode) {
    console.log("🎤 Connecting to Gemini Live API (TTS/STT)...");
    try {
      await agent.connectLive();
      console.log("✅ Live API connected - voice mode enabled");
    } catch (err) {
      console.error("⚠️  Live API connection failed:", err instanceof Error ? err.message : err);
      console.log("   Falling back to text-only mode");
    }
  }

  console.log("\n🧠 System Ready. Type commands (or 'exit' to quit):");
  console.log("   Commands: /live (toggle voice), /speak <text>, exit\n");
  
  // 6. Interactive command loop with readline
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

    // Handle special commands
    if (command.toLowerCase() === 'exit' || command.toLowerCase() === 'quit') {
      console.log("👋 Shutting down...");
      agent.disconnectLive();
      rl.close();
      process.exit(0);
    }

    // Toggle live mode
    if (command.toLowerCase() === '/live') {
      if (agent.isLiveConnected) {
        agent.disconnectLive();
        console.log("🔇 Live mode disconnected");
      } else {
        try {
          await agent.connectLive();
          console.log("🎤 Live mode connected");
        } catch (err) {
          console.error("❌ Failed to connect live mode:", err instanceof Error ? err.message : err);
        }
      }
      rl.prompt();
      return;
    }

    // Speak text via Live API (TTS)
    if (command.toLowerCase().startsWith('/speak ')) {
      const text = command.slice(7).trim();
      if (!agent.isLiveConnected) {
        console.log("⚠️  Live mode not connected. Use /live to connect first.");
      } else {
        try {
          await agent.speakLive(text);
          console.log("🔊 Sent to Live API for speech");
        } catch (err) {
          console.error("❌ Speech error:", err instanceof Error ? err.message : err);
        }
      }
      rl.prompt();
      return;
    }

    // Regular command execution (text mode with tools)
    try {
      await agent.execute(command);
    } catch (err) {
      console.error("\n❌ Execution error:", err instanceof Error ? err.message : err);
    }

    console.log(); // blank line
    rl.prompt();
  });

  rl.on('close', () => {
    agent.disconnectLive();
    console.log("\n👋 Goodbye!");
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
