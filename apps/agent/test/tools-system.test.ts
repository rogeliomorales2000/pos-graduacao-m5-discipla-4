import { strict as assert } from "node:assert";
import test from "node:test";
import { BASE_TOOLS } from "../src/tools/registry";
import { normalizeGitArgs } from "../src/tools/git";

test("usb_devices está registrada e é somente leitura", () => {
  const tool = BASE_TOOLS.find((item) => item.spec.name === "usb_devices");
  assert.ok(tool, "tool usb_devices ausente do registry");
  assert.equal(tool.spec.dangerous, false);
  assert.match(tool.spec.description, /USB/i);
});

test("git branch list vira listagem somente-leitura", () => {
  assert.deepEqual(normalizeGitArgs(["branch", "list"]), ["branch", "--list"]);
  assert.deepEqual(normalizeGitArgs("branch list --all"), ["branch", "--list", "--all"]);
  assert.deepEqual(normalizeGitArgs(["branch", "-a"]), ["branch", "-a"]);
});
