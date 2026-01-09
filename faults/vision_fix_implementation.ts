// ==============================================================================
// SOLUTION: Add Vision Verification to Gemini Orchestrator
// ==============================================================================
// This adds a hybrid approach where the Live API can request vision analysis
// from the Text API when it needs to verify screen state.

// File: src/agent/gemini-orchestrator.ts (additions/modifications)

import { GoogleGenerativeAI } from "@google/generative-ai";

export class GeminiOrchestrator {
  // ... existing properties ...
  
  private visionModel?: any; // Separate model instance for vision
  private lastScreenshot?: { data: string; timestamp: number };
  
  /**
   * Initialize vision model for screen analysis
   */
  private async initVisionModel() {
    if (!this.visionModel) {
      const apiKey = this.keyPool.next();
      const genAI = new GoogleGenerativeAI(apiKey);
      this.visionModel = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash" // Text model with vision support
      });
    }
  }
  
  /**
   * Analyze screenshot using vision-capable model
   * Returns detailed description of what's on screen
   */
  private async analyzeScreenWithVision(imageBase64: string): Promise<{
    description: string;
    elements: string[];
    confidence: number;
  }> {
    await this.initVisionModel();
    
    const prompt = `Analyze this screenshot and provide:
1. What application/window is currently in focus
2. List of visible UI elements and their approximate locations
3. Any error messages or dialogs visible
4. Whether the screen looks responsive or frozen

Format as JSON with keys: application, elements (array), errors (array), status`;

    const result = await this.visionModel.generateContent([
      prompt,
      {
        inlineData: {
          data: imageBase64,
          mimeType: "image/png"
        }
      }
    ]);
    
    const response = result.response.text();
    
    // Try to parse as JSON, fallback to text description
    try {
      const parsed = JSON.parse(response.replace(/```json\n?|\n?```/g, ''));
      return {
        description: `Application: ${parsed.application}. Elements: ${parsed.elements.join(', ')}`,
        elements: parsed.elements || [],
        confidence: parsed.errors?.length > 0 ? 0.5 : 0.9
      };
    } catch {
      return {
        description: response,
        elements: [],
        confidence: 0.7
      };
    }
  }
  
  /**
   * Enhanced tool call handler with vision verification
   */
  private async callToolWithVerification(
    name: string, 
    args: Record<string, unknown> = {}
  ): Promise<any> {
    const result = await this.callTool(name, args);
    
    // Special handling for screen_observe
    if (name === "screen_observe" && result?.content) {
      for (const item of result.content) {
        if (item.type === "image") {
          // Cache the screenshot
          this.lastScreenshot = {
            data: item.data,
            timestamp: Date.now()
          };
          
          // Analyze with vision
          console.log("🔍 Analyzing screenshot with vision...");
          const analysis = await this.analyzeScreenWithVision(item.data);
          
          // Return both the confirmation AND the analysis
          return {
            content: [{
              type: "text",
              text: `Screenshot captured and analyzed:\n${analysis.description}\n\nVisible elements: ${analysis.elements.join(', ')}`
            }]
          };
        }
      }
    }
    
    // For action tools (mouse_click, keyboard_type, etc.), verify the result
    const actionTools = ['mouse_click', 'keyboard_type', 'keyboard_press', 'keyboard_shortcut'];
    if (actionTools.includes(name) && this.lastScreenshot) {
      // Check if screenshot is recent (within 5 seconds)
      const age = Date.now() - this.lastScreenshot.timestamp;
      if (age < 5000) {
        console.log("⚠️  Action performed without recent screen verification");
        console.log("   Consider taking a new screenshot to verify result");
      }
    }
    
    return result;
  }
  
  /**
   * Verify expected state against actual screen
   */
  private async verifyScreenState(expectedState: {
    application?: string;
    contains?: string[];
    notContains?: string[];
  }): Promise<{ matches: boolean; details: string }> {
    // Take new screenshot
    const screenResult = await this.callTool("screen_observe", {});
    
    let imageData: string | null = null;
    for (const item of screenResult.content || []) {
      if (item.type === "image") {
        imageData = item.data;
        break;
      }
    }
    
    if (!imageData) {
      return { matches: false, details: "Could not capture screenshot" };
    }
    
    // Analyze with vision
    const analysis = await this.analyzeScreenWithVision(imageData);
    
    // Check expectations
    const checks: string[] = [];
    let allMatch = true;
    
    if (expectedState.application) {
      const appMatch = analysis.description.toLowerCase()
        .includes(expectedState.application.toLowerCase());
      checks.push(`App '${expectedState.application}': ${appMatch ? '✅' : '❌'}`);
      allMatch = allMatch && appMatch;
    }
    
    if (expectedState.contains) {
      for (const text of expectedState.contains) {
        const found = analysis.description.toLowerCase().includes(text.toLowerCase());
        checks.push(`Contains '${text}': ${found ? '✅' : '❌'}`);
        allMatch = allMatch && found;
      }
    }
    
    if (expectedState.notContains) {
      for (const text of expectedState.notContains) {
        const found = analysis.description.toLowerCase().includes(text.toLowerCase());
        checks.push(`Not contains '${text}': ${!found ? '✅' : '❌'}`);
        allMatch = allMatch && !found;
      }
    }
    
    return {
      matches: allMatch,
      details: `Verification: ${allMatch ? 'PASSED' : 'FAILED'}\n${checks.join('\n')}\n\nScreen: ${analysis.description}`
    };
  }
  
  /**
   * Modified tool call handler for Live API responses
   * This replaces the existing code around line 220
   */
  private async handleToolCallForLiveAPI(fc: any): Promise<any> {
    console.log(`🔧 Executing: ${fc.name} (id: ${fc.id})`);
    const startTime = Date.now();
    
    try {
      // Use verification wrapper instead of direct call
      const result = await this.callToolWithVerification(fc.name, fc.args || {});
      const duration = Date.now() - startTime;
      
      // Process result based on content type
      let responseData: any = { success: true };
      
      if (result?.content) {
        for (const item of result.content) {
          if (item.type === "text") {
            responseData = { result: item.text };
          } else if (item.type === "image") {
            // Image was already processed by callToolWithVerification
            // This case should not be reached, but keep as fallback
            responseData = { 
              result: "⚠️ Screenshot captured but not analyzed (fallback path)",
              warning: "Vision analysis was bypassed"
            };
          }
        }
      }
      
      return {
        id: fc.id,
        name: fc.name,
        response: responseData
      };
      
    } catch (err) {
      const duration = Date.now() - startTime;
      console.error(`❌ Tool ${fc.name} failed:`, err);
      
      return {
        id: fc.id,
        name: fc.name,
        response: { 
          error: err instanceof Error ? err.message : String(err)
        }
      };
    }
  }
}

// ==============================================================================
// ADDITIONAL: Enhanced System Instructions for Live API
// ==============================================================================

const ENHANCED_SYSTEM_INSTRUCTION = `
You are an AI agent that controls computers through voice commands.

CRITICAL VISION RULES:
1. You can now see the screen! When you call screen_observe, you receive a detailed description of what's visible.
2. ALWAYS verify actions by taking a screenshot AFTER performing them.
3. NEVER claim success without visual confirmation.
4. If you don't see what you expect, report the discrepancy and try a different approach.

WORKFLOW FOR CONTROL TASKS:
1. Call control_enable to get permission
2. Call screen_observe to see the current state
3. Plan your action based on what you see
4. Execute the action (mouse_click, keyboard_type, etc.)
5. Call screen_observe again to verify the result
6. Report actual outcome (success or failure) based on verification

EXAMPLE - Opening Control Panel:
1. "I'll start by taking a screenshot to see the desktop"
2. screen_observe → sees Start button at bottom left
3. "I can see the Start button at coordinates (27, 1056)"
4. mouse_click → clicks Start
5. wait → pause for UI to respond
6. screen_observe → sees Start menu open
7. "Start menu is now open, I'll search for Control Panel"
8. keyboard_type → types "control panel"
9. screen_observe → sees search results
10. "I can see Control Panel in the search results"
11. keyboard_press("enter") → opens Control Panel
12. screen_observe → verifies Control Panel window
13. "Control Panel has successfully opened" ← Only claim success after visual confirmation!

FAILURE DETECTION:
- If screen_observe shows something unexpected, acknowledge it
- If an action didn't work, try a different approach
- Never say "I've opened X" without seeing X in a screenshot

Speak naturally and narrate what you're actually seeing as you work.
`.trim();

// ==============================================================================
// USAGE IN EXISTING CODE
// ==============================================================================

// In the connectLive() method, update the systemInstruction:
this.liveClient = new GeminiLiveClient({
  apiKey,
  model: LIVE_MODEL,
  voiceName: "Aoede",
  tools: liveTools,
  systemInstruction: ENHANCED_SYSTEM_INSTRUCTION
});

// In the tool call handler, replace the old code with:
for (const fc of toolCall.functionCalls) {
  const response = await this.handleToolCallForLiveAPI(fc);
  responses.push(response);
}