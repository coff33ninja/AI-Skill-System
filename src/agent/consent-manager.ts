import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import crypto from "crypto";

export interface TrustPair {
  machineId: string;
  token: string;
  grantedAt: number;
  expiresAt: number;
}

/**
 * Manages security tokens and machine-to-machine pairing.
 * Prevents unauthorized agents from controlling local hardware.
 */
export class ConsentManager {
  private storagePath = "./data/consent-tokens.json";

  async requestPairing(machineId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    const pair: TrustPair = {
      machineId,
      token,
      grantedAt: Date.now(),
      expiresAt: Date.now() + (1000 * 60 * 60 * 24) // 24 hour default
    };

    await this.savePair(pair);
    return token;
  }

  async verify(machineId: string, token: string): Promise<boolean> {
    const pairs = await this.loadPairs();
    const pair = pairs.find(p => p.machineId === machineId && p.token === token);
    
    if (!pair) return false;
    if (Date.now() > pair.expiresAt) return false;
    
    return true;
  }

  private async loadPairs(): Promise<TrustPair[]> {
    await this.ensureDirectoryExists();
    if (!existsSync(this.storagePath)) return [];
    const data = await readFile(this.storagePath, "utf-8");
    return JSON.parse(data);
  }

  private async savePair(pair: TrustPair) {
    const pairs = await this.loadPairs();
    pairs.push(pair);
    await writeFile(this.storagePath, JSON.stringify(pairs, null, 2));
  }

  private async ensureDirectoryExists() {
    const dir = dirname(this.storagePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }
}
