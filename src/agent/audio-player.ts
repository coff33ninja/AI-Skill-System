import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Simple audio player for PCM audio data
 * Uses platform-specific tools to play audio
 */
export class AudioPlayer {
  private tempDir: string;
  private isPlaying = false;
  private queue: Buffer[] = [];

  constructor() {
    this.tempDir = path.join(os.tmpdir(), "gemini-audio");
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Play PCM audio data (24kHz, 16-bit, mono)
   * @param base64Data Base64 encoded PCM audio
   */
  async play(base64Data: string): Promise<void> {
    const buffer = Buffer.from(base64Data, "base64");
    this.queue.push(buffer);
    
    if (!this.isPlaying) {
      await this.processQueue();
    }
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

      ffplay.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Fallback: Convert to WAV and use PowerShell
          this.convertAndPlayWindows(buffer, wavFile).then(resolve).catch(reject);
        }
      });

      ffplay.on("error", () => {
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
   * Stop all audio playback
   */
  stop(): void {
    this.queue = [];
    this.isPlaying = false;
  }
}
