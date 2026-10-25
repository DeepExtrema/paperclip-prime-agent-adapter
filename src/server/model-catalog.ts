// TAI-273 plan rev 12 §2.2 item 12: the model-catalog check, then the parent's live model and thinking level (rev 11, TAI-342).
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

/** Rev 9 narrowed rule: only the allowedModels entries. null when they pass, else the reason. */
export function primeCatalogProblem(data: unknown, allowedModels: readonly string[], thinking: string | null): string | null {
  const models = isObject(data) && Array.isArray(data.models) ? data.models.filter(isObject) : null;
  if (!models) return "get_model_catalog gave no model list";
  for (const ref of allowedModels) {
    const slash = ref.indexOf("/");
    const provider = ref.slice(0, slash);
    const id = ref.slice(slash + 1);
    const entry = models.find((model) => model.provider === provider && model.id === id);
    if (!entry) return `${ref} is not listed`;
    if (provider === "anthropic" && entry.baseUrl !== PRIME_ANTHROPIC_BASE_URL) return `${ref} has baseUrl ${JSON.stringify(entry.baseUrl ?? null)}, not ${PRIME_ANTHROPIC_BASE_URL}`;
    if (thinking !== null && thinking !== "off" && entry.reasoning !== true) return `${ref} has no reasoning (thinking is ${thinking})`;
  }
  return null;
}

/** One get_model_catalog read with the session's activeSessionId. null when the allowed models pass. */
export async function readPrimeCatalogProblem(client: Requester, activeSessionId: string, allowedModels: readonly string[], thinking: string | null): Promise<string | null> {
  const response = await client.request({ type: "get_model_catalog", activeSessionId }, 30_000)
    .catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err), data: undefined }));
  if (!response.success) return `get_model_catalog failed: ${response.error ?? "no error text"}`;
  return primeCatalogProblem(response.data, allowedModels, thinking);
}

/** Before the first prompt: read every 500 ms for up to 15 s, until the allowed models pass. Counts each read in record.checks. */
export async function waitForPrimeCatalog(client: Requester, activeSessionId: string, allowedModels: readonly string[], thinking: string | null,
  record: PrimeModelCatalogRecord, waitMs = CATALOG_WAIT_MS): Promise<string | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    record.checks += 1;
    const problem = await readPrimeCatalogProblem(client, activeSessionId, allowedModels, thinking);
    if (problem === null) return null;
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
