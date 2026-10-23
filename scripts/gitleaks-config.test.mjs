import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const binary = process.argv[2];
assert.ok(binary, "Pass the Gitleaks executable path as the first argument");
const config = fileURLToPath(new URL("../.gitleaks.toml", import.meta.url));
const releaseVersion = "d56ad744-eeb3-42be-8b24-7e4a3ed0ceac";
const releaseLine = `- API version: \`${releaseVersion}\`.`;
const syntheticSecret = randomBytes(32).toString("hex");
const cases = [
  {
    name: "documented public deployment version",
    path: "workfiles/CONFIGURATION.md",
    content: `# Release audit\n${releaseLine}`,
    findingLines: [],
  },
  {
    name: "nearby synthetic API key remains blocked",
    path: "workfiles/CONFIGURATION.md",
    content: `# Release audit\n${releaseLine}\napi_key = "${syntheticSecret}"`,
    findingLines: [3],
  },
  {
    name: "the same value in a credential assignment remains blocked",
    path: "workfiles/CONFIGURATION.md",
    content: `api_key = "${releaseVersion}"`,
    findingLines: [1],
  },
  {
    name: "the same release line outside its documented path remains blocked",
    path: "other/CONFIGURATION.md",
    content: releaseLine,
    findingLines: [1],
  },
];

for (const testCase of cases) {
  const temporary = mkdtempSync(join(tmpdir(), "eventforge-gitleaks-"));
  try {
    const fixture = join(temporary, "fixture");
    const file = join(fixture, testCase.path);
    const report = join(temporary, "report.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${testCase.content}\n`);
    const result = spawnSync(
      resolve(binary),
      [
        "dir",
        "--config",
        config,
        "--redact",
        "--no-banner",
        "--exit-code",
        "1",
        "--report-format",
        "json",
        "--report-path",
        report,
        ".",
      ],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, testCase.findingLines.length ? 1 : 0, testCase.name);
    const findings = JSON.parse(readFileSync(report, "utf8"));
    assert.deepEqual(
      findings.map(({ RuleID, StartLine }) => ({ RuleID, StartLine })),
      testCase.findingLines.map((StartLine) => ({ RuleID: "generic-api-key", StartLine })),
      testCase.name,
    );
    console.log(`PASS: ${testCase.name}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
