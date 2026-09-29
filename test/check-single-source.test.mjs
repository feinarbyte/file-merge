import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { ConfigManager } from "../dist/core/ConfigManager.js";

async function withTempProject(fn) {
    const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-test-file-merge-check-"));
    try {
        await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function write(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
}

async function setup(projectRoot) {
    await write(
        path.join(projectRoot, ".file-merge.config.json"),
        `${JSON.stringify({
            templatesDir: "config-templates",
            fragmentPatterns: ["fragments/**/*.fragment.*"],
            ignorePatterns: ["**/node_modules/**", "**/.git/**"],
        })}\n`,
    );
    // Single fragment source (generated, not symlinked)
    await write(
        path.join(projectRoot, "fragments/only.fragment.json"),
        `${JSON.stringify({ _targetPath: "only.json", a: 1 })}\n`,
    );
    // Single .overrides.properties source (generated, not symlinked)
    await write(path.join(projectRoot, "app.overrides.properties"), "key=value\n");
}

function manager(projectRoot, check) {
    return new ConfigManager({
        projectRoot,
        verbose: false,
        check,
        configPath: ".file-merge.config.json",
    });
}

test("check mode reports and does not write single-source generated targets", async () => {
    await withTempProject(async (projectRoot) => {
        await setup(projectRoot);

        const before = await manager(projectRoot, true).apply();
        assert.deepEqual(before.changedTargets.sort(), ["app.properties", "only.json"]);
        await assert.rejects(fs.lstat(path.join(projectRoot, "only.json")));
        await assert.rejects(fs.lstat(path.join(projectRoot, "app.properties")));

        await manager(projectRoot, false).apply();

        const after = await manager(projectRoot, true).apply();
        assert.deepEqual(after.changedTargets, []);
        assert.deepEqual(after.unchangedTargets.sort(), ["app.properties", "only.json"]);
    });
});
