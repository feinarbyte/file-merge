/**
 * OverrideCreator
 *
 * Creates override files for managed configurations with helpful templates
 */

import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { DiffExtractor } from "../migration/DiffExtractor.js";
import { ConfigManager } from "./ConfigManager.js";
import { type FileMergeConfig, FileMergeConfigLoader } from "./FileMergeConfig.js";
import { HeaderGenerator } from "./HeaderGenerator.js";
import { OVERRIDE_COMMENT_MARKER, isMarkdownPath } from "./MarkdownUtils.js";
import { TemplateDiscovery } from "./TemplateDiscovery.js";
import type { ConfigContent } from "./types.js";

const exec = promisify(childProcess.exec);

export interface CreateOverrideOptions {
    /** Extract current file differences as starting point */
    extractCurrent?: boolean;
    /** Open in editor after creation */
    edit?: boolean;
    /** Override auto-detected merge strategy */
    template?: string;
    /** Force overwrite existing override */
    force?: boolean;
}

export class OverrideCreator {
    private templateDiscovery!: TemplateDiscovery;
    private diffExtractor: DiffExtractor;
    private config!: FileMergeConfig;

    constructor(private projectRoot: string) {
        this.diffExtractor = new DiffExtractor();
    }

    private async init(): Promise<void> {
        if (!this.config) {
            this.config = await FileMergeConfigLoader.load(this.projectRoot);
            this.templateDiscovery = new TemplateDiscovery(this.projectRoot, this.config);
        }
    }

    /**
     * Create override file for managed config
     */
    async create(targetPath: string, options: CreateOverrideOptions = {}): Promise<void> {
        await this.init();

        // 1. Validate and resolve paths
        const absoluteTargetPath = path.resolve(this.projectRoot, targetPath);
        const relativeTargetPath = path.relative(this.projectRoot, absoluteTargetPath);

        // 2. Find template
        const templatePath = this.findTemplatePath(relativeTargetPath);
        if (!templatePath) {
            throw new Error(
                `File not managed: ${relativeTargetPath}\n` +
                    `  No template found in ${this.config.templatesDir ?? "config-templates"}/\n` +
                    `  Use 'pnpm config:add ${relativeTargetPath}' to add it first.`,
            );
        }

        // 3. Determine override path
        const overridePath = this.getOverridePath(relativeTargetPath);
        const absoluteOverridePath = path.join(this.projectRoot, overridePath);

        // 4. Check if override already exists
        if (!options.force && (await this.fileExists(absoluteOverridePath))) {
            throw new Error(
                `Override already exists: ${overridePath}\n  Use --force to overwrite.`,
            );
        }

        console.log("✅ Creating override file\n");

        // 5. Create override content
        let content: string;

        if (options.extractCurrent && (await this.fileExists(absoluteTargetPath))) {
            console.log("  🔍 Extracting differences from current file...");
            content = await this.extractDifferences(
                templatePath,
                absoluteTargetPath,
                relativeTargetPath,
            );
        } else {
            console.log("  📝 Creating empty override template...");
            content = this.generateTemplate(relativeTargetPath);
        }

        // 6. Write override file
        await fs.mkdir(path.dirname(absoluteOverridePath), { recursive: true });
        await fs.writeFile(absoluteOverridePath, content);
        console.log(`\n  ✅ Created: ${overridePath}\n`);

        // 7. Show what's in the template
        this.showTemplatePreview(content);

        // 8. Trigger transition and regeneration
        console.log("\n  🔄 Auto-transitioning configuration mode...\n");
        await this.triggerRegeneration(relativeTargetPath);

        // 9. Open in editor if requested
        if (options.edit) {
            await this.openInEditor(absoluteOverridePath);
        }

        // 10. Show next steps
        console.log("\nNext steps:");
        console.log(`  1. Edit overrides: code ${overridePath}`);
        console.log("  2. Changes auto-apply with watch mode, or run: pnpm config:apply");
        if (isMarkdownPath(relativeTargetPath)) {
            console.log("\nTip: Content is appended after the template (markdown-concat).");
            console.log('     Add front matter "_mergeStrategy: markdown-sections" to merge');
            console.log('     matching "## Heading" sections into the template instead.');
        } else {
            console.log("\nTip: Use null values to delete keys from template");
            console.log('     Example: { "compilerOptions": { "strict": null } }');
        }
    }

    /**
     * Extract differences between template and current file
     */
    private async extractDifferences(
        templatePath: string,
        currentPath: string,
        relativeTargetPath: string,
    ): Promise<string> {
        const absoluteTemplatePath = path.join(this.projectRoot, templatePath);

        // Load both files
        const templateContent = await this.loadFile(absoluteTemplatePath);
        const currentContent = await this.loadFile(currentPath);

        if (isMarkdownPath(relativeTargetPath)) {
            // Line diff: keep lines of the current file that aren't in the template
            const diff = this.diffExtractor.extractTextLines(
                String(templateContent),
                new HeaderGenerator(this.projectRoot).removeHeader(
                    String(currentContent),
                    path.extname(currentPath),
                ),
                { markdownSections: true },
            );
            const frontMatter = diff.usesSections
                ? "---\n_mergeStrategy: markdown-sections\n---\n\n"
                : "";
            return (
                frontMatter +
                this.generateMarkdownTemplate(path.basename(relativeTargetPath)) +
                diff.added
            );
        }

        // Extract diff
        const diff = this.diffExtractor.extract(templateContent, currentContent, {
            strategy: "smart-extract",
            commentExtraction: false,
        });

        // Format as override file
        return this.formatOverrideContent(relativeTargetPath, diff.content);
    }

    /**
     * Generate empty template for override file
     */
    private generateTemplate(targetPath: string): string {
        const ext = path.extname(targetPath);
        const basename = path.basename(targetPath);

        if ([".json", ".jsonc", ".json5"].includes(ext)) {
            return this.generateJsonTemplate(basename);
        }
        if ([".yaml", ".yml"].includes(ext)) {
            return this.generateYamlTemplate(basename);
        }
        if (isMarkdownPath(targetPath)) {
            return this.generateMarkdownTemplate(basename);
        }
        return this.generateTextTemplate(basename);
    }

    /**
     * Generate JSON template
     */
    private generateJsonTemplate(basename: string): string {
        return JSON.stringify(
            {
                $comment: `Override file for ${basename}`,
                $comment2: "Add project-specific overrides here",
                $comment3: "These will be deep-merged with the master template",
                $comment4: "Use null to delete keys from template",
                $comment5: "Sources merged in order: template → fragments → THIS FILE",
                "// Example": "Add your overrides below this line",
            },
            null,
            2,
        );
    }

    /**
     * Generate YAML template
     */
    private generateYamlTemplate(basename: string): string {
        return `# Override file for ${basename}
# Add project-specific overrides here
# These will be deep-merged with the master template
# Sources merged in order: template → fragments → THIS FILE

# Example: Add your overrides below this line
`;
    }

    /**
     * Generate Markdown template
     * Starts with an HTML comment ("#" would be a heading). The comment is
     * recognised by OverrideDiscovery and not copied into the generated file.
     */
    private generateMarkdownTemplate(basename: string): string {
        return `${OVERRIDE_COMMENT_MARKER} for ${basename}
     Project-specific content. It is appended after the shared template
     (and any fragments) when running: pnpm config:apply
     To add content to an existing "## Heading" of the template instead of
     appending, start this file with front matter:
       ---
       _mergeStrategy: markdown-sections
       ---
     This comment is not copied into ${basename}. -->

`;
    }

    /**
     * Generate text template
     */
    private generateTextTemplate(basename: string): string {
        return `# Override file for ${basename}
# Lines here will be appended to the master template

# Add project-specific content below:
`;
    }

    /**
     * Format content as override file
     */
    private formatOverrideContent(targetPath: string, content: ConfigContent): string {
        const ext = path.extname(targetPath);

        if ([".json", ".jsonc", ".json5"].includes(ext)) {
            return JSON.stringify(
                {
                    $comment: `Extracted overrides for ${path.basename(targetPath)}`,
                    $comment2: "Edit these values as needed",
                    ...(typeof content === "object" ? content : { value: content }),
                },
                null,
                2,
            );
        }

        // For other formats, just return as string
        return typeof content === "string" ? content : JSON.stringify(content, null, 2);
    }

    /**
     * Show template preview
     */
    private showTemplatePreview(content: string): void {
        const lines = content.split("\n");
        const previewLines = lines.slice(0, 10);

        console.log("  Template contents:");
        for (const line of previewLines) {
            console.log(`    ${line}`);
        }
        if (lines.length > 10) {
            console.log(`    ... (${lines.length - 10} more lines)`);
        }
    }

    /**
     * Trigger regeneration of target file
     */
    private async triggerRegeneration(targetPath: string): Promise<void> {
        const manager = new ConfigManager({
            projectRoot: this.projectRoot,
            verbose: false,
        });

        await manager.apply();

        // Show transition message
        console.log("  Before:  🔗 Symlinked (single source)");
        console.log("  After:   🤖 Generated (multiple sources)");
    }

    /**
     * Open file in editor
     */
    private async openInEditor(filePath: string): Promise<void> {
        const editor = process.env.EDITOR || process.env.VISUAL || "code";

        try {
            console.log(`\n  📝 Opening in editor: ${editor}`);
            await exec(`${editor} "${filePath}"`);
        } catch (error) {
            console.warn(`\n  ⚠️  Could not open editor: ${error}`);
            console.log(`     Please open manually: ${filePath}`);
        }
    }

    /**
     * Get override path for a target file
     */
    private getOverridePath(targetPath: string): string {
        const parsed = path.parse(targetPath);
        const extWithoutDot = parsed.ext.slice(1);
        return path.join(
            parsed.dir,
            `${parsed.name}.overrides${extWithoutDot ? `.${extWithoutDot}` : ""}`,
        );
    }

    /**
     * Find template path for a target file
     */
    private findTemplatePath(targetPath: string): string | null {
        const parsed = path.parse(targetPath);
        const templatePath = path.join(
            this.config.templatesDir ?? "config-templates",
            parsed.dir,
            `__${parsed.base}`,
        );

        const absolutePath = path.join(this.projectRoot, templatePath);

        return existsSync(absolutePath) ? templatePath : null;
    }

    /**
     * Load file content
     */
    private async loadFile(filePath: string): Promise<ConfigContent> {
        const content = await fs.readFile(filePath, "utf-8");
        const ext = path.extname(filePath);

        if ([".json", ".jsonc", ".json5"].includes(ext)) {
            return JSON.parse(content);
        }

        return content;
    }

    /**
     * Check if file exists
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}
