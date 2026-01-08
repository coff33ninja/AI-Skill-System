import { GoogleGenerativeAI } from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GeminiKeyPool } from "./key-pool.js";
import { SkillRecorder } from "../memory/recorder.js";

export class GeminiOrchestrator {
  private keyPool: GeminiKeyPool;
  private recorder: SkillRecorder;
  private mcp?: Client;
  private currentModel?: any;

  constructor(apiKeys: string[]) {
    this.keyPool = new GeminiKeyPool(apiKeys);
    this.recorder = new SkillRecorder();
  }

  async connectMCP(command: string, args: string[]) {
    const transport = new StdioClientTransport({ command, args });
    
    this.mcp = new Client(
      { name: "gemini-orchestrator", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.mcp.connect(transport);
    console.log("✅ MCP connected");
  }

  async think(prompt: string, context?: any) {
    const apiKey = this.keyPool.next();
    const genAI = new GoogleGenerativeAI(apiKey);

    try {
      // Get available tools from MCP
      const toolsResponse = this.mcp ? await this.mcp.listTools() : { tools: [] };
      const tools = toolsResponse.tools || [];

      this.currentModel = genAI.getGenerativeModel({
        model: "gemini-1.5-pro",
        tools: tools as any,
        systemInstruction: `
You are an AI agent that controls computers through MCP tools.

RULES:
1. Always call control_enable before attempting actions
2. Call screen_observe to understand current state
3. Narrate your actions clearly
4. Stop immediately if uncertain
5. Call control_disable when done

You learn from repeated patterns and build procedural memory.
        `.trim()
      });

      const traceId = `trace_${Date.now()}`;
      this.recorder.startTrace(traceId);

      const result = await this.currentModel.generateContent(prompt);
      
      // Process tool calls if any
      const response = result.response;
      
      console.log("🧠 Gemini response:", response.text());

      return response;
    } catch (error) {
      this.keyPool.release(apiKey);
      throw error;
    }
  }

  async execute(command: string) {
    console.log(`\n🎯 Executing: ${command}\n`);
    return this.think(command);
  }
}

// ========== MAIN ==========

if (import.meta.url === `file://${process.argv[1]}`) {
  const keys = [
    process.env.GEMINI_KEY_1,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3
  ].filter(Boolean) as string[];

  if (keys.length === 0) {
    console.error("❌ No Gemini API keys found in environment");
    process.exit(1);
  }

  const orchestrator = new GeminiOrchestrator(keys);
  
  await orchestrator.connectMCP("node", ["src/mcp/computer-control-server.ts"]);
  
  await orchestrator.execute(
    "Enable control, observe the screen, and tell me what you see."
  );
}
