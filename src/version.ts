import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

interface PackageInfo {
  version: string;
  name: string;
}

function readPackageJson(): PackageInfo {
  // src/version.ts compiles to dist/version.js; package.json is at ../package.json from either.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', 'package.json'), resolve(here, '..', '..', 'package.json')];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      return {
        name: parsed.name ?? 'unknown',
        version: parsed.version ?? 'unknown',
      };
    } catch {
      // try next candidate
    }
  }
  return { name: 'unknown', version: 'unknown' };
}

function readGitSha(): string {
  // Allow GIT_SHA env var override (set by deploy script). Falls back to git command.
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

const pkg = readPackageJson();

export const VERSION = {
  name: pkg.name,
  version: pkg.version,
  gitSha: readGitSha(),
  nodeVersion: process.version,
  startedAt: new Date().toISOString(),
} as const;
