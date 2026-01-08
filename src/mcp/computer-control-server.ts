#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import screenshot from "screenshot-desktop";

// Optional dependency - import with better error handling
let robot: any = null;
let robotAvailable = false;

try {
  const nutjs = await import("@nut-tree-fork/nut-js");
  robot = nutjs;
  robotAvailable = true;
  console.error("✅ nut-js loaded successfully");
} catch (e) {
  console.error("⚠️  nut-js is not available. Install with: npm install @nut-tree-fork/nut-js");
  console.error("   Computer control tools (mouse, keyboard) will be disabled.");
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
      if (!robotAvailable) throw new Error("nut-js not available - mouse control disabled");
      
      const { x, y } = (args as any) as { x: number; y: number };
      await robot.mouse.setPosition({ x, y });
      
      return {
        content: [{
          type: "text",
          text: `Mouse → (${x}, ${y})`
        }]
      };
    }

    case "mouse_click": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available - mouse control disabled");
      
      const { button = "left", double = false } = (args as any) || {};
      
      if (double) {
        await robot.mouse.doubleClick(robot.Button.LEFT);
      } else {
        const buttonMap: any = {
          left: robot.Button.LEFT,
          right: robot.Button.RIGHT,
          middle: robot.Button.MIDDLE
        };
        await robot.mouse.click(buttonMap[button] || robot.Button.LEFT);
      }
      
      return {
        content: [{
          type: "text",
          text: `Mouse ${button} ${double ? "double-" : ""}click`
        }]
      };
    }

    case "keyboard_type": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available - keyboard control disabled");
      
      const { text } = (args as any) as { text: string };
      await robot.keyboard.type(text);
      
      return {
        content: [{
          type: "text",
          text: `Typed: "${text}"`
        }]
      };
    }

    case "keyboard_shortcut": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available - keyboard control disabled");
      
      const { keys } = (args as any) as { keys: string };
      
      // Parse shortcut like "control+c" or "alt+tab"
      const parts = keys.toLowerCase().split("+");
      const modifiers = parts.slice(0, -1);
      const mainKey = parts[parts.length - 1];
      
      // Build key combination
      const keyCombo = [];
      for (const mod of modifiers) {
        if (mod === "control" || mod === "ctrl") keyCombo.push(robot.Key.LeftControl);
        else if (mod === "alt") keyCombo.push(robot.Key.LeftAlt);
        else if (mod === "shift") keyCombo.push(robot.Key.LeftShift);
        else if (mod === "super" || mod === "win" || mod === "cmd") keyCombo.push(robot.Key.LeftSuper);
      }
      
      // Add main key (map common keys)
      const keyMap: any = {
        'c': robot.Key.C, 'v': robot.Key.V, 'x': robot.Key.X, 'a': robot.Key.A,
        'tab': robot.Key.Tab, 'enter': robot.Key.Enter, 'escape': robot.Key.Escape,
        'space': robot.Key.Space, 'backspace': robot.Key.Backspace
      };
      
      if (keyMap[mainKey]) {
        keyCombo.push(keyMap[mainKey]);
      } else if (mainKey.length === 1) {
        // Single character
        keyCombo.push(mainKey.toUpperCase());
      }
      
      // Execute shortcut
      await robot.keyboard.pressKey(...keyCombo);
      await robot.keyboard.releaseKey(...keyCombo);
      
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
