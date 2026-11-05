import { randomUUID } from "node:crypto";

export type MemoryRecord = {
  id: string;
  workspaceId: string;
  projectId: string;
  text: string;
  tags: string[];
  createdAt: string;
};

export class ScopedMemory {
  #records: MemoryRecord[] = [];
  #listeners = new Set<(record: MemoryRecord) => void>();

  /** Notified after every new record; used by durable state sinks. */
  subscribe(listener: (record: MemoryRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Replace all records with persisted ones (newest first). Does not notify listeners. */
  load(records: MemoryRecord[]): void {
    this.#records = [...records];
  }

  records(): MemoryRecord[] {
    return [...this.#records];
  }

  remember(input: Omit<MemoryRecord, "id" | "createdAt">): MemoryRecord {
    const record: MemoryRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.#records.unshift(record);
    for (const listener of this.#listeners) listener(record);
    return record;
  }

  query(workspaceId: string, projectId: string, query: string, limit = 8): MemoryRecord[] {
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
    return this.#records
      .filter((record) => record.workspaceId === workspaceId && record.projectId === projectId)
      .map((record) => ({
        record,
        score: terms.reduce(
          (score, term) => score + Number(record.text.toLowerCase().includes(term)),
          0,
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ record }) => record);
  }
}
