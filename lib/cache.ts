import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

function ensureDir(namespace: string) {
  const dir = path.join(DATA_DIR, namespace);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getCached(namespace: string, date: string): Record<string, unknown> | null {
  try {
    const dir = ensureDir(namespace);
    const filePath = path.join(dir, `${date}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function saveCache(namespace: string, date: string, data: Record<string, unknown>): void {
  try {
    const dir = ensureDir(namespace);
    const filePath = path.join(dir, `${date}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data));
  } catch {
    // Cache write failure is non-fatal
  }
}

export function listCachedDates(namespace: string): string[] {
  try {
    const dir = ensureDir(namespace);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

// ─── BACKWARDS-COMPATIBLE WRAPPERS (player prop predictions) ─────────────────

export function getCachedPredictions(date: string): Record<string, unknown> | null {
  return getCached('predictions', date);
}

export function savePredictions(date: string, data: Record<string, unknown>): void {
  saveCache('predictions', date, data);
}
