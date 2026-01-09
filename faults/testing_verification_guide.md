# Testing Guide: Vision Verification Fixes

## Before You Start

1. **Backup your current code:**
   ```bash
   cd C:\GitHub\AI-Skill-System
   git add .
   git commit -m "Backup before vision fixes"
   ```

2. **Install dependencies (if needed):**
   ```bash
   npm install
   ```

## Implementation Steps

### Step 1: Add Vision Analysis Method

Edit `src/agent/gemini-orchestrator.ts`:

1. Add the `visionModel` property and `lastScreenshot` cache
2. Add `initVisionModel()` method
3. Add `analyzeScreenWithVision()` method
4. Add `verifyScreenState()` method
5. Add `callToolWithVerification()` wrapper

### Step 2: Update System Instructions

Replace the system instruction in `connectLive()` with `ENHANCED_SYSTEM_INSTRUCTION`.

### Step 3: Modify Tool Call Handler

Find the tool call handling code (around line 220) and replace with `handleToolCallForLiveAPI()`.

### Step 4: Rebuild

```bash
npm run build
```

## Test Cases

### Test 1: Basic Vision Verification

**Goal:** Verify the AI can actually see the screen

**Steps:**
1. Start the AI in voice mode
2. Say: "What do you see on my screen right now?"
3. Expected: Detailed description of visible applications and UI elements
4. ❌ Old behavior: Generic response or hallucination
5. ✅ New behavior: Accurate description based on vision analysis

### Test 2: Open Control Panel (Regression Test)

**Goal:** Verify the original failing scenario now works

**Steps:**
1. Close all applications except the AI
2. Say: "Open Control Panel"
3. Watch console logs for:
   ```
   🔍 Analyzing screenshot with vision...
   ```
4. Listen for AI narration:
   - ✅ Should describe what it sees at each step
   - ✅ Should confirm Control Panel opened
   - ❌ Should NOT claim success before verification

**Expected Console Output:**
```
🔧 Executing: screen_observe (id: ...)
🔍 Analyzing screenshot with vision...
✅ Tool screen_observe completed in XXXms
Analysis: "Application: Desktop. Elements: Start button, Taskbar, ..."

🔧 Executing: mouse_click (id: ...)
✅ Tool mouse_click completed in XXms

🔧 Executing: screen_observe (id: ...)
🔍 Analyzing screenshot with vision...
✅ Tool screen_observe completed in XXXms
Analysis: "Application: Start Menu. Elements: Search box, ..."

... (more actions) ...

🔧 Executing: screen_observe (id: ...)
🔍 Analyzing screenshot with vision...
✅ Tool screen_observe completed in XXXms
Analysis: "Application: Control Panel. Elements: Close button, ..."
```

### Test 3: Failed Action Detection

**Goal:** Verify the AI detects when actions don't work

**Steps:**
1. Say: "Open a program called XYZ12345" (non-existent program)
2. Expected behavior:
   - AI attempts to search for it
   - Takes screenshot to verify
   - Reports that the program wasn't found
   - ❌ Does NOT claim it opened successfully

### Test 4: UI Change Detection

**Goal:** Verify the AI notices unexpected UI changes

**Steps:**
1. Say: "Click the Start button"
2. Manually close the Start menu immediately (before AI takes next screenshot)
3. AI should notice the Start menu is no longer open
4. Expected: AI reports the menu closed or action needs retry

### Test 5: Vision Analysis Quality

**Goal:** Verify vision descriptions are detailed enough

**Steps:**
1. Open Notepad with some text
2. Say: "What's in the Notepad window?"
3. Expected: Description mentioning:
   - Application name (Notepad)
   - Window title
   - Approximate content visible
   - UI elements (menu bar, etc.)

## Debugging

### Check Vision API Calls

Enable verbose logging in `analyzeScreenWithVision()`:

```typescript
console.log("📸 Screenshot size:", imageBase64.length, "chars");
console.log("🤖 Sending to vision model:", "gemini-2.5-flash");
console.log("📝 Vision response:", response.substring(0, 200) + "...");
```

### Check Screenshot Capture

Verify screenshots are being taken:

```typescript
// In computer-control-server.ts, add:
case "screen_observe": {
  if (!state.enabled) throw new Error("Control not enabled");
  const img = await screenshot({ format: "png" });
  
  // DEBUG: Save screenshot to disk
  const fs = await import('fs');
  fs.writeFileSync(`debug_screenshot_${Date.now()}.png`, img);
  console.log("📸 Screenshot saved to debug_screenshot_*.png");
  
  return {
    content: [{
      type: "image",
      data: img.toString("base64"),
      mimeType: "image/png"
    }]
  };
}
```

### Check Vision Model Initialization

Add logging to `initVisionModel()`:

```typescript
private async initVisionModel() {
  if (!this.visionModel) {
    console.log("🔧 Initializing vision model...");
    const apiKey = this.keyPool.next();
    console.log("🔑 Using API key:", apiKey.substring(0, 10) + "...");
    const genAI = new GoogleGenerativeAI(apiKey);
    this.visionModel = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash"
    });
    console.log("✅ Vision model initialized");
  }
}
```

## Expected Performance Impact

- **Screen observation time:** +1-2 seconds (for vision analysis)
- **API costs:** +1 vision API call per screenshot
- **Memory usage:** +5-10 MB (for screenshot caching)

## Rollback Plan

If issues occur:

```bash
git revert HEAD
npm run build
npm start
```

## Success Criteria

✅ AI describes what it sees in screenshots
✅ AI verifies actions before claiming success
✅ AI detects when actions fail
✅ Console shows "🔍 Analyzing screenshot with vision..."
✅ No more blind assumptions about UI state

## Common Issues

### Issue: "Vision model initialization failed"

**Solution:** Check API key has Vision API enabled:
```bash
# Test vision directly
curl https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash \
  -H "x-goog-api-key: YOUR_API_KEY"
```

### Issue: "Screenshot analysis returns empty"

**Solution:** Check image encoding:
```typescript
// Verify base64 is valid
const testDecode = Buffer.from(imageBase64, 'base64');
console.log("Image decoded size:", testDecode.length, "bytes");
```

### Issue: "Tool responses still show 'Screenshot captured successfully'"

**Solution:** Verify `callToolWithVerification()` is being used:
```typescript
// Add breakpoint or log:
console.log("🔍 Using verification wrapper:", name === "screen_observe");
```

## Next Steps After Testing

1. Monitor API usage and costs
2. Tune vision prompt for better descriptions
3. Add caching for repeated screenshots
4. Implement confidence thresholds
5. Add user feedback for accuracy