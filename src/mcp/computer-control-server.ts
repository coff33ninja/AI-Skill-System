#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import screenshot from "screenshot-desktop";

// Optional dependency
let robot: any;
try {
  // @ts-ignore
  robot = (await import("@nut-tree-fork/nut-js")).default;
} catch (e) {
  console.error("Could not import nut-js, computer control tools will not be available.");
  robot = new Proxy({}, {
    get: (target, prop) => {
      throw new Error(`nut-js is not available, but required for tool call "${String(prop)}". Please install it manually.`);
    }
  });
}

interface ControlState {
  enabled: boolean;
  grantedAt?: number;
  expiresAt?: number;
}

const state: ControlState = {
  enabled: false
};

const server = new Server(
  {
    name: "human-computer-control",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// ========== CONSENT & CONTROL ==========

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "control_enable",
      description: "Grant AI permission to control computer (time-limited)",
      inputSchema: {
        type: "object",
        properties: {
          durationMs: { type: "number", default: 300000 }
        }
      }
    },
    {
      name: "control_disable",
      description: "Immediately revoke control",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "control_status",
      description: "Check current control permissions",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "screen_observe",
      description: "Capture current screen as image",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "mouse_move",
      description: "Move mouse smoothly to coordinates",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" }
        },
        required: ["x", "y"]
      }
    },
    {
      name: "mouse_click",
      description: "Click mouse button",
      inputSchema: {
        type: "object",
        properties: {
          button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
          double: { type: "boolean", default: false }
        }
      }
    },
    {
      name: "keyboard_type",
      description: "Type text as if human",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"]
      }
    },
    {
      name: "keyboard_shortcut",
      description: "Execute keyboard shortcut (e.g., 'control+c')",
      inputSchema: {
        type: "object",
        properties: {
          keys: { type: "string" }
        },
        required: ["keys"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const { name, arguments: args } = request.params;

  // Check expiry
  if (state.enabled && state.expiresAt && Date.now() > state.expiresAt) {
    state.enabled = false;
  }

  switch (name) {
    case "control_enable": {
      const duration = (args as any)?.durationMs || 300000;
      state.enabled = true;
      state.grantedAt = Date.now();
      state.expiresAt = Date.now() + duration;
      
      return {
        content: [{
          type: "text",
          text: `✅ Control enabled for ${duration/1000}s (expires: ${new Date(state.expiresAt!).toISOString()})`
        }]
      };
    }

    case "control_disable": {
      state.enabled = false;
      state.expiresAt = undefined;
      
      return {
        content: [{
          type: "text",
          text: "🛑 Control disabled"
        }]
      };
    }

    case "control_status": {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(state, null, 2)
        }]
      };
    }

    case "screen_observe": {
      if (!state.enabled) throw new Error("Control not enabled");
      const img = await screenshot({ format: "png" });
      return {
        content: [{
          type: "image",
          data: img.toString("base64"),
          mimeType: "image/png"
        }]
      };
    }

    case "mouse_move": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { x, y } = (args as any) as { x: number; y: number };
      robot.moveMouseSmooth(x, y);
      
      return {
        content: [{
          type: "text",
          text: `Mouse → (${x}, ${y})`
        }]
      };
    }

    case "mouse_click": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { button = "left", double = false } = (args as any) || {};
      robot.mouseClick(button, double);
      
      return {
        content: [{
          type: "text",
          text: `Mouse ${button} ${double ? "double-" : ""}click`
        }]
      };
    }

    case "keyboard_type": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { text } = (args as any) as { text: string };
      robot.typeString(text);
      
      return {
        content: [{
          type: "text",
          text: `Typed: "${text}"`
        }]
      };
    }

    case "keyboard_shortcut": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { keys } = (args as any) as { keys: string };
      const parts = keys.split("+");
      
      robot.keyTap(parts[parts.length - 1], parts.slice(0, -1) as any);
      
      return {
        content: [{
          type: "text",
          text: `Shortcut: ${keys}`
        }]
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ========== START ==========

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("🧠 Computer Control MCP Server running");
