#!/usr/bin/env bash
set -euo pipefail

scenario="${1:-}"
model="${2:-}"
output_dir="${3:-}"
if [[ -z "$scenario" || -z "$model" || -z "$output_dir" || "$output_dir" != /* ]]; then
	cat >&2 <<'USAGE'
Usage: run-live.sh <scenario-id> <provider/model> <absolute-output-dir>
Open the resulting Pi session and enter the printed /ped-start command. Complete
the scenario using the same artifacts and operator decisions for each revision.
USAGE
	exit 2
fi

case "$scenario" in
	clean-pipeline|review-fix-loop|long-plan-resume-escalation|debug-verify) ;;
	*) echo "Unknown scenario: $scenario" >&2; exit 2 ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
benchmark_dir="$repo_root/docs/benchmarks/issue-62"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"

scenario_json="$(bun -e 'import { readFileSync } from "node:fs"; const data = JSON.parse(readFileSync(process.argv[1], "utf8")); const scenario = data.scenarios.find((entry) => entry.id === process.argv[2]); if (!scenario) process.exit(2); process.stdout.write(JSON.stringify(scenario));' "$benchmark_dir/live-scenarios.json" "$scenario")"
entry_command="$(BENCH_SCENARIO_JSON="$scenario_json" bun -e 'process.stdout.write(JSON.parse(process.env.BENCH_SCENARIO_JSON).entryCommand)')"
fixture_rel="$(BENCH_SCENARIO_JSON="$scenario_json" bun -e 'process.stdout.write(JSON.parse(process.env.BENCH_SCENARIO_JSON).fixture)')"
fixture_path="$benchmark_dir/$fixture_rel"
workspace="$output_dir/workspace"
if [[ "$fixture_path" != "$benchmark_dir/fixtures/"* || ! -d "$fixture_path" || -e "$workspace" ]]; then
	echo "Fixture is missing, escapes the benchmark directory, or output workspace already exists." >&2
	exit 2
fi
cp -R "$fixture_path" "$workspace"
revision="$(git rev-parse HEAD)"
config_path="$workspace/.pi/pi-pedstack/config.json"
if [[ ! -f "$config_path" ]]; then
	config_path="${HOME}/.pi/pi-pedstack/config.json"
fi
config_hash="unconfigured"
if [[ -f "$config_path" ]]; then
	config_hash="$(sha256sum "$config_path" | cut -d ' ' -f 1)"
fi
fixture_hash="$(BENCH_TREE_ROOT="$workspace" bun -e 'import { createHash } from "node:crypto"; import { readFile, readdir } from "node:fs/promises"; import path from "node:path"; const root = process.env.BENCH_TREE_ROOT; const files = []; async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile()) files.push(file); } } await walk(root); files.sort(); const hash = createHash("sha256"); for (const file of files) { hash.update(path.relative(root, file).split(path.sep).join("/")); hash.update("\0"); hash.update(await readFile(file)); hash.update("\0"); } process.stdout.write(hash.digest("hex"));')"
decision_plan_hash="$(BENCH_SCENARIO_JSON="$scenario_json" bun -e 'import { createHash } from "node:crypto"; const scenario = JSON.parse(process.env.BENCH_SCENARIO_JSON); process.stdout.write(createHash("sha256").update(JSON.stringify(scenario.operatorDecisions ?? [])).digest("hex"));')"

BENCH_SCENARIO_JSON="$scenario_json" BENCH_SCENARIO="$scenario" BENCH_MODEL="$model" BENCH_REVISION="$revision" BENCH_CONFIG_HASH="$config_hash" BENCH_FIXTURE_HASH="$fixture_hash" BENCH_DECISION_PLAN_HASH="$decision_plan_hash" BENCH_ENTRY_COMMAND="$entry_command" BENCH_RUNTIME="$(bun --version)" bun -e 'import { writeFileSync } from "node:fs"; const scenario = JSON.parse(process.env.BENCH_SCENARIO_JSON); writeFileSync(process.argv[1], JSON.stringify({ scenario: process.env.BENCH_SCENARIO, fixture: scenario.fixture, model: process.env.BENCH_MODEL, thinkingLevel: "medium", revision: process.env.BENCH_REVISION, fixtureSha256: process.env.BENCH_FIXTURE_HASH, configSha256: process.env.BENCH_CONFIG_HASH, operatorDecisionPlanSha256: process.env.BENCH_DECISION_PLAN_HASH, runtime: process.env.BENCH_RUNTIME, startedAt: new Date().toISOString(), entryCommand: process.env.BENCH_ENTRY_COMMAND, expectedStages: scenario.expectedStageStarts, expectedTransitions: scenario.expectedTransitions, expectedReviewOutcomes: scenario.expectedReviewOutcomes ?? [], operatorDecisions: scenario.operatorDecisions }, null, 2) + "\n");' "$output_dir/metadata.json"

printf 'Scenario: %s\nModel: %s\nRevision: %s\n' "$scenario" "$model" "$revision"
printf 'Fixture: %s\n' "$fixture_path"
printf 'Enter this exact command in the Pi session, then follow the scenario through its required stages:\n\n%s\n\n' "$entry_command"
printf 'Diagnostics will be saved locally at %s/diagnostics.jsonl\n' "$output_dir"
(cd "$workspace" && PEDSTACK_DIAGNOSTICS_FILE="$output_dir/diagnostics.jsonl" pi --approve --extension "$repo_root/extensions/ce-core/index.ts" --model "$model" --thinking medium)

bun "$repo_root/extensions/ce-core/diagnostics-report.ts" "$output_dir/diagnostics.jsonl" > "$output_dir/report.json"
artifact_hash="$(BENCH_TREE_ROOT="$workspace" bun -e 'import { createHash } from "node:crypto"; import { readFile, readdir } from "node:fs/promises"; import path from "node:path"; const root = process.env.BENCH_TREE_ROOT; const files = []; async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile()) files.push(file); } } await walk(root); files.sort(); const hash = createHash("sha256"); for (const file of files) { hash.update(path.relative(root, file).split(path.sep).join("/")); hash.update("\0"); hash.update(await readFile(file)); hash.update("\0"); } process.stdout.write(hash.digest("hex"));')"
BENCH_METADATA="$output_dir/metadata.json" BENCH_ARTIFACT_HASH="$artifact_hash" bun -e 'import { readFileSync, writeFileSync } from "node:fs"; const file = process.env.BENCH_METADATA; const value = JSON.parse(readFileSync(file, "utf8")); value.finishedAt = new Date().toISOString(); value.artifactsSha256 = process.env.BENCH_ARTIFACT_HASH; writeFileSync(file, JSON.stringify(value, null, 2) + "\n");'
bun "$benchmark_dir/verify-live-run.ts" "$output_dir"
printf 'Saved metadata, raw diagnostics, and report under %s\n' "$output_dir"
