import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { TemplateDiscovery } from "../dist/core/TemplateDiscovery.js";
import { TemplateVariableResolver } from "../dist/core/TemplateVariableResolver.js";

async function withTempProject(fn) {
    const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-test-file-merge-template-vars-"));
    try {
        await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

test("resolves unescaped variables and preserves escaped placeholders", () => {
    const varName = "FILE_MERGE_TEMPLATE_VAR_TEST";
    process.env[varName] = "env-value";

    try {
        const input = String.raw`env={{${varName}}} literal=\{{config_root}}`;
        const resolved = TemplateVariableResolver.resolve(input);

        assert.equal(resolved, "env=env-value literal={{config_root}}");
        assert.equal(TemplateVariableResolver.hasVariables(String.raw`\{{config_root}}`), false);
        assert.deepEqual(
            TemplateVariableResolver.extractVariables(
                String.raw`\{{config_root}} and {{A}} and {{A}}`,
            ),
            ["A"],
        );
    } finally {
        delete process.env[varName];
    }
});

test("throws for unresolved unescaped variables", () => {
    assert.throws(
        () => TemplateVariableResolver.resolve("missing={{FILE_MERGE_MISSING_VAR_TEST}}"),
        /Missing required environment variables: FILE_MERGE_MISSING_VAR_TEST/,
    );
});

test("does not skip templates that only contain escaped placeholders", async () => {
    await withTempProject(async (projectRoot) => {
        const templatesDir = path.join(projectRoot, "config-templates");
        await fs.mkdir(templatesDir, { recursive: true });
        await fs.writeFile(
            path.join(templatesDir, "__mise.toml"),
            [
                '[tools]',
                'node = "22"',
                "",
                "[env]",
                "_.path = ['\\{{config_root}}/node_modules/.bin']",
                "",
            ].join("\n"),
            "utf-8",
        );

        const discovery = new TemplateDiscovery(projectRoot, {
            templatesDir: "config-templates",
            fragmentPatterns: [],
            ignorePatterns: [],
        });

        const templates = await discovery.discoverTemplates();
        assert.equal(templates.length, 1);

        const template = templates[0];
        const content = JSON.stringify(template.content);
        assert.match(content, /\{\{config_root\}\}\/node_modules\/\.bin/);
        assert.doesNotMatch(content, /\\\{\{config_root\}\}/);
    });
});
