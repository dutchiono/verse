import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { makeLogger } from "./logger.ts";
import {
  validateSequencer,
  type SequencerAction,
  type SequencerLoopMode,
  type SequencerSchedule,
  type SequencerSize,
  type SequencerStep,
} from "./pools-store.ts";

const log = makeLogger("sequences-store");
const PATH = "config/sequences.json";

/** Saved queue + knobs (no runtime `active` flag — that stays per pool). */
export interface SequencerPreset {
  queue: SequencerStep[];
  action: SequencerAction;
  schedule: SequencerSchedule;
  size: SequencerSize;
  loop_mode: SequencerLoopMode;
}

export interface SavedSequence extends SequencerPreset {
  id: string;
  name: string;
  updatedAt: number;
}

interface SequencesFile {
  version: 1;
  sequences: SavedSequence[];
}

function newId(): string {
  return `seq_${randomBytes(8).toString("hex")}`;
}

class SequencesStore extends EventEmitter {
  private cache: SequencesFile | null = null;

  private read(): SequencesFile {
    if (this.cache) return this.cache;
    if (!existsSync(PATH)) {
      this.cache = { version: 1, sequences: [] };
      return this.cache;
    }
    const raw = readFileSync(PATH, "utf8");
    const parsed = JSON.parse(raw) as SequencesFile;
    if (!parsed.sequences || !Array.isArray(parsed.sequences)) {
      this.cache = { version: 1, sequences: [] };
      return this.cache;
    }
    this.cache = { version: 1, sequences: parsed.sequences };
    return this.cache;
  }

  private write(file: SequencesFile): void {
    writeFileSync(PATH, JSON.stringify(file, null, 2));
    this.cache = file;
  }

  list(): SavedSequence[] {
    return [...this.read().sequences];
  }

  get(id: string): SavedSequence | undefined {
    return this.read().sequences.find((s) => s.id === id);
  }

  add(input: { name: string } & SequencerPreset): SavedSequence {
    const name = input.name.trim();
    if (!name) throw new Error("sequence name required");
    const preset: SequencerPreset = {
      queue: input.queue,
      action: input.action,
      schedule: input.schedule,
      size: input.size,
      loop_mode: input.loop_mode,
    };
    validateSequencer({ active: false, ...preset });
    const file = this.read();
    const row: SavedSequence = {
      id: newId(),
      name,
      updatedAt: Date.now(),
      queue: input.queue,
      action: input.action,
      schedule: input.schedule,
      size: input.size,
      loop_mode: input.loop_mode,
    };
    file.sequences.push(row);
    this.write(file);
    log.info("sequence saved", { id: row.id, name: row.name });
    this.emit("change", { type: "added", id: row.id });
    return row;
  }

  update(id: string, patch: Partial<{ name: string } & SequencerPreset>): SavedSequence {
    const file = this.read();
    const idx = file.sequences.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`sequence not found: ${id}`);
    const cur = file.sequences[idx]!;
    const next: SavedSequence = {
      ...cur,
      ...patch,
      name: patch.name !== undefined ? patch.name.trim() || cur.name : cur.name,
      id: cur.id,
      updatedAt: Date.now(),
    };
    const preset: SequencerPreset = {
      queue: next.queue,
      action: next.action,
      schedule: next.schedule,
      size: next.size,
      loop_mode: next.loop_mode,
    };
    validateSequencer({ active: false, ...preset });
    file.sequences[idx] = next;
    this.write(file);
    log.info("sequence updated", { id });
    this.emit("change", { type: "updated", id });
    return next;
  }

  remove(id: string): void {
    const file = this.read();
    const before = file.sequences.length;
    file.sequences = file.sequences.filter((s) => s.id !== id);
    if (file.sequences.length === before) throw new Error(`sequence not found: ${id}`);
    this.write(file);
    log.info("sequence removed", { id });
    this.emit("change", { type: "removed", id });
  }
}

export const sequences = new SequencesStore();
