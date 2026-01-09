import { WebSocketServer, WebSocket } from 'ws';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConsentManager } from "../agent/consent-manager.js";
import crypto from 'crypto';

interface ConnectionState {
  isAuthenticated: boolean;
  machineId?: string;
}

/**
 * MeshNode allows this machine to act as a remote execution target.
 * It wraps the local MCP server and exposes it via WebSockets to the Orchestrator.
 * 
 * Authentication modes:
 * 1. Simple token: Set MCP_MESH_AUTH_TOKEN env var (backwards compatible)
 * 2. Pairing: Use REQUEST_PAIRING to get time-limited token for a machine
 */
export class MeshNode {
  private wss: WebSocketServer;
  private connections = new Map<WebSocket, ConnectionState>();
  private simpleToken?: string;
  private consentManager: ConsentManager;
  private mcpClient?: Client;

  constructor(port: number = 8080, authToken?: string) {
    this.wss = new WebSocketServer({ port });
    this.consentManager = new ConsentManager();
    
    // Simple token auth (backwards compatible)
    this.simpleToken = authToken || process.env.MCP_MESH_AUTH_TOKEN;
    
    if (!this.simpleToken) {
      console.log(`ℹ️  No MCP_MESH_AUTH_TOKEN set - using pairing mode only`);
      console.log(`   Clients must use REQUEST_PAIRING to get a token`);
    }
    
    console.log(`🌐 Mesh Node listening on port ${port}`);
  }

  private generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Connect to local MCP server for tool execution
   */
  private async connectLocalMCP() {
    if (this.mcpClient) return;

    try {
      const transport = new StdioClientTransport({
        command: "npx",
        args: ["tsx", "src/mcp/computer-control-server.ts"]
      });

      this.mcpClient = new Client(
        { name: "mesh-node", version: "1.0.0" },
        { capabilities: {} }
      );

      await this.mcpClient.connect(transport);
      console.log("✅ Mesh Node connected to local MCP server");
    } catch (error) {
      console.error("❌ Failed to connect to local MCP server:", error);
      throw error;
    }
  }

  async start() {
    // Connect to local MCP server on startup
    await this.connectLocalMCP();

    this.wss.on('connection', (ws: WebSocket) => {
      console.log("🔗 Client connected to Mesh Node. Awaiting authentication.");
      this.connections.set(ws, { isAuthenticated: false });

      ws.on('message', async (data: any) => {
        try {
          const message = JSON.parse(data.toString());
          const state = this.connections.get(ws);

          if (!state) return;

          // 1. Handle Pairing Request (get a new token for a machine)
          if (message.type === 'REQUEST_PAIRING') {
            const machineId = message.machineId;
            if (!machineId) {
              ws.send(JSON.stringify({ type: 'PAIRING_FAILURE', error: 'machineId required' }));
              return;
            }
            
            const token = await this.consentManager.requestPairing(machineId);
            console.log(`🤝 Pairing granted for machine: ${machineId}`);
            console.log(`   Token (valid 24h): ${token.slice(0, 8)}...`);
            ws.send(JSON.stringify({ type: 'PAIRING_SUCCESS', token, expiresIn: '24h' }));
            return;
          }

          // 2. Handle Authentication
          if (message.type === 'AUTH') {
            let authenticated = false;
            
            // Try simple token first (backwards compatible)
            if (this.simpleToken && message.token === this.simpleToken) {
              authenticated = true;
              console.log("✅ Client authenticated via simple token");
            }
            // Try ConsentManager pairing
            else if (message.machineId && message.token) {
              authenticated = await this.consentManager.verify(message.machineId, message.token);
              if (authenticated) {
                state.machineId = message.machineId;
                console.log(`✅ Client authenticated via pairing: ${message.machineId}`);
              }
            }
            
            if (authenticated) {
              state.isAuthenticated = true;
              ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
            } else {
              console.error("⛔ Authentication failed. Closing connection.");
              ws.send(JSON.stringify({ type: 'AUTH_FAILURE' }));
              ws.close();
            }
            return;
          }

          // 3. Reject if not authenticated
          if (!state.isAuthenticated) {
            console.error("⛔ Unauthenticated client sent a command. Closing connection.");
            ws.close();
            return;
          }

          // 4. Handle LIST_TOOLS request
          if (message.type === 'LIST_TOOLS') {
            const tools = await this.getAvailableTools();
            ws.send(JSON.stringify({ type: 'TOOLS_LIST', id: message.id, tools }));
            return;
          }

          // 5. Handle remote tool execution requests
          if (message.type === 'EXECUTE_TOOL') {
            const result = await this.handleLocalExecution(message.tool, message.args);
            ws.send(JSON.stringify({ type: 'RESULT', id: message.id, result }));
          }
        } catch (err) {
          console.error("Failed to process mesh message:", err);
          ws.send(JSON.stringify({ 
            type: 'ERROR', 
            error: err instanceof Error ? err.message : String(err) 
          }));
        }
      });

      ws.on('close', () => {
        const state = this.connections.get(ws);
        const machineInfo = state?.machineId ? ` (${state.machineId})` : '';
        console.log(`🔌 Client disconnected${machineInfo}`);
        this.connections.delete(ws);
      });
    });
  }

  /**
   * Get list of available tools from local MCP
   */
  private async getAvailableTools(): Promise<any[]> {
    if (!this.mcpClient) {
      return [];
    }
    
    try {
      const result = await this.mcpClient.listTools();
      return result.tools || [];
    } catch (err) {
      console.error("Failed to list tools:", err);
      return [];
    }
  }

  private async handleLocalExecution(tool: string, args: any) {
    if (!this.mcpClient) {
      throw new Error("MCP client not connected");
    }

    console.log(`⚡ Executing remote command: ${tool}`);
    console.log(`   Args:`, JSON.stringify(args, null, 2));

    try {
      const result = await this.mcpClient.callTool({
        name: tool,
        arguments: args || {}
      });

      console.log(`✅ Tool ${tool} executed successfully`);
      return { status: "success", result };
    } catch (error) {
      console.error(`❌ Tool ${tool} execution failed:`, error);
      throw error;
    }
  }
}

// Start if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const node = new MeshNode(parseInt(process.env.MESH_PORT || "8080"));
  node.start();
}