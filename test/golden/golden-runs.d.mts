export declare const GOLDEN_CONFIGS: Record<string, { config: Record<string, unknown>; env: Record<string, string>; settings?: Record<string, unknown> }>;
export declare function goldenRuns(execute: (ctx: unknown) => Promise<unknown>): Promise<Record<string, unknown>>;
