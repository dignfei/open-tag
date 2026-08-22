import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("agent profiles expose a permission-gated session reset", () => {
  const members = fs.readFileSync(new URL("../web/src/views/Members.tsx", import.meta.url), "utf8");
  const actions = members.slice(members.indexOf("const acts ="), members.indexOf("return (", members.indexOf("const acts =")));
  const managedActions = actions.slice(actions.indexOf("{capabilities.manageAgents && <>"), actions.indexOf("</>}") + 4);

  assert.match(managedActions, /onClick=\{clearSession\}>\{t\("members\.clearSession"\)\}/);
  assert.match(members, /title: t\("members\.clearSessionTitle", \{ name: a\.displayName \|\| a\.name \}\)/);
  assert.match(members, /message: t\("members\.resetDesc"\)/);
  assert.match(members, /confirmLabel: t\("members\.clearSession"\)/);
  assert.match(members, /const clearSession = async \(\) => \{[\s\S]*?await doRestart\("reset"\);[\s\S]*?\n  \};/);
  assert.match(members, /mode === "reset"\) r = await api\("POST", `\/api\/agents\/\$\{id\}\/reset`, \{ restart: true \}\)/);
});

test("session reset labels describe the immediate restart", () => {
  const en = JSON.parse(fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8"));
  const zh = JSON.parse(fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8"));

  assert.equal(en.members.clearSession, "Clear session");
  assert.match(en.members.clearSessionTitle, /restart/);
  assert.match(en.members.resetDesc, /workspace files .* preserved/);
  assert.equal(zh.members.clearSession, "清会话");
  assert.match(zh.members.clearSessionTitle, /重启/);
  assert.match(zh.members.resetDesc, /工作区文件.*保留/);
});
