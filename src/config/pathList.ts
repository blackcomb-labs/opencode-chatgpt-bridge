import { delimiter, resolve } from "node:path";
import process from "node:process";

/**
 * Split an OS path list (like PATH) without touching the individual entries.
 *
 * `path.delimiter` is `;` on Windows and `:` elsewhere, so Windows drive
 * letters such as `C:\repos` survive the split.
 */
export function splitPathEntries(value: string | undefined, separator = delimiter): string[] {
  const raw = value?.trim();
  if (!raw) return [];

  const entries: string[] = [];
  for (const part of raw.split(separator)) {
    const entry = part.trim();
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  return entries;
}

/** Split an OS path list and resolve each entry to an absolute path. */
export function splitPathList(value: string | undefined, separator = delimiter): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const entry of splitPathEntries(value, separator)) {
    const path = resolve(entry);
    // Windows paths are case-insensitive, so dedupe them that way.
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }

  return paths;
}

/** Join absolute paths with the OS path-list separator. */
export function joinPathList(paths: string[]): string {
  return paths.map((path) => resolve(path)).join(delimiter);
}
