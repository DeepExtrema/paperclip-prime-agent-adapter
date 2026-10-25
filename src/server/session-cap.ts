// TAI-273 plan rev 7 §2.2 item 2: the per-run session cap, keyed by sessionId, and the item 1 isQuotaParked backstop.
// Sessions are learned from roster_subscribe (roster_update events), rlm_child_update events and `list` (N0 items 3-5).

export interface PrimeRosterRow {
  activeSessionId: string;
  sessionId: string;
  depth: number;
  parentActiveSessionId: string | null;
  rlmChildId: string | null;
  sessionFile: string | null;
  workerPid: number | null;
  /** The row shows work: a turn, streaming, tools or bash. */
  active: boolean;
  quotaParked: boolean;
}

type DaemonAnswer = { success: boolean; data?: unknown; error?: string };
export interface PrimeTrackerClient {
  request(command: Record<string, unknown> & { type: string }, timeoutMs: number | null): Promise<DaemonAnswer>;
}
export interface PrimeTrackerViolation { code: "prime_subagent_limit_exceeded" | "prime_provider_quota"; message: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const POLL_MS = 5000;
const DELETE_ATTEMPTS = 20;

/** A flat `list` row, or a roster_subscribe / roster_update item `{ summary }`. */
export function readPrimeRosterRow(value: unknown): PrimeRosterRow | null {
  const row = isObject(value) && isObject(value.summary) ? value.summary : value;
  if (!isObject(row)) return null;
  const activeSessionId = str(row.activeSessionId) ?? str(row.id);
  const sessionId = str(row.sessionId);
  if (!activeSessionId || !sessionId) return null;
  return {
    activeSessionId, sessionId, depth: typeof row.rlmDepth === "number" ? row.rlmDepth : 0,
    parentActiveSessionId: str(row.parentActiveSessionId), rlmChildId: str(row.rlmChildId), sessionFile: str(row.sessionFile),
    workerPid: typeof row.workerPid === "number" ? row.workerPid : null,
    active: row.isSessionActive === true || row.isStreaming === true || row.isRunningTools === true || row.isBashRunning === true || row.activity === "working",
    quotaParked: row.isQuotaParked === true,
  };
}

type Ended = { activeSessionId: string; confirmed: boolean };

export class PrimeSessionTracker {
  private readonly seen = new Set<string>();
  private readonly ended = new Map<string, Ended>();
  private readonly endedOrder: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private poll: NodeJS.Timeout | null = null;
  private listing: Promise<void> | null = null;
  private disposed = false;
  violation: PrimeTrackerViolation | null = null;

  constructor(private readonly options: {
    client: PrimeTrackerClient;
    /** The run parent: never counted. */
    parent: { activeSessionId: string; sessionId: string };
    cap: number;
    onViolation: (violation: PrimeTrackerViolation) => void;
    onLog: (line: string) => void;
    /** Every row seen (model audit, worker pids). */
    onRow: (row: PrimeRosterRow) => void;
  }) {}

  /** A session this tracker ended (by its activeSessionId at the time): the parent's wait for it is over. */
  isEnded(activeSessionId: string): boolean {
    return [...this.ended.values()].some((entry) => entry.activeSessionId === activeSessionId);
  }

  /** Sessions other than the parent seen in this run, finished ones included. */
  get sessions(): number { return this.seen.size; }
  get sessionsEnded(): string[] { return [...this.endedOrder]; }

  /** Subscribes to roster updates; on refusal, logs one line and lists every 5 s instead. */
  async start(): Promise<void> {
    const response: DaemonAnswer = await this.options.client.request({ type: "roster_subscribe" }, 30_000)
      .catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }));
    if (response.success) {
      const roster = isObject(response.data) && Array.isArray(response.data.roster) ? response.data.roster : [];
      this.ingest(roster);
      return;
    }
    this.options.onLog(`[paperclip] Prime roster subscription failed (${response.error ?? "no error text"}); listing sessions every 5 s instead.\n`);
    this.poll = setInterval(() => void this.list(), POLL_MS);
  }

  /** One `list`, ingested. Concurrent calls share one request. */
  list(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.listing ??= this.options.client.request({ type: "list" }, 30_000).then((response) => {
      if (response.success && isObject(response.data) && Array.isArray(response.data.sessions)) this.ingest(response.data.sessions);
    }, () => undefined).finally(() => { this.listing = null; });
    return this.listing;
  }

  /** A roster_update, or rows from any other source. */
  ingest(values: unknown[]): void {
    for (const value of values) {
      const row = readPrimeRosterRow(value);
      if (!row) continue;
      this.options.onRow(row);
      if (row.quotaParked) this.fail({ code: "prime_provider_quota", message: `Prime parked session ${row.sessionId} on a usage limit (isQuotaParked).` });
      if (row.sessionId === this.options.parent.sessionId || row.activeSessionId === this.options.parent.activeSessionId) continue;
      const ended = this.ended.get(row.sessionId);
      if (ended) {
        if (ended.confirmed && (row.activeSessionId !== ended.activeSessionId || row.active)) {
          this.fail({ code: "prime_subagent_limit_exceeded", message: `Ended session ${row.sessionId} was seen running again (active session ${row.activeSessionId}).` });
        }
        continue;
      }
      if (this.seen.has(row.sessionId)) continue;
      this.seen.add(row.sessionId);
      if (this.seen.size > this.options.cap) this.end(row);
    }
  }

  /** Waits for every end the tracker started. */
  async settle(): Promise<void> {
    for (let chain = this.chain; ; chain = this.chain) {
      await chain;
      if (chain === this.chain) return;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.poll) clearInterval(this.poll);
  }

  private fail(violation: PrimeTrackerViolation): void {
    if (this.violation) return;
    this.violation = violation;
    this.options.onViolation(violation);
  }

  private end(row: PrimeRosterRow): void {
    this.ended.set(row.sessionId, { activeSessionId: row.activeSessionId, confirmed: false });
    this.endedOrder.push(row.sessionId);
    this.chain = this.chain.then(() => this.endNow(row)).catch((err: unknown) => {
      this.fail({ code: "prime_subagent_limit_exceeded", message: `Could not end session ${row.sessionId}: ${err instanceof Error ? err.message : String(err)}` });
    });
  }

  /** N0 item 3: depth >= 1 needs cancel_rlm_child then delete_rlm_subagent; depth 0 needs kill. Then the roster must not list it. */
  private async endNow(row: PrimeRosterRow): Promise<void> {
    const { client } = this.options;
    const refuse = (why: string): never => { throw new Error(why); };
    if (row.depth >= 1) {
      if (!row.rlmChildId) refuse("the roster row has no rlmChildId");
      const parent = row.parentActiveSessionId ?? this.options.parent.activeSessionId; // a woken old child has no parent id
      const command = { activeSessionId: parent, childId: row.rlmChildId };
      const cancelled = await client.request({ type: "cancel_rlm_child", ...command }, 30_000);
      if (!cancelled.success) refuse(`cancel_rlm_child failed: ${cancelled.error ?? "no error text"}`);
      let deleted = false;
      for (let attempt = 0; attempt < DELETE_ATTEMPTS && !deleted; attempt += 1) {
        const answer = await client.request({ type: "delete_rlm_subagent", ...command }, 30_000);
        if (!answer.success) refuse(`delete_rlm_subagent failed: ${answer.error ?? "no error text"}`);
        deleted = isObject(answer.data) && answer.data.deleted === true;
        if (!deleted) await delay(100);
      }
      if (!deleted) refuse("delete_rlm_subagent did not answer deleted: true");
    } else {
      const killed = await client.request({ type: "kill", activeSessionId: row.activeSessionId }, 30_000);
      if (!killed.success) refuse(`kill failed: ${killed.error ?? "no error text"}`);
    }
    const listed = await client.request({ type: "list" }, 30_000);
    const rows = listed.success && isObject(listed.data) && Array.isArray(listed.data.sessions) ? listed.data.sessions : null;
    if (!rows) refuse(`list failed: ${listed.error ?? "no error text"}`);
    if (rows!.some((value) => readPrimeRosterRow(value)?.sessionId === row.sessionId)) refuse("the roster still lists it");
    this.ended.get(row.sessionId)!.confirmed = true;
    this.options.onLog(`[paperclip] session limit ${this.options.cap} reached; ended session ${row.sessionId}\n`);
    this.ingest(rows!);
  }
}
