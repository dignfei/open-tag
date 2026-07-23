import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

test("Docker builds browser assets with production condition exports", () => {
  assert.match(dockerfile, /RUN NODE_ENV=production npm run site:build/);
});
