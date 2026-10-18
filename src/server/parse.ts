// Owner: WP2. Contract: INTERFACES.md §6. Replace the stub bodies; keep the typed exports.
import { notImplemented } from "../errors.js";
import type { IsPrimeUnknownSessionError, ParsePrimeJsonl } from "../types.js";

export const parsePrimeJsonl: ParsePrimeJsonl = () => notImplemented("WP2", "parsePrimeJsonl");

export const isPrimeUnknownSessionError: IsPrimeUnknownSessionError = () =>
  notImplemented("WP2", "isPrimeUnknownSessionError");
