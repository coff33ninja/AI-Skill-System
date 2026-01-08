import { GoogleGenerativeAI, FunctionCall } from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GeminiKeyPool } from "./key-pool.js";
import { SkillRecorder } from "../memory/recorder.js";
import { DriftTracker } from "../memory/drift-tracker.js";
import { GeminiLiveClient, LiveEvent } from "./gemini-live-client.js";

// Model configuration - Gemini 2.5 Flash family
const TEXT_MODEL = "gemini-2.5-flash"; // Stable - for standard text/tool operations via generateContent
const LIVE_MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"; // For real-time audio TTS/STT via Live API

export class GeminiOrchestrator {
  private keyPool: GeminiKeyPool;
  private recorder: SkillRecorder;
  private driftTracker: DriftTracker;
  private mcp?: Client;
  private currentModel?: any;
  private currentApiKey?: string;
  private liveClient?: GeminiLiveClient;
  private useLiveMode: boolean = false;

  constructor(apiKeys: string[], options?: { useLiveMode?: boolean }) {
    this.keyPool = new GeminiKeyPool(apiKeys);
    this.recorder = new SkillRecorder();
    this.driftTracker = new DriftTracker();
    this.useLiveMode = options?.useLiveMode ?? false;
  }

  /**
   * Connect to Gemini Live API for real-time TTS/STT
   */
  async connectLive(systemInstruction?: string): Promise<void> {
    const apiKey = this.keyPool.next();
    
    this.liveClient = new GeminiLiveClient({
      apiKey,
      model: LIVE_MODEL,
      voiceName: "Aoede",
      systemInstruction: systemInstruction || `
You are an AI agent that controls computers through voice commands.
Speak naturally and clearly. Narrate your actions.
Stop immediately if uncertain.
      `.trim()
    });

    // Set up event handlers
    this.liveClient.on("audio", (event: LiveEvent) => {
      console.log("🔊 Received audio response");
      // Audio data is in event.data.data (base64 PCM 24kHz)
    });

    this.liveClient.on("text", (event: LiveEvent) => {
      console.log("💬 Live response:", event.data);
    });

    this.liveClient.on("transcription", (event: LiveEvent) => {
      if (event.data.input) {
        console.log("🎤 You said:", event.data.input);
      }
      if (event.data.output) {
        console.log("🗣️ Model said:", event.data.output);
      }
    });

    this.liveClient.on("turnComplete", (_event: LiveEvent) => {
      console.log("✅ Turn complete");
    });

    this.liveClient.on("error", (event: LiveEvent) => {
      console.error("❌ Live API error:", event.data);
    });

    await this.liveClient.connect();
    console.log("✅ Live API connected (TTS/STT ready)");
  }

  /**
   * Send text to Live API and get audio response
   */
  async speakLive(text: string): Promise<void> {
    if (!this.liveClient?.connected) {
      throw new Error("Live API not connected. Call connectLive() first.");
    }
    this.liveClient.sendText(text);
  }

  /**
   * Send audio to Live API for STT processing
   * @param audioData Base64 encoded PCM audio (16kHz, 16-bit, mono)
   */
  sendAudioLive(audioData: string): void {
    if (!this.liveClient?.connected) {
      throw new Error("Live API not connected. Call connectLive() first.");
    }
    this.liveClient.sendAudio(audioData);
  }

  /**
   * Disconnect from Live API
   */
  disconnectLive(): void {
    this.liveClient?.disconnect();
    this.liveClient = undefined;
  }

  get isLiveConnected(): boolean {
    return this.liveClient?.connected ?? false;
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

  /**
   * Convert MCP tool schema to Gemini function declaration format
   */
  private convertMCPToolsToGemini(mcpTools: any[]) {
    return mcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }));
  }

  /**
   * Execute a single tool call via MCP
   */
  private async executeToolCall(toolCall: FunctionCall, traceId: string): Promise<any> {
    if (!this.mcp) {
      throw new Error("MCP not connected");
    }

    const startTime = Date.now();
    console.log(`🔧 Calling tool: ${toolCall.name}`);
    console.log(`   Args:`, JSON.stringify(toolCall.args, null, 2));

    try {
      const result = await this.mcp.callTool({
        name: toolCall.name,
        arguments: (toolCall.args || {}) as {[key: string]: unknown}
      });

      const duration = Date.now() - startTime;
      
      // Record this step in the trace
      this.recorder.recordStep(traceId, toolCall.name, true, duration, toolCall.args);

      console.log(`✅ Tool ${toolCall.name} completed in ${duration}ms`);
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Record failure
      this.recorder.recordStep(traceId, toolCall.name, false, duration, toolCall.args);
      
      console.error(`❌ Tool ${toolCall.name} failed:`, error);
      throw error;
    }
  }

  async think(prompt: string, context?: any) {
    let attempts = 0;
    const maxAttempts = this.keyPool.size();

    if (maxAttempts === 0) {
      throw new Error("No API keys available in the pool.");
    }

    while (attempts < maxAttempts) {
      attempts++;
      this.currentApiKey = this.keyPool.next();
      const genAI = new GoogleGenerativeAI(this.currentApiKey);

      try {
        // Get available tools from MCP
        const toolsResponse = this.mcp ? await this.mcp.listTools() : { tools: [] };
        const mcpTools = toolsResponse.tools || [];
        
        // Convert to Gemini format
        const geminiTools = this.convertMCPToolsToGemini(mcpTools);

        this.currentModel = genAI.getGenerativeModel({
          model: TEXT_MODEL, // Use text model for generateContent API
          tools: geminiTools.length > 0 ? [{ functionDeclarations: geminiTools }] : undefined,
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

        // Start chat for multi-turn interaction
        const chat = this.currentModel.startChat({
          history: context?.history || []
        });

        let result = await chat.sendMessage(prompt);
        let response = result.response;
        
        // Handle tool calls in a loop (multi-turn conversation)
        let turnCount = 0;
        const MAX_TURNS = 10; // Prevent infinite loops

        while (response.functionCalls && response.functionCalls().length > 0 && turnCount < MAX_TURNS) {
          turnCount++;
          console.log(`\n🔄 Turn ${turnCount}: Processing ${response.functionCalls().length} tool call(s)`);

          const functionCalls = response.functionCalls();
          const functionResponses = [];

          // Execute each tool call
          for (const toolCall of functionCalls) {
            try {
              const toolResult = await this.executeToolCall(toolCall, traceId);
              
              functionResponses.push({
                name: toolCall.name,
                response: toolResult
              });
            } catch (error) {
              // Include error in response so Gemini can handle it
              functionResponses.push({
                name: toolCall.name,
                response: {
                  error: error instanceof Error ? error.message : String(error)
                }
              });
            }
          }

          // Send tool results back to Gemini
          result = await chat.sendMessage(functionResponses);
          response = result.response;
        }

        if (turnCount >= MAX_TURNS) {
          console.warn(`⚠️  Max turns (${MAX_TURNS}) reached, stopping execution`);
        }

        // Finalize trace
        const outcome = turnCount > 0 ? 'success' : 'aborted';
        await this.recorder.finalizeTrace(traceId, outcome);

        // Capture drift snapshot if a skill was created/updated
        const skills = await this.recorder.storage.loadSkills();
        if (skills.length > 0) {
          const latestSkill = skills[skills.length - 1];
          await this.driftTracker.captureSnapshot(latestSkill);
        }

        console.log("\n🧠 Final response:", response.text());

        // Success, release the key back to the pool
        if (this.currentApiKey) {
          this.keyPool.release(this.currentApiKey);
        }
        return response;

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const keyIdentifier = this.currentApiKey ? `...${this.currentApiKey.slice(-4)}` : "undefined";
        
        console.warn(`⚠️ API call failed for key ending in ${keyIdentifier}. Attempt ${attempts}/${maxAttempts}.`);
        console.warn(`   Error: ${errorMessage}`);
        
        if (this.currentApiKey) {
          // If it's a "Not Found" or permission error, it's likely a bad key.
          // Deprioritize it so it's tried last next time.
          if (errorMessage.includes('404') || errorMessage.includes('permission')) {
            console.log(`   Deprioritizing key due to error.`);
            this.keyPool.deprioritize(this.currentApiKey);
          } else {
            // For other errors (e.g., rate limits, server errors), just release it
            // so it can be used again soon.
            this.keyPool.release(this.currentApiKey);
          }
        }
        
        if (attempts >= maxAttempts) {
          console.error(`❌ All ${maxAttempts} API keys failed. The last error was:`);
          throw error; // Rethrow the last error after all retries are exhausted
        }
      }
    }
    // This should not be reachable if there are keys in the pool.
    throw new Error("Failed to get a response from the model after exhausting all API keys.");
  }

  async execute(command: string) {
    console.log(`\n🎯 Executing: ${command}\n`);
    
    // If live mode is enabled and connected, use Live API for voice interaction
    if (this.useLiveMode && this.isLiveConnected) {
      console.log("🎤 Using Live API mode");
      this.liveClient!.sendText(command);
      // Live API handles response via event handlers (audio/text)
      // Return a promise that resolves when turn is complete
      return new Promise<void>((resolve) => {
        const handler = () => {
          resolve();
        };
        this.liveClient!.on("turnComplete", handler);
        // Timeout fallback
        setTimeout(() => resolve(), 30000);
      });
    }
    
    // Standard text mode with MCP tools
    return this.think(command);
  }
}

// ========== MAIN ==========

if (import.meta.url === `file://${process.argv[1]}`) {
  const keys = Object.keys(process.env)
    .filter((key) => key.startsWith("GEMINI_KEY_"))
    .map((key) => process.env[key]!)
    .filter(Boolean);

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
