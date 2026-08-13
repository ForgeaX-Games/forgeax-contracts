import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");

function job(name, next) {
  const start = workflow.indexOf("  " + name + ":\n");
  assert.notEqual(start, -1, "missing " + name + " job");
  const end = next ? workflow.indexOf("  " + next + ":\n", start + 1) : workflow.length;
  return workflow.slice(start, end);
}

test("uses the common triggers and fresh runner chain", () => {
  assert.match(workflow, /on:\n  push:\n    tags: \['v\*'\]\n  workflow_dispatch:\n/u);
  assert.match(workflow, /^  build:\n/mu);
  assert.match(workflow, /^  scan:\n    needs: build\n/mu);
  assert.match(workflow, /^  publish:\n    needs: scan\n/mu);
});

test("builds and scans one isolated candidate per package", () => {
  const build = job("build", "scan");
  const scan = job("scan", "publish");
  assert.match(build, /candidate\/types/u);
  assert.match(build, /candidate\/agent-runtime/u);
  assert.equal((scan.match(/python3 scripts\/verify-release-artifact\.py/gu) ?? []).length, 2);
  assert.equal((scan.match(/--mode package/gu) ?? []).length, 4);
  assert.match(scan, /types_sha256/u);
  assert.match(scan, /agent_runtime_sha256/u);
  assert.match(scan, /name: contracts-scanned/u);
});

test("verifies both digests before one token-scoped dependency-order publish step", () => {
  const publish = job("publish");
  assert.equal((workflow.match(/NPM_TOKEN/gu) ?? []).length, 1);
  assert.doesNotMatch(publish, /actions\/checkout|bun install|node scripts\//u);
  const firstPublish = publish.indexOf("npm publish");
  assert.ok(firstPublish > publish.indexOf("needs.scan.outputs.types_sha256"));
  assert.ok(firstPublish > publish.indexOf("needs.scan.outputs.agent_runtime_sha256"));
  assert.ok(publish.indexOf("@forgeax/types") < publish.indexOf("@forgeax/agent-runtime"));
  assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/u);
});

test("pins npm before dependency-order publishing", () => {
  const publish = job("publish");
  const pinnedNpm = "npm install --global npm@11.19.0 --ignore-scripts";
  assert.ok(publish.indexOf(pinnedNpm) < publish.indexOf("npm publish"));
});
