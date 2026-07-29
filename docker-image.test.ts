import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Guards the packaging gap that CI's typecheck cannot see.
 *
 * `tsc --noEmit` runs against the whole working tree, so it stays green even
 * when the Docker image ships only a subset of the sources. That is exactly how
 * `process-queue.ts` reached production importing `./api-availability` while the
 * image never copied that file - the failure only surfaced as a TS2307 inside
 * the cron run.
 *
 * These tests resolve the import graph the container actually loads and assert
 * every file in it is copied into the image.
 */

const repoRoot = __dirname;
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const entrypoint = fs.readFileSync(path.join(repoRoot, "entrypoint.sh"), "utf8");

/** Sources copied into the image's WORKDIR, as literal names or `*` globs. */
function copiedPatterns(): string[] {
  const patterns: string[] = [];
  // Join `\`-continued lines so multi-line COPY instructions parse as one.
  const instructions = dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/);

  for (const line of instructions) {
    const match = /^\s*COPY\s+(.*)$/i.exec(line);
    if (!match) continue;
    const args = match[1]
      .split(/\s+/)
      .filter((arg) => arg.length > 0 && !arg.startsWith("--"));
    // Last argument is the destination, everything before it is a source.
    patterns.push(...args.slice(0, -1));
  }
  return patterns;
}

/** Minimal Dockerfile-style glob: `*` matches any run of non-separator chars. */
function matchesPattern(file: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, "[^/]*")}$`);
  return regex.test(file);
}

function isCopiedIntoImage(file: string): boolean {
  return copiedPatterns().some((pattern) => matchesPattern(file, pattern));
}

/** The script `entrypoint.sh` hands to ts-node, e.g. `process-queue.ts`. */
function entrypointScript(): string {
  const match = /ts-node\s+(?:\S*\/)?(\S+\.ts)/.exec(entrypoint);
  if (!match) throw new Error("Could not find the ts-node invocation in entrypoint.sh");
  return match[1];
}

/** Resolve a relative import specifier to a repo-relative file, if it exists. */
function resolveImport(fromFile: string, specifier: string): string | null {
  const base = path.join(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.json`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    const absolute = path.join(repoRoot, candidate);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return path.normalize(candidate);
    }
  }
  return null;
}

/** Every repo-local file reachable from `entry` via relative imports. */
function importGraph(entry: string): { files: Set<string>; unresolved: string[] } {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue = [path.normalize(entry)];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (files.has(current)) continue;
    files.add(current);
    if (!current.endsWith(".ts")) continue;

    const source = fs.readFileSync(path.join(repoRoot, current), "utf8");
    const specifiers = [
      ...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g),
      ...source.matchAll(/require\s*\(\s*["'](\.[^"']+)["']\s*\)/g),
    ].map((m) => m[1]);

    for (const specifier of specifiers) {
      const resolved = resolveImport(current, specifier);
      if (resolved) queue.push(resolved);
      else unresolved.push(`${current} -> ${specifier}`);
    }
  }

  return { files, unresolved };
}

describe("Docker image packaging", () => {
  const entry = entrypointScript();
  const { files, unresolved } = importGraph(entry);

  it("resolves every relative import in the runtime graph", () => {
    // A specifier that resolves to nothing on disk is the TS2307 failure itself,
    // just caught before it reaches a cron run.
    expect(unresolved).toEqual([]);
  });

  it("reaches more than the entrypoint module", () => {
    // Cheap canary: if the graph walker silently stops finding imports, the
    // coverage assertion below would pass vacuously.
    expect(files.size).toBeGreaterThan(1);
    expect(files.has(entry)).toBe(true);
  });

  it("copies every module the entrypoint imports into the image", () => {
    const missing = [...files].filter((file) => !isCopiedIntoImage(file));
    expect(missing).toEqual([]);
  });

  it("copies the files the entrypoint needs to start at all", () => {
    for (const file of [entry, "entrypoint.sh", "tsconfig.json"]) {
      expect(isCopiedIntoImage(file), `${file} is not COPYed into the image`).toBe(true);
    }
  });
});

describe("glob matching", () => {
  it("matches literal names and star patterns", () => {
    expect(matchesPattern("process-queue.ts", "*.ts")).toBe(true);
    expect(matchesPattern("api-availability.ts", "*.ts")).toBe(true);
    expect(matchesPattern("tsconfig.json", "tsconfig.json")).toBe(true);
    expect(matchesPattern("api-availability.ts", "process-queue.ts")).toBe(false);
    expect(matchesPattern("tsconfig.json", "*.ts")).toBe(false);
    expect(matchesPattern("nested/thing.ts", "*.ts")).toBe(false);
  });
});
