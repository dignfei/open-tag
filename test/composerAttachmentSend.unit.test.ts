import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canSendComposerDraft } from "../web/src/views/Composer.tsx";

test("composer sends only text or a fully uploaded attachment queue", () => {
  assert.equal(canSendComposerDraft("", []), false);
  assert.equal(canSendComposerDraft("hello", []), true);
  assert.equal(canSendComposerDraft("", [{ status: "done" }]), true);
  assert.equal(canSendComposerDraft("hello", [{}]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "uploading" }]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "error" }]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "unknown" }]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "done" }, { status: "uploading" }]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "done" }, { status: "error" }]), false);
});

test("composer wires the readiness decision before clearing its draft", () => {
  const src = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  const guard = src.indexOf("if (!canSend || sendingRef.current) return;");
  const claim = src.indexOf("sendingRef.current = true;");
  const effects = [src.indexOf('setText("")'), src.indexOf("setPendingAtts([])"), src.indexOf('api("POST", "/api/messages"')];
  assert.ok(guard >= 0 && claim > guard && effects.every((i) => i > claim), "the send lock must be claimed before clearing or posting the draft");
  assert.match(src, /const canSend = !!channelId && !sending && canSendComposerDraft/, "the rendered send state must stay disabled in flight");
  assert.match(src, /catch \(error\) \{\s*console\.error\("Message send failed", error\);/, "request errors must not leave an unhandled send promise");
  assert.match(src, /finally \{\s*sendingRef\.current = false; setSending\(false\);/, "the send lock must release after the request settles");
  assert.match(src, /disabled=\{!canSend\}/, "the button must expose the same readiness rule");
  assert.match(src, /const ids = pendingAtts\.map\(\(a\) => a\.id\)/, "a ready queue must be attached in full");
  assert.match(src, /catch \{ setPendingAtts\(\(p\) => p\.map\(\(x\) => \(x\.id === tmpId \? \{ \.\.\.x, status: "error" \} : x\)\)\); \}/, "a failed upload must remain visible");
  assert.match(src, /setPendingAtts\(\(p\) => p\.filter\(\(x\) => x\.id !== a\.id\)\)/, "the user must be able to remove a blocked row explicitly");
});

test("composer send failures have generic and detailed localized feedback", () => {
  const en = JSON.parse(fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8"));
  const zh = JSON.parse(fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8"));
  assert.equal(en.chat.sendFailed, "Could not send message");
  assert.equal(en.chat.sendFailedReason, "Could not send message: {{error}}");
  assert.equal(zh.chat.sendFailed, "消息发送失败");
  assert.equal(zh.chat.sendFailedReason, "消息发送失败：{{error}}");
});
