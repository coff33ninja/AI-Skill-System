export class GeminiKeyPool {
  private keys: Array<{ key: string; load: number; lastUsed: number }>;

  constructor(keys: string[]) {
    this.keys = keys.map(k => ({ key: k, load: 0, lastUsed: 0 }));
  }

  next(): string {
    // Sort by load, then by staleness
    this.keys.sort((a, b) => {
      if (a.load !== b.load) return a.load - b.load;
      return a.lastUsed - b.lastUsed;
    });

    this.keys[0].load++;
    this.keys[0].lastUsed = Date.now();
    
    return this.keys[0].key;
  }

  release(key: string) {
    const entry = this.keys.find(k => k.key === key);
    if (entry) entry.load = Math.max(0, entry.load - 1);
  }
}
