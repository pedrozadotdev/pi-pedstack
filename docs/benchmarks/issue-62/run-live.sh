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

task="$(bun -e 'import { readFileSync } from "node:fs"; const data = JSON.parse(readFileSync(process.argv[1], "utf8")); const scenario = data.scenarios.find((entry) => entry.id === process.argv[2]); if (!scenario) process.exit(2); process.stdout.write(scenario.prompt);' "$benchmark_dir/live-scenarios.json" "$scenario")"
revision="$(git rev-parse HEAD)"
config_path="$repo_root/.pi/pi-pedstack/config.json"
if [[ ! -f "$config_path" ]]; then
	config_path="${HOME}/.pi/pi-pedstack/config.json"
fi
config_hash="unconfigured"
if [[ -f "$config_path" ]]; then
	config_hash="$(sha256sum "$config_path" | cut -d ' ' -f 1)"
fi

BENCH_SCENARIO="$scenario" BENCH_MODEL="$model" BENCH_REVISION="$revision" BENCH_CONFIG_HASH="$config_hash" BENCH_TASK="$task" BENCH_RUNTIME="$(bun --version)" bun -e 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], JSON.stringify({ scenario: process.env.BENCH_SCENARIO, model: process.env.BENCH_MODEL, revision: process.env.BENCH_REVISION, configSha256: process.env.BENCH_CONFIG_HASH, runtime: process.env.BENCH_RUNTIME, startedAt: new Date().toISOString(), task: process.env.BENCH_TASK }, null, 2) + "\n");' "$output_dir/metadata.json"

printf 'Scenario: %s\nModel: %s\nRevision: %s\n' "$scenario" "$model" "$revision"
printf 'Enter this command in the Pi session, then follow the scenario through its required stages:\n\n/ped-start %s\n\n' "$task"
printf 'Diagnostics will be saved locally at %s/diagnostics.jsonl\n' "$output_dir"
PEDSTACK_DIAGNOSTICS_FILE="$output_dir/diagnostics.jsonl" pi --model "$model"

bun "$repo_root/extensions/ce-core/diagnostics-report.ts" "$output_dir/diagnostics.jsonl" > "$output_dir/report.json"
BENCH_METADATA="$output_dir/metadata.json" bun -e 'import { readFileSync, writeFileSync } from "node:fs"; const file = process.env.BENCH_METADATA; const value = JSON.parse(readFileSync(file, "utf8")); value.finishedAt = new Date().toISOString(); writeFileSync(file, JSON.stringify(value, null, 2) + "\n");'
printf 'Saved metadata, raw diagnostics, and report under %s\n' "$output_dir"
