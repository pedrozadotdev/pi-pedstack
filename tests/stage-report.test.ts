import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStageReportTool } from "../extensions/ce-core/tools/stage-report";

let root: string;
const tool = createStageReportTool();
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "stage-report-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
test("publishes docs report and creates the directory", async () => {
  const x = await tool.execute({repoRoot:root,stage:"06-docsync",activeStage:"06-docsync",markdown:"README updated. AGENTS unchanged. Exit criteria met."});
  expect(x.path).toBe(".context/compound-engineering/stage-reports/06-docsync.md");
  expect(await readFile(path.join(root,x.path),"utf8")).toContain("README updated");
});
test("rejects mismatched stage, invalid stage, and blank content", async () => {
  await expect(tool.execute({repoRoot:root,stage:"03-work",activeStage:"06-docsync",markdown:"x"})).rejects.toThrow("not active");
  await expect(tool.execute({repoRoot:root,stage:"../bad",activeStage:"../bad",markdown:"x"})).rejects.toThrow("invalid stage");
  await expect(tool.execute({repoRoot:root,stage:"06-docsync",activeStage:"06-docsync",markdown:"  "})).rejects.toThrow("empty");
});
test("refuses symlinks in context directory or report file", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "report-outside-"));
  try {
    await symlink(outside,path.join(root,".context"));
    await expect(tool.execute({repoRoot:root,stage:"06-docsync",activeStage:"06-docsync",markdown:"x"})).rejects.toThrow("unsafe directory");
    await rm(path.join(root,".context"));
    const dir = path.join(root,".context/compound-engineering/stage-reports");
    await mkdir(dir,{recursive:true});
    const safe = path.join(root,"safe.md");
    await writeFile(safe,"safe");
    await symlink(safe,path.join(dir,"06-docsync.md"));
    await expect(tool.execute({repoRoot:root,stage:"06-docsync",activeStage:"06-docsync",markdown:"x"})).rejects.toThrow("unsafe report");
    expect(await readFile(safe,"utf8")).toBe("safe");
  } finally { await rm(outside,{recursive:true,force:true}); }
});
