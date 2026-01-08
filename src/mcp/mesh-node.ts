import { WebSocketServer, WebSocket } from 'ws';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import crypto from 'crypto';

// Add a state for each connection
interface ConnectionState {
  isAuthenticated: boolean;
}

/**
 * MeshNode allows this machine to act as a remote execution target.
 * It wraps the local MCP server and exposes it via WebSockets to the Orchestrator.
 * WARNING: This is a security-sensitive component.
 */
export class MeshNode {
  private wss: WebSocketServer;
  private connections = new Map<WebSocket, ConnectionState>();
  private authToken: string;
  private mcpClient?: Client;

  constructor(port: number = 8080, authToken?: string) {
    this.wss = new WebSocketServer({ port });
    this.authToken = authToken || process.env.MCP_MESH_AUTH_TOKEN || this.generateToken();
    
    if (!process.env.MCP_MESH_AUTH_TOKEN && !authToken) {
        console.warn(`****************************************************************`);
        console.warn(`* WARNING: No auth token provided for MeshNode.                *`);
        console.warn(`* A random token has been generated: ${this.authToken}      *`);
        console.warn(`* Set MCP_MESH_AUTH_TOKEN environment variable for persistence. *`);
        console.warn(`****************************************************************`);
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
        command: "node",
        args: ["dist/mcp/computer-control-server.js"]
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

          // 1. Handle Authentication
          if (message.type === 'AUTH') {
            if (message.token === this.authToken) {
              state.isAuthenticated = true;
              console.log("✅ Client authenticated successfully.");
              ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
            } else {
              console.error("⛔ Authentication failed. Closing connection.");
              ws.send(JSON.stringify({ type: 'AUTH_FAILURE' }));
              ws.close();
            }
            return;
          }

          // 2. Reject if not authenticated
          if (!state.isAuthenticated) {
            console.error("⛔ Unauthenticated client sent a command. Closing connection.");
            ws.close();
            return;
          }

          // 3. Handle remote tool execution requests
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
        console.log("🔌 Client disconnected.");
        this.connections.delete(ws);
      });
    });
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