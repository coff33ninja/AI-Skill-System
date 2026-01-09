import { GoogleGenerativeAI, FunctionCall } from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GeminiKeyPool } from "./key-pool.js";
import { SkillRecorder } from "../memory/recorder.js";
import { DriftTracker } from "../memory/drift-tracker.js";
import { GeminiLiveClient, LiveEvent } from "./gemini-live-client.js";
import { AudioPlayer } from "./audio-player.js";
import { MicCapture } from "./mic-capture.js";
import { MeshClient } from "../mcp/mesh-client.js";

// Model configuration - Current Gemini models (as of January 2026)
// See: https://ai.google.dev/gemini-api/docs/models
// See deprecations: https://ai.google.dev/gemini-api/docs/deprecations

// Available text models (newest to oldest):
// - gemini-3-pro-preview: Most intelligent, best for complex reasoning
// - gemini-3-flash-preview: Balanced speed/intelligence  
// - gemini-2.5-pro: Stable, advanced thinking model
// - gemini-2.5-flash: Stable, best price-performance (recommended default)
// - gemini-2.5-flash-lite: Ultra fast, cost-efficient

// Available Live API models for real-time audio:
// - gemini-2.5-flash-native-audio-preview-12-2025 (current)
// - gemini-2.5-flash-native-audio-preview-09-2025 (older preview)
// Deprecated: gemini-2.0-flash-live-001, gemini-live-2.5-flash-preview (shutdown Dec 2025)

const TEXT_MODEL = "gemini-2.5-flash"; // Stable - for standard text/tool operations via generateContent
const LIVE_MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"; // For real-time audio TTS/STT via Live API

export class GeminiOrchestrator {
  private keyPool: GeminiKeyPool;
  private recorder: SkillRecorder;
  private driftTracker: DriftTracker;
  private mcp?: Client;
  private meshClient?: MeshClient;
  private currentModel?: any;
  private currentApiKey?: string;
  private liveClient?: GeminiLiveClient;
  private useLiveMode: boolean = false;
  private audioPlayer: AudioPlayer;
  private micCapture: MicCapture;
  private isListening: boolean = false;
  private useRemote: boolean = false;

  constructor(apiKeys: string[], options?: { useLiveMode?: boolean }) {
    this.keyPool = new GeminiKeyPool(apiKeys);
    this.recorder = new SkillRecorder();
    this.driftTracker = new DriftTracker();
    this.useLiveMode = options?.useLiveMode ?? false;
    this.audioPlayer = new AudioPlayer();
    this.micCapture = new MicCapture();
  }

  /**
   * Connect to Gemini Live API for real-time TTS/STT
   */
  async connectLive(systemInstruction?: string): Promise<void> {
    const apiKey = this.keyPool.next();
    
    // Get available tools from MCP or Mesh
    const toolsResponse = await this.listTools();
    const mcpTools = toolsResponse.tools || [];
    
    // Convert MCP tools to Live API format
    const liveTools = mcpTools.map((t: any) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }));
    
    this.liveClient = new GeminiLiveClient({
      apiKey,
      model: LIVE_MODEL,
      voiceName: "Aoede",
      tools: liveTools,
      systemInstruction: systemInstruction || `
You are an AI agent that controls computers through voice commands.
You have tools to control the mouse, keyboard, and take screenshots.
IMPORTANT: You MUST use the tools to perform actions - do not just describe what you would do.
1. First call control_enable to get permission
2. Use screen_observe to see the screen
3. Use mouse_move, mouse_click, keyboard_type, keyboard_shortcut to control
4. Call control_disable when done
Speak naturally and narrate what you're doing as you do it.
      `.trim()
    });

    // Track if we've received audio in this turn (to know when to resume mic)
    let receivedAudioThisTurn = false;

    // Set up event handlers
    this.liveClient.on("audio", async (event: LiveEvent) => {
      // Pause mic while AI is speaking to prevent feedback
      if (this.isListening && !this.micCapture.paused) {
        this.micCapture.pause();
      }
      receivedAudioThisTurn = true;
      
      console.log("🔊 Received audio chunk, playing...");
      try {
        await this.audioPlayer.play(event.data.data);
      } catch (err) {
        console.error("Audio playback failed:", err);
      }
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

    this.liveClient.on("error", (event: LiveEvent) => {
      console.error("❌ Live API error:", event.data);
    });

    // Track current trace for skill recording in voice mode
    let currentTraceId: string | null = null;

    // Handle turn complete - resume mic and finalize skill traces
    this.liveClient.on("turnComplete", async (_event: LiveEvent) => {
      console.log("✅ Turn complete");
      // Flush any remaining buffered audio
      this.audioPlayer.flush();
      
      // Resume mic after AI finishes speaking (with small delay for audio to finish)
      if (this.isListening && receivedAudioThisTurn) {
        setTimeout(() => {
          this.micCapture.resume();
          console.log("🎤 Listening resumed");
        }, 300);
      }
      receivedAudioThisTurn = false;
      
      // Finalize skill trace if we had tool calls
      if (currentTraceId) {
        await this.recorder.finalizeTrace(currentTraceId, 'success');
        
        // Capture drift snapshot for the new skill
        const skills = await this.recorder.storage.loadSkills();
        if (skills.length > 0) {
          const latestSkill = skills[skills.length - 1];
          await this.driftTracker.captureSnapshot(latestSkill);
          console.log("📚 Skill recorded and saved");
        }
        
        currentTraceId = null;
      }
    });

    // Handle tool calls from Live API
    this.liveClient.on("toolCall", async (event: LiveEvent) => {
      console.log("🔧 Live API tool call received");
      const toolCall = event.data;
      
      if (toolCall.functionCalls) {
        // Start a new trace if we don't have one
        if (!currentTraceId) {
          currentTraceId = `voice_trace_${Date.now()}`;
          this.recorder.startTrace(currentTraceId);
        }
        
        const responses: Array<{ id: string; name: string; response: any }> = [];
        
        for (const fc of toolCall.functionCalls) {
          console.log(`🔧 Executing: ${fc.name} (id: ${fc.id})`);
          const startTime = Date.now();
          try {
            const result = await this.callTool(fc.name, fc.args || {});
            const duration = Date.now() - startTime;
            
            // Record step for skill learning
            this.recorder.recordStep(currentTraceId, fc.name, true, duration, fc.args);
            
            // Process result based on content type
            let responseData: any = { success: true };
            
            if (result?.content) {
              for (const item of result.content) {
                if (item.type === "text") {
                  responseData = { result: item.text };
                } else if (item.type === "image") {
                  // For images, just confirm we got it - don't send the huge base64
                  // The Live API can't process images in tool responses anyway
                  responseData = { 
                    result: "Screenshot captured successfully. I can see the screen.",
                    imageSize: item.data?.length || 0
                  };
                }
              }
            }
            
            responses.push({ id: fc.id, name: fc.name, response: responseData });
            console.log(`✅ Tool ${fc.name} completed in ${duration}ms`);
          } catch (err) {
            const duration = Date.now() - startTime;
            // Record failed step
            this.recorder.recordStep(currentTraceId, fc.name, false, duration, fc.args);
            
            console.error(`❌ Tool ${fc.name} failed:`, err);
            responses.push({ 
              id: fc.id,
              name: fc.name, 
              response: { error: err instanceof Error ? err.message : String(err) }
            });
          }
        }
        
        // Send tool responses back to Live API
        console.log("📤 Sending tool responses to continue conversation...");
        this.liveClient!.sendToolResponse(responses);
        
        // Resume mic after sending tool response - model should respond with audio
        // but if it doesn't, we don't want to leave mic paused forever
        if (this.isListening) {
          setTimeout(() => {
            if (this.micCapture.paused) {
              this.micCapture.resume();
              console.log("🎤 Mic resumed after tool response");
            }
          }, 2000); // Give model 2 seconds to start speaking
        }
      }
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
    this.stopListening();
    this.liveClient?.disconnect();
    this.liveClient = undefined;
    this.audioPlayer.stop();
  }

  /**
   * Start continuous microphone listening (hands-free mode)
   * Audio is streamed directly to Gemini Live API for STT
   */
  startListening(): void {
    if (!this.liveClient?.connected) {
      console.log("⚠️  Live API not connected. Connect first with connectLive()");
      return;
    }

    if (this.isListening) {
      console.log("🎤 Already listening");
      return;
    }

    this.micCapture.start(
      // On audio chunk - send to Gemini Live
      (base64Audio) => {
        if (this.liveClient?.connected) {
          this.liveClient.sendAudio(base64Audio);
        }
      },
      // On error
      (error) => {
        console.error("🎤 Mic error:", error.message);
        this.isListening = false;
      }
    );

    this.isListening = true;
    console.log("🎤 Listening... (speak naturally, hands-free mode active)");
  }

  /**
   * Stop microphone listening
   */
  stopListening(): void {
    if (this.isListening) {
      this.micCapture.stop();
      this.isListening = false;
    }
  }

  /**
   * Toggle listening on/off
   */
  toggleListening(): boolean {
    if (this.isListening) {
      this.stopListening();
      return false;
    } else {
      this.startListening();
      return true;
    }
  }

  get listening(): boolean {
    return this.isListening;
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
    this.useRemote = false;
    console.log("✅ MCP connected (local)");
  }

  /**
   * Connect to a remote mesh node instead of local MCP
   */
  async connectMesh(host: string, port: number = 8080, token: string): Promise<void> {
    this.meshClient = new MeshClient(host, port, token);
    await this.meshClient.connect();
    this.useRemote = true;
    console.log(`✅ Connected to remote mesh node at ${host}:${port}`);
  }

  /**
   * Disconnect from mesh node
   */
  disconnectMesh(): void {
    this.meshClient?.disconnect();
    this.meshClient = undefined;
    this.useRemote = false;
  }

  /**
   * Call a tool - routes to local MCP or remote mesh based on connection
   */
  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    if (this.useRemote && this.meshClient?.connected) {
      return this.meshClient.callTool(name, args);
    } else if (this.mcp) {
      return this.mcp.callTool({ name, arguments: args });
    } else {
      throw new Error("No MCP or mesh connection available");
    }
  }

  /**
   * List available tools from local MCP or remote mesh
   */
  private async listTools(): Promise<{ tools: any[] }> {
    if (this.useRemote && this.meshClient?.connected) {
      return this.meshClient.listTools();
    } else if (this.mcp) {
      return this.mcp.listTools();
    } else {
      return { tools: [] };
    }
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
   * Execute a single tool call via MCP or Mesh
   */
  private async executeToolCall(toolCall: FunctionCall, traceId: string): Promise<any> {
    const startTime = Date.now();
    console.log(`🔧 Calling tool: ${toolCall.name}`);
    console.log(`   Args:`, JSON.stringify(toolCall.args, null, 2));

    try {
      const result = await this.callTool(
        toolCall.name,
        (toolCall.args || {}) as Record<string, unknown>
      );

      const duration = Date.now() - startTime;
      this.recorder.recordStep(traceId, toolCall.name, true, duration, toolCall.args);
      console.log(`✅ Tool ${toolCall.name} completed in ${duration}ms`);
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
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
        // Get available tools from MCP or Mesh
        const toolsResponse = await this.listTools();
        const mcpTools = toolsResponse.tools || [];
        const geminiTools = this.convertMCPToolsToGemini(mcpTools);

        this.currentModel = genAI.getGenerativeModel({
          model: TEXT_MODEL,
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

        const chat = this.currentModel.startChat({
          history: context?.history || []
        });

        let result = await chat.sendMessage(prompt);
        let response = result.response;
        
        let turnCount = 0;
        const MAX_TURNS = 10;

        while (response.functionCalls && response.functionCalls().length > 0 && turnCount < MAX_TURNS) {
          turnCount++;
          console.log(`\n🔄 Turn ${turnCount}: Processing ${response.functionCalls().length} tool call(s)`);

          const functionCalls = response.functionCalls();
          const functionResponses = [];

          for (const toolCall of functionCalls) {
            try {
              const toolResult = await this.executeToolCall(toolCall, traceId);
              functionResponses.push({ name: toolCall.name, response: toolResult });
            } catch (error) {
              functionResponses.push({
                name: toolCall.name,
                response: { error: error instanceof Error ? error.message : String(error) }
              });
            }
          }

          result = await chat.sendMessage(functionResponses);
          response = result.response;
        }

        if (turnCount >= MAX_TURNS) {
          console.warn(`⚠️  Max turns (${MAX_TURNS}) reached, stopping execution`);
        }

        const outcome = turnCount > 0 ? 'success' : 'aborted';
        await this.recorder.finalizeTrace(traceId, outcome);

        const skills = await this.recorder.storage.loadSkills();
        if (skills.length > 0) {
          const latestSkill = skills[skills.length - 1];
          await this.driftTracker.captureSnapshot(latestSkill);
        }

        console.log("\n🧠 Final response:", response.text());

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
          if (errorMessage.includes('404') || errorMessage.includes('permission')) {
            console.log(`   Deprioritizing key due to error.`);
            this.keyPool.deprioritize(this.currentApiKey);
          } else {
            this.keyPool.release(this.currentApiKey);
          }
        }
        
        if (attempts >= maxAttempts) {
          console.error(`❌ All ${maxAttempts} API keys failed. The last error was:`);
          throw error;
        }
      }
    }
    throw new Error("Failed to get a response from the model after exhausting all API keys.");
  }

  async execute(command: string) {
    console.log(`\n🎯 Executing: ${command}\n`);
    
    // If live mode is enabled and connected, use Live API for voice interaction
    if (this.useLiveMode && this.isLiveConnected) {
      console.log("🎤 Using Live API mode");
      this.liveClient!.sendText(command);
      
      return new Promise<void>((resolve) => {
        const handler = () => resolve();
        this.liveClient!.on("turnComplete", handler);
        setTimeout(() => resolve(), 30000);
      });
    }
    
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
  await orchestrator.connectMCP("npx", ["tsx", "src/mcp/computer-control-server.ts"]);
  await orchestrator.execute("Enable control, observe the screen, and tell me what you see.");
}
