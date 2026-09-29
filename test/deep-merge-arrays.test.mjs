import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { ConfigManager } from "../dist/core/ConfigManager.js";
import { DeepMergeStrategy } from "../dist/strategies/index.js";

const context = {
    targetPath: "out.json",
    relativePath: "out.json",
    sourcePaths: [],
    activeModules: [],
};

test("deep-merge keeps repeated array items within a single source", () => {
    const merged = new DeepMergeStrategy().merge(
        [{ list: ["--flag", "a", "--flag", "b"] }, { other: true }],
        context,
    );
    assert.deepEqual(merged.list, ["--flag", "a", "--flag", "b"]);
});

test("deep-merge unions arrays across sources and keeps repeats within the later source", () => {
    const merged = new DeepMergeStrategy().merge(
        [{ list: ["a", "b"] }, { list: ["b", "c", "x", "x"] }],
        context,
    );
    assert.deepEqual(merged.list, ["a", "b", "c", "x", "x"]);
});

test("deep-merge replaces arrays when arrayMerge is replace", () => {
    const merged = new DeepMergeStrategy().merge(
        [
            { nested: { list: ["--flag", "a", "--flag", "b"] }, keep: ["k"] },
            { nested: { list: ["--flag", "c"] } },
        ],
        { ...context, arrayMerge: "replace" },
    );
    assert.deepEqual(merged.nested.list, ["--flag", "c"]);
    assert.deepEqual(merged.keep, ["k"]);
});

async function withTempProject(fn) {
    const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-test-file-merge-arrays-"));
    try {
        await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function write(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf-8");
}

async function apply(projectRoot, config, template, override) {
    await write(path.join(projectRoot, ".file-merge.config.json"), {
        templatesDir: "config-templates",
        fragmentPatterns: [],
        ignorePatterns: ["**/node_modules/**", "**/.git/**"],
        jsonCommentStyle: { default: "none" },
        ...config,
    });
    await write(path.join(projectRoot, "config-templates/__settings.json"), template);
    await write(path.join(projectRoot, "settings.overrides.json"), override);

    await new ConfigManager({
        projectRoot,
        verbose: false,
        configPath: ".file-merge.config.json",
    }).apply();

    return JSON.parse(await fs.readFile(path.join(projectRoot, "settings.json"), "utf-8"));
}

const template = { tools: { example: { args: ["run", "--flag", "A", "--flag", "B", "image"] } } };

test("an unrelated override does not drop repeated template array items", async () => {
    await withTempProject(async (projectRoot) => {
        const result = await apply(projectRoot, {}, template, {
            tools: { other: { args: ["--flag", "C"] } },
        });
        assert.deepEqual(result.tools.example.args, template.tools.example.args);
        assert.deepEqual(result.tools.other.args, ["--flag", "C"]);
    });
});

test("replaceArrayPatterns lets an override replace an array", async () => {
    await withTempProject(async (projectRoot) => {
        const result = await apply(
            projectRoot,
            { replaceArrayPatterns: ["settings.json"] },
            template,
            { tools: { example: { args: ["run", "--flag", "C", "image"] } } },
        );
        assert.deepEqual(result.tools.example.args, ["run", "--flag", "C", "image"]);
    });
});
