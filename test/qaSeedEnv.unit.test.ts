import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/db/qa-seed.ts", import.meta.url), "utf8");

test("qa seed loads ENV_FILE before constructing the database client", () => {
  const envImport = source.indexOf('import "../env.js"');
  const dbImport = source.indexOf('from "./index.js"');

  assert.notEqual(envImport, -1, "qa-seed must load src/env.ts");
  assert.ok(envImport < dbImport, "the env side effect must run before db/index.ts reads DATABASE_URL");
});
