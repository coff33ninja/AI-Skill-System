import { GeminiOrchestrator } from "./agent/gemini-orchestrator.js";
import { MeshNode } from "./mcp/mesh-node.js";
import { config } from "dotenv";
import * as readline from "readline";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

config();

/**
 * Available Modes:
 * - voice:   Hands-free voice control. Just speak, no typing. Best for accessibility.
 * - text:    Keyboard input only. Type commands in terminal.
 * - hybrid:  Both voice and keyboard work together.
 * - node:    Mesh node only. This machine receives commands from other machines.
 * - server:  HTTP/WebSocket server. Control via API or web interface.
 * - relay:   Voice commands control remote machines (not local).
 */
type Mode = "voice" | "text" | "hybrid" | "node" | "server" | "relay";

async function bootstrap() {
  console.log("🚀 Starting AI Skill System...");
  console.log("   Accessibility-focused computer control\n");

  // 1. Initialize API Keys
  const keys = Object.keys(process.env)
    .filter((key) => key.startsWith("GEMINI_KEY_"))
    .map((key) => process.env[key]!)
    .filter(Boolean);

  // 2. Determine mode
  const mode = (process.env.MODE || "text").toLowerCase() as Mode;
  console.log(`📋 Mode: ${mode.toUpperCase()}`);
  
  // Validate mode
  const validModes: Mode[] = ["voice", "text", "hybrid", "node", "server", "relay"];
  if (!validModes.includes(mode)) {
    console.error(`❌ Invalid MODE: ${mode}`);
    console.error(`   Valid modes: ${validModes.join(", ")}`);
    process.exit(1);
  }

  // Mode: NODE - This machine only receives commands, no AI needed
  if (mode === "node") {
    await startNodeMode();
    return;
  }

  // All other modes need API keys
  if (keys.length === 0) {
    console.error("❌ Missing GEMINI_KEY_X in .env");
    console.error("   Get a key from: https://aistudio.google.com/apikey");
    process.exit(1);
  }
  console.log(`✅ Loaded ${keys.length} API key(s)`);

  // Mode: SERVER - HTTP/WebSocket API
  if (mode === "server") {
    await startServerMode(keys);
    return;
  }

  // Mode: RELAY - Voice controls remote machines only
  if (mode === "relay") {
    await startRelayMode(keys);
    return;
  }

  // Modes: VOICE, TEXT, HYBRID - Local control with optional voice
  await startLocalMode(keys, mode);
}

/**
 * NODE Mode: This machine is a remote-controlled node
 * No AI, no voice - just waits for commands from other machines
 */
async function startNodeMode() {
  console.log("🖥️  Starting as MESH NODE (remote-controlled machine)");
  console.log("   This computer will receive commands from other machines.\n");

  const port = parseInt(process.env.MESH_PORT || "8080");
  const mesh = new MeshNode(port);
  await mesh.start();
  
  console.log(`\n✅ Mesh Node ready on port ${port}`);
  console.log("   Waiting for connections from controller machines...");
  console.log("   Press Ctrl+C to stop.\n");

  process.on('SIGINT', () => {
    console.log("\n👋 Mesh Node shutting down...");
    process.exit(0);
  });
}

/**
 * SERVER Mode: HTTP/WebSocket API for web interfaces or integrations
 */
async function startServerMode(keys: string[]) {
  console.log("🌐 Starting as API SERVER");
  console.log("   Control via HTTP requests or WebSocket.\n");

  const port = parseInt(process.env.SERVER_PORT || process.env.PORT || "3000");
  const agent = new GeminiOrchestrator(keys, { useLiveMode: false });
  
  console.log("🔌 Connecting to MCP server...");
  await agent.connectMCP("node", ["src/mcp/computer-control-server.ts"]);

  // Create HTTP server
  const httpServer = createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Health check
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "server" }));
      return;
    }

    // Execute command via POST /command
    if (req.method === "POST" && req.url === "/command") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { command } = JSON.parse(body);
          if (!command) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'command' field" }));
            return;
          }

          console.log(`📥 API command: ${command}`);
          const result = await agent.execute(command);
          
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, result: result?.text?.() || "Done" }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // WebSocket for real-time control
  const wss = new WebSocketServer({ server: httpServer });
  
  wss.on("connection", (ws: WebSocket) => {
    console.log("🔗 WebSocket client connected");

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === "command" && message.text) {
          console.log(`📥 WS command: ${message.text}`);
          const result = await agent.execute(message.text);
          ws.send(JSON.stringify({ 
            type: "result", 
            text: result?.text?.() || "Done" 
          }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ 
          type: "error", 
          message: err instanceof Error ? err.message : String(err) 
        }));
      }
    });

    ws.on("close", () => {
      console.log("🔌 WebSocket client disconnected");
    });
  });

  httpServer.listen(port, () => {
    console.log(`\n✅ API Server running on port ${port}`);
    console.log(`   HTTP:      http://localhost:${port}/command (POST)`);
    console.log(`   WebSocket: ws://localhost:${port}`);
    console.log(`   Health:    http://localhost:${port}/health`);
    console.log("\n   Press Ctrl+C to stop.\n");
  });

  process.on('SIGINT', () => {
    console.log("\n👋 Server shutting down...");
    httpServer.close();
    process.exit(0);
  });
}

/**
 * RELAY Mode: Voice commands control REMOTE machines (not this one)
 * Perfect for controlling other computers hands-free
 */
async function startRelayMode(keys: string[]) {
  console.log("📡 Starting as RELAY (voice controls remote machines)");
  console.log("   Your voice commands will control other computers.\n");

  const remoteHost = process.env.REMOTE_HOST;
  const remotePort = parseInt(process.env.REMOTE_PORT || "8080");
  const remoteToken = process.env.REMOTE_TOKEN || process.env.MCP_MESH_AUTH_TOKEN;

  if (!remoteHost) {
    console.error("❌ REMOTE_HOST not set in .env");
    console.error("   Set REMOTE_HOST=192.168.1.x (IP of machine to control)");
    process.exit(1);
  }

  if (!remoteToken) {
    console.error("❌ REMOTE_TOKEN not set in .env");
    console.error("   Set REMOTE_TOKEN to match the target machine's MCP_MESH_AUTH_TOKEN");
    process.exit(1);
  }

  console.log(`🎯 Target: ${remoteHost}:${remotePort}`);

  const agent = new GeminiOrchestrator(keys, { useLiveMode: true });

  // Connect to remote mesh node
  console.log("🔌 Connecting to remote machine...");
  try {
    await agent.connectMesh(remoteHost, remotePort, remoteToken);
  } catch (err) {
    console.error("❌ Failed to connect to remote machine:", err instanceof Error ? err.message : err);
    console.error("   Make sure the remote machine is running with MODE=node or npm run mesh");
    process.exit(1);
  }

  console.log("🎤 Connecting to Gemini Live API...");
  try {
    await agent.connectLive();
    agent.startListening();
    console.log("\n✅ Relay mode active");
    console.log(`   Speaking will control: ${remoteHost}`);
    console.log("   Press Ctrl+C to stop.\n");
  } catch (err) {
    console.error("❌ Voice connection failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  process.on('SIGINT', () => {
    console.log("\n👋 Relay shutting down...");
    agent.disconnectLive();
    agent.disconnectMesh();
    process.exit(0);
  });
}

/**
 * LOCAL Modes: voice, text, hybrid
 * Control THIS machine with voice and/or keyboard
 */
async function startLocalMode(keys: string[], mode: "voice" | "text" | "hybrid") {
  const useVoice = mode === "voice" || mode === "hybrid";

  // Optionally also start mesh node for incoming connections
  if (process.env.ENABLE_MESH === "true") {
    const mesh = new MeshNode(parseInt(process.env.MESH_PORT || "8080"));
    await mesh.start();
    console.log("✅ Mesh Node also started (accepting remote connections)");
  }

  // Initialize Orchestrator
  const agent = new GeminiOrchestrator(keys, { useLiveMode: useVoice });
  
  // Connect to local Control Server
  console.log("🔌 Connecting to MCP server...");
  await agent.connectMCP("node", ["src/mcp/computer-control-server.ts"]);

  // Voice mode: Connect Live API and start listening
  if (useVoice) {
    console.log("🎤 Connecting to Gemini Live API...");
    try {
      await agent.connectLive();
      agent.startListening();
      console.log("✅ Voice active - just speak, no typing needed");
    } catch (err) {
      console.error("⚠️  Voice connection failed:", err instanceof Error ? err.message : err);
      if (mode === "voice") {
        console.log("❌ Voice-only mode failed. Set MODE=hybrid or MODE=text in .env");
        process.exit(1);
      }
      console.log("   Continuing with text-only mode");
    }
  }

  // Text/Hybrid mode: Start readline interface
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
    // Voice-only mode
    console.log("\n🧠 Voice-only mode. Speak to control. Press Ctrl+C to exit.\n");
    
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
