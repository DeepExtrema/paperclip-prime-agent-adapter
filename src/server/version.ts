// Owner: WP5. Contract: INTERFACES.md §8. Replace the stub bodies; keep the typed exports.
import { notImplemented } from "../errors.js";
import type { IsSupportedPrimeVersion, ReadPrimeVersion } from "../types.js";

export const readPrimeVersion: ReadPrimeVersion = async () => notImplemented("WP5", "readPrimeVersion");

export const isSupportedPrimeVersion: IsSupportedPrimeVersion = () =>
  notImplemented("WP5", "isSupportedPrimeVersion");
