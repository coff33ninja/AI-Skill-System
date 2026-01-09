import WebSocket from "ws";

/**
 * MeshClient connects to remote MeshNodes to execute tools on other machines.
 * 
 * Authentication modes:
 * 1. Simple token: Pass token to constructor (backwards compatible)
 * 2. Pairing: Pass machineId + token from previous pairing
 * 
 * Protocol:
 * 1. Connect via WebSocket
 * 2. Send AUTH message with token (and optionally machineId)
 * 3. Receive AUTH_SUCCESS or AUTH_FAILURE
 * 4. Send LIST_TOOLS to discover available tools
 * 5. Send EXECUTE_TOOL messages, receive RESULT messages
 */
export class MeshClient {
  private ws?: WebSocket;
  private host: string;
  private port: number;
  private token: string;
  private machineId?: string;
  private isAuthenticated = false;
  private pendingRequests = new Map<string, { resolve: Function; reject: Function }>();
  private requestId = 0;
  private cachedTools?: any[];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private onDisconnect?: () => void;

  constructor(host: string, port: number = 8080, token: string, machineId?: string) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.machineId = machineId;
  }

  /**
   * Connect to a remote mesh node with auto-retry
   */
  async connect(): Promise<void> {
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      try {
        await this._connect();
        this.reconnectAttempts = 0; // Reset on success
        return;
      } catch (err) {
        this.reconnectAttempts++;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          throw err;
        }
        console.log(`⚠️  Connection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} failed, retrying...`);
        await new Promise(r => setTimeout(r, 1000 * this.reconnectAttempts)); // Backoff
      }
    }
  }

  private _connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.port}`;
      console.log(`🔌 Connecting to mesh node at ${url}...`);

      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout to ${url}`));
        this.ws?.close();
      }, 10000);

      this.ws.on("open", () => {
        console.log("🔗 WebSocket connected, authenticating...");
        // Send auth with optional machineId for pairing mode
        const authMsg: any = { type: "AUTH", token: this.token };
        if (this.machineId) {
          authMsg.machineId = this.machineId;
        }
        this.ws!.send(JSON.stringify(authMsg));
      });

      this.ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());

          // Handle auth response
          if (message.type === "AUTH_SUCCESS") {
            clearTimeout(timeout);
            this.isAuthenticated = true;
            console.log("✅ Authenticated with mesh node");
            resolve();
            return;
          }

          if (message.type === "AUTH_FAILURE") {
            clearTimeout(timeout);
            reject(new Error("Authentication failed - check your token"));
            this.ws?.close();
            return;
          }

          // Handle tool execution results
          if (message.type === "RESULT" && message.id) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
              this.pendingRequests.delete(message.id);
              pending.resolve(message.result);
            }
            return;
          }

          // Handle tools list response
          if (message.type === "TOOLS_LIST" && message.id) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
              this.pendingRequests.delete(message.id);
              pending.resolve(message.tools);
            }
            return;
          }

          // Handle errors
          if (message.type === "ERROR") {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
              this.pendingRequests.delete(message.id);
              pending.reject(new Error(message.error));
            } else {
              console.error("🔴 Mesh error:", message.error);
            }
            return;
          }
        } catch (err) {
          console.error("Failed to parse mesh message:", err);
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        console.error("❌ Mesh connection error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        this.isAuthenticated = false;
        console.log("🔌 Mesh connection closed");
        
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error("Connection closed"));
          this.pendingRequests.delete(id);
        }

        this.onDisconnect?.();
      });
    });
  }

  /**
   * Execute a tool on the remote machine
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.ws || !this.isAuthenticated) {
      throw new Error("Not connected to mesh node");
    }

    const id = `req_${++this.requestId}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Tool execution timeout: ${name}`));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (result: any) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.ws!.send(JSON.stringify({
        type: "EXECUTE_TOOL",
        id,
        tool: name,
        args
      }));
    });
  }

  /**
   * List available tools from remote mesh node
   */
  async listTools(): Promise<{ tools: any[] }> {
    if (!this.ws || !this.isAuthenticated) {
      throw new Error("Not connected to mesh node");
    }

    // Return cached if available
    if (this.cachedTools) {
      return { tools: this.cachedTools };
    }

    const id = `req_${++this.requestId}`;

    const tools = await new Promise<any[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("LIST_TOOLS timeout"));
      }, 10000);

      this.pendingRequests.set(id, {
        resolve: (result: any) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.ws!.send(JSON.stringify({ type: "LIST_TOOLS", id }));
    });

    this.cachedTools = tools;
    return { tools };
  }

  /**
   * Disconnect from mesh node
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.isAuthenticated = false;
    this.cachedTools = undefined;
  }

  get connected(): boolean {
    return this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Set callback for disconnect events
   */
  onClose(callback: () => void): void {
    this.onDisconnect = callback;
  }
}
