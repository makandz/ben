import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logger.js";
import { internalStatusSchema, type InternalStatus } from "./statusSchema.js";

export interface InternalStatusState {
  action: "status";
  status: InternalStatus;
  setAt: string;
}

interface InternalStateFile {
  statuses?: {
    current?: InternalStatusState;
  };
}

export class InternalStateStore {
  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  async readCurrentStatus(): Promise<InternalStatusState | undefined> {
    const state = await this.readStateFile();
    const current = state.statuses?.current;

    if (current === undefined) {
      return undefined;
    }

    return parseInternalStatusState(current);
  }

  async writeCurrentStatus(status: InternalStatus, now = new Date()): Promise<InternalStatusState> {
    const state = await this.readStateFile();
    const current: InternalStatusState = {
      action: "status",
      status,
      setAt: now.toISOString(),
    };

    state.statuses = {
      ...state.statuses,
      current,
    };

    await this.writeStateFile(state);
    return current;
  }

  private async readStateFile(): Promise<InternalStateFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        this.logger.warn("internal.state_invalid", { path: this.filePath });
        return {};
      }

      return parsed;
    } catch (error) {
      if (isNotFoundError(error)) {
        return {};
      }

      this.logger.warn("internal.state_read_failed", {
        path: this.filePath,
        error: String(error),
      });
      return {};
    }
  }

  private async writeStateFile(state: InternalStateFile): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

export function isFreshStatusState(
  state: InternalStatusState,
  intervalMs: number,
  now = new Date(),
): boolean {
  const setAtMs = Date.parse(state.setAt);

  if (!Number.isFinite(setAtMs)) {
    return false;
  }

  return now.getTime() - setAtMs < intervalMs;
}

function parseInternalStatusState(value: unknown): InternalStatusState | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const status = record.status;

  if (record.action !== "status" || typeof record.setAt !== "string") {
    return undefined;
  }

  if (status === null || Array.isArray(status) || typeof status !== "object") {
    return undefined;
  }

  const statusRecord = status as Record<string, unknown>;
  const statusResult = internalStatusSchema.safeParse(statusRecord);

  if (!statusResult.success) {
    return undefined;
  }

  return {
    action: "status",
    status: statusResult.data,
    setAt: record.setAt,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
