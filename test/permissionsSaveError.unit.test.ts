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
  assert.match(permissions, /if\s*\(\s*!canManage\s*\|\|/);
  assert.match(
    permissions,
    /\{canManage\s*&&\s*<>[\s\S]*t\("members\.grantAll"\)[\s\S]*t\("members\.save"\)[\s\S]*<\/>\}/,
    "Grant all and Save must only render for members who can manage agents",
  );
  assert.match(
    permissions,
    /<input\s+type="checkbox"[^>]*disabled=\{!canManage\s*\|\|/,
    "read-only members must not be able to change local checkbox state",
  );
});

test("permission saves block overlap and always release the active-view gate", () => {
  assert.match(permissions, /const \[saving, setSaving\] = useState\(false\)/);
  assert.match(permissions, /const savingRef = useRef\(false\)/);

  const saveStart = permissions.indexOf("const save = async");
  const saveEnd = permissions.indexOf("const groups", saveStart);
  const save = permissions.slice(saveStart, saveEnd);
  const guardAt = save.search(/if\s*\(\s*!canManage\s*\|\|\s*savingRef\.current\s*\)\s*return/);
  const acquireRefAt = save.indexOf("savingRef.current = true");
  const acquireUiAt = save.indexOf("setSaving(true)");
  const requestAt = save.indexOf('await api("PUT"');
  const finallyAt = save.indexOf("finally", requestAt);
  const releaseRefAt = save.indexOf("savingRef.current = false", finallyAt);
  const releaseUiAt = save.indexOf("setSaving(false)", finallyAt);

  assert.ok(
    guardAt >= 0 && acquireRefAt > guardAt && acquireUiAt > guardAt
      && requestAt > acquireRefAt && requestAt > acquireUiAt,
    "the save handler must acquire its gate before issuing the PUT",
  );
  assert.ok(
    finallyAt > requestAt && releaseRefAt > finallyAt && releaseUiAt > finallyAt,
    "success and failure must both release the save gate",
  );

  const grantLabelAt = permissions.indexOf('{t("members.grantAll")}');
  const grantButtonAt = permissions.lastIndexOf("<button", grantLabelAt);
  const saveLabelAt = permissions.indexOf('{t("members.save")}', grantLabelAt);
  const saveButtonAt = permissions.lastIndexOf("<button", saveLabelAt);
  assert.match(permissions.slice(grantButtonAt, grantLabelAt), /disabled=\{saving\}/);
  assert.match(permissions.slice(saveButtonAt, saveLabelAt), /disabled=\{saving\}/);
  assert.match(permissions, /<input\s+type="checkbox"[^>]*disabled=\{!canManage\s*\|\|\s*saving\}/);
});
