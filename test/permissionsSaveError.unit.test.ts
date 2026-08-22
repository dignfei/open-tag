import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/src/views/Members.tsx", import.meta.url), "utf8");
const start = src.indexOf("function PermissionsTab");
const end = src.indexOf("function AppsTab", start);
assert.ok(start >= 0 && end > start, "PermissionsTab implementation must exist");
const permissions = src.slice(start, end);
const en = JSON.parse(fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8"));

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

test("permission save failures preserve state and show localized feedback", () => {
  const saveStart = permissions.indexOf("const save = async");
  const saveEnd = permissions.indexOf("const groups", saveStart);
  const save = permissions.slice(saveStart, saveEnd);
  const requestAt = save.indexOf('await api("PUT"');
  const errorGuardAt = save.search(/if\s*\(\s*result\?\.error\s*\)\s*throw/);
  const successDataAt = save.indexOf("setData(", requestAt);
  const successGrantedAt = save.indexOf("setGranted(", requestAt);
  const successSavedAt = save.indexOf("setSaved(true)", requestAt);
  const catchAt = save.indexOf("catch", successSavedAt);
  const feedbackAt = save.indexOf('toast.error(t("members.permissionsSaveFailed"))', catchAt);
  const finallyAt = save.indexOf("finally", feedbackAt);

  assert.ok(
    requestAt >= 0 && errorGuardAt > requestAt && successDataAt > errorGuardAt
      && successGrantedAt > errorGuardAt && successSavedAt > errorGuardAt,
    "resolved API errors must be rejected before success state is committed",
  );
  assert.ok(catchAt > successSavedAt && feedbackAt > catchAt && finallyAt > feedbackAt);
  assert.doesNotMatch(
    save.slice(catchAt, finallyAt),
    /set(?:Data|Granted)\(|setSaved\(true\)/,
    "the failure path must not replace the current permission state",
  );
  assert.equal(en.members.permissionsSaveFailed, "Couldn't save agent permissions. Try again.");
  assert.equal(zh.members.permissionsSaveFailed, "保存 agent 权限失败，请重试。");
});

test("permission saves adopt only the expected success envelope", () => {
  const saveStart = permissions.indexOf("const save = async");
  const saveEnd = permissions.indexOf("const groups", saveStart);
  const save = permissions.slice(saveStart, saveEnd);
  const requestAt = save.indexOf('await api("PUT"');
  const agentAt = save.indexOf("?.agentId !== id", requestAt);
  const modeAt = save.indexOf('?.mode !== "custom"', requestAt);
  const revisionAt = save.indexOf("Number.isInteger(", requestAt);
  const grantedArrayAt = save.indexOf("Array.isArray(", requestAt);
  const grantedStringsAt = save.indexOf('typeof scope === "string"', requestAt);
  const successDataAt = save.indexOf("setData(", requestAt);
  const successGrantedAt = save.indexOf("setGranted(", requestAt);
  const successSavedAt = save.indexOf("setSaved(true)", requestAt);

  assert.ok(
    agentAt > requestAt && modeAt > requestAt && revisionAt > requestAt
      && grantedArrayAt > requestAt && grantedStringsAt > requestAt
      && successDataAt > agentAt && successDataAt > modeAt && successDataAt > revisionAt
      && successDataAt > grantedArrayAt && successDataAt > grantedStringsAt
      && successGrantedAt > grantedStringsAt && successSavedAt > grantedStringsAt,
    "local state and Saved must follow validation of every consumed response field",
  );
});

test("permission state and confirmation timers stay with the selected agent", () => {
  assert.match(
    src,
    /tab === "permissions"\s*\?\s*<PermissionsTab\s+key=\{id\}\s+id=\{id\}\s*\/>/,
    "switching agents must remount the permissions panel",
  );
  assert.match(
    permissions,
    /const savedTimerRef = useRef<ReturnType<typeof setTimeout> \| null>\(null\)/,
  );
  assert.match(
    permissions,
    /useEffect\(\(\) => \(\) => \{ if \(savedTimerRef\.current\) clearTimeout\(savedTimerRef\.current\); \}, \[\]\)/,
    "unmounting the panel must clear its pending confirmation timer",
  );

  const saveStart = permissions.indexOf("const save = async");
  const saveEnd = permissions.indexOf("const groups", saveStart);
  const save = permissions.slice(saveStart, saveEnd);
  const clearAt = save.indexOf("clearTimeout(savedTimerRef.current)");
  const requestAt = save.indexOf('await api("PUT"');
  const scheduleAt = save.indexOf("savedTimerRef.current = setTimeout", requestAt);

  assert.ok(clearAt >= 0 && clearAt < requestAt, "a new save must clear the previous confirmation timer");
  assert.ok(scheduleAt > requestAt, "a successful save must retain its confirmation timer for cleanup");
});
