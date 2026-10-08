import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isStageKey } from "../stage-gate/store";

const DIR = ".context/compound-engineering/stage-reports";

export function createStageReportTool() {
  return {
    name: "stage_report",
    async execute(input: { repoRoot: string; stage: string; activeStage: string | null; markdown: string }) {
      if (!isStageKey(input.stage)) throw new Error("stage_report: invalid stage");
      if (input.stage !== input.activeStage) throw new Error("stage_report: stage is not active");
      if (!input.markdown.trim()) throw new Error("stage_report: report cannot be empty");
      const root = await realpath(input.repoRoot);
      let dir = root;
      for (const name of [".context", "compound-engineering", "stage-reports"]) {
        dir = path.join(dir, name);
        try {
          const stat = await lstat(dir);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("stage_report: unsafe directory");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      await mkdir(dir, { recursive: true });
      if (await realpath(dir) !== dir) throw new Error("stage_report: directory escaped repository");
      const target = path.join(dir, input.stage + ".md");
      try {
        const stat = await lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("stage_report: unsafe report file");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await writeFile(target, input.markdown, "utf8");
      return { path: DIR + "/" + input.stage + ".md" };
    },
  };
}
