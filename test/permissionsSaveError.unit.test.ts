import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/src/views/Members.tsx", import.meta.url), "utf8");
const start = src.indexOf("function PermissionsTab");
const end = src.indexOf("function AppsTab", start);
assert.ok(start >= 0 && end > start, "PermissionsTab implementation must exist");
const permissions = src.slice(start, end);

test("members without manageAgents can inspect but cannot edit agent permissions", () => {
  assert.match(permissions, /const\s*\{[^}]*\bcapabilities\b[^}]*\}\s*=\s*useStore\(\)/);
  assert.match(permissions, /const canManage\s*=\s*!!capabilities\.manageAgents/);
  assert.match(permissions, /if\s*\(\s*!canManage\s*\)\s*return/);
  assert.match(
    permissions,
    /\{canManage\s*&&\s*<>[\s\S]*t\("members\.grantAll"\)[\s\S]*t\("members\.save"\)[\s\S]*<\/>\}/,
    "Grant all and Save must only render for members who can manage agents",
  );
  assert.match(
    permissions,
    /<input\s+type="checkbox"[^>]*disabled=\{!canManage\}/,
    "read-only members must not be able to change local checkbox state",
  );
});
