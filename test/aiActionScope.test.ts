// Run with: npx tsx --test test/aiActionScope.test.ts
import test from "node:test";
import assert from "node:assert";
import { actionTargetsOutsideSelection } from "../src/routes/aiActionScope.js";

test("allows actions on the selected emails", () => {
  assert.deepStrictEqual(actionTargetsOutsideSelection({ messageIds: ["a", "b"] }, ["a", "b", "c"]), []);
  assert.deepStrictEqual(actionTargetsOutsideSelection({ messageId: "c" }, ["a", "b", "c"]), []);
});
test("refuses emails outside the selection (SEC-8)", () => {
  assert.deepStrictEqual(actionTargetsOutsideSelection({ messageIds: ["a", "zzz"] }, ["a"]), ["zzz"]);
  assert.deepStrictEqual(actionTargetsOutsideSelection({ messageId: "x" }, ["a"]), ["x"]);
});
test("does not apply to inbox-wide chats", () => {
  assert.deepStrictEqual(actionTargetsOutsideSelection({ messageIds: ["a"] }, []), []);
  assert.deepStrictEqual(actionTargetsOutsideSelection({ messageIds: ["a"] }, undefined), []);
});
