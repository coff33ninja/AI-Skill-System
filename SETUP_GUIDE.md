# Setup Guide

Step-by-step instructions for setting up the AI Skill System.

---

## Available Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Main entry - uses MODE from .env |
| `npm run mcp` | Computer control server only |
| `npm run mesh` | Mesh node only (receive remote commands) |
| `npm run agent` | AI agent only (connect to existing MCP) |
| `npm run viz` | Open skill visualization in browser |
| `npm run build` | Compile TypeScript |

---

## Single Computer Setup

### 1. Install Node.js

Download and install Node.js 18 or newer from: https://nodejs.org/

To check if it's installed, open a terminal and type:
```
node --version
```
You should see something like `v18.0.0` or higher.

### 2. Install ffmpeg (for voice mode)

**Windows:**
1. Download from https://www.gyan.dev/ffmpeg/builds/ (get the "essentials" build)
2. Extract the zip file
3. Copy the `ffmpeg.exe` from the `bin` folder to `C:\Windows\` (or add to PATH)

**Mac:**
```
brew install ffmpeg
```

**Linux:**
```
sudo apt install ffmpeg
```

To check if it's installed:
```
ffmpeg -version
```

### 3. Get a Gemini API Key

1. Go to https://aistudio.google.com/apikey
2. Sign in with your Google account
3. Click "Create API Key"
4. Copy the key (it starts with `AIza`)

### 4. Download and Configure

```bash
# Navigate to the project folder
cd ai-skill-system

# Install dependencies
npm install

# Create your config file
copy .env.example .env    # Windows
cp .env.example .env      # Mac/Linux
```

### 5. Edit the .env File

Open `.env` in Notepad (Windows) or any text editor:

```
GEMINI_KEY_1=paste_your_api_key_here
MODE=voice
```

### 6. Run

```bash
npm run dev
```

You should see:
```
🚀 Starting AI Skill System...
✅ Loaded 1 API key(s)
📋 Mode: VOICE
🎤 Connecting to Gemini Live API...
✅ Voice mode active - just speak, no typing needed
```

Now just talk! Say something like "Hello, can you hear me?"

---

## Multi-Computer Setup

Control multiple computers from one place using your voice.

### Example Setup

```
┌─────────────────┐         ┌─────────────────┐
│  Your Computer  │ ──────► │  Office PC      │
│  (Main)         │         │  (Mesh Node)    │
│  MODE=voice     │         │  ENABLE_MESH=   │
└─────────────────┘         │  true           │
                            └─────────────────┘
                                    │
                                    ▼
                            ┌─────────────────┐
                            │  Living Room PC │
                            │  (Mesh Node)    │
                            └─────────────────┘
```

### On Each Remote Computer:

1. Copy the project to that computer
2. Run `npm install`
3. Create `.env` with:

```
GEMINI_KEY_1=your_api_key
MODE=node
```

4. Run:
```bash
npm run dev
```

Or use the dedicated mesh script:
```bash
npm run mesh
```

You'll see:
```
🌐 Mesh Node listening on port 8080
✅ Mesh Node connected to local MCP server
```

Keep this running. The computer is now ready to receive commands.

### On Your Main Computer:

Just run normally with `MODE=voice`. You can then tell the AI to connect to other machines.

---

## Testing Your Setup

### Test 1: Check the AI responds

Say: "Hello, are you there?"

The AI should respond with voice.

### Test 2: Check screen control

Say: "Take a screenshot and tell me what you see"

The AI should describe your screen.

### Test 3: Check mouse/keyboard

Say: "Move the mouse to the center of the screen"

Your mouse should move.

---

## Common Issues

### "Cannot find module" error

Run `npm install` again.

### "GEMINI_KEY" error

Make sure your `.env` file has a valid API key.

### No sound/voice

- Check your speakers are on
- Check ffmpeg is installed
- Try `MODE=hybrid` to also use keyboard

### Mouse doesn't move

The nut-js library needs to be installed. Run:
```
npm install @nut-tree-fork/nut-js
```

### "Connection refused" on mesh node

- Check the remote computer's firewall allows port 8080
- Make sure the mesh node is running on the remote computer
- Verify the IP address is correct

### "Authentication failed" on mesh

- Make sure `MCP_MESH_AUTH_TOKEN` matches on both machines
- Check for typos in the token

### Drift visualization shows "Data not found"

- Run some commands first to generate skill data
- Check that `data/drift.json` exists
- The file is created after skills are used multiple times

---

## Stopping the System

- Press `Ctrl+C` in the terminal
- Or say "Exit" or "Quit"
- Or just close the terminal window

---

## Skill Memory System

The AI learns from your commands automatically.

### How Skills Work

1. When you give a command, the system records each step (mouse move, click, type, etc.)
2. Similar command sequences are grouped into "skills"
3. Each time you repeat a task, the skill becomes more confident
4. Skills are saved to `data/skills.json`

### Viewing Learned Skills

Open `data/skills.json` to see what the AI has learned. Each skill shows:
- `skillId`: Unique identifier
- `description`: What the skill does
- `nodes`: Each step in the sequence
- `confidence`: How reliable the skill is (0-1)
- `totalExecutions`: How many times it's been used

### Drift Visualization

Track how skills change over time:

```bash
npm run viz
```

This opens a dashboard in your browser showing three charts per skill:
- **Confidence**: Is the skill getting more reliable?
- **Latency**: Is it getting faster?
- **Complexity**: Is it getting simpler?

The data comes from `data/drift.json`. You need to run some commands first to generate data.

---

## Updating

To get the latest version:

```bash
git pull
npm install
npm run dev
```

---

## Need More Help?

Check the terminal output for error messages. Most problems are:

1. Missing API key
2. ffmpeg not installed (for voice)
3. Firewall blocking connections (for mesh)

The error messages usually tell you exactly what's wrong.
