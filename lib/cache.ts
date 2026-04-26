import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'data', 'predictions');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

export function getCachedPredictions(date: string): Record<string, unknown> | null {
  try {
    ensureCacheDir();
    const filePath = path.join(CACHE_DIR, `${date}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function savePredictions(date: string, data: Record<string, unknown>): void {
  try {
    ensureCacheDir();
    const filePath = path.join(CACHE_DIR, `${date}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data));
  } catch {
    // Cache write failure is non-fatal
  }
}
