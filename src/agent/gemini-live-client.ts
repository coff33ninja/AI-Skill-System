import WebSocket from "ws";

export interface LiveClientConfig {
  apiKey: string;
  model?: string;
  voiceName?: string;
  systemInstruction?: string;
  tools?: Array<{
    name: string;
    description: string;
    parameters?: any;
  }>;
}

export interface AudioChunk {
  mimeType: string;
  data: string; // base64 encoded
}

export type LiveEventType = 
  | "setupComplete" 
  | "audio" 
  | "text" 
  | "transcription"
  | "turnComplete" 
  | "interrupted"
  | "error"
  | "toolCall";

export interface LiveEvent {
  type: LiveEventType;
  data?: any;
}

/**
 * Gemini Live API Client for real-time TTS/STT
 * Uses WebSocket bidirectional streaming
 */
// Available Live API models (as of January 2026):
// - models/gemini-2.5-flash-native-audio-preview-12-2025 (current, recommended)
// - models/gemini-2.5-flash-native-audio-preview-09-2025 (older preview)
// Deprecated: gemini-2.0-flash-live-001, gemini-live-2.5-flash-preview (shutdown Dec 2025)
const DEFAULT_LIVE_MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";

export class GeminiLiveClient {
  private ws?: WebSocket;
  private config: LiveClientConfig;
  private eventHandlers: Map<LiveEventType, ((event: LiveEvent) => void)[]> = new Map();
  private isSetupComplete = false;

  constructor(config: LiveClientConfig) {
    this.config = {
      model: DEFAULT_LIVE_MODEL,
      voiceName: "Aoede",
      ...config
    };
  }

  /**
   * Connect to the Gemini Live API WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.config.apiKey}`;
      
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        console.log("🔌 Live API WebSocket connected");
        this.sendSetup();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          console.log("📥 Received:", JSON.stringify(message, null, 2).slice(0, 500));
          this.handleMessage(message);
          
          if (message.setupComplete) {
            this.isSetupComplete = true;
            resolve();
          }
        } catch (err) {
          console.error("Failed to parse message:", err);
        }
      });

      this.ws.on("error", (err) => {
        console.error("❌ Live API WebSocket error:", err);
        this.emit({ type: "error", data: err });
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        console.log(`🔌 Live API WebSocket closed: ${code} - ${reason}`);
        this.isSetupComplete = false;
      });

      // Timeout for setup
      setTimeout(() => {
        if (!this.isSetupComplete) {
          reject(new Error("Setup timeout - no setupComplete received"));
        }
      }, 10000);
    });
  }

  /**
   * Send initial setup message
   * Note: Gemini Live API uses camelCase for all config properties
   * IMPORTANT: response_modalities can only have ONE value - either TEXT or AUDIO, not both
   */
  private sendSetup(): void {
    const setupMessage: any = {
      setup: {
        model: this.config.model,
        generationConfig: {
          // Live API only supports ONE modality - use AUDIO for voice interaction
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.config.voiceName
              }
            }
          }
        },
        systemInstruction: this.config.systemInstruction ? {
          parts: [{ text: this.config.systemInstruction }]
        } : undefined
      }
    };

    // Add tools if provided
    if (this.config.tools && this.config.tools.length > 0) {
      setupMessage.setup.tools = [{
        functionDeclarations: this.config.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: "object", properties: {} }
        }))
      }];
    }

    console.log("📤 Sending setup:", JSON.stringify(setupMessage, null, 2));
    this.send(setupMessage);
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: any): void {
    if (message.setupComplete) {
      this.emit({ type: "setupComplete" });
      return;
    }

    if (message.serverContent) {
      const content = message.serverContent;

      // Handle model turn (audio/text response)
      if (content.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          if (part.inlineData) {
            this.emit({
              type: "audio",
              data: {
                mimeType: part.inlineData.mimeType,
                data: part.inlineData.data
              }
            });
          }
          if (part.text) {
            this.emit({ type: "text", data: part.text });
          }
        }
      }

      // Handle transcription
      if (content.inputTranscription) {
        this.emit({ 
          type: "transcription", 
          data: { input: content.inputTranscription.text } 
        });
      }
      if (content.outputTranscription) {
        this.emit({ 
          type: "transcription", 
          data: { output: content.outputTranscription.text } 
        });
      }

      // Handle turn complete
      if (content.turnComplete) {
        this.emit({ type: "turnComplete" });
      }

      // Handle interruption
      if (content.interrupted) {
        this.emit({ type: "interrupted" });
      }
    }

    // Handle tool calls
    if (message.toolCall) {
      this.emit({ type: "toolCall", data: message.toolCall });
    }
  }

  /**
   * Send audio chunk to the model (for STT)
   * Audio should be PCM 16kHz 16-bit mono, base64 encoded
   */
  sendAudio(audioData: string): void {
    if (!this.isSetupComplete) {
      throw new Error("Cannot send audio before setup is complete");
    }

    this.send({
      realtimeInput: {
        mediaChunks: [{
          mimeType: "audio/pcm",
          data: audioData
        }]
      }
    });
  }

  /**
   * Send text message to the model
   */
  sendText(text: string, endTurn = true): void {
    if (!this.isSetupComplete) {
      throw new Error("Cannot send text before setup is complete");
    }

    this.send({
      clientContent: {
        turns: [{
          role: "user",
          parts: [{ text }]
        }],
        turnComplete: endTurn
      }
    });
  }

  /**
   * Send tool response back to the model
   */
  sendToolResponse(functionResponses: Array<{ id: string; name: string; response: any }>): void {
    const msg = {
      toolResponse: {
        functionResponses: functionResponses.map(fr => ({
          id: fr.id,
          name: fr.name,
          response: fr.response
        }))
      }
    };
    console.log("📤 Sending tool response:", JSON.stringify(msg, null, 2).slice(0, 500));
    this.send(msg);
  }

  /**
   * Register event handler
   */
  on(event: LiveEventType, handler: (event: LiveEvent) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  /**
   * Emit event to handlers
   */
  private emit(event: LiveEvent): void {
    const handlers = this.eventHandlers.get(event.type) || [];
    for (const handler of handlers) {
      handler(event);
    }
  }

  /**
   * Send JSON message over WebSocket
   */
  private send(message: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Close the connection
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.isSetupComplete = false;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.isSetupComplete;
  }
}
