// Regression contracts for saved-message mutations.
// Run: npx tsx --test --test-force-exit test/savedMessageFailure.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const storeSrc = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
const chatSrc = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");
const miscSrc = fs.readFileSync(new URL("../web/src/views/misc.tsx", import.meta.url), "utf8");

test("bookmark state changes only after successful API responses", () => {
  assert.match(storeSrc, /const saveMsg = async[\s\S]*?await api\("POST", "\/api\/channels\/saved"[\s\S]*?if \(r\?\.error\) return false;[\s\S]*?setSavedIds/);
  assert.match(storeSrc, /const unsaveMsg = async[\s\S]*?await api\("DELETE", `\/api\/channels\/saved\/\$\{messageId\}`\);[\s\S]*?if \(r\?\.error\) return false;[\s\S]*?setSavedIds/);
  assert.match(storeSrc, /catch \{ return false; \}/, "network failures must leave bookmark state unchanged");
});

test("bookmark controls surface failures and the Saved page keeps failed removals", () => {
  assert.match(chatSrc, /const ok = await \(isSaved \? unsaveMsg\(messageId\) : saveMsg\(messageId\)\);/);
  assert.match(chatSrc, /if \(!ok\) toast\.error\(t\("common\.savedUpdateFailed"\)\);/);
  assert.match(miscSrc, /if \(unsaving\.current\.has\(it\.messageId\)\) return;[\s\S]*?unsaving\.current\.add\(it\.messageId\)/, "duplicate removals must not corrupt pagination state");
  assert.match(miscSrc, /if \(!await unsaveMsg\(it\.messageId\)\) \{ toast\.error\(t\("common\.savedUpdateFailed"\)\); return; \}[\s\S]*?setItems[\s\S]*?finally \{ unsaving\.current\.delete\(it\.messageId\); \}/);
});
