import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { ConfigManager } from "../dist/core/ConfigManager.js";
import { StatusReporter } from "../dist/core/StatusReporter.js";

async function withTempProject(fn) {
    const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-test-file-merge-properties-"));
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

async function writeText(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
}

async function createManager(projectRoot) {
    await writeJson(path.join(projectRoot, ".file-merge.config.json"), {
        templatesDir: "atom-framework/config-templates",
        fragmentPatterns: [],
        ignorePatterns: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
        noSymlink: false,
        copyPatterns: [],
    });

    return new ConfigManager({
        projectRoot,
        verbose: false,
        configPath: ".file-merge.config.json",
    });
}

function splitLines(content) {
    return content.replace(/\r\n/g, "\n").trimEnd().split("\n");
}

async function captureConsoleOutput(fn) {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const logs = [];
    const warns = [];
    const errors = [];

    console.log = (...args) => {
        logs.push(args.map(String).join(" "));
    };
    console.warn = (...args) => {
        warns.push(args.map(String).join(" "));
    };
    console.error = (...args) => {
        errors.push(args.map(String).join(" "));
    };

    try {
        await fn();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }

    return {
        logs: logs.join("\n"),
        warns: warns.join("\n"),
        errors: errors.join("\n"),
    };
}

test("merges .template.properties + .overrides.properties with override precedence", async () => {
    await withTempProject(async (projectRoot) => {
        const manager = await createManager(projectRoot);

        await writeText(
            path.join(
                projectRoot,
                "atom-framework/config-templates/application-config.template.properties",
            ),
            [
                "app.name=shared-template",
                "app.retry.enabled=true",
                "app.exclusions=**/generated/**",
                "",
            ].join("\n"),
        );

        await writeText(
            path.join(projectRoot, "application-config.overrides.properties"),
            ["app.name=my-project", "app.ignore.rules=rule-1", ""].join("\n"),
        );

        await manager.apply();

        const output = await fs.readFile(
            path.join(projectRoot, "application-config.properties"),
            "utf-8",
        );
        const lines = splitLines(output);

        assert.equal(lines[0], "app.name=my-project");
        assert.ok(lines.includes("app.retry.enabled=true"));
        assert.ok(lines.includes("app.exclusions=**/generated/**"));
        assert.ok(lines.includes("app.ignore.rules=rule-1"));

        const overrideOnlyIndex = lines.indexOf("app.ignore.rules=rule-1");
        const templateTailIndex = lines.indexOf("app.exclusions=**/generated/**");
        assert.ok(
            overrideOnlyIndex > templateTailIndex,
            "override-only key should be appended after template keys",
        );
    });
});

test("preserves template comments and blank lines, appends override-only comments near keys", async () => {
    await withTempProject(async (projectRoot) => {
        const manager = await createManager(projectRoot);

        await writeText(
            path.join(
                projectRoot,
                "atom-framework/config-templates/application-config.template.properties",
            ),
            [
                "# template comment",
                "! template bang comment",
                "app.alpha=1",
                "",
                "# between comment",
                "app.beta=2",
                "",
            ].join("\n"),
        );

        await writeText(
            path.join(projectRoot, "application-config.overrides.properties"),
            [
                "app.beta=22",
                "",
                "# appended override block",
                "! appended bang",
                "app.gamma=3",
                "",
            ].join("\n"),
        );

        await manager.apply();

        const output = await fs.readFile(
            path.join(projectRoot, "application-config.properties"),
            "utf-8",
        );
        const lines = splitLines(output);

        assert.equal(lines[0], "# template comment");
        assert.equal(lines[1], "! template bang comment");
        assert.equal(lines[2], "app.alpha=1");
        assert.equal(lines[4], "# between comment");
        assert.equal(lines[5], "app.beta=22");

        const appendedKey = lines.indexOf("app.gamma=3");
        assert.ok(appendedKey > 0);
        assert.equal(lines[appendedKey - 1], "! appended bang");
        assert.equal(lines[appendedKey - 2], "# appended override block");
    });
});

test("deduplicates duplicate keys and keeps final value", async () => {
    await withTempProject(async (projectRoot) => {
        const manager = await createManager(projectRoot);

        await writeText(
            path.join(
                projectRoot,
                "atom-framework/config-templates/application-config.template.properties",
            ),
            ["k=1", "k=2", "x=1", ""].join("\n"),
        );

        await writeText(
            path.join(projectRoot, "application-config.overrides.properties"),
            ["k=3", "k=4", ""].join("\n"),
        );

        await manager.apply();

        const output = await fs.readFile(
            path.join(projectRoot, "application-config.properties"),
            "utf-8",
        );
        const lines = splitLines(output);

        const keyLines = lines.filter((line) => line.startsWith("k="));
        assert.deepEqual(keyLines, ["k=4"]);
        assert.ok(lines.indexOf("k=4") < lines.indexOf("x=1"));
    });
});

test("parses escaped separators/spaces and writes normalized key=value output", async () => {
    await withTempProject(async (projectRoot) => {
        const manager = await createManager(projectRoot);

        await writeText(
            path.join(
                projectRoot,
                "atom-framework/config-templates/application-config.template.properties",
            ),
            [
                "complex\\ key\\=part\\:two = template\\ value",
                "escaped\\:\\ key:base",
                "",
            ].join("\n"),
        );

        await writeText(
            path.join(projectRoot, "application-config.overrides.properties"),
            [
                "complex\\ key\\=part\\:two:override value",
                "escaped\\:\\ key=override\\:final",
                "",
            ].join("\n"),
        );

        await manager.apply();

        const output = await fs.readFile(
            path.join(projectRoot, "application-config.properties"),
            "utf-8",
        );
        const lines = splitLines(output);

        assert.ok(lines.includes("complex\\ key\\=part\\:two=override value"));
        assert.ok(lines.includes("escaped\\:\\ key=override:final"));
    });
});

test("supports standard whitespace delimiter syntax", async () => {
    await withTempProject(async (projectRoot) => {
        const manager = await createManager(projectRoot);

        await writeText(
            path.join(
                projectRoot,
                "atom-framework/config-templates/application-config.template.properties",
            ),
            ["app.mode production", "app.region  eu-central-1", ""].join("\n"),
        );

        await writeText(
            path.join(projectRoot, "application-config.overrides.properties"),
            ["app.mode development", ""].join("\n"),
        );

        await manager.apply();

        const output = await fs.readFile(
            path.join(projectRoot, "application-config.properties"),
            "utf-8",
        );
        const lines = splitLines(output);

        assert.ok(lines.includes("app.mode=development"));
        assert.ok(lines.includes("app.region=eu-central-1"));
    });
});

test("supports line continuations and override precedence", async () => {
    await withTempProject(async (projectRoot) => {
        const manager = await createManager(projectRoot);

        await writeText(
            path.join(
                projectRoot,
                "atom-framework/config-templates/application-config.template.properties",
            ),
            [
                "app.paths.exclude=src/**,\\",
                "  test/**,\\",
                "  docs/**",
                "app.retry.enabled=true",
                "",
            ].join("\n"),
        );

        await writeText(
            path.join(projectRoot, "application-config.overrides.properties"),
            ["app.paths.exclude=src/**", ""].join("\n"),
        );

        await manager.apply();

        const output = await fs.readFile(
            path.join(projectRoot, "application-config.properties"),
            "utf-8",
        );
        const lines = splitLines(output);

        assert.ok(lines.includes("app.paths.exclude=src/**"));
        assert.ok(lines.includes("app.retry.enabled=true"));
    });
});

test("is idempotent for .properties outputs (apply twice => no rewrite)", async () => {
    await withTempProject(async (projectRoot) => {
        const manager = await createManager(projectRoot);

        await writeText(
            path.join(
                projectRoot,
                "atom-framework/config-templates/application-config.template.properties",
            ),
            ["k=1", ""].join("\n"),
        );
        await writeText(
            path.join(projectRoot, "application-config.overrides.properties"),
            ["k=2", ""].join("\n"),
        );

        await manager.apply();
        const outPath = path.join(projectRoot, "application-config.properties");
        const stat1 = await fs.stat(outPath);

        await new Promise((resolve) => setTimeout(resolve, 1100));
        await manager.apply();
        const stat2 = await fs.stat(outPath);

        assert.equal(stat2.mtimeMs, stat1.mtimeMs);
    });
});

test("generates target from override-only .overrides.properties file", async () => {
    await withTempProject(async (projectRoot) => {
        const manager = await createManager(projectRoot);

        await writeText(
            path.join(projectRoot, "application-config.overrides.properties"),
            ["app.name=override-only", ""].join("\n"),
        );

        await manager.apply();

        const outPath = path.join(projectRoot, "application-config.properties");
        const content = await fs.readFile(outPath, "utf-8");
        const stats = await fs.lstat(outPath);

        assert.ok(content.includes("app.name=override-only"));
        assert.equal(stats.isSymbolicLink(), false);
    });
});

test("status reports generated mode and source list for properties merge", async () => {
    await withTempProject(async (projectRoot) => {
        const manager = await createManager(projectRoot);

        await writeText(
            path.join(
                projectRoot,
                "atom-framework/config-templates/application-config.template.properties",
            ),
            ["a=1", ""].join("\n"),
        );
        await writeText(
            path.join(projectRoot, "application-config.overrides.properties"),
            ["a=2", ""].join("\n"),
        );

        await manager.apply();

        const reporter = new StatusReporter(projectRoot);
        const output = await captureConsoleOutput(async () => {
            await reporter.showStatus("application-config.properties");
        });

        assert.ok(output.logs.includes("Mode: 🤖 generated"));
        assert.ok(output.logs.includes("Sources: 2"));
        assert.ok(output.logs.includes("application-config.overrides.properties"));
        assert.ok(
            output.logs.includes(
                "atom-framework/config-templates/application-config.template.properties",
            ),
        );
    });
});
