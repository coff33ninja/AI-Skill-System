# AI Skill System - Root Cause Analysis

## Problem Summary

The AI voice assistant claims to successfully complete tasks (like opening Control Panel) but actually **operates completely blind** without being able to see the screen, leading to hallucinated success.

## Root Causes Identified

### 1. **Gemini Live API Cannot Process Images**

**Location:** `src/agent/gemini-orchestrator.ts` ~line 220

```typescript
// For images, just confirm we got it - don't send the huge base64
// The Live API can't process images in tool responses anyway
responseData = { 
  result: "Screenshot captured successfully. I can see the screen.",
  imageSize: item.data?.length || 0
};
```

**Issue:** The code explicitly strips out screenshot image data and replaces it with a text placeholder because Gemini's Live API cannot accept images in tool call responses.

**Impact:** The AI receives confirmation that a screenshot was taken, but never sees the actual screen content, causing it to make blind assumptions about success.

### 2. **No Verification Loop**

The AI's workflow from your logs shows:
1. ✅ Takes screenshot (`screen_observe`)
2. ✅ Performs actions (click, type, etc.)
3. ✅ Takes another screenshot
4. ❌ **Never analyzes what's actually on screen**
5. ❌ **Assumes success and announces completion**

### 3. **Live API vs Text API Architecture Mismatch**

The system has two separate code paths:

- **Live API** (`LIVE_MODEL`): Real-time audio TTS/STT for voice mode
  - **Cannot process images**
  - Used for voice interactions
  
- **Text API** (`TEXT_MODEL`): Standard `generateContent` endpoint
  - **CAN process images via multimodal input**
  - Only used for text-based operations

## Current System Architecture

```
User Voice → Live API → Tool Calls → MCP Server → Actions
                ↓
         Text Response (NO VISION)
                ↓
         Audio Output (Hallucinated Success)
```

## Why Audio Plays

The audio **is working correctly**. The base64 audio chunks you see in the logs are being generated and played. The problem isn't audio playback - it's that **the AI is confidently narrating actions it performed without visual confirmation they worked**.

## Verification Test

From the State-Tool output, we can confirm:
- **Control Panel IS open** (Interactive Element #0: "Control Panel" with Close/OK buttons)
- **BUT** the Claude chat window is in front of it
- The AI never "saw" this because it only received text: "Screenshot captured successfully"

## Solutions

### Option 1: Hybrid Approach (Recommended)

Modify the Live API workflow to periodically call the Text API for vision verification:

```typescript
// After taking screenshot
if (toolName === 'screen_observe') {
  // Use TEXT_MODEL with vision to analyze the screenshot
  const visionResult = await this.analyzeScreenWithVision(imageData);
  // Feed the textual description back to Live API
  return { result: visionResult.description };
}
```

**Pros:**
- Works within Live API limitations
- Adds verification without breaking voice mode
- Can continue conversation naturally

**Cons:**
- Slightly slower (additional API call)
- More complex code
- Higher API usage

### Option 2: Switch to Text API for Computer Control

Use Live API only for voice I/O, but switch to Text API when tools are needed:

```typescript
// On tool call from Live API
1. Pause voice interaction
2. Switch to TEXT_MODEL (with vision)
3. Execute tool + analyze result
4. Resume Live API with summary
```

**Pros:**
- Full vision capability during control tasks
- Clean separation of concerns

**Cons:**
- More complex state management
- Potential audio interruptions
- User experience disruption

### Option 3: Use Windows-MCP UI Accessibility (Current Fallback)

The `State-Tool` with `use_vision: false` returns structured UI data:

```
List of Interactive Elements:
  Label  ControlType    Name              Coordinates
      0  Button         Close             (1214,431)
      1  Button         OK                (1186,526)
```

**Pros:**
- Already implemented
- Works without vision
- Fast and lightweight

**Cons:**
- Only works on Windows
- Can't see visual content (images, colors, layouts)
- May miss dynamically rendered UI

### Option 4: Image-to-Text Preprocessing

Before tool execution, convert screenshots to detailed text descriptions:

```typescript
async describeScreen(imageBase64: string): Promise<string> {
  // Use TEXT_MODEL to describe the image
  const description = await genAI.getGenerativeModel({ model: TEXT_MODEL })
    .generateContent([
      "Describe this screenshot in detail, focusing on UI elements and their locations:",
      { inlineData: { data: imageBase64, mimeType: "image/png" } }
    ]);
  return description.text();
}
```

**Pros:**
- Compatible with Live API
- Provides textual context
- Can be cached

**Cons:**
- Additional API calls
- Description may miss details
- Slower execution

## Immediate Fixes

### Fix 1: Add Verification Step

Modify `gemini-orchestrator.ts` to require explicit verification:

```typescript
// After control actions, force a verification check
if (actionCompleted) {
  const verification = await this.verifyScreenState(expectedState);
  if (!verification.matches) {
    return { error: "Action may have failed", details: verification };
  }
}
```

### Fix 2: Use State-Tool with Vision

Change the default to always capture vision:

```typescript
case "screen_observe": {
  if (!state.enabled) throw new Error("Control not enabled");
  
  // Get both screenshot AND UI structure
  const [img, uiState] = await Promise.all([
    screenshot({ format: "png" }),
    getUIAccessibilityTree() // From Windows-MCP
  ]);
  
  return {
    content: [{
      type: "image",
      data: img.toString("base64"),
      mimeType: "image/png"
    }, {
      type: "text",
      text: JSON.stringify(uiState)
    }]
  };
}
```

### Fix 3: Log When Operating Blind

Add warnings when vision isn't being used:

```typescript
if (item.type === "image") {
  console.warn("⚠️  WARNING: Operating without vision - image stripped");
  console.warn("⚠️  AI cannot see screen and may hallucinate results");
  responseData = { 
    result: "⚠️ Screenshot taken but NOT analyzed - operating blind",
    warning: "Vision not available in Live API mode"
  };
}
```

## Recommended Implementation Path

1. **Short-term (Immediate):**
   - Add warnings when operating blind
   - Default to `use_vision: true` in State-Tool
   - Require UI element verification before claiming success

2. **Medium-term (This Week):**
   - Implement hybrid approach (Option 1)
   - Add vision verification checkpoints
   - Create explicit success/failure detection

3. **Long-term (Future):**
   - Wait for Gemini Live API to support vision
   - Migrate to full vision-enabled workflow
   - Add visual regression testing

## Testing Strategy

Create test cases that would expose blind operation:

```typescript
// Test: Can the AI detect a failed window open?
1. Ask AI to open Notepad
2. Verify it actually checks if Notepad opened
3. Verify it doesn't just assume success

// Test: Can the AI detect UI changes?
1. Ask AI to change a setting
2. Verify it visually confirms the change
3. Verify it doesn't just assume the click worked

// Test: Can the AI handle unexpected UI?
1. Ask AI to click a button
2. Show an error dialog instead
3. Verify it detects and reports the error
```

## Conclusion

The system is technically working as designed, but the design has a critical flaw: **Gemini Live API's lack of vision support means the AI is performing actions blindly and hallucinating success.**

The most pragmatic solution is **Option 1 (Hybrid Approach)** combined with better use of the existing **State-Tool UI accessibility data** as a fallback. This provides vision when possible, structured UI data when vision isn't available, and explicit verification before claiming success.