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

interface MacroAction {
  type: 'mouse_move' | 'mouse_click' | 'keyboard_type' | 'keyboard_shortcut' | 'wait';
  params: Record<string, any>;
  timestamp: number;
}

interface Macro {
  name: string;
  actions: MacroAction[];
  createdAt: number;
}

interface MacroState {
  recording: boolean;
  currentMacro: string | null;
  actions: MacroAction[];
  startTime: number;
  macros: Map<string, Macro>;
}

interface ActionLogEntry {
  tool: string;
  params: Record<string, any>;
  timestamp: number;
  success: boolean;
}

interface SafeZone {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SafetyState {
  actionHistory: ActionLogEntry[];
  safeZones: Map<string, SafeZone>;
  rateLimit: number; // actions per second
  lastActionTime: number;
}

const state: ControlState = { enabled: false };
const macroState: MacroState = {
  recording: false,
  currentMacro: null,
  actions: [],
  startTime: 0,
  macros: new Map()
};
const safetyState: SafetyState = {
  actionHistory: [],
  safeZones: new Map(),
  rateLimit: 10,
  lastActionTime: 0
};
const skillStorage = new SkillStorage();
const driftTracker = new DriftTracker();

// Context snapshots for AI memory
interface ContextSnapshot {
  name: string;
  mouseX: number;
  mouseY: number;
  activeWindow: string;
  timestamp: number;
  screenshotBase64?: string;
}
const contextSnapshots: Map<string, ContextSnapshot> = new Map();

// Browser automation state (Chrome DevTools Protocol)
let browserWsUrl: string | null = null;
const CDP_PORT = 9222;

// Mesh networking state (multi-device control)
import { MeshClient } from "./mesh-client.js";
const meshConnections: Map<string, MeshClient> = new Map();

// Helper: Get Chrome DevTools WebSocket URL
async function getCdpTarget(): Promise<{ webSocketDebuggerUrl: string; id: string } | null> {
  try {
    const response = await fetch(`http://localhost:${CDP_PORT}/json`);
    const tabs = await response.json() as any[];
    const pageTab = tabs.find((t: any) => t.type === 'page');
    return pageTab || null;
  } catch {
    return null;
  }
}

// Helper: Send CDP command
async function sendCdpCommand(method: string, params: any = {}): Promise<any> {
  const target = await getCdpTarget();
  if (!target) {
    throw new Error("No browser connected. Launch Chrome with --remote-debugging-port=9222");
  }
  
  return new Promise((resolve, reject) => {
    const ws = new (require('ws'))(target.webSocketDebuggerUrl);
    const id = Date.now();
    
    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    
    ws.on('message', (data: string) => {
      const msg = JSON.parse(data);
      if (msg.id === id) {
        ws.close();
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          resolve(msg.result);
        }
      }
    });
    
    ws.on('error', (err: Error) => {
      reject(err);
    });
    
    setTimeout(() => {
      ws.close();
      reject(new Error("CDP command timeout"));
    }, 10000);
  });
}

// Helper: Log action to history
function logAction(tool: string, params: Record<string, any>, success: boolean) {
  safetyState.actionHistory.push({
    tool,
    params,
    timestamp: Date.now(),
    success
  });
  // Keep only last 100 actions
  if (safetyState.actionHistory.length > 100) {
    safetyState.actionHistory.shift();
  }
}

// Helper: Check if coordinates are in a safe zone
function isInSafeZone(x: number, y: number): SafeZone | null {
  for (const zone of safetyState.safeZones.values()) {
    if (x >= zone.x && x <= zone.x + zone.width &&
        y >= zone.y && y <= zone.y + zone.height) {
      return zone;
    }
  }
  return null;
}

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
    // Phase 1: Screen Region Tools
    {
      name: "screen_region_capture",
      description: "Capture a specific region of the screen",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" }
        },
        required: ["x", "y", "width", "height"]
      }
    },
    {
      name: "screen_color_at",
      description: "Get the pixel color at specific coordinates",
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
      name: "screen_dominant_colors",
      description: "Get the dominant colors in a screen region (useful for detecting UI themes, button states)",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          count: { type: "number", default: 5, description: "Number of dominant colors to return" }
        },
        required: ["x", "y", "width", "height"]
      }
    },
    // Phase 4: UI Accessibility
    {
      name: "ui_element_at",
      description: "Get UI element info at screen coordinates using Windows UI Automation",
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
      name: "ui_element_tree",
      description: "Get UI element hierarchy of the active window (accessibility tree)",
      inputSchema: {
        type: "object",
        properties: {
          depth: { type: "number", default: 3, description: "Max depth to traverse (1-5)" }
        }
      }
    },
    {
      name: "ui_element_find",
      description: "Find UI elements by name, type, or automation ID",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Element name to search for (partial match)" },
          type: { type: "string", description: "Control type (Button, Edit, Text, etc.)" },
          automationId: { type: "string", description: "Automation ID" }
        }
      }
    },
    {
      name: "ui_element_click",
      description: "Click a UI element by its name or automation ID",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Element name to click" },
          automationId: { type: "string", description: "Or automation ID to click" }
        }
      }
    },
    {
      name: "screen_find_text",
      description: "Find text on screen using OCR and return its location",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to find on screen" },
          confidence: { type: "number", default: 70, description: "Minimum confidence (0-100)" }
        },
        required: ["text"]
      }
    },
    {
      name: "screen_wait_for_text",
      description: "Wait until specific text appears on screen",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to wait for" },
          timeoutMs: { type: "number", default: 10000, description: "Timeout in milliseconds" },
          intervalMs: { type: "number", default: 500, description: "Check interval in milliseconds" }
        },
        required: ["text"]
      }
    },
    {
      name: "screen_read_all_text",
      description: "OCR the entire screen or a region and return all detected text",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "Region X (optional, full screen if omitted)" },
          y: { type: "number", description: "Region Y" },
          width: { type: "number", description: "Region width" },
          height: { type: "number", description: "Region height" }
        }
      }
    },
    {
      name: "screen_find_image",
      description: "Find a template image on screen (provide base64 PNG of what to find)",
      inputSchema: {
        type: "object",
        properties: {
          templateBase64: { type: "string", description: "Base64 encoded PNG image to find" },
          threshold: { type: "number", default: 0.1, description: "Match threshold (0-1, lower = stricter)" }
        },
        required: ["templateBase64"]
      }
    },
    {
      name: "screen_wait_for_image",
      description: "Wait until a template image appears on screen",
      inputSchema: {
        type: "object",
        properties: {
          templateBase64: { type: "string", description: "Base64 encoded PNG image to find" },
          timeoutMs: { type: "number", default: 10000 },
          intervalMs: { type: "number", default: 500 },
          threshold: { type: "number", default: 0.1 }
        },
        required: ["templateBase64"]
      }
    },
    {
      name: "screen_click_text",
      description: "Find text on screen using OCR and click on it",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to find and click" },
          button: { type: "string", enum: ["left", "right"], default: "left" }
        },
        required: ["text"]
      }
    },
    // Phase 2: Window Management
    {
      name: "window_focus",
      description: "Focus/activate a window by its title (partial match supported)",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"]
      }
    },
    {
      name: "window_resize",
      description: "Resize a window by title",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          width: { type: "number" },
          height: { type: "number" }
        },
        required: ["title", "width", "height"]
      }
    },
    {
      name: "window_move",
      description: "Move a window to specific coordinates",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          x: { type: "number" },
          y: { type: "number" }
        },
        required: ["title", "x", "y"]
      }
    },
    {
      name: "window_minimize",
      description: "Minimize a window by title",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"]
      }
    },
    {
      name: "window_maximize",
      description: "Maximize a window by title",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"]
      }
    },
    {
      name: "window_close",
      description: "Close a window by title",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"]
      }
    },
    {
      name: "window_restore",
      description: "Restore a minimized/maximized window to normal size",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"]
      }
    },
    {
      name: "window_snap",
      description: "Snap window to screen edge (left half, right half, top, bottom, or corners)",
      inputSchema: {
        type: "object",
        properties: { 
          title: { type: "string" },
          position: { type: "string", enum: ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"] }
        },
        required: ["title", "position"]
      }
    },
    {
      name: "process_list",
      description: "List running processes with their names and PIDs",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "process_kill",
      description: "Kill a process by name or PID",
      inputSchema: {
        type: "object",
        properties: { 
          name: { type: "string", description: "Process name (optional)" },
          pid: { type: "number", description: "Process ID (optional)" }
        }
      }
    },
    // Phase 3: System Integration
    {
      name: "app_launch",
      description: "Launch an application by name or path",
      inputSchema: {
        type: "object",
        properties: { 
          app: { type: "string", description: "Application name or full path" }
        },
        required: ["app"]
      }
    },
    {
      name: "app_close",
      description: "Close an application by name (closes all windows of that app)",
      inputSchema: {
        type: "object",
        properties: { 
          app: { type: "string", description: "Application name (e.g., 'notepad', 'chrome')" }
        },
        required: ["app"]
      }
    },
    {
      name: "url_open",
      description: "Open a URL in the default browser",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"]
      }
    },
    {
      name: "file_open",
      description: "Open a file with its default application",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    {
      name: "folder_open",
      description: "Open a folder in the file manager",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    {
      name: "volume_get",
      description: "Get current system volume level (0-100)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "volume_set",
      description: "Set system volume level (0-100)",
      inputSchema: {
        type: "object",
        properties: { level: { type: "number", minimum: 0, maximum: 100 } },
        required: ["level"]
      }
    },
    {
      name: "volume_mute",
      description: "Mute or unmute system audio",
      inputSchema: {
        type: "object",
        properties: { mute: { type: "boolean", default: true } }
      }
    },
    {
      name: "notification_show",
      description: "Show a system notification",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          sound: { type: "boolean", default: false }
        },
        required: ["title", "message"]
      }
    },
    {
      name: "screen_text_read",
      description: "Read/OCR text from a screen region (experimental)",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" }
        },
        required: ["x", "y", "width", "height"]
      }
    },
    // Phase 5: Advanced Input
    {
      name: "mouse_smooth_move",
      description: "Move mouse smoothly along a path (human-like movement)",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          duration: { type: "number", default: 500, description: "Duration in ms" }
        },
        required: ["x", "y"]
      }
    },
    {
      name: "keyboard_type_slow",
      description: "Type text with human-like delays between keystrokes",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          delayMs: { type: "number", default: 50, description: "Delay between keys in ms" }
        },
        required: ["text"]
      }
    },
    {
      name: "mouse_move_relative",
      description: "Move mouse relative to current position",
      inputSchema: {
        type: "object",
        properties: {
          dx: { type: "number", description: "Horizontal offset" },
          dy: { type: "number", description: "Vertical offset" }
        },
        required: ["dx", "dy"]
      }
    },
    {
      name: "mouse_click_at",
      description: "Move to coordinates and click in one action",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "right", "middle"], default: "left" }
        },
        required: ["x", "y"]
      }
    },
    {
      name: "keyboard_combo",
      description: "Execute a sequence of keys with delays (e.g., for menu navigation)",
      inputSchema: {
        type: "object",
        properties: {
          keys: { type: "array", items: { type: "string" }, description: "Array of keys to press in sequence" },
          delayMs: { type: "number", default: 100, description: "Delay between keys" }
        },
        required: ["keys"]
      }
    },
    {
      name: "text_select_all",
      description: "Select all text (Ctrl+A) and optionally copy it",
      inputSchema: {
        type: "object",
        properties: {
          copy: { type: "boolean", default: false, description: "Also copy to clipboard" }
        }
      }
    },
    {
      name: "text_paste",
      description: "Paste from clipboard (Ctrl+V)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "text_copy",
      description: "Copy selected text to clipboard (Ctrl+C)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "text_cut",
      description: "Cut selected text to clipboard (Ctrl+X)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "text_undo",
      description: "Undo last action (Ctrl+Z)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "text_redo",
      description: "Redo last undone action (Ctrl+Y or Ctrl+Shift+Z)",
      inputSchema: { type: "object", properties: {} }
    },
    // Phase 6: Macro Recording
    {
      name: "macro_record_start",
      description: "Start recording user actions as a macro",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the macro" }
        },
        required: ["name"]
      }
    },
    {
      name: "macro_record_stop",
      description: "Stop recording and save the macro",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "macro_play",
      description: "Play a recorded macro by name",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the macro to play" },
          speed: { type: "number", default: 1.0, description: "Playback speed multiplier (0.5 = half speed, 2 = double speed)" }
        },
        required: ["name"]
      }
    },
    {
      name: "macro_list",
      description: "List all saved macros",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "macro_delete",
      description: "Delete a saved macro",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the macro to delete" }
        },
        required: ["name"]
      }
    },
    // Phase 9: Safety & Accessibility
    {
      name: "action_history",
      description: "Get history of recent actions performed (audit log)",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", default: 20, description: "Number of recent actions to return" }
        }
      }
    },
    {
      name: "action_undo_last",
      description: "Attempt to undo the last action (best effort - works for typing, clipboard)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "safe_zone_add",
      description: "Add a screen region where AI cannot click (e.g., system tray, important buttons)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for this safe zone" },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" }
        },
        required: ["name", "x", "y", "width", "height"]
      }
    },
    {
      name: "safe_zone_remove",
      description: "Remove a safe zone by name",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    },
    {
      name: "safe_zone_list",
      description: "List all defined safe zones",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "rate_limit_set",
      description: "Set maximum actions per second (safety throttle)",
      inputSchema: {
        type: "object",
        properties: {
          actionsPerSecond: { type: "number", default: 10, description: "Max actions per second (1-100)" }
        }
      }
    },
    // Phase 10: Platform-Specific (Windows)
    {
      name: "windows_search",
      description: "Search Windows using the Start menu search (Win+S)",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    },
    {
      name: "windows_run",
      description: "Open Windows Run dialog and execute command (Win+R)",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"]
      }
    },
    {
      name: "windows_lock",
      description: "Lock the Windows workstation (Win+L)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "windows_screenshot_snip",
      description: "Open Windows Snipping Tool (Win+Shift+S)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "windows_task_manager",
      description: "Open Windows Task Manager (Ctrl+Shift+Esc)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "windows_settings",
      description: "Open Windows Settings app",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "windows_action_center",
      description: "Open Windows Action Center / Notification panel (Win+A)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "windows_emoji_picker",
      description: "Open Windows emoji picker (Win+.)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "display_brightness_get",
      description: "Get current display brightness (0-100)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "display_brightness_set",
      description: "Set display brightness (0-100)",
      inputSchema: {
        type: "object",
        properties: { level: { type: "number", minimum: 0, maximum: 100 } },
        required: ["level"]
      }
    },
    // Phase 7: Multi-Device & Remote
    {
      name: "adb_devices",
      description: "List connected Android devices via ADB",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "adb_tap",
      description: "Tap on Android device screen at coordinates",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          device: { type: "string", description: "Device serial (optional if only one device)" }
        },
        required: ["x", "y"]
      }
    },
    {
      name: "adb_swipe",
      description: "Swipe on Android device screen",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number" },
          y1: { type: "number" },
          x2: { type: "number" },
          y2: { type: "number" },
          duration: { type: "number", default: 300, description: "Duration in ms" },
          device: { type: "string" }
        },
        required: ["x1", "y1", "x2", "y2"]
      }
    },
    {
      name: "adb_type",
      description: "Type text on Android device",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          device: { type: "string" }
        },
        required: ["text"]
      }
    },
    {
      name: "adb_key",
      description: "Press a key on Android device (home, back, menu, enter, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name: home, back, menu, enter, tab, space, del, power, volup, voldown" },
          device: { type: "string" }
        },
        required: ["key"]
      }
    },
    {
      name: "adb_screenshot",
      description: "Take screenshot of Android device",
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string" }
        }
      }
    },
    {
      name: "adb_shell",
      description: "Run shell command on Android device",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          device: { type: "string" }
        },
        required: ["command"]
      }
    },
    {
      name: "adb_app_launch",
      description: "Launch an app on Android device by package name",
      inputSchema: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name (e.g., com.android.chrome)" },
          device: { type: "string" }
        },
        required: ["package"]
      }
    },
    {
      name: "adb_app_list",
      description: "List installed apps on Android device",
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string" }
        }
      }
    },
    // Phase 7: Browser Automation (via Chrome DevTools Protocol)
    {
      name: "browser_open",
      description: "Open a URL in Chrome with remote debugging enabled",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          incognito: { type: "boolean", default: false }
        },
        required: ["url"]
      }
    },
    {
      name: "browser_tabs",
      description: "List open browser tabs (requires Chrome with --remote-debugging-port)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "browser_navigate",
      description: "Navigate current tab to a URL",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" }
        },
        required: ["url"]
      }
    },
    {
      name: "browser_click",
      description: "Click an element in the browser by CSS selector",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector (e.g., '#submit', '.btn-primary')" }
        },
        required: ["selector"]
      }
    },
    {
      name: "browser_type",
      description: "Type text into a browser input field",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for input field" },
          text: { type: "string" }
        },
        required: ["selector", "text"]
      }
    },
    {
      name: "browser_screenshot",
      description: "Take a screenshot of the browser page",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "browser_eval",
      description: "Execute JavaScript in the browser and return result",
      inputSchema: {
        type: "object",
        properties: {
          script: { type: "string", description: "JavaScript code to execute" }
        },
        required: ["script"]
      }
    },
    {
      name: "browser_scroll",
      description: "Scroll the browser page",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "top", "bottom"], default: "down" },
          amount: { type: "number", default: 300, description: "Pixels to scroll (for up/down)" }
        }
      }
    },
    {
      name: "browser_get_text",
      description: "Get text content of an element",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" }
        },
        required: ["selector"]
      }
    },
    {
      name: "browser_get_html",
      description: "Get HTML content of the page or an element",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector (optional, omit for full page)" }
        }
      }
    },
    {
      name: "browser_wait_for",
      description: "Wait for an element to appear on the page",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          timeoutMs: { type: "number", default: 10000 }
        },
        required: ["selector"]
      }
    },
    // Phase 7: Mesh Networking (Multi-Device)
    {
      name: "mesh_connect",
      description: "Connect to a remote mesh node to control another computer",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string", description: "Remote host IP or hostname" },
          port: { type: "number", default: 8080 },
          token: { type: "string", description: "Authentication token" }
        },
        required: ["host", "token"]
      }
    },
    {
      name: "mesh_disconnect",
      description: "Disconnect from a remote mesh node",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string" }
        },
        required: ["host"]
      }
    },
    {
      name: "mesh_list_connections",
      description: "List all active mesh connections to remote computers",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "mesh_list_tools",
      description: "List available tools on a remote mesh node",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string" }
        },
        required: ["host"]
      }
    },
    {
      name: "mesh_execute",
      description: "Execute a tool on a remote mesh node",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string", description: "Remote host to execute on" },
          tool: { type: "string", description: "Tool name to execute" },
          args: { type: "object", description: "Tool arguments" }
        },
        required: ["host", "tool"]
      }
    },
    {
      name: "mesh_screenshot",
      description: "Take a screenshot from a remote mesh node",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string" }
        },
        required: ["host"]
      }
    },
    // Phase 8: AI Enhancements
    {
      name: "screen_describe",
      description: "Get a structured description of what's visible on screen (windows, UI elements, text regions)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "screen_find_clickable",
      description: "Find all clickable elements on screen (buttons, links, inputs) with their locations",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "action_suggest",
      description: "Get AI suggestions for next actions based on current screen state and goal",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What you're trying to accomplish" }
        },
        required: ["goal"]
      }
    },
    {
      name: "error_recover",
      description: "Analyze a failed action and suggest recovery steps",
      inputSchema: {
        type: "object",
        properties: {
          failedAction: { type: "string", description: "The action that failed" },
          errorMessage: { type: "string", description: "The error message received" }
        },
        required: ["failedAction", "errorMessage"]
      }
    },
    {
      name: "screen_wait_for_change",
      description: "Wait until the screen content changes (useful after clicking)",
      inputSchema: {
        type: "object",
        properties: {
          timeoutMs: { type: "number", default: 5000 },
          threshold: { type: "number", default: 0.05, description: "Change threshold (0-1, lower = more sensitive)" }
        }
      }
    },
    {
      name: "screen_compare",
      description: "Compare current screen with a previous screenshot to detect changes",
      inputSchema: {
        type: "object",
        properties: {
          previousBase64: { type: "string", description: "Base64 PNG of previous screenshot" }
        },
        required: ["previousBase64"]
      }
    },
    {
      name: "context_save",
      description: "Save current context (screen, window, mouse position) for later reference",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for this context snapshot" }
        },
        required: ["name"]
      }
    },
    {
      name: "context_restore",
      description: "Restore a previously saved context (move mouse back, focus window)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" }
        },
        required: ["name"]
      }
    },
    {
      name: "context_list",
      description: "List all saved context snapshots",
      inputSchema: { type: "object", properties: {} }
    },
    // Phase 8: Advanced AI Enhancements
    {
      name: "screen_find_element",
      description: "Find UI element by natural language description (e.g., 'the red button', 'login field', 'submit'). Uses OCR + color analysis to locate elements.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Natural language description of what to find" },
          clickAfterFind: { type: "boolean", description: "Click the element after finding it" }
        },
        required: ["description"]
      }
    },
    {
      name: "skill_generalize",
      description: "Adapt a learned skill to work in a similar but different context (e.g., 'copy file' skill adapted for different file manager)",
      inputSchema: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "ID of the skill to generalize" },
          newContext: { type: "string", description: "Description of the new context to adapt to" }
        },
        required: ["skillId", "newContext"]
      }
    },
    {
      name: "suggest_proactive",
      description: "Analyze current screen and context to proactively suggest helpful actions the user might want to take",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Optional: user's current goal to focus suggestions" }
        }
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
      
      // Check safe zones
      const safeZone = isInSafeZone(x, y);
      if (safeZone) {
        return { content: [{ type: "text", text: `⛔ Cannot move to (${x}, ${y}) - inside safe zone "${safeZone.name}"` }] };
      }
      
      await mouse.setPosition({ x, y });
      logAction("mouse_move", { x, y }, true);
      return { content: [{ type: "text", text: `Mouse → (${x}, ${y})` }] };
    }

    case "mouse_click": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { button = "left", double = false } = args || {};
      
      // Check if current position is in safe zone
      const pos = await mouse.getPosition();
      const safeZone = isInSafeZone(pos.x, pos.y);
      if (safeZone) {
        return { content: [{ type: "text", text: `⛔ Cannot click at (${pos.x}, ${pos.y}) - inside safe zone "${safeZone.name}"` }] };
      }
      
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

    // Phase 1: Screen Region Tools
    case "screen_region_capture": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { x, y, width, height } = args as { x: number; y: number; width: number; height: number };
      
      // Capture full screen then crop with sharp
      const fullImg = await screenshot({ format: "png" });
      
      try {
        const sharp = (await import("sharp")).default;
        const cropped = await sharp(fullImg)
          .extract({ left: x, top: y, width, height })
          .png()
          .toBuffer();
        
        return {
          content: [{
            type: "image",
            data: cropped.toString("base64"),
            mimeType: "image/png"
          }]
        };
      } catch (e) {
        // Fallback if sharp fails
        return {
          content: [
            { type: "text", text: `Region: (${x}, ${y}) ${width}x${height} - crop failed, returning full screen` },
            { type: "image", data: fullImg.toString("base64"), mimeType: "image/png" }
          ]
        };
      }
    }

    case "screen_color_at": {
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { x, y } = args as { x: number; y: number };
      
      try {
        const color = await screen.colorAt({ x, y });
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              x, y,
              r: color.R,
              g: color.G,
              b: color.B,
              hex: `#${color.R.toString(16).padStart(2, '0')}${color.G.toString(16).padStart(2, '0')}${color.B.toString(16).padStart(2, '0')}`
            }, null, 2)
          }] 
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not get color at (${x}, ${y})` }] };
      }
    }

    case "screen_dominant_colors": {
      const { x, y, width, height, count = 5 } = args as { x: number; y: number; width: number; height: number; count?: number };
      
      try {
        const sharp = (await import("sharp")).default;
        const fullImg = await screenshot({ format: "png" });
        
        // Crop region
        const cropped = await sharp(fullImg)
          .extract({ left: x, top: y, width, height })
          .raw()
          .toBuffer({ resolveWithObject: true });
        
        // Count colors (simplified - group by rounding to nearest 16)
        const colorCounts: Record<string, { r: number; g: number; b: number; count: number }> = {};
        const pixels = cropped.data;
        const channels = cropped.info.channels;
        
        for (let i = 0; i < pixels.length; i += channels) {
          const r = Math.round(pixels[i] / 16) * 16;
          const g = Math.round(pixels[i + 1] / 16) * 16;
          const b = Math.round(pixels[i + 2] / 16) * 16;
          const key = `${r},${g},${b}`;
          
          if (!colorCounts[key]) {
            colorCounts[key] = { r, g, b, count: 0 };
          }
          colorCounts[key].count++;
        }
        
        // Sort by frequency and take top N
        const sorted = Object.values(colorCounts)
          .sort((a, b) => b.count - a.count)
          .slice(0, count);
        
        const totalPixels = (width * height);
        const dominantColors = sorted.map(c => ({
          r: c.r,
          g: c.g,
          b: c.b,
          hex: `#${c.r.toString(16).padStart(2, '0')}${c.g.toString(16).padStart(2, '0')}${c.b.toString(16).padStart(2, '0')}`,
          percentage: Math.round((c.count / totalPixels) * 100) + '%'
        }));
        
        return { content: [{ type: "text", text: JSON.stringify(dominantColors, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to analyze colors: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    // Phase 4: UI Accessibility (Windows UI Automation)
    case "ui_element_at": {
      const { x, y } = args as { x: number; y: number };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      if (os.platform() !== "win32") {
        return { content: [{ type: "text", text: "UI Automation only available on Windows" }] };
      }
      
      const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$point = New-Object System.Windows.Point(${x}, ${y})
$element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
if ($element) {
  @{
    Name = $element.Current.Name
    ControlType = $element.Current.ControlType.ProgrammaticName
    AutomationId = $element.Current.AutomationId
    ClassName = $element.Current.ClassName
    IsEnabled = $element.Current.IsEnabled
    BoundingRectangle = @{
      X = $element.Current.BoundingRectangle.X
      Y = $element.Current.BoundingRectangle.Y
      Width = $element.Current.BoundingRectangle.Width
      Height = $element.Current.BoundingRectangle.Height
    }
  } | ConvertTo-Json -Depth 3
}
`;
      
      return new Promise((resolve) => {
        exec(`powershell -command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
          if (error || !stdout.trim()) {
            resolve({ content: [{ type: "text", text: `No UI element found at (${x}, ${y})` }] });
          } else {
            try {
              const parsed = JSON.parse(stdout);
              resolve({ content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] });
            } catch {
              resolve({ content: [{ type: "text", text: stdout.trim() }] });
            }
          }
        });
      });
    }

    case "ui_element_tree": {
      const { depth = 3 } = args || {};
      const { exec } = await import("child_process");
      const os = await import("os");
      
      if (os.platform() !== "win32") {
        return { content: [{ type: "text", text: "UI Automation only available on Windows" }] };
      }
      
      const maxDepth = Math.min(5, Math.max(1, depth));
      const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Get-UITree($element, $currentDepth, $maxDepth) {
  if ($currentDepth -gt $maxDepth) { return $null }
  $result = @{
    Name = $element.Current.Name
    Type = $element.Current.ControlType.ProgrammaticName -replace 'ControlType.',''
    AutomationId = $element.Current.AutomationId
  }
  if ($currentDepth -lt $maxDepth) {
    $children = @()
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($element)
    $count = 0
    while ($child -and $count -lt 10) {
      $childResult = Get-UITree $child ($currentDepth + 1) $maxDepth
      if ($childResult) { $children += $childResult }
      $child = $walker.GetNextSibling($child)
      $count++
    }
    if ($children.Count -gt 0) { $result.Children = $children }
  }
  return $result
}
$root = [System.Windows.Automation.AutomationElement]::FocusedElement
if (-not $root) { $root = [System.Windows.Automation.AutomationElement]::RootElement }
$tree = Get-UITree $root 1 ${maxDepth}
$tree | ConvertTo-Json -Depth 10 -Compress
`;
      
      return new Promise((resolve) => {
        exec(`powershell -command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { maxBuffer: 1024 * 1024, timeout: 10000 }, (error, stdout) => {
          if (error || !stdout.trim()) {
            resolve({ content: [{ type: "text", text: "Could not get UI tree" }] });
          } else {
            try {
              const parsed = JSON.parse(stdout);
              resolve({ content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] });
            } catch {
              resolve({ content: [{ type: "text", text: stdout.trim().slice(0, 2000) }] });
            }
          }
        });
      });
    }

    case "ui_element_find": {
      const { name, type, automationId } = args as { name?: string; type?: string; automationId?: string };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      if (os.platform() !== "win32") {
        return { content: [{ type: "text", text: "UI Automation only available on Windows" }] };
      }
      
      if (!name && !type && !automationId) {
        return { content: [{ type: "text", text: "Provide at least one of: name, type, or automationId" }] };
      }
      
      const conditions: string[] = [];
      if (name) conditions.push(`$_.Current.Name -like '*${name}*'`);
      if (type) conditions.push(`$_.Current.ControlType.ProgrammaticName -like '*${type}*'`);
      if (automationId) conditions.push(`$_.Current.AutomationId -eq '${automationId}'`);
      
      const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = [System.Windows.Automation.Condition]::TrueCondition
$elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$results = @()
foreach ($el in $elements) {
  if (${conditions.join(' -and ')}) {
    $results += @{
      Name = $el.Current.Name
      Type = $el.Current.ControlType.ProgrammaticName -replace 'ControlType.',''
      AutomationId = $el.Current.AutomationId
      X = [int]$el.Current.BoundingRectangle.X
      Y = [int]$el.Current.BoundingRectangle.Y
      Width = [int]$el.Current.BoundingRectangle.Width
      Height = [int]$el.Current.BoundingRectangle.Height
    }
    if ($results.Count -ge 10) { break }
  }
}
$results | ConvertTo-Json -Depth 3
`;
      
      return new Promise((resolve) => {
        exec(`powershell -command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { maxBuffer: 1024 * 1024, timeout: 15000 }, (error, stdout) => {
          if (error || !stdout.trim()) {
            resolve({ content: [{ type: "text", text: "No matching UI elements found" }] });
          } else {
            try {
              const parsed = JSON.parse(stdout);
              const arr = Array.isArray(parsed) ? parsed : [parsed];
              resolve({ content: [{ type: "text", text: JSON.stringify(arr, null, 2) }] });
            } catch {
              resolve({ content: [{ type: "text", text: "No matching UI elements found" }] });
            }
          }
        });
      });
    }

    case "ui_element_click": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { name, automationId } = args as { name?: string; automationId?: string };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      if (os.platform() !== "win32") {
        return { content: [{ type: "text", text: "UI Automation only available on Windows" }] };
      }
      
      if (!name && !automationId) {
        return { content: [{ type: "text", text: "Provide either name or automationId" }] };
      }
      
      const condition = automationId 
        ? `$_.Current.AutomationId -eq '${automationId}'`
        : `$_.Current.Name -like '*${name}*'`;
      
      const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
foreach ($el in $elements) {
  if (${condition}) {
    $rect = $el.Current.BoundingRectangle
    @{
      Found = $true
      Name = $el.Current.Name
      X = [int]($rect.X + $rect.Width / 2)
      Y = [int]($rect.Y + $rect.Height / 2)
    } | ConvertTo-Json
    exit
  }
}
@{ Found = $false } | ConvertTo-Json
`;
      
      return new Promise((resolve) => {
        exec(`powershell -command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { maxBuffer: 1024 * 1024, timeout: 10000 }, async (error, stdout) => {
          if (error) {
            resolve({ content: [{ type: "text", text: "UI element search failed" }] });
            return;
          }
          
          try {
            const result = JSON.parse(stdout);
            if (!result.Found) {
              resolve({ content: [{ type: "text", text: `UI element not found: ${name || automationId}` }] });
              return;
            }
            
            // Check safe zone
            const safeZone = isInSafeZone(result.X, result.Y);
            if (safeZone) {
              resolve({ content: [{ type: "text", text: `⛔ Cannot click "${result.Name}" - inside safe zone "${safeZone.name}"` }] });
              return;
            }
            
            // Click the element
            await mouse.setPosition({ x: result.X, y: result.Y });
            await new Promise(r => setTimeout(r, 50));
            await mouse.leftClick();
            
            logAction("ui_element_click", { name: result.Name, x: result.X, y: result.Y }, true);
            resolve({ content: [{ type: "text", text: `Clicked "${result.Name}" at (${result.X}, ${result.Y})` }] });
          } catch {
            resolve({ content: [{ type: "text", text: "Failed to parse UI element result" }] });
          }
        });
      });
    }

    case "screen_find_text": {
      const { text, confidence = 70 } = args as { text: string; confidence?: number };
      
      try {
        const Tesseract = await import("tesseract.js");
        const img = await screenshot({ format: "png" });
        
        const result = await Tesseract.recognize(img, 'eng', {
          logger: () => {} // Suppress progress logs
        });
        
        // Find the text in OCR results
        const data = result.data as any;
        const words = data.words || [];
        const matches = words.filter((w: any) => 
          w.text.toLowerCase().includes(text.toLowerCase()) && 
          w.confidence >= confidence
        );
        
        if (matches.length === 0) {
          return { content: [{ type: "text", text: `Text "${text}" not found on screen` }] };
        }
        
        const locations = matches.map((m: any) => ({
          text: m.text,
          confidence: Math.round(m.confidence),
          x: m.bbox.x0,
          y: m.bbox.y0,
          width: m.bbox.x1 - m.bbox.x0,
          height: m.bbox.y1 - m.bbox.y0,
          centerX: Math.round((m.bbox.x0 + m.bbox.x1) / 2),
          centerY: Math.round((m.bbox.y0 + m.bbox.y1) / 2)
        }));
        
        return { content: [{ type: "text", text: JSON.stringify(locations, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `OCR failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "screen_wait_for_text": {
      const { text, timeoutMs = 10000, intervalMs = 500 } = args as { text: string; timeoutMs?: number; intervalMs?: number };
      
      const startTime = Date.now();
      const Tesseract = await import("tesseract.js");
      
      while (Date.now() - startTime < timeoutMs) {
        try {
          const img = await screenshot({ format: "png" });
          const result = await Tesseract.recognize(img, 'eng', {
            logger: () => {}
          });
          
          const data = result.data as any;
          const fullText = data.text.toLowerCase();
          if (fullText.includes(text.toLowerCase())) {
            // Find exact location
            const words = data.words || [];
            const match = words.find((w: any) => 
              w.text.toLowerCase().includes(text.toLowerCase())
            );
            
            if (match) {
              return { 
                content: [{ 
                  type: "text", 
                  text: JSON.stringify({
                    found: true,
                    text: match.text,
                    x: match.bbox.x0,
                    y: match.bbox.y0,
                    centerX: Math.round((match.bbox.x0 + match.bbox.x1) / 2),
                    centerY: Math.round((match.bbox.y0 + match.bbox.y1) / 2),
                    waitedMs: Date.now() - startTime
                  }, null, 2)
                }] 
              };
            }
          }
        } catch {}
        
        await new Promise(r => setTimeout(r, intervalMs));
      }
      
      return { content: [{ type: "text", text: `Timeout: "${text}" not found after ${timeoutMs}ms` }] };
    }

    case "screen_read_all_text": {
      const { x, y, width, height } = args as { x?: number; y?: number; width?: number; height?: number };
      
      try {
        const Tesseract = await import("tesseract.js");
        let img = await screenshot({ format: "png" });
        
        // Crop if region specified
        if (x !== undefined && y !== undefined && width && height) {
          const sharp = (await import("sharp")).default;
          img = await sharp(img)
            .extract({ left: x, top: y, width, height })
            .png()
            .toBuffer();
        }
        
        const result = await Tesseract.recognize(img, 'eng', {
          logger: () => {}
        });
        
        return { 
          content: [{ 
            type: "text", 
            text: result.data.text || "(no text detected)"
          }] 
        };
      } catch (e) {
        return { content: [{ type: "text", text: `OCR failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "screen_find_image": {
      const { templateBase64, threshold = 0.1 } = args as { templateBase64: string; threshold?: number };
      
      try {
        const sharp = (await import("sharp")).default;
        const { PNG } = await import("pngjs");
        const pixelmatch = (await import("pixelmatch")).default;
        
        // Get screenshot
        const screenImg = await screenshot({ format: "png" });
        const screenPng = PNG.sync.read(screenImg);
        
        // Decode template
        const templateBuffer = Buffer.from(templateBase64, 'base64');
        const templatePng = PNG.sync.read(templateBuffer);
        
        const tw = templatePng.width;
        const th = templatePng.height;
        const sw = screenPng.width;
        const sh = screenPng.height;
        
        // Slide template across screen (step by 4 pixels for speed)
        let bestMatch = { x: 0, y: 0, diff: Infinity };
        const step = 4;
        
        for (let sy = 0; sy <= sh - th; sy += step) {
          for (let sx = 0; sx <= sw - tw; sx += step) {
            // Extract region from screen
            const regionData = Buffer.alloc(tw * th * 4);
            for (let ry = 0; ry < th; ry++) {
              for (let rx = 0; rx < tw; rx++) {
                const srcIdx = ((sy + ry) * sw + (sx + rx)) * 4;
                const dstIdx = (ry * tw + rx) * 4;
                regionData[dstIdx] = screenPng.data[srcIdx];
                regionData[dstIdx + 1] = screenPng.data[srcIdx + 1];
                regionData[dstIdx + 2] = screenPng.data[srcIdx + 2];
                regionData[dstIdx + 3] = screenPng.data[srcIdx + 3];
              }
            }
            
            // Compare
            const diff = pixelmatch(regionData, templatePng.data, undefined, tw, th, { threshold: 0.1 });
            const diffRatio = diff / (tw * th);
            
            if (diffRatio < bestMatch.diff) {
              bestMatch = { x: sx, y: sy, diff: diffRatio };
            }
            
            // Early exit if perfect match
            if (diffRatio < 0.01) break;
          }
          if (bestMatch.diff < 0.01) break;
        }
        
        if (bestMatch.diff <= threshold) {
          return { 
            content: [{ 
              type: "text", 
              text: JSON.stringify({
                found: true,
                x: bestMatch.x,
                y: bestMatch.y,
                width: tw,
                height: th,
                centerX: bestMatch.x + Math.round(tw / 2),
                centerY: bestMatch.y + Math.round(th / 2),
                matchQuality: Math.round((1 - bestMatch.diff) * 100) + '%'
              }, null, 2)
            }] 
          };
        } else {
          return { content: [{ type: "text", text: `Image not found (best match: ${Math.round((1 - bestMatch.diff) * 100)}%)` }] };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Image search failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "screen_wait_for_image": {
      const { templateBase64, timeoutMs = 10000, intervalMs = 500, threshold = 0.1 } = args as { 
        templateBase64: string; timeoutMs?: number; intervalMs?: number; threshold?: number 
      };
      
      const startTime = Date.now();
      
      while (Date.now() - startTime < timeoutMs) {
        // Reuse screen_find_image logic
        const findResult = await (async () => {
          try {
            const sharp = (await import("sharp")).default;
            const { PNG } = await import("pngjs");
            const pixelmatch = (await import("pixelmatch")).default;
            
            const screenImg = await screenshot({ format: "png" });
            const screenPng = PNG.sync.read(screenImg);
            const templateBuffer = Buffer.from(templateBase64, 'base64');
            const templatePng = PNG.sync.read(templateBuffer);
            
            const tw = templatePng.width;
            const th = templatePng.height;
            const sw = screenPng.width;
            const sh = screenPng.height;
            
            let bestMatch = { x: 0, y: 0, diff: Infinity };
            const step = 8; // Faster for waiting
            
            for (let sy = 0; sy <= sh - th; sy += step) {
              for (let sx = 0; sx <= sw - tw; sx += step) {
                const regionData = Buffer.alloc(tw * th * 4);
                for (let ry = 0; ry < th; ry++) {
                  for (let rx = 0; rx < tw; rx++) {
                    const srcIdx = ((sy + ry) * sw + (sx + rx)) * 4;
                    const dstIdx = (ry * tw + rx) * 4;
                    regionData[dstIdx] = screenPng.data[srcIdx];
                    regionData[dstIdx + 1] = screenPng.data[srcIdx + 1];
                    regionData[dstIdx + 2] = screenPng.data[srcIdx + 2];
                    regionData[dstIdx + 3] = screenPng.data[srcIdx + 3];
                  }
                }
                
                const diff = pixelmatch(regionData, templatePng.data, undefined, tw, th, { threshold: 0.1 });
                const diffRatio = diff / (tw * th);
                
                if (diffRatio < bestMatch.diff) {
                  bestMatch = { x: sx, y: sy, diff: diffRatio };
                }
                if (diffRatio < 0.01) break;
              }
              if (bestMatch.diff < 0.01) break;
            }
            
            if (bestMatch.diff <= threshold) {
              return { found: true, x: bestMatch.x, y: bestMatch.y, tw, th };
            }
            return { found: false };
          } catch {
            return { found: false };
          }
        })();
        
        if (findResult.found) {
          return { 
            content: [{ 
              type: "text", 
              text: JSON.stringify({
                found: true,
                x: findResult.x,
                y: findResult.y,
                centerX: findResult.x! + Math.round(findResult.tw! / 2),
                centerY: findResult.y! + Math.round(findResult.th! / 2),
                waitedMs: Date.now() - startTime
              }, null, 2)
            }] 
          };
        }
        
        await new Promise(r => setTimeout(r, intervalMs));
      }
      
      return { content: [{ type: "text", text: `Timeout: image not found after ${timeoutMs}ms` }] };
    }

    case "screen_click_text": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { text, button = "left" } = args as { text: string; button?: string };
      
      try {
        const Tesseract = await import("tesseract.js");
        const img = await screenshot({ format: "png" });
        
        const result = await Tesseract.recognize(img, 'eng', {
          logger: () => {}
        });
        
        const data = result.data as any;
        const words = data.words || [];
        const match = words.find((w: any) => 
          w.text.toLowerCase().includes(text.toLowerCase()) && w.confidence >= 60
        );
        
        if (!match) {
          return { content: [{ type: "text", text: `Text "${text}" not found on screen` }] };
        }
        
        const centerX = Math.round((match.bbox.x0 + match.bbox.x1) / 2);
        const centerY = Math.round((match.bbox.y0 + match.bbox.y1) / 2);
        
        await mouse.setPosition({ x: centerX, y: centerY });
        await new Promise(r => setTimeout(r, 50));
        
        if (button === "right") {
          await mouse.rightClick();
        } else {
          await mouse.leftClick();
        }
        
        return { content: [{ type: "text", text: `Clicked "${match.text}" at (${centerX}, ${centerY})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    // Phase 2: Window Management
    case "window_focus": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { title } = args as { title: string };
      
      try {
        const windows = await getWindows();
        const target = await Promise.all(
          windows.map(async (win: any) => {
            try {
              const winTitle = await win.title;
              return { win, title: winTitle };
            } catch {
              return null;
            }
          })
        ).then(results => 
          results.find(r => r && r.title && r.title.toLowerCase().includes(title.toLowerCase()))
        );
        
        if (!target) {
          return { content: [{ type: "text", text: `Window not found: ${title}` }] };
        }
        
        await target.win.focus();
        return { content: [{ type: "text", text: `Focused window: ${target.title}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not focus window: ${title}` }] };
      }
    }

    case "window_resize": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { title, width, height } = args as { title: string; width: number; height: number };
      
      try {
        const windows = await getWindows();
        const target = await Promise.all(
          windows.map(async (win: any) => {
            try {
              const winTitle = await win.title;
              return { win, title: winTitle };
            } catch {
              return null;
            }
          })
        ).then(results => 
          results.find(r => r && r.title && r.title.toLowerCase().includes(title.toLowerCase()))
        );
        
        if (!target) {
          return { content: [{ type: "text", text: `Window not found: ${title}` }] };
        }
        
        await target.win.resize({ width, height });
        return { content: [{ type: "text", text: `Resized "${target.title}" to ${width}x${height}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not resize window: ${title}` }] };
      }
    }

    case "window_move": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { title, x, y } = args as { title: string; x: number; y: number };
      
      try {
        const windows = await getWindows();
        const target = await Promise.all(
          windows.map(async (win: any) => {
            try {
              const winTitle = await win.title;
              return { win, title: winTitle };
            } catch {
              return null;
            }
          })
        ).then(results => 
          results.find(r => r && r.title && r.title.toLowerCase().includes(title.toLowerCase()))
        );
        
        if (!target) {
          return { content: [{ type: "text", text: `Window not found: ${title}` }] };
        }
        
        await target.win.move({ x, y });
        return { content: [{ type: "text", text: `Moved "${target.title}" to (${x}, ${y})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not move window: ${title}` }] };
      }
    }

    case "window_minimize": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { title } = args as { title: string };
      
      try {
        const windows = await getWindows();
        const target = await Promise.all(
          windows.map(async (win: any) => {
            try {
              const winTitle = await win.title;
              return { win, title: winTitle };
            } catch {
              return null;
            }
          })
        ).then(results => 
          results.find(r => r && r.title && r.title.toLowerCase().includes(title.toLowerCase()))
        );
        
        if (!target) {
          return { content: [{ type: "text", text: `Window not found: ${title}` }] };
        }
        
        await target.win.minimize();
        return { content: [{ type: "text", text: `Minimized: ${target.title}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not minimize window: ${title}` }] };
      }
    }

    case "window_maximize": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { title } = args as { title: string };
      
      try {
        const windows = await getWindows();
        const target = await Promise.all(
          windows.map(async (win: any) => {
            try {
              const winTitle = await win.title;
              return { win, title: winTitle };
            } catch {
              return null;
            }
          })
        ).then(results => 
          results.find(r => r && r.title && r.title.toLowerCase().includes(title.toLowerCase()))
        );
        
        if (!target) {
          return { content: [{ type: "text", text: `Window not found: ${title}` }] };
        }
        
        await target.win.maximize();
        return { content: [{ type: "text", text: `Maximized: ${target.title}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not maximize window: ${title}` }] };
      }
    }

    case "window_close": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { title } = args as { title: string };
      
      try {
        const windows = await getWindows();
        const target = await Promise.all(
          windows.map(async (win: any) => {
            try {
              const winTitle = await win.title;
              return { win, title: winTitle };
            } catch {
              return null;
            }
          })
        ).then(results => 
          results.find(r => r && r.title && r.title.toLowerCase().includes(title.toLowerCase()))
        );
        
        if (!target) {
          return { content: [{ type: "text", text: `Window not found: ${title}` }] };
        }
        
        // Focus then Alt+F4
        await target.win.focus();
        await keyboard.pressKey(Key.LeftAlt);
        await keyboard.pressKey(Key.F4);
        await keyboard.releaseKey(Key.F4);
        await keyboard.releaseKey(Key.LeftAlt);
        
        return { content: [{ type: "text", text: `Closed: ${target.title}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not close window: ${title}` }] };
      }
    }

    case "window_restore": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { title } = args as { title: string };
      
      try {
        const windows = await getWindows();
        const target = await Promise.all(
          windows.map(async (win: any) => {
            try {
              const winTitle = await win.title;
              return { win, title: winTitle };
            } catch {
              return null;
            }
          })
        ).then(results => 
          results.find(r => r && r.title && r.title.toLowerCase().includes(title.toLowerCase()))
        );
        
        if (!target) {
          return { content: [{ type: "text", text: `Window not found: ${title}` }] };
        }
        
        // Focus and use Win+Down to restore from maximized, or click taskbar for minimized
        await target.win.focus();
        // Try restore method if available
        try {
          await target.win.restore?.();
        } catch {
          // Fallback: Win+Down restores maximized windows
          await keyboard.pressKey(Key.LeftSuper);
          await keyboard.pressKey(Key.Down);
          await keyboard.releaseKey(Key.Down);
          await keyboard.releaseKey(Key.LeftSuper);
        }
        
        return { content: [{ type: "text", text: `Restored: ${target.title}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not restore window: ${title}` }] };
      }
    }

    case "window_snap": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { title, position } = args as { title: string; position: string };
      
      try {
        const windows = await getWindows();
        const target = await Promise.all(
          windows.map(async (win: any) => {
            try {
              const winTitle = await win.title;
              return { win, title: winTitle };
            } catch {
              return null;
            }
          })
        ).then(results => 
          results.find(r => r && r.title && r.title.toLowerCase().includes(title.toLowerCase()))
        );
        
        if (!target) {
          return { content: [{ type: "text", text: `Window not found: ${title}` }] };
        }
        
        await target.win.focus();
        await new Promise(r => setTimeout(r, 100));
        
        // Use Windows snap shortcuts (Win + Arrow keys)
        const snapKeys: Record<string, any[]> = {
          'left': [Key.LeftSuper, Key.Left],
          'right': [Key.LeftSuper, Key.Right],
          'top': [Key.LeftSuper, Key.Up],
          'bottom': [Key.LeftSuper, Key.Down],
          'top-left': [Key.LeftSuper, Key.Left, Key.Up],
          'top-right': [Key.LeftSuper, Key.Right, Key.Up],
          'bottom-left': [Key.LeftSuper, Key.Left, Key.Down],
          'bottom-right': [Key.LeftSuper, Key.Right, Key.Down]
        };
        
        const keys = snapKeys[position];
        if (!keys) {
          return { content: [{ type: "text", text: `Invalid position: ${position}` }] };
        }
        
        // For corners, we need two snap operations
        if (position.includes('-')) {
          // First snap to side
          const side = position.split('-')[1]; // left or right
          await keyboard.pressKey(Key.LeftSuper);
          await keyboard.pressKey(side === 'left' ? Key.Left : Key.Right);
          await keyboard.releaseKey(side === 'left' ? Key.Left : Key.Right);
          await keyboard.releaseKey(Key.LeftSuper);
          await new Promise(r => setTimeout(r, 200));
          
          // Then snap to top or bottom
          const vert = position.split('-')[0]; // top or bottom
          await keyboard.pressKey(Key.LeftSuper);
          await keyboard.pressKey(vert === 'top' ? Key.Up : Key.Down);
          await keyboard.releaseKey(vert === 'top' ? Key.Up : Key.Down);
          await keyboard.releaseKey(Key.LeftSuper);
        } else {
          // Simple snap
          for (const k of keys) await keyboard.pressKey(k);
          for (const k of keys.reverse()) await keyboard.releaseKey(k);
        }
        
        return { content: [{ type: "text", text: `Snapped "${target.title}" to ${position}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not snap window: ${title}` }] };
      }
    }

    case "process_list": {
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        const platform = os.platform();
        let cmd: string;
        
        if (platform === "win32") {
          cmd = 'tasklist /fo csv /nh';
        } else {
          cmd = 'ps -eo pid,comm --no-headers';
        }
        
        exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
          if (error) {
            resolve({ content: [{ type: "text", text: "Could not list processes" }] });
            return;
          }
          
          let processes: { name: string; pid: number }[] = [];
          
          if (platform === "win32") {
            // Parse CSV: "name.exe","PID",...
            const lines = stdout.trim().split('\n');
            processes = lines.slice(0, 50).map(line => {
              const match = line.match(/"([^"]+)","(\d+)"/);
              if (match) {
                return { name: match[1], pid: parseInt(match[2]) };
              }
              return null;
            }).filter(Boolean) as any;
          } else {
            // Parse: PID COMMAND
            const lines = stdout.trim().split('\n');
            processes = lines.slice(0, 50).map(line => {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2) {
                return { pid: parseInt(parts[0]), name: parts[1] };
              }
              return null;
            }).filter(Boolean) as any;
          }
          
          resolve({ content: [{ type: "text", text: JSON.stringify(processes, null, 2) }] });
        });
      });
    }

    case "process_kill": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { name, pid } = args as { name?: string; pid?: number };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      if (!name && !pid) {
        return { content: [{ type: "text", text: "Provide either name or pid" }] };
      }
      
      return new Promise((resolve) => {
        const platform = os.platform();
        let cmd: string;
        
        if (platform === "win32") {
          cmd = pid ? `taskkill /PID ${pid} /F` : `taskkill /IM "${name}" /F`;
        } else {
          cmd = pid ? `kill -9 ${pid}` : `pkill -9 "${name}"`;
        }
        
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Failed to kill process: ${name || pid}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `Killed: ${name || pid}` }] });
          }
        });
      });
    }

    // Phase 3: System Integration
    case "app_launch": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { app } = args as { app: string };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        let cmd: string;
        const platform = os.platform();
        
        if (platform === "win32") {
          cmd = `start "" "${app}"`;
        } else if (platform === "darwin") {
          cmd = `open -a "${app}"`;
        } else {
          cmd = app; // Linux: just run the command
        }
        
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Failed to launch: ${app}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `Launched: ${app}` }] });
          }
        });
      });
    }

    case "app_close": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { app } = args as { app: string };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        let cmd: string;
        const platform = os.platform();
        
        if (platform === "win32") {
          // taskkill by image name
          cmd = `taskkill /IM "${app}.exe" /F 2>nul || taskkill /IM "${app}" /F`;
        } else if (platform === "darwin") {
          cmd = `osascript -e 'quit app "${app}"' || pkill -x "${app}"`;
        } else {
          cmd = `pkill -x "${app}"`;
        }
        
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Failed to close: ${app} (may not be running)` }] });
          } else {
            resolve({ content: [{ type: "text", text: `Closed: ${app}` }] });
          }
        });
      });
    }

    case "url_open": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { url } = args as { url: string };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        let cmd: string;
        const platform = os.platform();
        
        if (platform === "win32") {
          cmd = `start "" "${url}"`;
        } else if (platform === "darwin") {
          cmd = `open "${url}"`;
        } else {
          cmd = `xdg-open "${url}"`;
        }
        
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Failed to open URL: ${url}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `Opened: ${url}` }] });
          }
        });
      });
    }

    case "file_open": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { path } = args as { path: string };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        let cmd: string;
        const platform = os.platform();
        
        if (platform === "win32") {
          cmd = `start "" "${path}"`;
        } else if (platform === "darwin") {
          cmd = `open "${path}"`;
        } else {
          cmd = `xdg-open "${path}"`;
        }
        
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Failed to open file: ${path}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `Opened: ${path}` }] });
          }
        });
      });
    }

    case "folder_open": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { path } = args as { path: string };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        let cmd: string;
        const platform = os.platform();
        
        if (platform === "win32") {
          cmd = `explorer "${path}"`;
        } else if (platform === "darwin") {
          cmd = `open "${path}"`;
        } else {
          cmd = `xdg-open "${path}"`;
        }
        
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Failed to open folder: ${path}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `Opened folder: ${path}` }] });
          }
        });
      });
    }

    case "volume_get": {
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        const platform = os.platform();
        
        if (platform === "win32") {
          // PowerShell to get volume
          const cmd = `powershell -command "(Get-AudioDevice -PlaybackVolume).Volume"`;
          exec(cmd, (error, stdout) => {
            if (error) {
              // Fallback: try nircmd or just report unavailable
              resolve({ content: [{ type: "text", text: "Volume query not available (install AudioDeviceCmdlets)" }] });
            } else {
              resolve({ content: [{ type: "text", text: `Volume: ${stdout.trim()}%` }] });
            }
          });
        } else if (platform === "darwin") {
          exec("osascript -e 'output volume of (get volume settings)'", (error, stdout) => {
            if (error) {
              resolve({ content: [{ type: "text", text: "Could not get volume" }] });
            } else {
              resolve({ content: [{ type: "text", text: `Volume: ${stdout.trim()}%` }] });
            }
          });
        } else {
          exec("amixer get Master | grep -oP '\\d+%' | head -1", (error, stdout) => {
            if (error) {
              resolve({ content: [{ type: "text", text: "Could not get volume" }] });
            } else {
              resolve({ content: [{ type: "text", text: `Volume: ${stdout.trim()}` }] });
            }
          });
        }
      });
    }

    case "volume_set": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { level } = args as { level: number };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        const platform = os.platform();
        let cmd: string;
        
        if (platform === "win32") {
          // Use nircmd or PowerShell
          cmd = `powershell -command "(Get-AudioDevice -PlaybackVolume).Volume = ${level}"`;
        } else if (platform === "darwin") {
          cmd = `osascript -e "set volume output volume ${level}"`;
        } else {
          cmd = `amixer set Master ${level}%`;
        }
        
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Could not set volume to ${level}%` }] });
          } else {
            resolve({ content: [{ type: "text", text: `Volume set to ${level}%` }] });
          }
        });
      });
    }

    case "volume_mute": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { mute = true } = args || {};
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        const platform = os.platform();
        let cmd: string;
        
        if (platform === "win32") {
          // Use keyboard shortcut as fallback (volume mute key)
          cmd = `powershell -command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys([char]173)"`;
        } else if (platform === "darwin") {
          cmd = mute ? `osascript -e "set volume with output muted"` : `osascript -e "set volume without output muted"`;
        } else {
          cmd = `amixer set Master ${mute ? 'mute' : 'unmute'}`;
        }
        
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Could not ${mute ? 'mute' : 'unmute'}` }] });
          } else {
            resolve({ content: [{ type: "text", text: mute ? "Muted" : "Unmuted" }] });
          }
        });
      });
    }

    case "notification_show": {
      const { title, message, sound = false } = args as { title: string; message: string; sound?: boolean };
      
      try {
        const notifier = await import("node-notifier");
        
        return new Promise((resolve) => {
          notifier.default.notify({
            title,
            message,
            sound,
            wait: false
          }, (err: any) => {
            if (err) {
              resolve({ content: [{ type: "text", text: `Notification failed: ${err.message}` }] });
            } else {
              resolve({ content: [{ type: "text", text: `Notification shown: ${title}` }] });
            }
          });
        });
      } catch (e) {
        return { content: [{ type: "text", text: "Notifications not available" }] };
      }
    }

    case "screen_text_read": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { x, y, width, height } = args as { x: number; y: number; width: number; height: number };
      
      // Capture region and return as image - actual OCR would need tesseract.js
      // For now, capture the region so AI vision can read it
      const fullImg = await screenshot({ format: "png" });
      
      try {
        const sharp = (await import("sharp")).default;
        const cropped = await sharp(fullImg)
          .extract({ left: x, top: y, width, height })
          .png()
          .toBuffer();
        
        return {
          content: [
            { type: "text", text: `Captured region (${x}, ${y}) ${width}x${height} for text reading` },
            { type: "image", data: cropped.toString("base64"), mimeType: "image/png" }
          ]
        };
      } catch (e) {
        return { content: [{ type: "text", text: "Could not capture region for OCR" }] };
      }
    }

    // Phase 5: Advanced Input
    case "mouse_smooth_move": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { x, y, duration = 500 } = args as { x: number; y: number; duration?: number };
      const start = await mouse.getPosition();
      
      // Calculate steps for smooth movement
      const steps = Math.max(10, Math.floor(duration / 16)); // ~60fps
      const dx = (x - start.x) / steps;
      const dy = (y - start.y) / steps;
      const stepDelay = duration / steps;
      
      for (let i = 1; i <= steps; i++) {
        const nextX = Math.round(start.x + dx * i);
        const nextY = Math.round(start.y + dy * i);
        await mouse.setPosition({ x: nextX, y: nextY });
        await new Promise(r => setTimeout(r, stepDelay));
      }
      
      return { content: [{ type: "text", text: `Smoothly moved to (${x}, ${y}) in ${duration}ms` }] };
    }

    case "keyboard_type_slow": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { text, delayMs = 50 } = args as { text: string; delayMs?: number };
      
      for (const char of text) {
        await keyboard.type(char);
        await new Promise(r => setTimeout(r, delayMs + Math.random() * 30)); // Add slight randomness
      }
      
      return { content: [{ type: "text", text: `Slowly typed: "${text.slice(0, 30)}${text.length > 30 ? '...' : ''}"` }] };
    }

    case "mouse_move_relative": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { dx, dy } = args as { dx: number; dy: number };
      const pos = await mouse.getPosition();
      const newX = pos.x + dx;
      const newY = pos.y + dy;
      await mouse.setPosition({ x: newX, y: newY });
      
      return { content: [{ type: "text", text: `Moved by (${dx}, ${dy}) to (${newX}, ${newY})` }] };
    }

    case "mouse_click_at": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { x, y, button = "left" } = args as { x: number; y: number; button?: string };
      
      await mouse.setPosition({ x, y });
      await new Promise(r => setTimeout(r, 50)); // Small delay for stability
      
      if (button === "right") {
        await mouse.rightClick();
      } else if (button === "middle") {
        await mouse.click(Button.MIDDLE);
      } else {
        await mouse.leftClick();
      }
      
      return { content: [{ type: "text", text: `Clicked ${button} at (${x}, ${y})` }] };
    }

    case "keyboard_combo": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { keys, delayMs = 100 } = args as { keys: string[]; delayMs?: number };
      
      const keyMap: Record<string, any> = {
        'enter': Key.Return, 'return': Key.Return, 'tab': Key.Tab,
        'escape': Key.Escape, 'esc': Key.Escape, 'space': Key.Space,
        'backspace': Key.Backspace, 'delete': Key.Delete,
        'up': Key.Up, 'down': Key.Down, 'left': Key.Left, 'right': Key.Right,
        'home': Key.Home, 'end': Key.End, 'pageup': Key.PageUp, 'pagedown': Key.PageDown,
        'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4,
        'f5': Key.F5, 'f6': Key.F6, 'f7': Key.F7, 'f8': Key.F8,
        'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12
      };
      
      for (const keyName of keys) {
        const k = keyMap[keyName.toLowerCase()];
        if (k) {
          await keyboard.pressKey(k);
          await keyboard.releaseKey(k);
        }
        await new Promise(r => setTimeout(r, delayMs));
      }
      
      return { content: [{ type: "text", text: `Pressed sequence: ${keys.join(' → ')}` }] };
    }

    case "text_select_all": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { copy = false } = args || {};
      
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.A);
      await keyboard.releaseKey(Key.A);
      await keyboard.releaseKey(Key.LeftControl);
      
      if (copy) {
        await new Promise(r => setTimeout(r, 50));
        await keyboard.pressKey(Key.LeftControl);
        await keyboard.pressKey(Key.C);
        await keyboard.releaseKey(Key.C);
        await keyboard.releaseKey(Key.LeftControl);
        return { content: [{ type: "text", text: "Selected all and copied" }] };
      }
      
      return { content: [{ type: "text", text: "Selected all" }] };
    }

    case "text_paste": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.V);
      await keyboard.releaseKey(Key.V);
      await keyboard.releaseKey(Key.LeftControl);
      
      return { content: [{ type: "text", text: "Pasted from clipboard" }] };
    }

    case "text_copy": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.C);
      await keyboard.releaseKey(Key.C);
      await keyboard.releaseKey(Key.LeftControl);
      
      return { content: [{ type: "text", text: "Copied to clipboard" }] };
    }

    case "text_cut": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.X);
      await keyboard.releaseKey(Key.X);
      await keyboard.releaseKey(Key.LeftControl);
      
      return { content: [{ type: "text", text: "Cut to clipboard" }] };
    }

    case "text_undo": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.Z);
      await keyboard.releaseKey(Key.Z);
      await keyboard.releaseKey(Key.LeftControl);
      
      return { content: [{ type: "text", text: "Undo" }] };
    }

    case "text_redo": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.Y);
      await keyboard.releaseKey(Key.Y);
      await keyboard.releaseKey(Key.LeftControl);
      
      return { content: [{ type: "text", text: "Redo" }] };
    }

    // Phase 6: Macro Recording
    case "macro_record_start": {
      const { name: macroName } = args as { name: string };
      
      if (macroState.recording) {
        return { content: [{ type: "text", text: `Already recording macro: ${macroState.currentMacro}` }] };
      }
      
      macroState.recording = true;
      macroState.currentMacro = macroName;
      macroState.actions = [];
      macroState.startTime = Date.now();
      
      return { content: [{ type: "text", text: `🔴 Recording macro: ${macroName}` }] };
    }

    case "macro_record_stop": {
      if (!macroState.recording) {
        return { content: [{ type: "text", text: "Not currently recording" }] };
      }
      
      const macro: Macro = {
        name: macroState.currentMacro!,
        actions: macroState.actions,
        createdAt: Date.now()
      };
      
      macroState.macros.set(macro.name, macro);
      
      const actionCount = macroState.actions.length;
      macroState.recording = false;
      macroState.currentMacro = null;
      macroState.actions = [];
      
      return { content: [{ type: "text", text: `⏹️ Saved macro "${macro.name}" with ${actionCount} actions` }] };
    }

    case "macro_play": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { name: macroName, speed = 1.0 } = args as { name: string; speed?: number };
      
      const macro = macroState.macros.get(macroName);
      if (!macro) {
        return { content: [{ type: "text", text: `Macro not found: ${macroName}` }] };
      }
      
      // Play back actions with timing
      let lastTimestamp = 0;
      for (const action of macro.actions) {
        // Wait for relative timing (adjusted by speed)
        if (lastTimestamp > 0) {
          const delay = (action.timestamp - lastTimestamp) / speed;
          if (delay > 0) {
            await new Promise(r => setTimeout(r, delay));
          }
        }
        lastTimestamp = action.timestamp;
        
        // Execute action
        switch (action.type) {
          case 'mouse_move':
            await mouse.setPosition({ x: action.params.x, y: action.params.y });
            break;
          case 'mouse_click':
            if (action.params.button === 'right') {
              await mouse.rightClick();
            } else {
              await mouse.leftClick();
            }
            break;
          case 'keyboard_type':
            await keyboard.type(action.params.text);
            break;
          case 'keyboard_shortcut':
            // Simplified - just type the shortcut
            const keys = action.params.keys.toLowerCase().split('+');
            const keyMap: Record<string, any> = {
              'ctrl': Key.LeftControl, 'alt': Key.LeftAlt, 'shift': Key.LeftShift,
              'enter': Key.Return, 'tab': Key.Tab, 'escape': Key.Escape
            };
            const keyList = keys.map((k: string) => keyMap[k] || Key[k.toUpperCase() as keyof typeof Key]).filter(Boolean);
            for (const k of keyList) await keyboard.pressKey(k);
            for (const k of keyList.reverse()) await keyboard.releaseKey(k);
            break;
          case 'wait':
            await new Promise(r => setTimeout(r, action.params.ms / speed));
            break;
        }
      }
      
      return { content: [{ type: "text", text: `▶️ Played macro "${macroName}" (${macro.actions.length} actions)` }] };
    }

    case "macro_list": {
      const macros = Array.from(macroState.macros.values());
      
      if (macros.length === 0) {
        return { content: [{ type: "text", text: "No macros recorded yet" }] };
      }
      
      const summary = macros.map(m => ({
        name: m.name,
        actions: m.actions.length,
        created: new Date(m.createdAt).toLocaleString()
      }));
      
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    case "macro_delete": {
      const { name: macroName } = args as { name: string };
      
      if (!macroState.macros.has(macroName)) {
        return { content: [{ type: "text", text: `Macro not found: ${macroName}` }] };
      }
      
      macroState.macros.delete(macroName);
      return { content: [{ type: "text", text: `🗑️ Deleted macro: ${macroName}` }] };
    }

    // Phase 9: Safety & Accessibility
    case "action_history": {
      const { limit = 20 } = args || {};
      const history = safetyState.actionHistory.slice(-limit).reverse();
      
      if (history.length === 0) {
        return { content: [{ type: "text", text: "No actions recorded yet" }] };
      }
      
      const formatted = history.map(h => ({
        tool: h.tool,
        params: h.params,
        time: new Date(h.timestamp).toLocaleTimeString(),
        success: h.success
      }));
      
      return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }] };
    }

    case "action_undo_last": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      // Simple undo - just send Ctrl+Z
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.Z);
      await keyboard.releaseKey(Key.Z);
      await keyboard.releaseKey(Key.LeftControl);
      
      return { content: [{ type: "text", text: "Sent undo command (Ctrl+Z)" }] };
    }

    case "safe_zone_add": {
      const { name: zoneName, x, y, width, height } = args as { name: string; x: number; y: number; width: number; height: number };
      
      safetyState.safeZones.set(zoneName, { name: zoneName, x, y, width, height });
      return { content: [{ type: "text", text: `🛡️ Added safe zone "${zoneName}" at (${x}, ${y}) ${width}x${height}` }] };
    }

    case "safe_zone_remove": {
      const { name: zoneName } = args as { name: string };
      
      if (!safetyState.safeZones.has(zoneName)) {
        return { content: [{ type: "text", text: `Safe zone not found: ${zoneName}` }] };
      }
      
      safetyState.safeZones.delete(zoneName);
      return { content: [{ type: "text", text: `Removed safe zone: ${zoneName}` }] };
    }

    case "safe_zone_list": {
      const zones = Array.from(safetyState.safeZones.values());
      
      if (zones.length === 0) {
        return { content: [{ type: "text", text: "No safe zones defined" }] };
      }
      
      return { content: [{ type: "text", text: JSON.stringify(zones, null, 2) }] };
    }

    case "rate_limit_set": {
      const { actionsPerSecond = 10 } = args || {};
      safetyState.rateLimit = Math.max(1, Math.min(100, actionsPerSecond));
      return { content: [{ type: "text", text: `Rate limit set to ${safetyState.rateLimit} actions/second` }] };
    }

    // Phase 10: Windows-Specific
    case "windows_search": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { query } = args as { query: string };
      
      // Win+S to open search
      await keyboard.pressKey(Key.LeftSuper);
      await keyboard.pressKey(Key.S);
      await keyboard.releaseKey(Key.S);
      await keyboard.releaseKey(Key.LeftSuper);
      
      await new Promise(r => setTimeout(r, 500));
      await keyboard.type(query);
      
      return { content: [{ type: "text", text: `Opened Windows Search with: ${query}` }] };
    }

    case "windows_run": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      const { command } = args as { command: string };
      
      // Win+R to open Run dialog
      await keyboard.pressKey(Key.LeftSuper);
      await keyboard.pressKey(Key.R);
      await keyboard.releaseKey(Key.R);
      await keyboard.releaseKey(Key.LeftSuper);
      
      await new Promise(r => setTimeout(r, 300));
      await keyboard.type(command);
      await new Promise(r => setTimeout(r, 100));
      await keyboard.pressKey(Key.Return);
      await keyboard.releaseKey(Key.Return);
      
      return { content: [{ type: "text", text: `Executed via Run: ${command}` }] };
    }

    case "windows_lock": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftSuper);
      await keyboard.pressKey(Key.L);
      await keyboard.releaseKey(Key.L);
      await keyboard.releaseKey(Key.LeftSuper);
      
      return { content: [{ type: "text", text: "🔒 Locked workstation" }] };
    }

    case "windows_screenshot_snip": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftSuper);
      await keyboard.pressKey(Key.LeftShift);
      await keyboard.pressKey(Key.S);
      await keyboard.releaseKey(Key.S);
      await keyboard.releaseKey(Key.LeftShift);
      await keyboard.releaseKey(Key.LeftSuper);
      
      return { content: [{ type: "text", text: "📷 Opened Snipping Tool" }] };
    }

    case "windows_task_manager": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.LeftShift);
      await keyboard.pressKey(Key.Escape);
      await keyboard.releaseKey(Key.Escape);
      await keyboard.releaseKey(Key.LeftShift);
      await keyboard.releaseKey(Key.LeftControl);
      
      return { content: [{ type: "text", text: "Opened Task Manager" }] };
    }

    case "windows_settings": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftSuper);
      await keyboard.pressKey(Key.I);
      await keyboard.releaseKey(Key.I);
      await keyboard.releaseKey(Key.LeftSuper);
      
      return { content: [{ type: "text", text: "⚙️ Opened Windows Settings" }] };
    }

    case "windows_action_center": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftSuper);
      await keyboard.pressKey(Key.A);
      await keyboard.releaseKey(Key.A);
      await keyboard.releaseKey(Key.LeftSuper);
      
      return { content: [{ type: "text", text: "Opened Action Center" }] };
    }

    case "windows_emoji_picker": {
      if (!state.enabled) throw new Error("Control not enabled");
      if (!robotAvailable) throw new Error("nut-js not available");
      
      await keyboard.pressKey(Key.LeftSuper);
      await keyboard.pressKey(Key.Period);
      await keyboard.releaseKey(Key.Period);
      await keyboard.releaseKey(Key.LeftSuper);
      
      return { content: [{ type: "text", text: "😀 Opened Emoji Picker" }] };
    }

    case "display_brightness_get": {
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        if (os.platform() !== "win32") {
          resolve({ content: [{ type: "text", text: "Brightness control only available on Windows" }] });
          return;
        }
        
        const cmd = `powershell -command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness"`;
        exec(cmd, (error, stdout) => {
          if (error) {
            resolve({ content: [{ type: "text", text: "Could not get brightness (may not be supported on desktop monitors)" }] });
          } else {
            resolve({ content: [{ type: "text", text: `Brightness: ${stdout.trim()}%` }] });
          }
        });
      });
    }

    case "display_brightness_set": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { level } = args as { level: number };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        if (os.platform() !== "win32") {
          resolve({ content: [{ type: "text", text: "Brightness control only available on Windows" }] });
          return;
        }
        
        const cmd = `powershell -command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${level})"`;
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: "Could not set brightness (may not be supported on desktop monitors)" }] });
          } else {
            resolve({ content: [{ type: "text", text: `Brightness set to ${level}%` }] });
          }
        });
      });
    }

    // Phase 7: ADB (Android Debug Bridge)
    case "adb_devices": {
      const { exec } = await import("child_process");
      
      return new Promise((resolve) => {
        exec("adb devices -l", (error, stdout) => {
          if (error) {
            resolve({ content: [{ type: "text", text: "ADB not found. Install Android SDK Platform Tools." }] });
            return;
          }
          
          const lines = stdout.trim().split('\n').slice(1);
          const devices = lines
            .filter(l => l.trim() && !l.includes('offline'))
            .map(l => {
              const parts = l.split(/\s+/);
              const serial = parts[0];
              const model = l.match(/model:(\S+)/)?.[1] || 'unknown';
              return { serial, model };
            });
          
          if (devices.length === 0) {
            resolve({ content: [{ type: "text", text: "No Android devices connected" }] });
          } else {
            resolve({ content: [{ type: "text", text: JSON.stringify(devices, null, 2) }] });
          }
        });
      });
    }

    case "adb_tap": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { x, y, device } = args as { x: number; y: number; device?: string };
      const { exec } = await import("child_process");
      
      const deviceArg = device ? `-s ${device}` : '';
      
      return new Promise((resolve) => {
        exec(`adb ${deviceArg} shell input tap ${x} ${y}`, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `ADB tap failed: ${error.message}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `📱 Tapped (${x}, ${y})` }] });
          }
        });
      });
    }

    case "adb_swipe": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { x1, y1, x2, y2, duration = 300, device } = args as { x1: number; y1: number; x2: number; y2: number; duration?: number; device?: string };
      const { exec } = await import("child_process");
      
      const deviceArg = device ? `-s ${device}` : '';
      
      return new Promise((resolve) => {
        exec(`adb ${deviceArg} shell input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `ADB swipe failed: ${error.message}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `📱 Swiped (${x1},${y1}) → (${x2},${y2})` }] });
          }
        });
      });
    }

    case "adb_type": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { text, device } = args as { text: string; device?: string };
      const { exec } = await import("child_process");
      
      const deviceArg = device ? `-s ${device}` : '';
      // Escape special characters for shell
      const escaped = text.replace(/(['"\\$`!])/g, '\\$1').replace(/ /g, '%s');
      
      return new Promise((resolve) => {
        exec(`adb ${deviceArg} shell input text "${escaped}"`, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `ADB type failed: ${error.message}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `📱 Typed: "${text.slice(0, 30)}${text.length > 30 ? '...' : ''}"` }] });
          }
        });
      });
    }

    case "adb_key": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { key, device } = args as { key: string; device?: string };
      const { exec } = await import("child_process");
      
      const keyMap: Record<string, number> = {
        'home': 3, 'back': 4, 'menu': 82, 'enter': 66, 'tab': 61,
        'space': 62, 'del': 67, 'delete': 67, 'power': 26,
        'volup': 24, 'voldown': 25, 'mute': 164,
        'camera': 27, 'search': 84, 'play': 126, 'pause': 127,
        'up': 19, 'down': 20, 'left': 21, 'right': 22
      };
      
      const keyCode = keyMap[key.toLowerCase()];
      if (!keyCode) {
        return { content: [{ type: "text", text: `Unknown key: ${key}. Use: home, back, menu, enter, tab, space, del, power, volup, voldown, up, down, left, right` }] };
      }
      
      const deviceArg = device ? `-s ${device}` : '';
      
      return new Promise((resolve) => {
        exec(`adb ${deviceArg} shell input keyevent ${keyCode}`, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `ADB key failed: ${error.message}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `📱 Pressed: ${key}` }] });
          }
        });
      });
    }

    case "adb_screenshot": {
      const { device } = args as { device?: string };
      const { exec } = await import("child_process");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const { readFile: fsReadFile, unlink } = await import("fs/promises");
      
      const deviceArg = device ? `-s ${device}` : '';
      const tmpFile = join(tmpdir(), `adb_screenshot_${Date.now()}.png`);
      
      return new Promise((resolve) => {
        // Capture to device, pull to local, then read
        exec(`adb ${deviceArg} shell screencap -p /sdcard/screenshot.png && adb ${deviceArg} pull /sdcard/screenshot.png "${tmpFile}"`, async (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `ADB screenshot failed: ${error.message}` }] });
            return;
          }
          
          try {
            const imgData = await fsReadFile(tmpFile);
            await unlink(tmpFile).catch(() => {});
            exec(`adb ${deviceArg} shell rm /sdcard/screenshot.png`, () => {});
            
            resolve({
              content: [{
                type: "image",
                data: imgData.toString("base64"),
                mimeType: "image/png"
              }]
            });
          } catch (e) {
            resolve({ content: [{ type: "text", text: "Failed to read screenshot" }] });
          }
        });
      });
    }

    case "adb_shell": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { command, device } = args as { command: string; device?: string };
      const { exec } = await import("child_process");
      
      const deviceArg = device ? `-s ${device}` : '';
      
      return new Promise((resolve) => {
        exec(`adb ${deviceArg} shell ${command}`, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Error: ${stderr || error.message}` }] });
          } else {
            resolve({ content: [{ type: "text", text: stdout.trim() || "(no output)" }] });
          }
        });
      });
    }

    case "adb_app_launch": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { package: pkg, device } = args as { package: string; device?: string };
      const { exec } = await import("child_process");
      
      const deviceArg = device ? `-s ${device}` : '';
      
      return new Promise((resolve) => {
        // Get the main activity and launch it
        exec(`adb ${deviceArg} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Failed to launch ${pkg}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `📱 Launched: ${pkg}` }] });
          }
        });
      });
    }

    case "adb_app_list": {
      const { device } = args as { device?: string };
      const { exec } = await import("child_process");
      
      const deviceArg = device ? `-s ${device}` : '';
      
      return new Promise((resolve) => {
        exec(`adb ${deviceArg} shell pm list packages -3`, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Failed to list apps: ${error.message}` }] });
            return;
          }
          
          const packages = stdout.trim().split('\n')
            .map(l => l.replace('package:', '').trim())
            .filter(Boolean)
            .sort();
          
          resolve({ content: [{ type: "text", text: JSON.stringify(packages, null, 2) }] });
        });
      });
    }

    // Phase 7: Browser Automation
    case "browser_open": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { url, incognito = false } = args as { url: string; incognito?: boolean };
      const { exec } = await import("child_process");
      const os = await import("os");
      
      return new Promise((resolve) => {
        let cmd: string;
        const platform = os.platform();
        const debugFlag = `--remote-debugging-port=${CDP_PORT}`;
        const incognitoFlag = incognito ? '--incognito' : '';
        
        if (platform === "win32") {
          cmd = `start chrome ${debugFlag} ${incognitoFlag} "${url}"`;
        } else if (platform === "darwin") {
          cmd = `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome ${debugFlag} ${incognitoFlag} "${url}" &`;
        } else {
          cmd = `google-chrome ${debugFlag} ${incognitoFlag} "${url}" &`;
        }
        
        exec(cmd, (error) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `Failed to open browser: ${error.message}` }] });
          } else {
            resolve({ content: [{ type: "text", text: `🌐 Opened Chrome with debugging on port ${CDP_PORT}: ${url}` }] });
          }
        });
      });
    }

    case "browser_tabs": {
      try {
        const response = await fetch(`http://localhost:${CDP_PORT}/json`);
        const tabs = await response.json() as any[];
        
        const tabInfo = tabs
          .filter((t: any) => t.type === 'page')
          .map((t: any) => ({
            id: t.id,
            title: t.title,
            url: t.url
          }));
        
        return { content: [{ type: "text", text: JSON.stringify(tabInfo, null, 2) }] };
      } catch {
        return { content: [{ type: "text", text: "No browser connected. Launch Chrome with --remote-debugging-port=9222" }] };
      }
    }

    case "browser_navigate": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { url } = args as { url: string };
      
      try {
        await sendCdpCommand('Page.navigate', { url });
        return { content: [{ type: "text", text: `🌐 Navigated to: ${url}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Navigation failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "browser_click": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { selector } = args as { selector: string };
      
      try {
        // Find element and click it
        const script = `
          const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
          if (el) {
            el.click();
            'clicked';
          } else {
            'not found';
          }
        `;
        const result = await sendCdpCommand('Runtime.evaluate', { expression: script });
        
        if (result.result?.value === 'clicked') {
          return { content: [{ type: "text", text: `🖱️ Clicked: ${selector}` }] };
        } else {
          return { content: [{ type: "text", text: `Element not found: ${selector}` }] };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Click failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "browser_type": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { selector, text } = args as { selector: string; text: string };
      
      try {
        const script = `
          const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
          if (el) {
            el.focus();
            el.value = '${text.replace(/'/g, "\\'")}';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            'typed';
          } else {
            'not found';
          }
        `;
        const result = await sendCdpCommand('Runtime.evaluate', { expression: script });
        
        if (result.result?.value === 'typed') {
          return { content: [{ type: "text", text: `⌨️ Typed into ${selector}` }] };
        } else {
          return { content: [{ type: "text", text: `Element not found: ${selector}` }] };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Type failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "browser_screenshot": {
      try {
        const result = await sendCdpCommand('Page.captureScreenshot', { format: 'png' });
        
        return {
          content: [{
            type: "image",
            data: result.data,
            mimeType: "image/png"
          }]
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Screenshot failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "browser_eval": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { script } = args as { script: string };
      
      try {
        const result = await sendCdpCommand('Runtime.evaluate', { 
          expression: script,
          returnByValue: true
        });
        
        if (result.exceptionDetails) {
          return { content: [{ type: "text", text: `Error: ${result.exceptionDetails.text}` }] };
        }
        
        return { content: [{ type: "text", text: JSON.stringify(result.result?.value, null, 2) || 'undefined' }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Eval failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "browser_scroll": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { direction = "down", amount = 300 } = args || {};
      
      try {
        let script: string;
        switch (direction) {
          case "up":
            script = `window.scrollBy(0, -${amount})`;
            break;
          case "down":
            script = `window.scrollBy(0, ${amount})`;
            break;
          case "top":
            script = `window.scrollTo(0, 0)`;
            break;
          case "bottom":
            script = `window.scrollTo(0, document.body.scrollHeight)`;
            break;
          default:
            script = `window.scrollBy(0, ${amount})`;
        }
        
        await sendCdpCommand('Runtime.evaluate', { expression: script });
        return { content: [{ type: "text", text: `📜 Scrolled ${direction}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Scroll failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "browser_get_text": {
      const { selector } = args as { selector: string };
      
      try {
        const script = `
          const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
          el ? el.textContent : null;
        `;
        const result = await sendCdpCommand('Runtime.evaluate', { expression: script });
        
        if (result.result?.value !== null) {
          return { content: [{ type: "text", text: result.result.value }] };
        } else {
          return { content: [{ type: "text", text: `Element not found: ${selector}` }] };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "browser_get_html": {
      const { selector } = args as { selector?: string };
      
      try {
        const script = selector 
          ? `document.querySelector('${selector.replace(/'/g, "\\'")}')?.outerHTML || null`
          : `document.documentElement.outerHTML`;
        
        const result = await sendCdpCommand('Runtime.evaluate', { expression: script });
        
        if (result.result?.value) {
          // Truncate if too long
          const html = result.result.value;
          const truncated = html.length > 10000 ? html.slice(0, 10000) + '\n... (truncated)' : html;
          return { content: [{ type: "text", text: truncated }] };
        } else {
          return { content: [{ type: "text", text: `Element not found: ${selector}` }] };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "browser_wait_for": {
      const { selector, timeoutMs = 10000 } = args as { selector: string; timeoutMs?: number };
      
      const startTime = Date.now();
      
      while (Date.now() - startTime < timeoutMs) {
        try {
          const script = `!!document.querySelector('${selector.replace(/'/g, "\\'")}')`;
          const result = await sendCdpCommand('Runtime.evaluate', { expression: script });
          
          if (result.result?.value === true) {
            return { content: [{ type: "text", text: `✅ Found: ${selector} (waited ${Date.now() - startTime}ms)` }] };
          }
        } catch {}
        
        await new Promise(r => setTimeout(r, 200));
      }
      
      return { content: [{ type: "text", text: `Timeout: ${selector} not found after ${timeoutMs}ms` }] };
    }

    // Phase 7: Mesh Networking
    case "mesh_connect": {
      const { host, port = 8080, token } = args as { host: string; port?: number; token: string };
      
      const key = `${host}:${port}`;
      
      if (meshConnections.has(key)) {
        return { content: [{ type: "text", text: `Already connected to ${key}` }] };
      }
      
      try {
        const client = new MeshClient(host, port, token);
        await client.connect();
        meshConnections.set(key, client);
        
        // Set up disconnect handler
        client.onClose(() => {
          meshConnections.delete(key);
          console.log(`🔌 Mesh connection to ${key} closed`);
        });
        
        return { content: [{ type: "text", text: `🌐 Connected to mesh node: ${key}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to connect to ${key}: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "mesh_disconnect": {
      const { host } = args as { host: string };
      
      // Find connection by host (with or without port)
      let key = host;
      if (!meshConnections.has(key)) {
        key = `${host}:8080`;
      }
      
      const client = meshConnections.get(key);
      if (!client) {
        return { content: [{ type: "text", text: `Not connected to ${host}` }] };
      }
      
      client.disconnect();
      meshConnections.delete(key);
      
      return { content: [{ type: "text", text: `🔌 Disconnected from ${key}` }] };
    }

    case "mesh_list_connections": {
      const connections = Array.from(meshConnections.entries()).map(([key, client]) => ({
        host: key,
        connected: client.connected
      }));
      
      if (connections.length === 0) {
        return { content: [{ type: "text", text: "No active mesh connections" }] };
      }
      
      return { content: [{ type: "text", text: JSON.stringify(connections, null, 2) }] };
    }

    case "mesh_list_tools": {
      const { host } = args as { host: string };
      
      let key = host;
      if (!meshConnections.has(key)) {
        key = `${host}:8080`;
      }
      
      const client = meshConnections.get(key);
      if (!client) {
        return { content: [{ type: "text", text: `Not connected to ${host}. Use mesh_connect first.` }] };
      }
      
      try {
        const result = await client.listTools();
        const toolNames = result.tools.map((t: any) => t.name);
        return { content: [{ type: "text", text: `Tools on ${key}:\n${toolNames.join('\n')}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to list tools: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "mesh_execute": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { host, tool, args: toolArgs = {} } = args as { host: string; tool: string; args?: Record<string, any> };
      
      let key = host;
      if (!meshConnections.has(key)) {
        key = `${host}:8080`;
      }
      
      const client = meshConnections.get(key);
      if (!client) {
        return { content: [{ type: "text", text: `Not connected to ${host}. Use mesh_connect first.` }] };
      }
      
      try {
        const result = await client.callTool(tool, toolArgs);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Remote execution failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "mesh_screenshot": {
      const { host } = args as { host: string };
      
      let key = host;
      if (!meshConnections.has(key)) {
        key = `${host}:8080`;
      }
      
      const client = meshConnections.get(key);
      if (!client) {
        return { content: [{ type: "text", text: `Not connected to ${host}. Use mesh_connect first.` }] };
      }
      
      try {
        const result = await client.callTool('screen_observe', {});
        
        // Extract image from result
        if (result?.result?.content?.[0]?.type === 'image') {
          return {
            content: [{
              type: "image",
              data: result.result.content[0].data,
              mimeType: "image/png"
            }]
          };
        }
        
        return { content: [{ type: "text", text: "Remote screenshot failed - unexpected response format" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Remote screenshot failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    // Phase 8: AI Enhancements
    case "screen_describe": {
      // Combine multiple sources to describe the screen
      const description: any = {
        timestamp: new Date().toISOString(),
        windows: [],
        mousePosition: null,
        activeWindow: null
      };
      
      try {
        // Get mouse position
        if (robotAvailable) {
          const pos = await mouse.getPosition();
          description.mousePosition = { x: pos.x, y: pos.y };
        }
        
        // Get active window
        if (robotAvailable && getActiveWindow) {
          try {
            const win = await getActiveWindow();
            const title = await win.title;
            const region = await win.region;
            description.activeWindow = {
              title,
              x: region.left,
              y: region.top,
              width: region.width,
              height: region.height
            };
          } catch {}
        }
        
        // Get window list
        if (robotAvailable && getWindows) {
          try {
            const windows = await getWindows();
            const windowInfo = await Promise.all(
              windows.slice(0, 10).map(async (win: any) => {
                try {
                  const title = await win.title;
                  if (!title) return null;
                  const region = await win.region;
                  return { title, x: region.left, y: region.top, width: region.width, height: region.height };
                } catch { return null; }
              })
            );
            description.windows = windowInfo.filter(Boolean);
          } catch {}
        }
        
        // Get screen dimensions
        if (robotAvailable && screen) {
          try {
            description.screenWidth = await screen.width();
            description.screenHeight = await screen.height();
          } catch {}
        }
        
        return { content: [{ type: "text", text: JSON.stringify(description, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to describe screen: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "screen_find_clickable": {
      // Use OCR to find potential clickable elements (buttons, links)
      try {
        const Tesseract = await import("tesseract.js");
        const img = await screenshot({ format: "png" });
        
        const result = await Tesseract.recognize(img, 'eng', { logger: () => {} });
        const data = result.data as any;
        const words = data.words || [];
        
        // Filter for likely clickable text (buttons, links, menu items)
        const clickablePatterns = /^(ok|cancel|yes|no|submit|save|close|open|next|back|continue|done|apply|confirm|delete|edit|add|new|search|login|sign|register|send|upload|download|browse|select|choose|click|tap|press|go|start|stop|play|pause|settings|menu|file|help|view|tools|options|preferences)$/i;
        
        const clickables = words
          .filter((w: any) => w.confidence >= 60)
          .map((w: any) => ({
            text: w.text,
            x: w.bbox.x0,
            y: w.bbox.y0,
            width: w.bbox.x1 - w.bbox.x0,
            height: w.bbox.y1 - w.bbox.y0,
            centerX: Math.round((w.bbox.x0 + w.bbox.x1) / 2),
            centerY: Math.round((w.bbox.y0 + w.bbox.y1) / 2),
            likelyButton: clickablePatterns.test(w.text)
          }))
          .filter((w: any) => w.likelyButton || w.text.length <= 20);
        
        return { content: [{ type: "text", text: JSON.stringify(clickables.slice(0, 30), null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to find clickables: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "action_suggest": {
      const { goal } = args as { goal: string };
      
      // Analyze current state and suggest actions
      const suggestions: string[] = [];
      
      // Get current context
      let activeWindowTitle = "";
      if (robotAvailable && getActiveWindow) {
        try {
          const win = await getActiveWindow();
          activeWindowTitle = await win.title;
        } catch {}
      }
      
      // Basic suggestions based on goal keywords
      const goalLower = goal.toLowerCase();
      
      if (goalLower.includes("open") || goalLower.includes("launch") || goalLower.includes("start")) {
        suggestions.push("Use app_launch to open the application");
        suggestions.push("Use windows_search to find and launch the app");
        suggestions.push("Use windows_run for quick access");
      }
      
      if (goalLower.includes("click") || goalLower.includes("press") || goalLower.includes("button")) {
        suggestions.push("Use screen_find_text to locate the button text");
        suggestions.push("Use screen_click_text to find and click in one step");
        suggestions.push("Use ui_element_find to locate by accessibility name");
      }
      
      if (goalLower.includes("type") || goalLower.includes("enter") || goalLower.includes("input") || goalLower.includes("write")) {
        suggestions.push("First click the input field, then use keyboard_type");
        suggestions.push("Use keyboard_type_slow for more reliable typing");
      }
      
      if (goalLower.includes("scroll")) {
        suggestions.push("Use mouse_scroll with direction up/down");
      }
      
      if (goalLower.includes("copy") || goalLower.includes("paste")) {
        suggestions.push("Use text_select_all then text_copy");
        suggestions.push("Use clipboard_read/clipboard_write for direct access");
      }
      
      if (goalLower.includes("wait") || goalLower.includes("loading")) {
        suggestions.push("Use screen_wait_for_text to wait for specific text");
        suggestions.push("Use screen_wait_for_change to detect any change");
      }
      
      if (goalLower.includes("android") || goalLower.includes("phone") || goalLower.includes("mobile")) {
        suggestions.push("Use adb_devices to check connected devices");
        suggestions.push("Use adb_tap, adb_swipe for touch input");
        suggestions.push("Use adb_screenshot to see the device screen");
      }
      
      suggestions.push(`Current active window: "${activeWindowTitle}"`);
      
      return { content: [{ type: "text", text: JSON.stringify({ goal, suggestions }, null, 2) }] };
    }

    case "error_recover": {
      const { failedAction, errorMessage } = args as { failedAction: string; errorMessage: string };
      
      const recovery: { analysis: string; suggestions: string[] } = {
        analysis: "",
        suggestions: []
      };
      
      const errorLower = errorMessage.toLowerCase();
      const actionLower = failedAction.toLowerCase();
      
      if (errorLower.includes("not found") || errorLower.includes("no element")) {
        recovery.analysis = "The target element was not found on screen";
        recovery.suggestions = [
          "Wait for the element to appear using screen_wait_for_text",
          "Take a screenshot to verify the current screen state",
          "Try scrolling to reveal the element",
          "Check if a dialog or popup is blocking the view"
        ];
      } else if (errorLower.includes("timeout")) {
        recovery.analysis = "The operation timed out";
        recovery.suggestions = [
          "Increase the timeout value",
          "Check if the application is responding",
          "Try the operation again after a short wait"
        ];
      } else if (errorLower.includes("control not enabled")) {
        recovery.analysis = "Control permission is not active";
        recovery.suggestions = [
          "Call control_enable first to grant permissions",
          "Check if the previous permission expired"
        ];
      } else if (errorLower.includes("safe zone")) {
        recovery.analysis = "The target is in a protected safe zone";
        recovery.suggestions = [
          "Use safe_zone_list to see defined zones",
          "Remove the zone with safe_zone_remove if appropriate",
          "Find an alternative way to achieve the goal"
        ];
      } else if (errorLower.includes("adb") || actionLower.includes("adb")) {
        recovery.analysis = "Android device communication failed";
        recovery.suggestions = [
          "Check USB connection and ADB authorization",
          "Run adb_devices to verify device is connected",
          "Try adb kill-server && adb start-server"
        ];
      } else {
        recovery.analysis = "General error occurred";
        recovery.suggestions = [
          "Take a screenshot to see current state",
          "Try the action again after a short wait",
          "Break down the action into smaller steps"
        ];
      }
      
      return { content: [{ type: "text", text: JSON.stringify(recovery, null, 2) }] };
    }

    case "screen_wait_for_change": {
      const { timeoutMs = 5000, threshold = 0.05 } = args || {};
      
      try {
        const { PNG } = await import("pngjs");
        const pixelmatch = (await import("pixelmatch")).default;
        
        // Take initial screenshot
        const initialImg = await screenshot({ format: "png" });
        const initialPng = PNG.sync.read(initialImg);
        
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeoutMs) {
          await new Promise(r => setTimeout(r, 200));
          
          const currentImg = await screenshot({ format: "png" });
          const currentPng = PNG.sync.read(currentImg);
          
          // Compare
          const diff = pixelmatch(
            initialPng.data, currentPng.data, undefined,
            initialPng.width, initialPng.height,
            { threshold: 0.1 }
          );
          
          const changeRatio = diff / (initialPng.width * initialPng.height);
          
          if (changeRatio > threshold) {
            return { 
              content: [{ 
                type: "text", 
                text: JSON.stringify({
                  changed: true,
                  changePercent: Math.round(changeRatio * 100) + '%',
                  waitedMs: Date.now() - startTime
                }, null, 2)
              }] 
            };
          }
        }
        
        return { content: [{ type: "text", text: `No significant change detected after ${timeoutMs}ms` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "screen_compare": {
      const { previousBase64 } = args as { previousBase64: string };
      
      try {
        const { PNG } = await import("pngjs");
        const pixelmatch = (await import("pixelmatch")).default;
        
        const previousBuffer = Buffer.from(previousBase64, 'base64');
        const previousPng = PNG.sync.read(previousBuffer);
        
        const currentImg = await screenshot({ format: "png" });
        const currentPng = PNG.sync.read(currentImg);
        
        if (previousPng.width !== currentPng.width || previousPng.height !== currentPng.height) {
          return { content: [{ type: "text", text: "Screen resolution changed - cannot compare" }] };
        }
        
        const diff = pixelmatch(
          previousPng.data, currentPng.data, undefined,
          previousPng.width, previousPng.height,
          { threshold: 0.1 }
        );
        
        const changeRatio = diff / (previousPng.width * previousPng.height);
        
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              pixelsChanged: diff,
              totalPixels: previousPng.width * previousPng.height,
              changePercent: Math.round(changeRatio * 100) + '%',
              significantChange: changeRatio > 0.05
            }, null, 2)
          }] 
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Compare failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }

    case "context_save": {
      const { name: ctxName } = args as { name: string };
      
      const snapshot: ContextSnapshot = {
        name: ctxName,
        mouseX: 0,
        mouseY: 0,
        activeWindow: "",
        timestamp: Date.now()
      };
      
      // Get mouse position
      if (robotAvailable) {
        try {
          const pos = await mouse.getPosition();
          snapshot.mouseX = pos.x;
          snapshot.mouseY = pos.y;
        } catch {}
      }
      
      // Get active window
      if (robotAvailable && getActiveWindow) {
        try {
          const win = await getActiveWindow();
          snapshot.activeWindow = await win.title;
        } catch {}
      }
      
      contextSnapshots.set(ctxName, snapshot);
      
      return { content: [{ type: "text", text: `💾 Saved context "${ctxName}" (mouse: ${snapshot.mouseX},${snapshot.mouseY}, window: "${snapshot.activeWindow}")` }] };
    }

    case "context_restore": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { name: ctxName } = args as { name: string };
      
      const snapshot = contextSnapshots.get(ctxName);
      if (!snapshot) {
        return { content: [{ type: "text", text: `Context not found: ${ctxName}` }] };
      }
      
      // Restore mouse position
      if (robotAvailable) {
        await mouse.setPosition({ x: snapshot.mouseX, y: snapshot.mouseY });
      }
      
      // Try to focus the window
      if (robotAvailable && getWindows && snapshot.activeWindow) {
        try {
          const windows = await getWindows();
          for (const win of windows) {
            try {
              const title = await win.title;
              if (title && title.includes(snapshot.activeWindow)) {
                await win.focus();
                break;
              }
            } catch {}
          }
        } catch {}
      }
      
      return { content: [{ type: "text", text: `📂 Restored context "${ctxName}"` }] };
    }

    case "context_list": {
      const contexts = Array.from(contextSnapshots.values()).map(c => ({
        name: c.name,
        mouseX: c.mouseX,
        mouseY: c.mouseY,
        activeWindow: c.activeWindow,
        savedAt: new Date(c.timestamp).toLocaleTimeString()
      }));
      
      if (contexts.length === 0) {
        return { content: [{ type: "text", text: "No contexts saved" }] };
      }
      
      return { content: [{ type: "text", text: JSON.stringify(contexts, null, 2) }] };
    }

    // Phase 8: Advanced AI Enhancements
    case "screen_find_element": {
      if (!state.enabled) throw new Error("Control not enabled");
      
      const { description, clickAfterFind = false } = args as { description: string; clickAfterFind?: boolean };
      
      // Take screenshot for analysis
      const img = await screenshot({ format: "png" });
      
      // Use OCR to find text elements
      let ocrResults: any[] = [];
      try {
        const Tesseract = await import("tesseract.js");
        const result = await Tesseract.recognize(img, 'eng');
        // Access words from the result - Tesseract returns Page with words array
        ocrResults = (result.data as any).words || [];
      } catch {}
      
      // Parse description for hints
      const descLower = description.toLowerCase();
      const colorHints = ['red', 'blue', 'green', 'yellow', 'orange', 'purple', 'white', 'black', 'gray', 'grey'];
      const typeHints = ['button', 'link', 'field', 'input', 'text', 'icon', 'image', 'checkbox', 'menu'];
      
      const mentionedColors = colorHints.filter(c => descLower.includes(c));
      const mentionedTypes = typeHints.filter(t => descLower.includes(t));
      
      // Extract key words from description (remove common words)
      const stopWords = ['the', 'a', 'an', 'to', 'in', 'on', 'at', 'for', 'of', 'with', 'click', 'find', 'locate'];
      const keywords = description.toLowerCase()
        .split(/\s+/)
        .filter(w => !stopWords.includes(w) && !colorHints.includes(w) && !typeHints.includes(w) && w.length > 2);
      
      // Search OCR results for matching text
      let bestMatch: { text: string; x: number; y: number; confidence: number } | null = null;
      
      for (const word of ocrResults) {
        const wordText = word.text.toLowerCase();
        for (const keyword of keywords) {
          if (wordText.includes(keyword) || keyword.includes(wordText)) {
            const confidence = word.confidence / 100;
            if (!bestMatch || confidence > bestMatch.confidence) {
              bestMatch = {
                text: word.text,
                x: Math.round(word.bbox.x0 + (word.bbox.x1 - word.bbox.x0) / 2),
                y: Math.round(word.bbox.y0 + (word.bbox.y1 - word.bbox.y0) / 2),
                confidence
              };
            }
          }
        }
      }
      
      // If color mentioned, try to find colored region
      if (mentionedColors.length > 0 && !bestMatch) {
        const sharp = (await import("sharp")).default;
        const { data, info } = await sharp(img).raw().toBuffer({ resolveWithObject: true });
        
        const colorRanges: Record<string, { r: [number, number]; g: [number, number]; b: [number, number] }> = {
          'red': { r: [180, 255], g: [0, 80], b: [0, 80] },
          'blue': { r: [0, 80], g: [0, 80], b: [180, 255] },
          'green': { r: [0, 80], g: [180, 255], b: [0, 80] },
          'yellow': { r: [200, 255], g: [200, 255], b: [0, 80] },
          'orange': { r: [200, 255], g: [100, 180], b: [0, 80] },
          'purple': { r: [100, 200], g: [0, 80], b: [180, 255] },
          'white': { r: [220, 255], g: [220, 255], b: [220, 255] },
          'black': { r: [0, 35], g: [0, 35], b: [0, 35] }
        };
        
        const targetColor = colorRanges[mentionedColors[0]];
        if (targetColor) {
          // Scan for colored pixels and find centroid
          const matches: { x: number; y: number }[] = [];
          for (let y = 0; y < info.height; y += 5) {
            for (let x = 0; x < info.width; x += 5) {
              const idx = (y * info.width + x) * info.channels;
              const r = data[idx], g = data[idx + 1], b = data[idx + 2];
              
              if (r >= targetColor.r[0] && r <= targetColor.r[1] &&
                  g >= targetColor.g[0] && g <= targetColor.g[1] &&
                  b >= targetColor.b[0] && b <= targetColor.b[1]) {
                matches.push({ x, y });
              }
            }
          }
          
          if (matches.length > 10) {
            // Find centroid of colored region
            const avgX = Math.round(matches.reduce((s, p) => s + p.x, 0) / matches.length);
            const avgY = Math.round(matches.reduce((s, p) => s + p.y, 0) / matches.length);
            bestMatch = { text: `${mentionedColors[0]} region`, x: avgX, y: avgY, confidence: 0.7 };
          }
        }
      }
      
      if (!bestMatch) {
        return { 
          content: [{ 
            type: "text", 
            text: `Could not find element matching: "${description}". Try being more specific or use screen_find_text/screen_find_image.` 
          }] 
        };
      }
      
      // Click if requested
      if (clickAfterFind && robotAvailable) {
        await mouse.setPosition({ x: bestMatch.x, y: bestMatch.y });
        await new Promise(r => setTimeout(r, 50));
        await mouse.leftClick();
        return { 
          content: [{ 
            type: "text", 
            text: `Found "${bestMatch.text}" at (${bestMatch.x}, ${bestMatch.y}) with ${Math.round(bestMatch.confidence * 100)}% confidence and clicked it.` 
          }] 
        };
      }
      
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({
            found: bestMatch.text,
            x: bestMatch.x,
            y: bestMatch.y,
            confidence: Math.round(bestMatch.confidence * 100) + '%',
            hint: "Use mouse_click or set clickAfterFind:true to click"
          }, null, 2)
        }] 
      };
    }

    case "skill_generalize": {
      const { skillId, newContext } = args as { skillId: string; newContext: string };
      
      const skills = await skillStorage.loadSkills();
      const skill = skills.find(s => s.skillId === skillId);
      
      if (!skill) {
        return { content: [{ type: "text", text: `Skill not found: ${skillId}` }] };
      }
      
      // Analyze the skill's nodes and create a generalized version
      // SkillGraph uses nodes (tools) and edges (transitions), not steps
      const generalizedNodes = skill.nodes.map((node: any) => ({
        ...node,
        _generalized: true,
        _needsRedetection: true // Mark for re-detection in new context
      }));
      
      // Create new skill variant
      const newSkillId = `${skillId}_generalized_${Date.now()}`;
      const newSkill: any = {
        ...skill,
        skillId: newSkillId,
        description: `${skill.description} (adapted for: ${newContext})`,
        nodes: generalizedNodes,
        edges: skill.edges, // Keep same transition patterns
        confidence: skill.confidence * 0.7, // Lower confidence for generalized version
        totalExecutions: 0,
        tags: [...skill.tags, 'generalized'],
        createdAt: Date.now(),
        lastUsed: Date.now()
      };
      
      // Save the new skill
      await skillStorage.saveSkill(newSkill);
      
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({
            originalSkill: skillId,
            newSkillId,
            newContext,
            nodesGeneralized: generalizedNodes.length,
            note: "Nodes marked for re-detection. Run the skill to adapt it to the new context."
          }, null, 2)
        }] 
      };
    }

    case "suggest_proactive": {
      const { goal } = args as { goal?: string };
      
      const suggestions: { action: string; reason: string; tool: string; priority: 'high' | 'medium' | 'low' }[] = [];
      
      // Gather current context
      let activeWindowTitle = '';
      let mousePos = { x: 0, y: 0 };
      
      if (robotAvailable) {
        mousePos = await mouse.getPosition();
        
        if (getActiveWindow) {
          try {
            const win = await getActiveWindow();
            activeWindowTitle = await win.title;
          } catch {}
        }
      }
      
      // Context-based suggestions
      const titleLower = activeWindowTitle.toLowerCase();
      
      // Browser suggestions
      if (titleLower.includes('chrome') || titleLower.includes('firefox') || titleLower.includes('edge') || titleLower.includes('browser')) {
        suggestions.push({
          action: "Take a screenshot of the current webpage",
          reason: "Browser detected - capture current state for reference",
          tool: "screen_observe",
          priority: "low"
        });
        
        if (goal?.toLowerCase().includes('form') || goal?.toLowerCase().includes('fill')) {
          suggestions.push({
            action: "Use OCR to find form fields",
            reason: "Goal mentions forms - locate input fields first",
            tool: "screen_find_text",
            priority: "high"
          });
        }
      }
      
      // File explorer suggestions
      if (titleLower.includes('explorer') || titleLower.includes('finder') || titleLower.includes('files')) {
        suggestions.push({
          action: "List visible files using OCR",
          reason: "File manager detected - read visible content",
          tool: "screen_read_all_text",
          priority: "medium"
        });
      }
      
      // Code editor suggestions
      if (titleLower.includes('code') || titleLower.includes('studio') || titleLower.includes('vim') || titleLower.includes('sublime')) {
        suggestions.push({
          action: "Save current file",
          reason: "Code editor detected - ensure work is saved",
          tool: "keyboard_shortcut",
          priority: "medium"
        });
      }
      
      // Terminal suggestions
      if (titleLower.includes('terminal') || titleLower.includes('cmd') || titleLower.includes('powershell') || titleLower.includes('bash')) {
        suggestions.push({
          action: "Read terminal output",
          reason: "Terminal detected - capture command results",
          tool: "screen_read_all_text",
          priority: "medium"
        });
      }
      
      // Goal-based suggestions
      if (goal) {
        const goalLower = goal.toLowerCase();
        
        if (goalLower.includes('copy') || goalLower.includes('paste')) {
          suggestions.push({
            action: "Check clipboard content",
            reason: "Goal involves clipboard operations",
            tool: "clipboard_read",
            priority: "high"
          });
        }
        
        if (goalLower.includes('click') || goalLower.includes('button')) {
          suggestions.push({
            action: "Find clickable elements on screen",
            reason: "Goal involves clicking - locate targets first",
            tool: "screen_find_clickable",
            priority: "high"
          });
        }
        
        if (goalLower.includes('type') || goalLower.includes('enter') || goalLower.includes('write')) {
          suggestions.push({
            action: "Ensure focus is on correct input field",
            reason: "Goal involves typing - verify target first",
            tool: "ui_element_at",
            priority: "high"
          });
        }
        
        if (goalLower.includes('wait') || goalLower.includes('load')) {
          suggestions.push({
            action: "Wait for screen to change",
            reason: "Goal involves waiting - monitor for changes",
            tool: "screen_wait_for_change",
            priority: "high"
          });
        }
      }
      
      // General suggestions if nothing specific
      if (suggestions.length === 0) {
        suggestions.push({
          action: "Take a screenshot to analyze current state",
          reason: "No specific context detected - gather information first",
          tool: "screen_observe",
          priority: "medium"
        });
        suggestions.push({
          action: "Get active window information",
          reason: "Understand current application context",
          tool: "window_active",
          priority: "medium"
        });
      }
      
      // Sort by priority
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
      
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({
            context: {
              activeWindow: activeWindowTitle || 'unknown',
              mousePosition: mousePos,
              goal: goal || 'none specified'
            },
            suggestions: suggestions.slice(0, 5) // Top 5 suggestions
          }, null, 2)
        }] 
      };
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
