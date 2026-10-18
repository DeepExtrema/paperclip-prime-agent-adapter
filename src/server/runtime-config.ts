// Owner: WP1. Contract: INTERFACES.md §2-§4. Replace the stub bodies; keep the typed exports.
import { notImplemented } from "../errors.js";
import type {
  BuildPrimeChildEnv,
  CreateEphemeralPrimeAgentDir,
  ResolvePrimeRuntimeConfig,
  SeedPrimeAgentDir,
} from "../types.js";

export const resolvePrimeRuntimeConfig: ResolvePrimeRuntimeConfig = () =>
  notImplemented("WP1", "resolvePrimeRuntimeConfig");

export const seedPrimeAgentDir: SeedPrimeAgentDir = async () => notImplemented("WP1", "seedPrimeAgentDir");

export const createEphemeralPrimeAgentDir: CreateEphemeralPrimeAgentDir = async () =>
  notImplemented("WP1", "createEphemeralPrimeAgentDir");

export const buildPrimeChildEnv: BuildPrimeChildEnv = () => notImplemented("WP1", "buildPrimeChildEnv");
