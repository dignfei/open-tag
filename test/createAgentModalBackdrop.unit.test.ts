import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("create agent keeps a filled form open after backdrop clicks", () => {
  const src = fs.readFileSync(new URL("../web/src/views/Members.tsx", import.meta.url), "utf8");
  const start = src.indexOf("export function CreateAgentModal");
  const end = src.indexOf("// Human member profile", start);
  const modal = src.slice(start, end);

  assert.match(modal, /<div className="modal-bg">\s*<div className="modal">/);
  assert.doesNotMatch(modal, /className="modal-bg" onClick=/);
  assert.match(modal, /useEscClose\(\(\) => \{ if \(projectPickerOpen\) setProjectPickerOpen\(false\); else onClose\(\); \}\);/);
  assert.match(modal, /<button className="cancel" onClick=\{onClose\}>/);
});
