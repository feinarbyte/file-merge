import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { ConfigManager } from "../dist/core/ConfigManager.js";

async function withTempProject(fn) {
    const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-test-file-merge-"));
    try {
        await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function writeJson(filePath, obj) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
}

test("does not rewrite generated output when merged result is unchanged", async () => {
    await withTempProject(async (projectRoot) => {
        await writeJson(path.join(projectRoot, ".file-merge.config.json"), {
            templatesDir: "config-templates",
            fragmentPatterns: ["fragments/**/*.fragment.*"],
            ignorePatterns: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
            noSymlink: false,
            copyPatterns: [],
        });

        await writeJson(path.join(projectRoot, "config-templates/__out.json"), {
            a: 1,
            arr: ["x"],
        });

        await writeJson(path.join(projectRoot, "fragments/add.fragment.json"), {
            _targetPath: "out.json",
            b: 2,
            arr: ["y"],
        });

        const manager = new ConfigManager({
            projectRoot,
            verbose: false,
            configPath: ".file-merge.config.json",
        });

        await manager.apply();
        const outPath = path.join(projectRoot, "out.json");
        const stat1 = await fs.stat(outPath);

        // Use >1s delay to avoid filesystem timestamp resolution edge cases.
        await new Promise((r) => setTimeout(r, 1100));

        await manager.apply();
        const stat2 = await fs.stat(outPath);

        assert.equal(
            stat2.mtimeMs,
            stat1.mtimeMs,
            "expected out.json not to be rewritten when output is unchanged",
        );
    });
});

test("does not rewrite copied single-source output when unchanged", async () => {
    await withTempProject(async (projectRoot) => {
        await writeJson(path.join(projectRoot, ".file-merge.config.json"), {
            templatesDir: "config-templates",
            fragmentPatterns: [],
            ignorePatterns: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
            // Force copy mode for single-source outputs
            noSymlink: true,
            copyPatterns: [],
        });

        await fs.mkdir(path.join(projectRoot, "config-templates"), { recursive: true });
        await fs.writeFile(
            path.join(projectRoot, "config-templates/__out.txt"),
            "hello\n",
            "utf-8",
        );

        const manager = new ConfigManager({
            projectRoot,
            verbose: false,
            configPath: ".file-merge.config.json",
        });

        await manager.apply();
        const outPath = path.join(projectRoot, "out.txt");
        const stat1 = await fs.stat(outPath);

        await new Promise((r) => setTimeout(r, 1100));

        await manager.apply();
        const stat2 = await fs.stat(outPath);

        assert.equal(
            stat2.mtimeMs,
            stat1.mtimeMs,
            "expected out.txt not to be recopied when output is unchanged",
        );
    });
});

