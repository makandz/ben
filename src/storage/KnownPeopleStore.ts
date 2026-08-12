import type { Logger } from "../logger.js";
import type { KnownPeople } from "../prompting/formatMessages.js";
import { isRecord, readJsonFile, UpdateQueue, writeJsonFileAtomic } from "./JsonFile.js";

type StoredKnownPerson = { username: string; name: string };
type KnownPeopleData = { people: Record<string, StoredKnownPerson> };

export type RememberKnownPersonInput = { userId: string; username: string; name: string };
export type RememberKnownPersonResult =
  { ok: true; username: string; name: string } | { ok: false; error: string };

/** Persists verified Discord identities used to add real names to prompts. */
export class KnownPeopleStore {
  private readonly updates = new UpdateQueue();

  /**
   * Creates a store over a production-compatible known-people file.
   *
   * @param filePath - JSON file compatible with the production known-people store.
   * @param logger - Logger used when malformed entries are ignored.
   */
  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /**
   * Lists remembered people for insertion into model prompts.
   *
   * @returns A case-insensitive username map suitable for prompt formatting.
   */
  async listForPrompt(): Promise<KnownPeople> {
    const knownPeople: Record<string, { name: string }> = {};
    for (const person of Object.values((await this.read()).people)) {
      knownPeople[normalizeUsername(person.username)] = { name: person.name };
    }
    return knownPeople;
  }

  /**
   * Stores or updates one verified person unless their username belongs to another ID.
   *
   * @param input - Verified Discord identity and supplied real or preferred name.
   * @returns A model-readable success or validation result.
   */
  async remember(input: RememberKnownPersonInput): Promise<RememberKnownPersonResult> {
    const userId = input.userId.trim();
    const username = input.username.trim();
    const normalizedUsername = normalizeUsername(username);
    const name = input.name.trim();

    if (userId.length === 0) return { ok: false, error: "missing Discord user ID" };
    if (normalizedUsername.length === 0) return { ok: false, error: "missing Discord username" };
    if (name.length === 0) return { ok: false, error: "missing name" };

    return this.updates.run<RememberKnownPersonResult>(async () => {
      const data = await this.read();
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
      await writeJsonFileAtomic(this.filePath, data);
      return { ok: true, username, name };
    });
  }

  /** Reads and validates the current compatible storage shape. */
  private async read(): Promise<KnownPeopleData> {
    let parsed: unknown;
    try {
      parsed = await readJsonFile(this.filePath);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(`${this.filePath} must contain valid JSON.`);
      throw error;
    }
    if (parsed === undefined) return { people: {} };
    if (!isRecord(parsed)) throw new Error(`${this.filePath} must contain a JSON object.`);
    if (parsed.people === undefined) return { people: {} };
    if (!isRecord(parsed.people)) throw new Error(`${this.filePath} people must be a JSON object.`);

    const data: KnownPeopleData = { people: {} };
    for (const [userId, value] of Object.entries(parsed.people)) {
      if (
        !isRecord(value) ||
        typeof value.username !== "string" ||
        typeof value.name !== "string"
      ) {
        this.logger.warn("known_people.invalid_entry_ignored", { userId });
        continue;
      }
      const normalizedUserId = userId.trim();
      const username = value.username.trim();
      const name = value.name.trim();
      if (normalizedUserId.length === 0 || username.length === 0 || name.length === 0) {
        this.logger.warn("known_people.invalid_entry_ignored", { userId });
        continue;
      }
      data.people[normalizedUserId] = { username, name };
    }
    return data;
  }
}

/** Normalizes Discord usernames for prompt and duplicate lookup. */
function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}
