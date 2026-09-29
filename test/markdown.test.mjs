/**
 * Markdown support tests
 * Run with: pnpm test (builds first, then runs node --test against dist/)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { ConfigManager } from "../dist/core/ConfigManager.js";
import { FragmentDiscovery } from "../dist/core/FragmentDiscovery.js";
import { HeaderGenerator } from "../dist/core/HeaderGenerator.js";
import { OverrideCreator } from "../dist/core/OverrideCreator.js";
import { DiffExtractor } from "../dist/migration/DiffExtractor.js";
import { getStrategy, strategies } from "../dist/strategies/index.js";

const TEMPLATE = `# Agents

Intro paragraph.


Paragraph after two blank lines.

## Learned Workspace Facts

- fact a
- fact b

## Other

Other text.
`;

const ctx = (sources = []) => ({
    targetPath: "/tmp/AGENTS.md",
    relativePath: "AGENTS.md",
    sourcePaths: sources,
    activeModules: [],
});

async function makeProject() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-merge-md-"));
    await fs.writeFile(
        path.join(root, ".file-merge.config.yaml"),
        [
            "templatesDir: atom-framework/config-templates",
            "fragmentPatterns:",
            '  - "**/*.fragment.*"',
            "ignorePatterns:",
            '  - "**/node_modules/**"',
            "",
        ].join("\n"),
    );
    const templatesDir = path.join(root, "atom-framework/config-templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(path.join(templatesDir, "__AGENTS.md"), TEMPLATE);
    return root;
}

async function apply(root) {
    const manager = new ConfigManager({ projectRoot: root });
    await manager.init();
    const log = console.log;
    console.log = () => {};
    try {
        await manager.apply();
    } finally {
        console.log = log;
    }
}

describe("getStrategy", () => {
    test("returns markdown-concat for .md and .markdown", () => {
        assert.equal(getStrategy(undefined, "AGENTS.md").name, "markdown-concat");
        assert.equal(getStrategy(undefined, "/x/docs/README.markdown").name, "markdown-concat");
        assert.equal(getStrategy(undefined, "docker-compose.md").name, "markdown-concat");
    });

    test("explicit markdown-sections is honored", () => {
        assert.equal(getStrategy("markdown-sections", "AGENTS.md").name, "markdown-sections");
    });
});

describe("markdown-concat", () => {
    const concat = strategies["markdown-concat"];

    test("joins with one blank line, keeps whitespace and duplicates, ends with one newline", () => {
        const out = concat.merge(["A\n\n\nB\n", "- x\n- x\n\n", "C"], ctx());
        assert.equal(out, "A\n\n\nB\n\n- x\n- x\n\n\nC\n");
    });

    test("skips whitespace-only sources", () => {
        assert.equal(concat.merge(["A\n", "\n\n", "B\n"], ctx()), "A\n\nB\n");
    });

    test("rejects non-string sources", () => {
        assert.throws(() => concat.merge(["A", { a: 1 }], ctx()), /not text/);
    });
});

describe("markdown-sections", () => {
    const sections = strategies["markdown-sections"];

    test("merges a matching ## heading into the earlier section", () => {
        const override = "## Learned Workspace Facts\n\n- fact c\n";
        const out = sections.merge([TEMPLATE, override], ctx());
        assert.equal(out, TEMPLATE.replace("- fact b\n", "- fact b\n- fact c\n"));
        assert.equal(out.match(/## Learned Workspace Facts/g).length, 1);
    });

    test("appends unmatched content and keeps paragraphs separated", () => {
        const override =
            "Preamble of override.\n\n## Other\n\nMore other text.\n\n## New Section\n\nNew text.\n";
        const out = sections.merge([TEMPLATE, override], ctx());
        assert.equal(
            out,
            `${TEMPLATE.replace("Other text.\n", "Other text.\n\nMore other text.\n")}\nPreamble of override.\n\n## New Section\n\nNew text.\n`,
        );
    });

    test("ignores headings inside fenced code blocks", () => {
        const base = "## A\n\ntext\n";
        const override = "```md\n## A\n```\n";
        assert.equal(sections.merge([base, override], ctx()), "## A\n\ntext\n\n```md\n## A\n```\n");
    });

    test("behaves like markdown-concat when nothing matches", () => {
        const srcs = [TEMPLATE, "## Else\n\n\nstuff\n"];
        assert.equal(sections.merge(srcs, ctx()), strategies["markdown-concat"].merge(srcs, ctx()));
    });
});

describe("HeaderGenerator (Markdown)", () => {
    const root = "/project";
    const gen = new HeaderGenerator(root);
    const sources = [
        "/project/atom-framework/config-templates/__AGENTS.md",
        "/project/AGENTS.overrides.md",
    ];

    test("emits an HTML comment header for .md", () => {
        assert.equal(
            gen.generate("/project/AGENTS.md", sources),
            [
                "<!-- 🤖 GENERATED FILE - DO NOT EDIT DIRECTLY",
                "     Edit source files instead:",
                "       • file://./atom-framework/config-templates/__AGENTS.md",
                "       • file://./AGENTS.overrides.md",
                "     To regenerate: pnpm config:apply -->",
            ].join("\n"),
        );
    });

    test("removeHeader round-trips", () => {
        const header = gen.generate("/project/AGENTS.md", sources);
        for (const body of [TEMPLATE, "\nstarts with blank line\n", "# Heading\n"]) {
            const rendered = `${header}\n\n${body}`;
            assert.ok(gen.hasGeneratedHeader(rendered));
            assert.equal(gen.removeHeader(rendered, ".md"), body);
        }
    });

    test("removeHeader leaves Markdown headings alone when there is no header", () => {
        assert.equal(gen.removeHeader(TEMPLATE, ".md"), TEMPLATE);
    });

    test("removeHeader strips the legacy hash header from .md", () => {
        const legacy =
            "# Generated by config-manager from:\n# - file://./a.md\n# To regenerate: pnpm config:apply\n# Title\n";
        assert.equal(gen.removeHeader(legacy, ".md"), "# Title\n");
    });
});

describe("ConfigManager with Markdown", () => {
    let root;
    before(async () => {
        root = await makeProject();
    });
    after(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    test("template alone gives a symlink", async () => {
        await apply(root);
        const target = path.join(root, "AGENTS.md");
        const stats = await fs.lstat(target);
        assert.ok(stats.isSymbolicLink());
        assert.equal(
            path.resolve(root, await fs.readlink(target)),
            path.join(root, "atom-framework/config-templates/__AGENTS.md"),
        );
    });

    test("template + override gives generated file with HTML header", async () => {
        const override = "## Project Notes\n\nLine one.\n\n\nLine after two blanks.\n";
        await fs.writeFile(path.join(root, "AGENTS.overrides.md"), override);
        await apply(root);

        const target = path.join(root, "AGENTS.md");
        assert.ok(!(await fs.lstat(target)).isSymbolicLink());
        const content = await fs.readFile(target, "utf-8");

        const header = new HeaderGenerator(root).generate(target, [
            path.join(root, "atom-framework/config-templates/__AGENTS.md"),
            path.join(root, "AGENTS.overrides.md"),
        ]);
        assert.equal(content, `${header}\n\n${TEMPLATE}\n${override}`);
        assert.ok(content.startsWith("<!-- 🤖 GENERATED FILE"));
        assert.ok(!content.includes("# Generated by config-manager"));
    });

    test("override front matter selects markdown-sections", async () => {
        await fs.writeFile(
            path.join(root, "AGENTS.overrides.md"),
            "---\n_mergeStrategy: markdown-sections\n---\n\n## Learned Workspace Facts\n\n- fact c\n",
        );
        await apply(root);
        const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf-8");
        const body = new HeaderGenerator(root).removeHeader(content, ".md");
        assert.equal(body, TEMPLATE.replace("- fact b\n", "- fact b\n- fact c\n"));
    });

    test("fragments are merged in priority order between template and override", async () => {
        await fs.writeFile(path.join(root, "AGENTS.overrides.md"), "Override text.\n");
        await fs.writeFile(
            path.join(root, "late.fragment.md"),
            "---\n_targetPath: AGENTS.md\n_priority: 60\n---\nLate fragment.\n",
        );
        await fs.writeFile(
            path.join(root, "early.fragment.md"),
            "---\n_targetPath: AGENTS.md\n_priority: 50\n---\n\nEarly fragment.\n",
        );
        await apply(root);
        const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf-8");
        const body = new HeaderGenerator(root).removeHeader(content, ".md");
        assert.equal(body, `${TEMPLATE}\nEarly fragment.\n\nLate fragment.\n\nOverride text.\n`);
        assert.ok(!content.includes("_targetPath"));
        assert.ok(!content.includes("_priority"));
        await fs.rm(path.join(root, "late.fragment.md"));
        await fs.rm(path.join(root, "early.fragment.md"));
    });
});

describe("FragmentDiscovery (Markdown)", () => {
    test("parses front matter and strips it from the content", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-merge-frag-"));
        try {
            await fs.writeFile(
                path.join(root, "agents.fragment.md"),
                "---\n_targetPath: AGENTS.md\n_priority: 50\n_mergeStrategy: markdown-sections\n---\n## Section\n\n- item\n",
            );
            await fs.writeFile(path.join(root, "broken.fragment.md"), "## No front matter\n");

            const discovery = new FragmentDiscovery(root, { fragmentPatterns: ["*.fragment.*"] });
            const error = console.error;
            console.error = () => {};
            let fragments;
            try {
                fragments = await discovery.discoverFragments();
            } finally {
                console.error = error;
            }

            assert.equal(fragments.length, 1);
            const [fragment] = fragments;
            assert.deepEqual(fragment.metadata, {
                _targetPath: "AGENTS.md",
                _priority: 50,
                _mergeStrategy: "markdown-sections",
            });
            assert.equal(fragment.content, "## Section\n\n- item\n");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});

describe("OverrideCreator (Markdown)", () => {
    test("creates an override starting with an HTML comment that is not merged", async () => {
        const root = await makeProject();
        const log = console.log;
        console.log = () => {};
        try {
            await new OverrideCreator(root).create("AGENTS.md");
        } finally {
            console.log = log;
        }
        try {
            const override = await fs.readFile(path.join(root, "AGENTS.overrides.md"), "utf-8");
            assert.ok(override.startsWith("<!-- file-merge override for AGENTS.md"));
            assert.ok(!override.split("\n").some((line) => line.startsWith("#")));

            // Empty override: output is template + header, the explanatory comment is dropped
            const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf-8");
            assert.ok(content.startsWith("<!-- 🤖 GENERATED FILE"));
            assert.ok(!content.includes("file-merge override"));
            assert.equal(new HeaderGenerator(root).removeHeader(content, ".md"), TEMPLATE);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});

describe("DiffExtractor.extractTextLines", () => {
    const diff = new DiffExtractor();

    test("appended content is returned verbatim", () => {
        const r = diff.extractTextLines(TEMPLATE, `${TEMPLATE}\n## Extra\n\n\n- x\n`);
        assert.equal(r.added, "## Extra\n\n\n- x\n");
        assert.equal(r.removedLines, 0);
    });

    test("inserted lines are extracted, removed lines counted", () => {
        const current = TEMPLATE.replace("- fact b\n", "- fact b\n- fact c\n").replace(
            "Other text.\n",
            "",
        );
        const r = diff.extractTextLines(TEMPLATE, current);
        assert.equal(r.added, "- fact c\n");
        assert.equal(r.removedLines, 1);
    });

    test("identical content", () => {
        assert.equal(diff.extractTextLines(TEMPLATE, `${TEMPLATE}\n`).identical, true);
    });
});

describe("DiffExtractor.extractTextLines (markdownSections)", () => {
    const diff = new DiffExtractor();

    test("lines added inside a shared section get its heading, and round-trip via markdown-sections", () => {
        const current = `${TEMPLATE.replace("- fact b\n", "- fact b\n- fact c\n")}\n## Local\n\nStuff.\n`;
        const r = diff.extractTextLines(TEMPLATE, current, { markdownSections: true });
        assert.equal(r.usesSections, true);
        assert.equal(r.added, "## Learned Workspace Facts\n\n- fact c\n\n## Local\n\nStuff.\n");
        assert.equal(strategies["markdown-sections"].merge([TEMPLATE, r.added], ctx()), current);
    });

    test("content appended to the last section keeps its heading", () => {
        const current = `${TEMPLATE}More other.\n`;
        const r = diff.extractTextLines(TEMPLATE, current, { markdownSections: true });
        assert.equal(r.added, "## Other\n\nMore other.\n");
    });
});
