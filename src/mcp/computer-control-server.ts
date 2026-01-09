#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import screenshot from "screenshot-desktop";
import { SkillStorage } from "../memory/storage.js";
import { DriftTracker } from "../memory/drift-tracker.js";

// Optional nut-js dependency for mouse/keyboard control
let mouse: any;
let keyboard: any;
let screen: any;
let clipboard: any;
let getWindows: any;
let getActiveWindow: any;
let Key: any;
let Button: any;
let robotAvailable = false;

try {
  const nutjs = await import("@nut-tree-fork/nut-js");
  mouse = nutjs.mouse;
  keyboard = nutjs.keyboard;
  screen = nutjs.screen;
  clipboard = nutjs.clipboard;
  getWindows = nutjs.getWindows;
  getActiveWindow = nutjs.getActiveWindow;
  Key = nutjs.Key;
  Button = nutjs.Button;
  robotAvailable = true;
  console.error("✅ nut-js loaded successfully");
} catch (e) {
  console.error("⚠️  nut-js not available. Mouse/keyboard control disabled.");
}

interface ControlState {
  enabled: boolean;
  grantedAt?: number;
  expiresAt?: number;
}

const state: ControlState = { enabled: false };
const skillStorage = new SkillStorage();
const driftTracker = new DriftTracker();

const server = new Server(
  { name: "human-computer-control", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "control_enable",
      description: "Grant AI permission to control computer (time-limited)",
      inputSchema: {
        type: "object",
        properties: { durationMs: { type: "number", default: 300000 } }
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
      name: "screen_info",
      description: "Get information about all connected screens/monitors (count, dimensions, positions)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "mouse_position",
      description: "Get current mouse cursor position (x, y coordinates)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "mouse_move",
      description: "Move mouse to coordinates",
      inputSchema: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
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
      description: "Type text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      }
    },
    {
      name: "keyboard_shortcut",
      description: "Execute keyboard shortcut (e.g., 'ctrl+c')",
      inputSchema: {
        type: "object",
        properties: { keys: { type: "string" } },
        required: ["keys"]
      }
    },
    {
      name: "mouse_scroll",
      description: "Scroll mouse wheel up or down",
      inputSchema: {
        type: "object",
        properties: { 
          direction: { type: "string", enum: ["up", "down"], default: "down" },
          amount: { type: "number", default: 3, description: "Number of scroll steps" }
        }
      }
    },
    {
      name: "mouse_drag",
      description: "Drag mouse from current position to target coordinates",
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
      name: "clipboard_read",
      description: "Read current clipboard text content",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "clipboard_write",
      description: "Write text to clipboard",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      }
    },
    {
      name: "window_active",
      description: "Get information about the currently active/focused window",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "window_list",
      description: "List all open windows with their titles and positions",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "mouse_hold",
      description: "Press and hold or release a mouse button (for drag operations)",
      inputSchema: {
        type: "object",
        properties: { 
          button: { type: "string", enum: ["left", "right"], default: "left" },
          action: { type: "string", enum: ["down", "up"] }
        },
        required: ["action"]
      }
    },
    {
      name: "keyboard_hold",
      description: "Press and hold or release a key (for modifier keys like shift, ctrl)",
      inputSchema: {
        type: "object",
        properties: { 
          key: { type: "string", description: "Key name (ctrl, shift, alt, etc.)" },
          action: { type: "string", enum: ["down", "up"] }
        },
        required: ["key", "action"]
      }
    },
    {
      name: "wait",
      description: "Wait/pause for specified milliseconds before next action",
      inputSchema: {
        type: "object",
        properties: { ms: { type: "number", default: 1000 } }
      }
    },
    {
      name: "screen_highlight",
      description: "Briefly highlight a region on screen (visual feedback for user)",
      inputSchema: {
        type: "object",
        properties: { 
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number", default: 100 },
          height: { type: "number", default: 100 }
        },
        required: ["x", "y"]
      }
    },
    {
      name: "mouse_triple_click",
      description: "Triple click to select entire line/paragraph",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "keyboard_press",
      description: "Press a single key (enter, tab, escape, arrow keys, etc.)",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"]
      }
    },
    {
      name: "skills_list",
      description: "List all learned skills with their confidence and execution count",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "skills_search",
      description: "Search skills by tag (mouse, keyboard, screenshot, multi-step)",
      inputSchema: {
        type: "object",
        properties: { tag: { type: "string" } },
        required: ["tag"]
      }
    },
    {
      name: "skills_drift",
      description: "Get drift analysis for a specific skill showing confidence/speed/complexity trends",
      inputSchema: {
        type: "object",
        properties: { skillId: { type: "string" } },
        required: ["skillId"]
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
      const duration = args?.durationMs || 300000;
      state.enabled = true;
      state.grantedAt = Date.now();
      state.expiresAt = Date.now() + duration;
      return {
        content: [{
          type: "text",
          text: `✅ Control enabled for ${duration/1000}s`
        }]
      };
    }

    case "control_disable": {
      state.enabled = false;
      state.expiresAt = undefined;
      return { content: [{ type: "text", text: "🛑 Control disabled" }] };
    }

    case "control_status": {
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
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

    case "screen_info": {
      // Get screen info - works even without control enabled (read-only)
      const displays = await screenshot.listDisplays();
      
      // Also get primary screen dimensions from nut-js if available
      let primaryWidth = 0, primaryHeight = 0;
      if (robotAvailable && screen) {
        try {
          primaryWidth = await screen.width();
          primaryHeight = await screen.height();
        } catch {}
      }
      
      const info = {
        screenCount: displays.length,
        screens: displays.map((d: any, i: number) => ({
          id: d.id,
          name: d.name || `Display ${i + 1}`,
          primary: i === 0,
          width: d.width || primaryWidth,
          height: d.height || primaryHeight,
          x: d.left || 0,
          y: d.top || 0
        })),
        totalWidth: primaryWidth,
        totalHeight: primaryHeight
      };
      
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }

    case "mouse_position": {
      // Get mouse position - works even without control enabled (read-only)
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const pos = await mouse.getPosition();
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ x: pos.x, y: pos.y }, null, 2) 
        }] 
      };
    }

    case "mouse_move": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { x, y } = args as { x: number; y: number };
      await mouse.setPosition({ x, y });
      return { content: [{ type: "text", text: `Mouse → (${x}, ${y})` }] };
    }

    case "mouse_click": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { button = "left", double = false } = args || {};
      
      if (double) {
        await mouse.doubleClick(Button.LEFT);
      } else if (button === "right") {
        await mouse.rightClick();
      } else if (button === "middle") {
        await mouse.click(Button.MIDDLE);
      } else {
        await mouse.leftClick();
      }
      
      return { content: [{ type: "text", text: `Mouse ${button} ${double ? "double-" : ""}click` }] };
    }

    case "keyboard_type": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { text } = args as { text: string };
      await keyboard.type(text);
      return { content: [{ type: "text", text: `Typed: "${text}"` }] };
    }

    case "keyboard_shortcut": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { keys } = args as { keys: string };
      const parts = keys.toLowerCase().split("+");
      const keyList: any[] = [];
      
      // Map modifier and regular keys
      const keyMap: Record<string, any> = {
        'ctrl': Key.LeftControl, 'control': Key.LeftControl,
        'alt': Key.LeftAlt, 'shift': Key.LeftShift,
        'cmd': Key.LeftSuper, 'win': Key.LeftSuper, 'super': Key.LeftSuper,
        'tab': Key.Tab, 'enter': Key.Return, 'return': Key.Return,
        'escape': Key.Escape, 'esc': Key.Escape,
        'space': Key.Space, 'backspace': Key.Backspace,
        'delete': Key.Delete, 'home': Key.Home, 'end': Key.End,
        'up': Key.Up, 'down': Key.Down, 'left': Key.Left, 'right': Key.Right,
        'a': Key.A, 'b': Key.B, 'c': Key.C, 'd': Key.D, 'e': Key.E,
        'f': Key.F, 'g': Key.G, 'h': Key.H, 'i': Key.I, 'j': Key.J,
        'k': Key.K, 'l': Key.L, 'm': Key.M, 'n': Key.N, 'o': Key.O,
        'p': Key.P, 'q': Key.Q, 'r': Key.R, 's': Key.S, 't': Key.T,
        'u': Key.U, 'v': Key.V, 'w': Key.W, 'x': Key.X, 'y': Key.Y, 'z': Key.Z,
        '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3, '4': Key.Num4,
        '5': Key.Num5, '6': Key.Num6, '7': Key.Num7, '8': Key.Num8, '9': Key.Num9,
        'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4,
        'f5': Key.F5, 'f6': Key.F6, 'f7': Key.F7, 'f8': Key.F8,
        'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12
      };
      
      for (const part of parts) {
        const key = keyMap[part];
        if (key) keyList.push(key);
      }
      
      if (keyList.length === 0) {
        throw new Error(`Unknown keys: ${keys}`);
      }
      
      // Press all keys, then release in reverse order
      for (const k of keyList) await keyboard.pressKey(k);
      for (const k of keyList.reverse()) await keyboard.releaseKey(k);
      
      return { content: [{ type: "text", text: `Shortcut: ${keys}` }] };
    }

    case "mouse_scroll": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { direction = "down", amount = 3 } = args || {};
      
      for (let i = 0; i < amount; i++) {
        if (direction === "up") {
          await mouse.scrollUp(1);
        } else {
          await mouse.scrollDown(1);
        }
      }
      
      return { content: [{ type: "text", text: `Scrolled ${direction} ${amount} steps` }] };
    }

    case "mouse_drag": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { x, y } = args as { x: number; y: number };
      const start = await mouse.getPosition();
      await mouse.drag([{ x, y }]);
      
      return { content: [{ type: "text", text: `Dragged from (${start.x}, ${start.y}) to (${x}, ${y})` }] };
    }

    case "clipboard_read": {
      // Read-only, doesn't require control enabled
      if (!robotAvailable) throw new Error("nut-js not available");
      
      try {
        const text = await clipboard.getContent();
        return { content: [{ type: "text", text: text || "(clipboard empty)" }] };
      } catch {
        return { content: [{ type: "text", text: "(clipboard empty or not text)" }] };
      }
    }

    case "clipboard_write": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { text } = args as { text: string };
      await clipboard.setContent(text);
      
      return { content: [{ type: "text", text: `Copied to clipboard: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"` }] };
    }

    case "window_active": {
      // Read-only, doesn't require control enabled
      if (!robotAvailable) throw new Error("nut-js not available");
      
      try {
        const win = await getActiveWindow();
        const region = await win.region;
        const title = await win.title;
        
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              title,
              x: region.left,
              y: region.top,
              width: region.width,
              height: region.height
            }, null, 2)
          }] 
        };
      } catch (e) {
        return { content: [{ type: "text", text: "Could not get active window info" }] };
      }
    }

    case "window_list": {
      // Read-only, doesn't require control enabled
      if (!robotAvailable) throw new Error("nut-js not available");
      
      try {
        const windows = await getWindows();
        const windowInfo = await Promise.all(
          windows.slice(0, 20).map(async (win: any) => {
            try {
              const title = await win.title;
              const region = await win.region;
              return {
                title,
                x: region.left,
                y: region.top,
                width: region.width,
                height: region.height
              };
            } catch {
              return null;
            }
          })
        );
        
        const validWindows = windowInfo.filter(w => w && w.title);
        return { content: [{ type: "text", text: JSON.stringify(validWindows, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: "Could not list windows" }] };
      }
    }

    case "mouse_hold": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { button = "left", action } = args as { button?: string; action: string };
      const btn = button === "right" ? Button.RIGHT : Button.LEFT;
      
      if (action === "down") {
        await mouse.pressButton(btn);
        return { content: [{ type: "text", text: `Mouse ${button} button held down` }] };
      } else {
        await mouse.releaseButton(btn);
        return { content: [{ type: "text", text: `Mouse ${button} button released` }] };
      }
    }

    case "keyboard_hold": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { key, action } = args as { key: string; action: string };
      
      const keyMap: Record<string, any> = {
        'ctrl': Key.LeftControl, 'control': Key.LeftControl,
        'alt': Key.LeftAlt, 'shift': Key.LeftShift,
        'cmd': Key.LeftSuper, 'win': Key.LeftSuper, 'super': Key.LeftSuper,
      };
      
      const k = keyMap[key.toLowerCase()];
      if (!k) throw new Error(`Unknown key: ${key}. Use ctrl, alt, shift, cmd, or win.`);
      
      if (action === "down") {
        await keyboard.pressKey(k);
        return { content: [{ type: "text", text: `Key ${key} held down` }] };
      } else {
        await keyboard.releaseKey(k);
        return { content: [{ type: "text", text: `Key ${key} released` }] };
      }
    }

    case "wait": {
      const { ms = 1000 } = args || {};
      await new Promise(resolve => setTimeout(resolve, ms));
      return { content: [{ type: "text", text: `Waited ${ms}ms` }] };
    }

    case "screen_highlight": {
      // Visual feedback - works without control (just shows, doesn't interact)
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { x, y, width = 100, height = 100 } = args as { x: number; y: number; width?: number; height?: number };
      
      try {
        // nut-js has a highlight feature
        await screen.highlight({ left: x, top: y, width, height });
        return { content: [{ type: "text", text: `Highlighted region at (${x}, ${y}) ${width}x${height}` }] };
      } catch {
        // Fallback: just confirm the coordinates
        return { content: [{ type: "text", text: `Region: (${x}, ${y}) ${width}x${height} (highlight not available)` }] };
      }
    }

    case "mouse_triple_click": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      // Triple click = 3 rapid left clicks
      await mouse.leftClick();
      await mouse.leftClick();
      await mouse.leftClick();
      
      return { content: [{ type: "text", text: "Triple clicked (select line/paragraph)" }] };
    }

    case "keyboard_press": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { key } = args as { key: string };
      
      const keyMap: Record<string, any> = {
        'enter': Key.Return, 'return': Key.Return,
        'tab': Key.Tab, 'escape': Key.Escape, 'esc': Key.Escape,
        'space': Key.Space, 'backspace': Key.Backspace,
        'delete': Key.Delete, 'del': Key.Delete,
        'home': Key.Home, 'end': Key.End,
        'pageup': Key.PageUp, 'pagedown': Key.PageDown,
        'up': Key.Up, 'down': Key.Down, 'left': Key.Left, 'right': Key.Right,
        'insert': Key.Insert, 'printscreen': Key.Print,
        'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4,
        'f5': Key.F5, 'f6': Key.F6, 'f7': Key.F7, 'f8': Key.F8,
        'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12
      };
      
      const k = keyMap[key.toLowerCase()];
      if (!k) throw new Error(`Unknown key: ${key}`);
      
      await keyboard.pressKey(k);
      await keyboard.releaseKey(k);
      
      return { content: [{ type: "text", text: `Pressed: ${key}` }] };
    }

    case "skills_list": {
      const skills = await skillStorage.loadSkills();
      if (skills.length === 0) {
        return { content: [{ type: "text", text: "No skills learned yet. Execute some commands to build skill memory." }] };
      }
      
      const summary = skills.map(s => ({
        id: s.skillId,
        description: s.description,
        tags: s.tags,
        confidence: Math.round(s.confidence * 100) + '%',
        executions: s.totalExecutions,
        lastUsed: new Date(s.lastUsed).toLocaleDateString()
      }));
      
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    case "skills_search": {
      const { tag } = args as { tag: string };
      const skills = await skillStorage.loadSkills();
      const matched = skills.filter(s => s.tags.includes(tag.toLowerCase()));
      
      if (matched.length === 0) {
        return { content: [{ type: "text", text: `No skills found with tag: ${tag}` }] };
      }
      
      const summary = matched.map(s => ({
        id: s.skillId,
        description: s.description,
        confidence: Math.round(s.confidence * 100) + '%'
      }));
      
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    case "skills_drift": {
      const { skillId } = args as { skillId: string };
      const analysis = await driftTracker.analyzeDrift(skillId);
      
      const report = {
        skillId,
        confidenceTrend: analysis.confidenceTrend > 0 ? `+${analysis.confidenceTrend.toFixed(2)}` : analysis.confidenceTrend.toFixed(2),
        speedTrend: analysis.speedTrend > 0 ? `+${analysis.speedTrend.toFixed(0)}ms (slower)` : `${analysis.speedTrend.toFixed(0)}ms (faster)`,
        complexityTrend: analysis.complexityTrend > 0 ? `+${analysis.complexityTrend} steps` : `${analysis.complexityTrend} steps`
      };
      
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🧠 Computer Control MCP Server running");
