# 🧠 AI Skill System

A sophisticated system for Gemini AI to learn, remember, and improve computer control skills through procedural memory graphs and drift analysis.

## Architecture

```
┌─────────────────┐
│  Gemini Live    │ ← reasoning, planning, tool selection
│  (multi-key)    │
└────────┬────────┘
         │ MCP protocol (stdio)
         │
┌────────▼────────────────────┐
│  Orchestrator               │
│  - skill matching           │
│  - consent verification     │
│  - execution gating         │
└────────┬────────────────────┘
         │
    ┌────▼─────┬──────────┐
    │          │          │
┌───▼───┐  ┌──▼───┐  ┌──▼───┐
│ MCP   │  │ MCP  │  │ MCP  │
│ Node  │  │ Node │  │ Node │
│   A   │  │  B   │  │  C   │
└───┬───┘  └──┬───┘  └──┬───┘
    │         │         │
┌───▼─────────▼─────────▼───┐
│  Skill Memory Store        │
│  (graphs, drift, patterns) │
└────────────────────────────┘
```

## Setup

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Configure environment:** Copy the example `.env` file and add your Gemini API keys.
    ```bash
    cp .env.example .env
    ```
    You need to edit the `.env` file to add your keys.

## Running the System

This project includes several scripts to build, run, and monitor the system.

### For Development (All-in-One)

The recommended way to run the system for development is using the `dev` script. This will start the orchestrator and the mesh node, and connect to the local computer control server.

1.  **Build the project:** The `dev` script runs TypeScript files directly, but some components expect the compiled JavaScript files. Therefore, you must build the project at least once before the first run.
    ```bash
    npm run build
    ```

2.  **Start the system:**
    ```bash
    npm run dev
    ```
    This will start the AI Skill System. You can now interact with the agent through the terminal.

### Individual Components

You can also run individual components of the system separately. This is useful for debugging or for distributed setups.

-   `npm run mcp`: Starts the Computer Control Server. This exposes the tools for computer control (mouse, keyboard, etc.) over a stdio connection. It should be running on any machine you want the AI to control.

-   `npm run agent`: Starts the Gemini Orchestrator. This is the "brain" of the AI. It connects to the Gemini API and to a running MCP server to execute commands. Use this if you are running the control server on a different machine or in a separate process.

-   `npm run mesh`: Starts the Mesh Node. This exposes the local machine's MCP server over a WebSocket, allowing a remote orchestrator to connect to it. This is for distributed execution. For security, the mesh node requires an authentication token, which can be set via the `MCP_MESH_AUTH_TOKEN` environment variable.

### Utility Scripts

-   `npm run build`: Compiles all TypeScript files from `src/` into JavaScript files in the `dist/` directory. This is required to run the `dev` script.

-   `npm run viz`: Opens the skill drift visualization page (`src/viz/drift-viewer.html`) in your default browser. This allows you to see how the AI's skills are changing over time. Note that `data/drift.json` must exist for the visualization to work.

## Key Features

- **Procedural Memory**: Learns skill sequences as directed graphs
- **Drift Tracking**: Monitors confidence, speed, and complexity changes
- **Multi-Key Rotation**: Load-balanced API key management
- **Consent System**: Machine pairing and time-limited control grants
- **Mesh Nodes**: Distributed execution across multiple machines

## File Structure

- `src/mcp/` - MCP server and mesh nodes
- `src/agent/` - Gemini orchestrator and key pool
- `src/memory/` - Skill graphs, recording, drift tracking
- `src/viz/` - Web-based drift visualization
- `data/` - Persistent storage (skills, drift, consent tokens)

