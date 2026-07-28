import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

test("Docker builds browser assets with production condition exports", () => {
  assert.match(dockerfile, /RUN NODE_ENV=production npm run site:build/);
});

test("Docker runtime includes the explicit reply-index migration used by db:push", () => {
  assert.match(
    dockerfile,
    /COPY --from=build \/app\/scripts\/migrate-reply-coordination-directed\.mjs \.\/scripts\/migrate-reply-coordination-directed\.mjs/,
  );
  assert.match(dockerfile, /COPY scripts\/docker-entrypoint\.sh \/usr\/local\/bin\/docker-entrypoint\.sh/);
});
