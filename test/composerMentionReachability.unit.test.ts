import test from "node:test";
import assert from "node:assert/strict";
import { mentionedAgents } from "../web/src/views/Composer.tsx";
import type { Agent } from "../web/src/store.tsx";

const agent = (id: string, name: string): Agent => ({ id, name, displayName: name, status: "offline", runtime: "codex" });

test("composer reachability matches server mention normalization", () => {
  const ghost = agent("a1", "ghost");
  const editor = agent("a2", "E\u0301diteur");
  const found = mentionedAgents("@GHOST please ask @ÉDITEUR and @ghost", [ghost, editor]);
  assert.deepEqual(found.map((a) => a.id), ["a1", "a2"]);
});

test("composer reachability ignores unknown handles", () => {
  assert.deepEqual(mentionedAgents("@missing", [agent("a1", "ghost")]), []);
});
