// Unit regression for system-message (task lifecycle banner) layout and rendering unification.
// The bug (2026-07): the base .md class carried document-mode geometry (max-width:--read-measure
// + left-pinned margins), so .msg-sys's text-align:center centered text inside a left-pinned 76ch
// column instead of the pane — every chat surface except the forgotten .msg-sys had to opt out.
// The invariant now: .md is a geometry-free content renderer; containers own width and set the
// --md-* typography tokens; reading-measure surfaces must opt in explicitly.
// Run: npx tsx --test --test-force-exit test/sysMsgLayout.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const chatSrc = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");

function ruleBodies(selector: string): string[] {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    if (match[1]!.split(",").map((s) => s.trim()).includes(selector)) bodies.push(match[2]!);
  }
  assert.ok(bodies.length > 0, `missing CSS rule for ${selector}`);
  return bodies;
}

test("base .md is geometry-free: containers own width, no document reading measure", () => {
  for (const body of ruleBodies(".md")) {
    assert.doesNotMatch(body, /max-width/, `.md must not cap its own width — that centers/pins content in wide containers: ${body}`);
    assert.doesNotMatch(body, /margin-left|margin-right/, `.md must not pin itself horizontally: ${body}`);
    assert.doesNotMatch(body, /var\(--read-measure\)/, `document reading measure must be an explicit opt-in, never the .md default: ${body}`);
  }
  // The per-container opt-outs existed only to escape the document-mode default; with the
  // default inverted they are dead weight and must not come back.
  assert.doesNotMatch(css, /\.msg \.md\s*\{/, "the .msg .md width opt-out should be gone with the geometry-free .md base");
  assert.doesNotMatch(css, /\.thread-panel \.msg \.md\s*\{/, "the thread-panel width opt-out should be gone with the geometry-free .md base");
  assert.doesNotMatch(css, /--read-measure\s*:/, "the --read-measure token has no consumer left and must not linger as a dead default");
});

test(".msg-sys stays a centered 12px banner even when it contains rendered Markdown", () => {
  const bodies = ruleBodies(".msg-sys");
  assert.ok(bodies.some((b) => /text-align\s*:\s*center/.test(b)), ".msg-sys must center its banner text");
  assert.ok(bodies.some((b) => /--md-text-size\s*:\s*12px/.test(b)), ".msg-sys must override the markdown type token so nested .md matches the 12px banner scale");
  assert.ok(bodies.some((b) => /--md-line-height\s*:\s*1\.4/.test(b)), ".msg-sys must override the markdown line-height token to the banner's 1.4");
});

test("channel feed and thread panel render system messages through one shared path", () => {
  const sysMsgUses = chatSrc.match(/<SysMsg\b/g) ?? [];
  assert.ok(sysMsgUses.length >= 2, `both the channel feed and the thread panel must render system messages via <SysMsg> (found ${sysMsgUses.length})`);
  assert.doesNotMatch(chatSrc, /"msg-sys"[^>]*>\{m\.content\}/, "system messages must not render raw content — task refs (#N) must stay clickable in the thread panel too");
});
