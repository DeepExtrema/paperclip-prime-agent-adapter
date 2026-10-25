// TAI-273 plan rev 13 §2.2 item 12: the model-catalog check with the level check (TAI-343), then the parent's live model and
// thinking level (rev 11, TAI-342).
// get_model_catalog needs a session (TAI-339 probe t2), so the parent is always created first.

/** The session's live model, from set_model's answer (rev 11). */
export interface PrimeLiveModel { provider: string | null; id: string | null; baseUrl: string | null; reasoning: boolean | null }
/** resultJson.featureProfile.modelCatalog. liveModel is from set_model's answer; thinkingLevel is the parent's level that get_state reported. */
export interface PrimeModelCatalogRecord {
  ok: boolean; checks: number; refreshesSeen: number; liveModel: PrimeLiveModel | null; thinkingLevel: string | null; failure: string | null;
}

export const PRIME_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const CATALOG_WAIT_MS = 15_000;
export const CATALOG_RETRY_MS = 500;
/** With no roster subscription, the catalog is read this often during the run, and once after the last turn. */
export const CATALOG_POLL_MS = 60_000;

type Requester = { request(command: Record<string, unknown> & { type: string }, timeoutMs: number | null): Promise<{ success: boolean; data?: unknown; error?: string }> };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Prime's level order (0.7.1 packages/ai/src/models.ts:64). */
export const PRIME_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Rev 13 (TAI-343 change 2): Prime's own rule, 0.7.1 getSupportedThinkingLevels (packages/ai/src/models.ts:66-75). A level mapped
 * to null is not supported; xhigh and max need a non-null value; the other levels are supported when the key or the map is absent.
 */
export function primeSupportedThinkingLevels(entry: Record<string, unknown>): string[] {
  if (entry.reasoning !== true) return ["off"];
  const map = isObject(entry.thinkingLevelMap) ? entry.thinkingLevelMap : undefined;
  return PRIME_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * Rev 9 narrowed rule: only the allowedModels entries. `wait` is true while an allowed model is not yet listed with reasoning on
 * (the fetch may still land); the address and level checks run only after that, and their failure is final (rev 13).
 */
export function primeCatalogCheck(data: unknown, allowedModels: readonly string[], thinking: string | null): { problem: string | null; wait: boolean } {
  const models = isObject(data) && Array.isArray(data.models) ? data.models.filter(isObject) : null;
  if (!models) return { problem: "get_model_catalog gave no model list", wait: true };
  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const ref of allowedModels) {
    const slash = ref.indexOf("/");
    const entry = models.find((model) => model.provider === ref.slice(0, slash) && model.id === ref.slice(slash + 1));
    if (!entry) return { problem: `${ref} is not listed`, wait: true };
    // Rev 13: whatever thinking is. Before the fetch lands Opus 5.5 has no reasoning, and then supports only "off".
    if (entry.reasoning !== true) return { problem: `${ref} has no reasoning (thinking is ${thinking})`, wait: true };
    entries.push([ref, entry]);
  }
  for (const [ref, entry] of entries) {
    if (entry.provider === "anthropic" && entry.baseUrl !== PRIME_ANTHROPIC_BASE_URL) {
      return { problem: `${ref} has baseUrl ${JSON.stringify(entry.baseUrl ?? null)}, not ${PRIME_ANTHROPIC_BASE_URL}`, wait: false };
    }
    const supported = primeSupportedThinkingLevels(entry);
    if (thinking !== null && !supported.includes(thinking)) {
      return { problem: `thinking level ${thinking} is not supported by ${ref}; supported: ${supported.join(", ")}`, wait: false };
    }
  }
  return { problem: null, wait: false };
}

/** null when the allowed models pass, else the reason. */
export function primeCatalogProblem(data: unknown, allowedModels: readonly string[], thinking: string | null): string | null {
  return primeCatalogCheck(data, allowedModels, thinking).problem;
}

/** One get_model_catalog read with the session's activeSessionId. problem null when the allowed models pass. */
async function readPrimeCatalogCheck(client: Requester, activeSessionId: string, allowedModels: readonly string[], thinking: string | null) {
  const response = await client.request({ type: "get_model_catalog", activeSessionId }, 30_000)
    .catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err), data: undefined }));
  if (!response.success) return { problem: `get_model_catalog failed: ${response.error ?? "no error text"}`, wait: true };
  return primeCatalogCheck(response.data, allowedModels, thinking);
}

/** One get_model_catalog read with the session's activeSessionId. null when the allowed models pass. */
export async function readPrimeCatalogProblem(client: Requester, activeSessionId: string, allowedModels: readonly string[], thinking: string | null): Promise<string | null> {
  return (await readPrimeCatalogCheck(client, activeSessionId, allowedModels, thinking)).problem;
}

/**
 * Before the first prompt: read every 500 ms for up to 15 s, until the allowed models are listed with reasoning on. An address
 * or level failure after that ends the wait at once (rev 13), so no set_model is sent. Counts each read in record.checks.
 */
export async function waitForPrimeCatalog(client: Requester, activeSessionId: string, allowedModels: readonly string[], thinking: string | null,
  record: PrimeModelCatalogRecord, waitMs = CATALOG_WAIT_MS): Promise<string | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    record.checks += 1;
    const { problem, wait } = await readPrimeCatalogCheck(client, activeSessionId, allowedModels, thinking);
    if (problem === null || !wait) return problem;
    if (Date.now() + CATALOG_RETRY_MS > until) return problem;
    await delay(CATALOG_RETRY_MS);
  }
}

/**
 * The thinking-level step (rev 11, TAI-324 F1): set_model with the configured model, then get_state. A session created before
 * the catalog lands keeps its model with no reasoning; set_thinking_level then changes what get_state shows but not the
 * request (get_state cannot tell the two apart). set_model puts the catalog entry on the session, so its answer must be that
 * entry. null when the answer passes and get_state shows the configured level. No set_thinking_level is sent here.
 */
export async function confirmPrimeThinkingLevel(client: Requester, activeSessionId: string, modelRef: string, thinking: string, record: PrimeModelCatalogRecord): Promise<string | null> {
  const slash = modelRef.indexOf("/");
  const [provider, id] = [modelRef.slice(0, slash), modelRef.slice(slash + 1)];
  const set = await client.request({ type: "set_model", activeSessionId, provider, modelId: id }, 30_000)
    .catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err), data: undefined }));
  if (!set.success) return `set_model failed: ${set.error ?? "no error text"}`;
  const answer = isObject(set.data) ? set.data : {};
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  record.liveModel = { provider: text(answer.provider), id: text(answer.id), baseUrl: text(answer.baseUrl), reasoning: typeof answer.reasoning === "boolean" ? answer.reasoning : null };
  if (answer.provider !== provider || answer.id !== id) return `set_model answered ${JSON.stringify(`${answer.provider ?? null}/${answer.id ?? null}`)}, not ${modelRef}`;
  const entry = primeCatalogProblem({ models: [answer] }, [modelRef], thinking);
  if (entry) return `set_model answered ${entry}`;
  const state = await client.request({ type: "get_state", activeSessionId }, 30_000)
    .catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err), data: undefined }));
  const level = state.success && isObject(state.data) && typeof state.data.thinkingLevel === "string" ? state.data.thinkingLevel : null;
  record.thinkingLevel = level;
  if (level === thinking) return null;
  const why = !state.success ? `; get_state failed: ${state.error ?? "no error text"}` : "";
  return `thinking level is ${JSON.stringify(level)}, configured ${JSON.stringify(thinking)}${why}`;
}
