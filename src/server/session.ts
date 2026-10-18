// Owner: WP4. Contract: INTERFACES.md §7. Replace the stub bodies; keep the typed exports.
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { notImplemented } from "../errors.js";
import type { DecidePrimeResume, ReadPrimeSessionHeader } from "../types.js";

export const primeSessionCodec: AdapterSessionCodec = {
  deserialize: () => notImplemented("WP4", "primeSessionCodec.deserialize"),
  serialize: () => notImplemented("WP4", "primeSessionCodec.serialize"),
  getDisplayId: () => notImplemented("WP4", "primeSessionCodec.getDisplayId"),
};

export const readPrimeSessionHeader: ReadPrimeSessionHeader = async () =>
  notImplemented("WP4", "readPrimeSessionHeader");

export const decidePrimeResume: DecidePrimeResume = () => notImplemented("WP4", "decidePrimeResume");
