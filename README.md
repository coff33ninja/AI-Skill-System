# 🎤 AI Skill System

**Voice-controlled computer automation for people with arthritis, RSI, or anyone who wants hands-free control.**

Just speak naturally — the AI listens, understands, and controls your computer for you.

---

## What Does This Do?

This system lets you control your computer using only your voice:

- "Open Chrome and go to YouTube"
- "Click the search box and type hello world"
- "Take a screenshot"
- "Press control+s to save"

The AI listens continuously, understands what you want, and does it. No typing, no clicking, no mouse needed.

---

## Features

### 🎤 Voice Control
Speak naturally — the AI understands context and executes multi-step tasks. No wake words, no button pressing.

### 🧠 Skill Memory
The system learns from your commands. Repeated tasks become "skills" that execute faster and more reliably over time.

### 📊 Drift Tracking
Monitors how skills change over time. See if tasks are getting faster, more reliable, or drifting from their original behavior.

### 🌐 Multi-Machine Control
Control multiple computers from one place. Set up mesh nodes on remote PCs and command them all with your voice.

### 🔒 Safety First
- Auto-timeout after inactivity
- Confirmation prompts for dangerous actions
- Token-based authentication for remote control

---

## Quick Start (5 Minutes)

### Step 1: Install Requirements

You need these installed on your computer:

1. **Node.js 18 or newer** — [Download here](https://nodejs.org/)
2. **ffmpeg** (for microphone) — [Download here](https://ffmpeg.org/download.html)
   - Windows: Download, extract, add to PATH
   - Mac: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`

### Step 2: Get a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy the key (starts with `AIza...`)

### Step 3: Set Up the Project

```bash
# Download or clone this project, then:
cd ai-skill-system

# Install dependencies
npm install

# Create your config file
copy .env.example .env
```

### Step 4: Add Your API Key

Open the `.env` file in any text editor and replace `your_api_key_here` with your actual key:

```
GEMINI_KEY_1=AIzaSy...your_actual_key_here...
```

### Step 5: Run It

```bash
npm run dev
```

That's it! Start speaking. The system will listen and respond.

---

## Running the System

### Simple Way (Recommended)

Just set your `MODE` in `.env` and run:

```bash
npm run dev
```

### Advanced: Individual Scripts

For more control, you can run components separately:

| Script | What It Does |
|--------|--------------|
| `npm run dev` | Main entry point. Uses MODE from .env |
| `npm run mcp` | Starts the computer control server only |
| `npm run mesh` | Starts mesh node only (for remote control) |
| `npm run agent` | Starts the AI agent only |
| `npm run viz` | Opens the skill drift visualization in your browser |
| `npm run build` | Compiles TypeScript to JavaScript |

---

## Skill Memory & Learning

The system automatically learns from your commands.

### How It Works

1. **Recording**: Every command you give is recorded as a "trace"
2. **Pattern Matching**: Similar command sequences are grouped into "skills"
3. **Reinforcement**: Each time you repeat a task, the skill gets stronger
4. **Drift Tracking**: The system monitors if skills change over time

### Viewing Your Skills

Your learned skills are saved in `data/skills.json`. Each skill tracks:
- What tools were used (mouse, keyboard, etc.)
- How long each step took
- Success/failure rates
- Confidence score (0-1)

### Drift Visualization

See how your skills evolve over time:

```bash
npm run viz
```

This opens a browser dashboard showing:
- **Confidence Reliability**: Is the skill getting more or less reliable?
- **Execution Latency**: Is it getting faster or slower?
- **Procedural Complexity**: Is the task getting simpler or more complex?

The drift data is stored in `data/drift.json`.

---

## Modes

Set the `MODE` in your `.env` file:

| Mode | What It Does | Best For |
|------|--------------|----------|
| `voice` | Hands-free. Just speak, no typing. | Accessibility, RSI, arthritis |
| `text` | Keyboard only. Type commands in terminal. | Developers, scripting |
| `hybrid` | Both voice and keyboard work. | Flexibility |
| `node` | Receives commands from other machines. | Remote-controlled PCs |
| `server` | HTTP/WebSocket API for web apps. | Integrations, web interfaces |
| `relay` | Your voice controls OTHER computers. | Control multiple PCs hands-free |

### Quick Mode Examples

**I want to control THIS computer with my voice:**
```
MODE=voice
```

**I want to control ANOTHER computer with my voice:**
```
MODE=relay
REMOTE_HOST=192.168.1.100
```

**I want THIS computer to be controlled remotely:**
```
MODE=node
ENABLE_MESH=true
MCP_MESH_AUTH_TOKEN=mysecretpassword
```

**I want to build a web app that controls computers:**
```
MODE=server
SERVER_PORT=3000
```

---

## What Can It Do?

The AI can:

| Action | Example Voice Command |
|--------|----------------------|
| Move mouse | "Move the mouse to the top left corner" |
| Click | "Click there" or "Double click" |
| Type text | "Type hello world" |
| Keyboard shortcuts | "Press control+c" or "Press alt+tab" |
| Take screenshots | "Take a screenshot" or "What's on my screen?" |
| Complex tasks | "Open notepad and type a grocery list" |

---

## Controlling Multiple Computers

Control other computers on your network using mesh nodes.

### Setup Overview

```
┌─────────────────────┐
│  Your Computer      │
│  MODE=relay         │──────► Voice commands
│  REMOTE_HOST=...    │        go here
└─────────┬───────────┘
          │ WebSocket
          ▼
┌─────────────────────┐     ┌─────────────────────┐
│  Office PC          │     │  Living Room PC     │
│  MODE=node          │     │  MODE=node          │
│  (receives commands)│     │  (receives commands)│
└─────────────────────┘     └─────────────────────┘
```

### Step 1: Set Up the Remote Computer (the one you want to control)

On the computer you want to control remotely:

1. Install the project (`npm install`)
2. Create `.env`:
```
MODE=node
MESH_PORT=8080
MCP_MESH_AUTH_TOKEN=choose_a_secret_password
```
3. Run: `npm run dev`

You'll see:
```
🖥️  Starting as MESH NODE (remote-controlled machine)
✅ Mesh Node ready on port 8080
```

### Step 2: Set Up Your Controller (where you speak)

On your main computer:

1. Create `.env`:
```
GEMINI_KEY_1=your_api_key
MODE=relay
REMOTE_HOST=192.168.1.100    # IP of the remote computer
REMOTE_PORT=8080
REMOTE_TOKEN=choose_a_secret_password   # Must match remote's token
```
2. Run: `npm run dev`

Now when you speak, the commands execute on the remote computer!

---

## Troubleshooting

### Voice Mode Issues

**"No audio input device found"**
- Make sure your microphone is plugged in
- Check that ffmpeg is installed: `ffmpeg -version`
- On Windows, check your microphone is set as default in Sound Settings

**Voice not working but text works**
- Check ffmpeg is installed
- Try `MODE=hybrid` to use both voice and keyboard

**Nothing happens when I speak**
- Check your microphone volume isn't muted
- Speak clearly and wait a moment for the AI to respond
- Check the terminal for any error messages

### Connection Issues

**"Setup timeout - no setupComplete received"**
- Check your internet connection
- Verify your Gemini API key is correct
- Try a different API key if you have multiple

**"Control not enabled"**
- The AI needs to enable control before it can click/type
- Say "Enable control" or it will do this automatically

### Mesh/Remote Control Issues

**"Connection refused" on mesh node**
- Check the remote computer's firewall allows the port (default 8080)
- Make sure the mesh node is running: `npm run mesh` or `npm run dev` with `MODE=node`
- Verify the IP address is correct

**"Authentication failed"**
- Make sure `MCP_MESH_AUTH_TOKEN` matches on both machines
- Check for typos in the token

**Remote commands not executing**
- Verify the mesh node shows "✅ Mesh Node ready"
- Check both machines are on the same network
- Try pinging the remote machine's IP

### Server Mode Issues

**"Port already in use"**
- Change `SERVER_PORT` in your `.env` to a different number (e.g., 3001)
- Or stop whatever is using that port

**API not responding**
- Check the server started: look for "🌐 Server listening on port..."
- Verify you're using the correct URL (http://localhost:PORT)

### Skill/Memory Issues

**Skills not being saved**
- Check the `data/` folder exists and is writable
- Look for errors in the terminal about file permissions

**Drift visualization shows "Data not found"**
- Run some commands first to generate drift data
- Check `data/drift.json` exists

---

## Configuration Options

All settings go in your `.env` file:

```bash
# Your Gemini API keys (get from Google AI Studio)
# Add multiple keys for better reliability
GEMINI_KEY_1=AIzaSy...
GEMINI_KEY_2=AIzaSy...  # optional backup
GEMINI_KEY_3=AIzaSy...  # optional backup

# How you want to interact
MODE=voice              # voice, text, hybrid, node, server, or relay

# Your computer's name (for multi-machine setups)
MACHINE_ID=my-computer
MACHINE_NAME=Living Room PC

# Safety settings
CONTROL_TIMEOUT_MS=300000    # Auto-disable control after 5 minutes
REQUIRE_CONFIRMATION=true    # Ask before dangerous actions

# Mesh node settings (for remote control)
ENABLE_MESH=false            # Enable mesh node server
MESH_PORT=8080               # Port for mesh connections
MCP_MESH_AUTH_TOKEN=secret   # Password for mesh authentication

# Remote connection (for relay mode)
REMOTE_HOST=192.168.1.100    # IP of remote mesh node
REMOTE_PORT=8080             # Port of remote mesh node
REMOTE_TOKEN=secret          # Must match remote's MCP_MESH_AUTH_TOKEN

# Server mode settings
SERVER_PORT=3000             # Port for HTTP/WebSocket API
```

---

## Safety Notes

This system can control your mouse and keyboard. Be aware:

- It will only act when you speak to it
- Control automatically times out after 5 minutes of inactivity
- You can say "Stop" or "Disable control" at any time
- Press Ctrl+C in the terminal to shut it down immediately

For extra safety:
- Test on a non-critical computer first
- Keep `CONTROL_TIMEOUT_MS` short (e.g., 60000 for 1 minute)
- Use `REQUIRE_CONFIRMATION=true` for important actions

---

## Project Structure

```
ai-skill-system/
├── src/
│   ├── agent/           # AI brain and voice handling
│   │   ├── gemini-orchestrator.ts  # Main AI coordinator
│   │   ├── gemini-live-client.ts   # Voice API connection
│   │   ├── audio-player.ts         # Text-to-speech playback
│   │   ├── mic-capture.ts          # Microphone input
│   │   ├── key-pool.ts             # API key rotation
│   │   └── consent-manager.ts      # Machine pairing security
│   ├── mcp/             # Computer control tools
│   │   ├── computer-control-server.ts  # Mouse/keyboard control
│   │   ├── mesh-node.ts                # Remote control server
│   │   └── mesh-client.ts              # Remote control client
│   ├── memory/          # Learning and skill storage
│   │   ├── recorder.ts      # Records command traces
│   │   ├── skill-graph.ts   # Skill data structures
│   │   ├── drift-tracker.ts # Monitors skill changes
│   │   └── storage.ts       # File persistence
│   ├── viz/             # Visualization
│   │   └── drift-viewer.html  # Skill drift dashboard
│   └── index.ts         # Main entry point
├── data/                # Saved data (auto-created)
│   ├── skills.json      # Learned skills
│   └── drift.json       # Drift tracking history
├── .env                 # Your configuration
└── package.json         # Dependencies
```

---

## Getting Help

If something isn't working:

1. Check the terminal for error messages
2. Make sure all requirements are installed (Node.js, ffmpeg)
3. Verify your API key is correct
4. Try `MODE=text` first to confirm the AI works, then switch to voice

---

## License

MIT — Use freely, modify as needed.

---

**Built for accessibility. Control your computer with just your voice.** 🎤
