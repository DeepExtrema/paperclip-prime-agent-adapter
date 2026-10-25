// Records the golden side of TAI-273's rule from an adapter build: node test/golden/record.mjs <dist/server/execute.js> <out.json>
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { goldenRuns } from "./golden-runs.mjs";

const [executeModule, out] = process.argv.slice(2);
const { execute } = await import(pathToFileURL(executeModule).href);
writeFileSync(out, `${JSON.stringify(await goldenRuns(execute), null, 2)}\n`);
