import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDmParticipantIds, classifyAgentDm } from "../src/server/channelAccess.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const otherServerId = "00000000-0000-4000-8000-000000000002";
const first = "10000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000002";
const name = `dm:${first}:${second}`;
const members = [
  { memberType: "agent", memberId: first },
  { memberType: "agent", memberId: second },
];
const agents = [
  { id: first, serverId, deletedAt: null },
  { id: second, serverId, deletedAt: null },
];

test("canonicalDmParticipantIds accepts one sorted pair", () => {
  assert.deepEqual(canonicalDmParticipantIds(name), [first, second]);
  assert.equal(canonicalDmParticipantIds(`dm:${second}:${first}`), null);
  assert.equal(canonicalDmParticipantIds(`dm:${first}:${first}`), null);
  assert.equal(canonicalDmParticipantIds("dm:not-a-uuid:also-not-a-uuid"), null);
});

test("classifyAgentDm requires exactly two live same-workspace agents", () => {
  assert.equal(classifyAgentDm(serverId, name, members, agents), "valid");
  assert.equal(classifyAgentDm(serverId, name, members.slice(0, 1), agents), "invalid");
  assert.equal(classifyAgentDm(serverId, name, [...members, { memberType: "user", memberId: first }], agents), "invalid");
  assert.equal(classifyAgentDm(serverId, name, members, [{ ...agents[0]!, deletedAt: new Date() }, agents[1]!]), "invalid");
  assert.equal(classifyAgentDm(serverId, name, members, [agents[0]!, { ...agents[1]!, serverId: otherServerId }]), "invalid");
});

test("classifyAgentDm keeps human conversations outside the audit class", () => {
  const humanMembers = [
    { memberType: "user", memberId: first },
    { memberType: "agent", memberId: second },
  ];
  assert.equal(classifyAgentDm(serverId, name, humanMembers, [agents[1]!], [{ id: first }]), "regular");
  assert.equal(classifyAgentDm(serverId, name, humanMembers, [agents[1]!]), "invalid");
});
