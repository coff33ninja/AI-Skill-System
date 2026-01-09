import { spawn, ChildProcess } from "child_process";
import * as os from "os";

/**
 * Microphone capture for Node.js - streams PCM audio for Gemini Live API
 * Designed for hands-free accessibility (arthritis/RSI users)
 * 
 * Output format: PCM 16kHz, 16-bit, mono (what Gemini Live expects)
 */
export class MicCapture {
  private process: ChildProcess | null = null;
  private isCapturing = false;
  private isPaused = false;
  private onAudioCallback?: (base64Audio: string) => void;
  private onErrorCallback?: (error: Error) => void;
  private platform: string;

  constructor() {
    this.platform = os.platform();
  }

  /**
   * Start capturing audio from the default microphone
   * @param onAudio Callback with base64-encoded PCM chunks
   * @param onError Callback for errors
   */
  start(
    onAudio: (base64Audio: string) => void,
    onError?: (error: Error) => void
  ): void {
    if (this.isCapturing) {
      console.log("🎤 Mic already capturing");
      return;
    }

    this.onAudioCallback = onAudio;
    this.onErrorCallback = onError;

    try {
      if (this.platform === "win32") {
        this.startWindows();
      } else if (this.platform === "darwin") {
        this.startMac();
      } else {
        this.startLinux();
      }
      
      this.isCapturing = true;
      console.log("🎤 Microphone capture started (16kHz PCM)");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("❌ Failed to start mic capture:", error.message);
      this.onErrorCallback?.(error);
    }
  }

  /**
   * Windows: Use ffmpeg to capture from default audio device
   * First detects available devices, then uses the first audio input
   */
  private startWindows(): void {
    // First, list available devices
    const listProcess = spawn("ffmpeg", [
      "-f", "dshow",
      "-list_devices", "true",
      "-i", "dummy"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let deviceList = "";
    listProcess.stderr?.on("data", (data) => {
      deviceList += data.toString();
    });

    listProcess.on("close", () => {
      // Parse device list and find first audio device
      const audioMatch = deviceList.match(/"([^"]+)" \(audio\)/);
      if (audioMatch) {
        this.startWindowsWithDevice(audioMatch[1]);
      } else {
        // Try alternative pattern for newer ffmpeg
        const altMatch = deviceList.match(/\[dshow[^\]]*\]\s+"([^"]+)"\s+\(audio\)/);
        if (altMatch) {
          this.startWindowsWithDevice(altMatch[1]);
        } else {
          console.error("❌ No audio input device found");
          console.error("   Available devices:\n" + deviceList);
          this.onErrorCallback?.(new Error("No audio input device found. Check microphone connection."));
        }
      }
    });
  }

  private startWindowsWithDevice(deviceName: string): void {
    console.log(`🎤 Using audio device: ${deviceName}`);
    
    this.process = spawn("ffmpeg", [
      "-f", "dshow",
      "-i", `audio=${deviceName}`,
      "-ar", "16000",
      "-ac", "1", 
      "-f", "s16le",
      "-"
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.setupProcessHandlers();
  }

  /**
   * macOS: Use ffmpeg with avfoundation
   */
  private startMac(): void {
    this.process = spawn("ffmpeg", [
      "-f", "avfoundation",
      "-i", ":0",          // default audio input
      "-ar", "16000",
      "-ac", "1",
      "-f", "s16le",
      "-"
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.setupProcessHandlers();
  }

  /**
   * Linux: Use ffmpeg with ALSA or PulseAudio
   */
  private startLinux(): void {
    // Try PulseAudio first (more common on modern distros)
    this.process = spawn("ffmpeg", [
      "-f", "pulse",
      "-i", "default",
      "-ar", "16000",
      "-ac", "1",
      "-f", "s16le",
      "-"
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.process.on("error", () => {
      this.tryLinuxAlsa();
    });

    this.setupProcessHandlers();
  }

  private tryLinuxAlsa(): void {
    this.process = spawn("ffmpeg", [
      "-f", "alsa",
      "-i", "default",
      "-ar", "16000",
      "-ac", "1",
      "-f", "s16le",
      "-"
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.setupProcessHandlers();
  }

  /**
   * Set up stdout/stderr handlers for the ffmpeg process
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    // Buffer to accumulate audio chunks (send ~100ms chunks)
    let audioBuffer = Buffer.alloc(0);
    const chunkSize = 3200; // 100ms at 16kHz 16-bit mono = 16000 * 2 * 0.1

    this.process.stdout?.on("data", (data: Buffer) => {
      // Skip sending audio if paused (but still consume the buffer)
      if (this.isPaused) {
        return;
      }
      
      audioBuffer = Buffer.concat([audioBuffer, data]);

      // Send chunks when we have enough data
      while (audioBuffer.length >= chunkSize) {
        const chunk = audioBuffer.subarray(0, chunkSize);
        audioBuffer = audioBuffer.subarray(chunkSize);
        
        const base64 = chunk.toString("base64");
        this.onAudioCallback?.(base64);
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString();
      // Only log actual errors, not ffmpeg info
      if (msg.includes("Error") || msg.includes("error")) {
        console.error("🎤 ffmpeg:", msg.trim());
      }
    });

    this.process.on("close", (code) => {
      if (this.isCapturing && code !== 0) {
        console.log(`🎤 Mic capture ended (code ${code})`);
      }
      this.isCapturing = false;
    });

    this.process.on("error", (err) => {
      console.error("❌ Mic capture error:", err.message);
      this.onErrorCallback?.(err);
      this.isCapturing = false;
    });
  }

  /**
   * Stop capturing audio
   */
  stop(): void {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {}
      this.process = null;
    }
    this.isCapturing = false;
    this.isPaused = false;
    console.log("🔇 Microphone capture stopped");
  }

  /**
   * Pause sending audio (mic still captures but doesn't send)
   * Used to prevent feedback when AI is speaking
   */
  pause(): void {
    if (this.isCapturing && !this.isPaused) {
      this.isPaused = true;
      console.log("🔇 Mic paused (AI speaking)");
    }
  }

  /**
   * Resume sending audio after pause
   */
  resume(): void {
    if (this.isCapturing && this.isPaused) {
      this.isPaused = false;
      console.log("🎤 Mic resumed");
    }
  }

  /**
   * Check if currently capturing
   */
  get capturing(): boolean {
    return this.isCapturing;
  }

  /**
   * Check if paused
   */
  get paused(): boolean {
    return this.isPaused;
  }
}
