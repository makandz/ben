import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { KnownPerson } from "../config.js";
import type { Logger } from "../logger.js";

interface StoredKnownPerson {
  username: string;
  name: string;
}

interface KnownPeopleData {
  people: Record<string, StoredKnownPerson>;
}

export interface RememberKnownPersonInput {
  userId: string;
  username: string;
  name: string;
}

export type RememberKnownPersonResult =
  | {
      ok: true;
      username: string;
      name: string;
    }
  | {
      ok: false;
      error: string;
    };

export class KnownPeopleStore {
  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  async listForPrompt(): Promise<Record<string, KnownPerson>> {
    const data = await this.read();
    const knownPeople: Record<string, KnownPerson> = {};

    for (const person of Object.values(data.people)) {
      knownPeople[normalizeUsername(person.username)] = { name: person.name };
    }

    return knownPeople;
  }

  async remember(input: RememberKnownPersonInput): Promise<RememberKnownPersonResult> {
    const userId = input.userId.trim();
    const username = input.username.trim();
    const normalizedUsername = normalizeUsername(username);
    const name = input.name.trim();

    if (userId.length === 0) {
      return { ok: false, error: "missing Discord user ID" };
    }

    if (normalizedUsername.length === 0) {
      return { ok: false, error: "missing Discord username" };
    }

    if (name.length === 0) {
      return { ok: false, error: "missing name" };
    }

    const data = await this.read();
    const existing = data.people[userId];

    if (existing !== undefined) {
      return {
        ok: false,
        error: `${existing.username} is already remembered as "${existing.name}"`,
      };
    }

    for (const [existingUserId, person] of Object.entries(data.people)) {
      if (
        existingUserId !== userId &&
        normalizeUsername(person.username) === normalizedUsername
      ) {
        return {
          ok: false,
          error: `${person.username} is already remembered as "${person.name}"`,
        };
      }
    }

    data.people[userId] = { username, name };
    await this.write(data);

    return { ok: true, username, name };
  }

  private async read(): Promise<KnownPeopleData> {
    let raw: string;

    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { people: {} };
      }

      throw error;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${this.filePath} must contain valid JSON.`);
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`${this.filePath} must contain a JSON object.`);
    }

    const people = (parsed as { people?: unknown }).people;

    if (people === undefined) {
      return { people: {} };
    }

    if (people === null || Array.isArray(people) || typeof people !== "object") {
      throw new Error(`${this.filePath} people must be a JSON object.`);
    }

    const data: KnownPeopleData = { people: {} };

    for (const [userId, value] of Object.entries(people)) {
      if (value === null || Array.isArray(value) || typeof value !== "object") {
        this.logger.warn("known_people.invalid_entry_ignored", { userId });
        continue;
      }

      const username = (value as { username?: unknown }).username;
      const name = (value as { name?: unknown }).name;

      if (typeof username !== "string" || typeof name !== "string") {
        this.logger.warn("known_people.invalid_entry_ignored", { userId });
        continue;
      }

      const normalizedUserId = userId.trim();
      const trimmedUsername = username.trim();
      const trimmedName = name.trim();

      if (
        normalizedUserId.length === 0 ||
        trimmedUsername.length === 0 ||
        trimmedName.length === 0
      ) {
        this.logger.warn("known_people.invalid_entry_ignored", { userId });
        continue;
      }

      data.people[normalizedUserId] = {
        username: trimmedUsername,
        name: trimmedName,
      };
    }

    return data;
  }

  private async write(data: KnownPeopleData): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const tempPath = path.join(
      dir,
      `.${path.basename(this.filePath)}.${String(process.pid)}.${String(Date.now())}.tmp`,
    );
    const content = `${JSON.stringify(data, null, 2)}\n`;

    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, this.filePath);
  }
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
