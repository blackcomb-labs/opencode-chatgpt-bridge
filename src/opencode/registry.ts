import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type RegistryEntry = {
  id: string;
  title: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  accessible: boolean;
  running: boolean;
  lastMessageAt?: number;
  lastError?: string;
};

export type RegistryFile = {
  sessions: Record<string, RegistryEntry>;
};

/**
 * Persistent registry of the OpenCode sessions the bridge has seen.
 *
 * It records the *real* id, title, working directory and accessibility of each
 * session, so a coordinator can resolve "Project Ferret" to the existing
 * session instead of guessing or creating a new one.
 */
export class SessionRegistry {
  private readonly file: string;

  constructor(private readonly stateDir: string) {
    this.file = join(stateDir, "session-registry.json");
  }

  async read(): Promise<RegistryFile> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed && typeof parsed === "object" && parsed.sessions) return parsed;
    } catch {
      // no registry yet
    }
    return { sessions: {} };
  }

  async write(data: RegistryFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async list(): Promise<RegistryEntry[]> {
    const data = await this.read();
    return Object.values(data.sessions).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async get(id: string): Promise<RegistryEntry | undefined> {
    const data = await this.read();
    return data.sessions[id];
  }

  /** Merge freshly discovered sessions into the registry. */
  async upsert(entries: RegistryEntry[]): Promise<RegistryFile> {
    const data = await this.read();
    const now = Date.now();
    for (const entry of entries) {
      const existing = data.sessions[entry.id];
      data.sessions[entry.id] = {
        ...existing,
        ...entry,
        firstSeenAt: existing?.firstSeenAt ?? entry.firstSeenAt ?? now,
        lastSeenAt: now
      };
    }
    await this.write(data);
    return data;
  }
}
