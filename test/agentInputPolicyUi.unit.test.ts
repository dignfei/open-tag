import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  filterAvailableAgentIds,
  MAX_AGENT_INPUT_SOURCES,
  toggleAgentInputSource,
} from "../web/src/lib/agentInputPolicy.ts";
import { isCurrentAgentProfileResponse } from "../web/src/lib/agentProfileLoad.ts";

const src = fs.readFileSync(new URL("../web/src/views/Members.tsx", import.meta.url), "utf8");
const chat = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
const start = src.indexOf("function AgentInputPolicyCard");
const end = src.indexOf("// Profile tab SKILLS", start);
assert.ok(start >= 0 && end > start, "AgentInputPolicyCard implementation must exist");
const editor = src.slice(start, end);
const en = JSON.parse(fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8"));

test("agent input settings render only for managers and live peer candidates", () => {
  assert.match(src, /capabilities\.manageAgents\s*&&\s*a\.creatorType\s*!==\s*"system"\s*&&\s*<AgentInputPolicyCard/);
  assert.match(src, /candidates=\{visibleAgents\.filter\(\(candidate\)\s*=>\s*candidate\.id\s*!==\s*id\)\}/);
  assert.deepEqual(filterAvailableAgentIds(["live", "deleted"], ["live"]), ["live"]);
  assert.match(editor, /const submittedWhitelist = filterAvailableAgentIds\(whitelist, candidateIds\)/);
});

test("agent input selections stop at the server limit", () => {
  const selected = Array.from({ length: MAX_AGENT_INPUT_SOURCES }, (_, index) => `agent-${index}`);
  assert.deepEqual([...toggleAgentInputSource(selected, "overflow")], selected);
  assert.equal(toggleAgentInputSource(selected, "agent-0").has("agent-0"), false);
});

test("agent profile responses stay bound to their request identity", () => {
  assert.equal(isCurrentAgentProfileResponse("a", 1, "a", 1, { id: "a" }), true);
  assert.equal(isCurrentAgentProfileResponse("a", 1, "b", 1, { id: "a" }), false);
  assert.equal(isCurrentAgentProfileResponse("a", 1, "a", 2, { id: "a" }), false);
  assert.equal(isCurrentAgentProfileResponse("a", 1, "a", 1, { id: "b" }), false);
  assert.match(src, /if \(!a \|\| a\.id !== id\) return <div className="scroll">/);
  assert.match(src, /return \(\) => \{ profileLoadVersionRef\.current\+\+; \}/);
  assert.match(src, /<AgentProfile key=\{agentId\} id=\{agentId\}/);
  assert.match(chat, /<AgentProfile key=\{profile\.id\} id=\{profile\.id\}/);
});

test("agent input saves acquire one gate and lock every control", () => {
  const saveStart = editor.indexOf("const save = async");
  const requestAt = editor.indexOf('await api("PATCH"', saveStart);
  const guardAt = editor.indexOf("if (savingRef.current) return", saveStart);
  const acquireRefAt = editor.indexOf("savingRef.current = true", saveStart);
  const acquireUiAt = editor.indexOf("setSaving(true)", saveStart);
  assert.ok(guardAt >= 0 && acquireRefAt > guardAt && acquireUiAt > guardAt && requestAt > acquireUiAt);
  assert.equal(editor.match(/disabled=\{saving\}/g)?.length, 2, "mode and Save must lock in flight");
  assert.match(editor, /disabled=\{saving \|\| \(!whitelist\.has\(candidate\.id\) && whitelistFull\)\}/);
  assert.match(editor, /<div className="perm-head"[^>]*>\s*<button className="ok" disabled=\{saving\}/);
  assert.match(styles, /\.perm-head \.ok:disabled\{opacity:\.5;cursor:default\}/);
  assert.match(editor, /inputPolicyWhitelistLimit", \{ count: MAX_AGENT_INPUT_SOURCES \}/);
  assert.equal(en.members.inputPolicyWhitelistLimit, "Select up to {{count}} agents.");
  assert.equal(zh.members.inputPolicyWhitelistLimit, "最多选择 {{count}} 个 agent。");
});

test("agent input saves validate the complete response before adopting it", () => {
  const saveStart = editor.indexOf("const save = async");
  const requestAt = editor.indexOf('await api("PATCH"', saveStart);
  const okAt = editor.indexOf("result?.ok !== true", requestAt);
  const modeAt = editor.indexOf('result?.incomingMode === "open"', requestAt);
  const arrayAt = editor.indexOf("Array.isArray(result?.commandWhitelist)", requestAt);
  const stringsAt = editor.indexOf('typeof id === "string"', arrayAt);
  const setModeAt = editor.indexOf("setMode(policy.incomingMode)", requestAt);
  const setWhitelistAt = editor.indexOf("setWhitelist(new Set(policy.commandWhitelist))", requestAt);
  const onSavedAt = editor.indexOf("onSaved(policy)", requestAt);
  assert.ok(okAt > requestAt && modeAt > requestAt && arrayAt > requestAt && stringsAt > arrayAt);
  assert.ok(setModeAt > okAt && setModeAt > modeAt && setModeAt > stringsAt);
  assert.ok(setWhitelistAt > setModeAt && onSavedAt > setWhitelistAt);
});

test("agent input failures retain selections and use localized feedback", () => {
  const catchAt = editor.indexOf("} catch {");
  const finallyAt = editor.indexOf("} finally {", catchAt);
  const failure = editor.slice(catchAt, finallyAt);
  assert.match(failure, /toast\.error\(t\("members\.inputPolicySaveFailed"\)\)/);
  assert.doesNotMatch(failure, /setMode\(|setWhitelist\(|onSaved\(/);
  assert.equal(en.members.inputPolicySaveFailed, "Couldn't save agent input settings. Your selections were kept; try again.");
  assert.equal(zh.members.inputPolicySaveFailed, "保存 agent 输入设置失败。已保留当前选择，请重试。");
});

test("late agent input save responses stay silent after profile close", () => {
  assert.match(editor, /const mountedRef = useRef\(true\)/);
  assert.match(
    editor,
    /useEffect\(\(\) => \{\s*mountedRef\.current = true;\s*return \(\) => \{ mountedRef\.current = false; \};\s*\}, \[\]\)/,
    "Strict Mode effect replay must reactivate the mounted guard",
  );
  const requestAt = editor.indexOf('await api("PATCH"');
  const inactiveAt = editor.indexOf("if (!mountedRef.current) return", requestAt);
  const validateAt = editor.indexOf("const validMode", requestAt);
  const catchAt = editor.indexOf("} catch {", requestAt);
  const catchGuardAt = editor.indexOf("if (mountedRef.current) toast.error", catchAt);
  const finallyAt = editor.indexOf("} finally {", catchAt);
  const releaseGuardAt = editor.indexOf("if (mountedRef.current)", finallyAt);
  const releaseAt = editor.indexOf("savingRef.current = false", finallyAt);
  assert.ok(inactiveAt > requestAt && validateAt > inactiveAt);
  assert.ok(catchGuardAt > catchAt && releaseGuardAt > finallyAt && releaseAt > releaseGuardAt);
});
