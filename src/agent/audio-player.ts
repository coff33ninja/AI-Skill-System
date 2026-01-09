import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Audio player for PCM audio data with buffering for smooth playback
 * Uses platform-specific tools to play audio
 * Accumulates small chunks before playing to avoid choppy audio
 */
export class AudioPlayer {
  private tempDir: string;
  private isPlaying = false;
  private queue: Buffer[] = [];
  
  // Buffer accumulator for smoother playback (like AI-Resident)
  private pendingData: Buffer[] = [];
  private minBufferBytes = 48000; // ~1 second at 24kHz 16-bit mono (24000 samples * 2 bytes)
  private flushTimeoutId: NodeJS.Timeout | null = null;
  private flushDelayMs = 100; // Small delay to accumulate chunks
  
  // Active playback process for interruption
  private activeProcess: ChildProcess | null = null;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), "gemini-audio");
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Play PCM audio data (24kHz, 16-bit, mono)
   * Accumulates small chunks for smoother playback
   * @param base64Data Base64 encoded PCM audio
   */
  async play(base64Data: string): Promise<void> {
    const buffer = Buffer.from(base64Data, "base64");
    this.pendingData.push(buffer);
    
    // Calculate total pending bytes
    const totalPending = this.pendingData.reduce((sum, b) => sum + b.length, 0);
    
    // Clear any existing flush timeout
    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
    
    // If we have enough data, flush immediately
    if (totalPending >= this.minBufferBytes) {
      this.flushPendingToQueue();
    } else {
      // Otherwise, set a small delay to accumulate more chunks
      this.flushTimeoutId = setTimeout(() => {
        this.flushPendingToQueue();
      }, this.flushDelayMs);
    }
  }
  
  /**
   * Flush accumulated audio data to the playback queue
   */
  private flushPendingToQueue(): void {
    if (this.pendingData.length === 0) return;
    
    // Combine all pending buffers
    const combined = Buffer.concat(this.pendingData);
    this.pendingData = [];
    
    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
    
    this.queue.push(combined);
    
    if (!this.isPlaying) {
      this.processQueue();
    }
  }
  
  /**
   * Force flush any remaining buffered audio (call on turn complete)
   */
  flush(): void {
    this.flushPendingToQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      return;
    }

    this.isPlaying = true;
    const buffer = this.queue.shift()!;
    
    try {
      await this.playBuffer(buffer);
    } catch (err) {
      console.error("Audio playback error:", err);
    }

    // Process next in queue
    await this.processQueue();
  }

  private async playBuffer(buffer: Buffer): Promise<void> {
    const tempFile = path.join(this.tempDir, `audio_${Date.now()}.raw`);
    const wavFile = path.join(this.tempDir, `audio_${Date.now()}.wav`);

    try {
      // Write raw PCM to temp file
      fs.writeFileSync(tempFile, buffer);

      // Convert to WAV using ffmpeg or play directly
      const platform = os.platform();

      if (platform === "win32") {
        // Windows: Use PowerShell with System.Media.SoundPlayer or ffplay
        await this.playWindows(tempFile, wavFile, buffer);
      } else if (platform === "darwin") {
        // macOS: Use afplay with sox conversion
        await this.playMac(tempFile, wavFile);
      } else {
        // Linux: Use aplay or paplay
        await this.playLinux(tempFile);
      }
    } finally {
      // Cleanup temp files
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile);
      } catch {}
    }
  }

  private async playWindows(tempFile: string, wavFile: string, buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      // Try ffplay first (comes with ffmpeg)
      const ffplay = spawn("ffplay", [
        "-f", "s16le",
        "-ar", "24000",
        "-ac", "1",
        "-nodisp",
        "-autoexit",
        tempFile
      ], { stdio: "ignore" });
      
      this.activeProcess = ffplay;

      ffplay.on("close", (code) => {
        this.activeProcess = null;
        if (code === 0) {
          resolve();
        } else {
          // Fallback: Convert to WAV and use PowerShell
          this.convertAndPlayWindows(buffer, wavFile).then(resolve).catch(reject);
        }
      });

      ffplay.on("error", () => {
        this.activeProcess = null;
        // ffplay not found, use fallback
        this.convertAndPlayWindows(buffer, wavFile).then(resolve).catch(reject);
      });
    });
  }

  private async convertAndPlayWindows(buffer: Buffer, wavFile: string): Promise<void> {
    // Create WAV header for 24kHz, 16-bit, mono
    const wavHeader = this.createWavHeader(buffer.length, 24000, 1, 16);
    const wavBuffer = Buffer.concat([wavHeader, buffer]);
    fs.writeFileSync(wavFile, wavBuffer);

    return new Promise((resolve, reject) => {
      const ps = spawn("powershell", [
        "-Command",
        `(New-Object Media.SoundPlayer '${wavFile}').PlaySync()`
      ], { stdio: "ignore" });

      ps.on("close", () => resolve());
      ps.on("error", reject);
    });
  }

  private async playMac(tempFile: string, wavFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use sox to convert and play
      const sox = spawn("play", [
        "-t", "raw",
        "-r", "24000",
        "-b", "16",
        "-c", "1",
        "-e", "signed-integer",
        tempFile
      ], { stdio: "ignore" });

      sox.on("close", () => resolve());
      sox.on("error", () => {
        // Fallback to afplay with WAV conversion
        const buffer = fs.readFileSync(tempFile);
        const wavHeader = this.createWavHeader(buffer.length, 24000, 1, 16);
        fs.writeFileSync(wavFile, Buffer.concat([wavHeader, buffer]));
        
        const afplay = spawn("afplay", [wavFile], { stdio: "ignore" });
        afplay.on("close", () => resolve());
        afplay.on("error", reject);
      });
    });
  }

  private async playLinux(tempFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Try aplay first
      const aplay = spawn("aplay", [
        "-f", "S16_LE",
        "-r", "24000",
        "-c", "1",
        tempFile
      ], { stdio: "ignore" });

      aplay.on("close", () => resolve());
      aplay.on("error", () => {
        // Try paplay (PulseAudio)
        const paplay = spawn("paplay", [
          "--raw",
          "--format=s16le",
          "--rate=24000",
          "--channels=1",
          tempFile
        ], { stdio: "ignore" });

        paplay.on("close", () => resolve());
        paplay.on("error", reject);
      });
    });
  }

  private createWavHeader(dataSize: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size
    header.writeUInt16LE(1, 20); // AudioFormat (PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
  }

  /**
   * Stop all audio playback and clear buffers
   */
  stop(): void {
    this.queue = [];
    this.pendingData = [];
    this.isPlaying = false;
    
    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
    
    // Kill active playback process if any
    if (this.activeProcess) {
      try {
        this.activeProcess.kill();
      } catch {}
      this.activeProcess = null;
    }
  }
}
