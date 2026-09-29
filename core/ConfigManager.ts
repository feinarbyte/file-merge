/**
 * Config Manager
 *
 * Main orchestrator for the unified configuration management system
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { minimatch } from "minimatch";
import YAML from "yaml";
import { getStrategy } from "../strategies/index.js";
import { ActiveModuleFilter } from "./ActiveModuleFilter.js";
import { type FileMergeConfig, FileMergeConfigLoader } from "./FileMergeConfig.js";
import { FragmentDiscovery } from "./FragmentDiscovery.js";
import { HeaderGenerator } from "./HeaderGenerator.js";
import { OverrideDiscovery } from "./OverrideDiscovery.js";
import { SymlinkManager } from "./SymlinkManager.js";
import { TemplateDiscovery } from "./TemplateDiscovery.js";
import type {
    ApplyResult,
    ConfigContent,
    ConfigManagerOptions,
    Fragment,
    MergeContext,
    Source,
} from "./types.js";

export class ConfigManager {
    private templateDiscovery: TemplateDiscovery;
    private fragmentDiscovery: FragmentDiscovery;
    private overrideDiscovery: OverrideDiscovery;
    private moduleFilter?: ActiveModuleFilter;
    private symlinkManager: SymlinkManager;
    private headerGenerator: HeaderGenerator;
    private config: FileMergeConfig;

    constructor(private options: ConfigManagerOptions) {
        // This will be initialized in init()
        this.config = null as any;
        this.templateDiscovery = null as any;
        this.fragmentDiscovery = null as any;
        this.overrideDiscovery = null as any;
        this.moduleFilter = null as any;
        this.symlinkManager = new SymlinkManager();
        this.headerGenerator = null as any;
    }

    /**
     * Initialize config and dependencies
     * Must be called before using the manager
     */
    async init(): Promise<void> {
        const { projectRoot, config: userConfig, configPath } = this.options;

        // Load config (use provided config or load from file/defaults)
        this.config = userConfig
            ? { ...(await FileMergeConfigLoader.load(projectRoot, configPath)), ...userConfig }
            : await FileMergeConfigLoader.load(projectRoot, configPath);

        // Initialize dependencies with config
        this.templateDiscovery = new TemplateDiscovery(projectRoot, this.config);
        this.fragmentDiscovery = new FragmentDiscovery(projectRoot, this.config);
        this.overrideDiscovery = new OverrideDiscovery(projectRoot);
        // Only create module filter if modules config is provided
        this.moduleFilter = this.config.modules
            ? new ActiveModuleFilter(projectRoot, this.config)
            : undefined;
        this.headerGenerator = new HeaderGenerator(projectRoot, this.config.jsonCommentStyle);
    }

    /**
     * Apply configuration from templates, fragments, and overrides
     */
    async apply(): Promise<ApplyResult> {
        // Ensure config is loaded
        if (!this.config) {
            await this.init();
        }

        const { verbose, check } = this.options;
        const isCheckMode = Boolean(check);
        const changedTargets: string[] = [];
        const unchangedTargets: string[] = [];

        if (!isCheckMode) {
            console.log("🔍 Discovering configuration sources...\n");
        }

        // 1. Discovery phase
        const templates = await this.templateDiscovery.discoverTemplates();
        const allFragments = await this.fragmentDiscovery.discoverFragments();
        const overrides = await this.overrideDiscovery.discoverOverrides();

        if (verbose) {
            console.log(`  Found ${templates.length} templates`);
            console.log(`  Found ${allFragments.length} fragments (before filtering)`);
            console.log(`  Found ${overrides.length} overrides\n`);
        }

        // 2. Filter fragments by active modules and conditions (if module filtering is enabled)
        const fragments = this.moduleFilter
            ? this.moduleFilter.filterFragmentsWithConditions(allFragments)
            : allFragments;

        const activeModules = this.moduleFilter?.getActiveModules() ?? [];

        if (verbose) {
            if (this.moduleFilter) {
                console.log(`  Active modules: ${activeModules.join(", ")}`);
            } else {
                console.log("  Module filtering: disabled (using glob patterns only)");
            }
            console.log(`  Fragments after filtering: ${fragments.length}\n`);
        }

        // 3. Group sources by target path
        const targetGroups = this.groupByTarget(templates, fragments, overrides);

        if (!isCheckMode) {
            console.log(`📋 Processing ${targetGroups.size} configuration files...\n`);
        }

        // 4. Process each target file
        const sortedTargets = Array.from(targetGroups.keys()).sort();

        for (const targetPath of sortedTargets) {
            const sources = targetGroups.get(targetPath);
            if (!sources) continue;
            const changed = await this.processTarget(targetPath, sources, activeModules);
            if (isCheckMode) {
                const relativePath = path.relative(this.options.projectRoot, targetPath);
                if (changed) {
                    changedTargets.push(relativePath);
                } else {
                    unchangedTargets.push(relativePath);
                }
            }
        }

        if (isCheckMode) {
            for (const relativePath of changedTargets) {
                console.log(`CHANGED ${relativePath}`);
            }
            console.log(
                `${changedTargets.length} changed, ${unchangedTargets.length} unchanged, ${sortedTargets.length} total`,
            );
        } else {
            console.log("\n✅ Configuration applied successfully!");
        }

        return {
            processedTargets: sortedTargets.length,
            changedTargets,
            unchangedTargets,
        };
    }

    /**
     * Group all sources by their target path
     */
    private groupByTarget(
        templates: Source[],
        fragments: Fragment[],
        overrides: Source[],
    ): Map<string, Source[]> {
        const groups = new Map<string, Source[]>();

        // Add templates
        for (const template of templates) {
            const targetPath = this.templateDiscovery.getTargetPath(
                template.path,
                template.resolvedRelativePath,
            );
            if (!groups.has(targetPath)) {
                groups.set(targetPath, []);
            }
            groups.get(targetPath)?.push(template);
        }

        // Add fragments
        for (const fragment of fragments) {
            const targets = Array.isArray(fragment.metadata._targetPath)
                ? fragment.metadata._targetPath
                : [fragment.metadata._targetPath];

            for (const target of targets) {
                const targetPath = path.join(this.options.projectRoot, target);

                if (!groups.has(targetPath)) {
                    groups.set(targetPath, []);
                }

                const source: Source = {
                    type: "fragment",
                    path: fragment.path,
                    content: fragment.content,
                    metadata: fragment.metadata,
                    priority: fragment.metadata._priority || 100,
                };

                groups.get(targetPath)?.push(source);
            }
        }

        // Add overrides
        for (const override of overrides) {
            const targetPath = this.overrideDiscovery.getTargetPath(override.path);
            if (!groups.has(targetPath)) {
                groups.set(targetPath, []);
            }
            groups.get(targetPath)?.push(override);
        }

        // Sort sources by priority within each group
        for (const [_targetPath, sources] of groups) {
            sources.sort((a, b) => {
                const priorityDiff = a.priority - b.priority;
                if (priorityDiff !== 0) {
                    return priorityDiff;
                }
                return a.path.localeCompare(b.path);
            });
        }

        return groups;
    }

    /**
     * Process a single target file
     */
    private async processTarget(
        targetPath: string,
        sources: Source[],
        activeModules: string[],
    ): Promise<boolean | undefined> {
        const { verbose, dryRun, check } = this.options;
        const isCheckMode = Boolean(check);
        const relativePath = path.relative(this.options.projectRoot, targetPath);

        if (sources.length === 0) {
            // No sources - remove target if it exists
            if (isCheckMode) {
                return this.wouldRemoveTargetChange(targetPath);
            }

            if (!dryRun) {
                await this.symlinkManager.remove(targetPath);
            }
            return undefined;
        }

        if (sources.length === 1) {
            // Single source
            const source = sources[0];

            // Special case: a single fragment should be GENERATED (not symlinked to the fragment file),
            // because fragments often include metadata and aren't intended to be the canonical file on disk.
            if (source.type === "fragment") {
                if (verbose && !isCheckMode) {
                    console.log(`🤖 ${relativePath} (single fragment source)`);
                }
                return this.generateTarget(targetPath, sources, activeModules);
            }

            // .template.properties and .overrides.properties should always be materialized
            // through merge generation, even as single-source inputs.
            if (this.shouldGeneratePropertiesForSingleSource(targetPath, source)) {
                if (verbose && !isCheckMode) {
                    console.log(`🤖 ${relativePath} (single properties source)`);
                }
                return this.generateTarget(targetPath, sources, activeModules);
            }

            const shouldCopyByPattern = matchesTargetPattern(
                relativePath,
                this.config.copyPatterns,
            );
            const shouldCopy = Boolean(
                this.config.noSymlink || source.metadata?._copy || shouldCopyByPattern,
            );

            if (verbose && !isCheckMode) {
                console.log(
                    `${shouldCopy ? "📄" : "🔗"} ${relativePath} (${shouldCopy ? "copy" : "symlink"} from ${path.relative(this.options.projectRoot, source.path)})`,
                );
            }

            if (isCheckMode) {
                return shouldCopy
                    ? this.wouldCopyTargetChange(source.path, targetPath)
                    : this.wouldSymlinkTargetChange(source.path, targetPath);
            }

            if (!dryRun) {
                if (shouldCopy) {
                    await this.symlinkManager.copyFile(source.path, targetPath);
                } else {
                    await this.symlinkManager.createSymlink(source.path, targetPath);
                }
            }
        } else {
            // Multiple sources - merge and generate
            if (verbose && !isCheckMode) {
                console.log(`🤖 ${relativePath} (merging ${sources.length} sources)`);
            }

            return this.generateTarget(targetPath, sources, activeModules);
        }

        return undefined;
    }

    /**
     * Generate a target from its sources. In check mode, only report whether the
     * target would change; in dry-run mode, do nothing.
     */
    private async generateTarget(
        targetPath: string,
        sources: Source[],
        activeModules: string[],
    ): Promise<boolean | undefined> {
        if (this.options.check) {
            const computed = await this.computeMergedContent(targetPath, sources, activeModules);
            return this.wouldMergedTargetChange(targetPath, computed.renderedContent);
        }

        if (!this.options.dryRun) {
            await this.mergeAndWrite(targetPath, sources, activeModules);
        }
        return undefined;
    }

    /**
     * Write generated content, skipping the write if the file already has identical
     * content (avoids churn and file watcher events). Symlinks are always replaced.
     */
    private async writeGeneratedFileIfChanged(
        targetPath: string,
        nextContent: string,
    ): Promise<"written" | "skipped"> {
        const nextBuffer = Buffer.from(nextContent, "utf-8");

        let stats: import("node:fs").Stats | undefined;
        try {
            stats = await fs.lstat(targetPath);
        } catch (error: unknown) {
            if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
            ) {
                // File doesn't exist yet - we'll write it below
                stats = undefined;
            } else {
                throw error;
            }
        }

        if (stats?.isDirectory()) {
            throw new Error(`Cannot write ${targetPath}: is a directory`);
        }

        // If target is a symlink, always replace with a real file (mode correctness).
        if (stats?.isSymbolicLink()) {
            await fs.unlink(targetPath);
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, nextBuffer);
            return "written";
        }

        if (stats?.isFile()) {
            const existingBuffer = await fs.readFile(targetPath);
            if (existingBuffer.equals(nextBuffer)) {
                return "skipped";
            }
        }

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, nextBuffer);
        return "written";
    }

    private async mergeAndWrite(
        targetPath: string,
        sources: Source[],
        activeModules: string[],
    ): Promise<void> {
        const computed = await this.computeMergedContent(targetPath, sources, activeModules);
        const result = await this.writeGeneratedFileIfChanged(targetPath, computed.renderedContent);
        if (result === "skipped" && this.options.verbose) {
            console.log(`  ⏭️  ${path.relative(this.options.projectRoot, targetPath)} unchanged`);
        }
    }

    private async computeMergedContent(
        targetPath: string,
        sources: Source[],
        activeModules: string[],
    ): Promise<{ renderedContent: string }> {
        const ext = path.extname(targetPath).toLowerCase();

        // Get merge strategy (from first source with strategy, or auto-detect)
        const explicitStrategy = sources.find((s) => s.metadata?._mergeStrategy)?.metadata
            ?._mergeStrategy;
        const strategy = getStrategy(explicitStrategy, targetPath);

        // Create merge context
        const relativePath = path.relative(this.options.projectRoot, targetPath);
        const context: MergeContext = {
            targetPath,
            relativePath,
            sourcePaths: sources.map((s) => s.path),
            sourceMetadata: sources.map((s) => s.metadata),
            activeModules,
            arrayMerge: matchesTargetPattern(relativePath, this.config.replaceArrayPatterns)
                ? "replace"
                : "union",
        };

        // Merge all sources
        const contents = sources.map((s) => s.content);
        const merged = strategy.merge(contents, context);

        // Post-process if strategy supports it
        const final = strategy.postProcess ? strategy.postProcess(merged, context) : merged;

        // Generate header
        const header = this.headerGenerator.generate(
            targetPath,
            sources.map((s) => s.path),
        );

        const renderedContent = await this.renderMergedContent(targetPath, ext, final, header);

        return { renderedContent };
    }

    private async renderMergedContent(
        targetPath: string,
        ext: string,
        final: ConfigContent,
        header: string,
    ): Promise<string> {
        // .code-workspace files are JSON files
        if ([".json", ".jsonc", ".json5", ".code-workspace"].includes(ext)) {
            const jsonCommentStyle = this.headerGenerator.getJsonCommentStyle(targetPath);
            const jsonContent = JSON.stringify(
                typeof final === "object" && final !== null ? final : {},
                null,
                2,
            );

            if (jsonCommentStyle === "jsonc") {
                // JSONC: prepend // comments before the JSON
                return `${header}\n${jsonContent}\n`;
            } else if (jsonCommentStyle === "none") {
                // No header
                return `${jsonContent}\n`;
            } else {
                // $comment: merge header object with content
                const headerObj = JSON.parse(header);
                const combined = {
                    ...(typeof headerObj === "object" && headerObj !== null ? headerObj : {}),
                    ...(typeof final === "object" && final !== null ? final : {}),
                };
                return `${JSON.stringify(combined, null, 2)}\n`;
            }
        } else if ([".yaml", ".yml"].includes(ext)) {
            // For YAML, prepend header comments
            const yamlOptions = {
                indent: 2,
                lineWidth: 0, // Disable automatic line wrapping
                sortKeys: false,
            };
            const yamlContent = YAML.stringify(final, yamlOptions);
            return header + yamlContent;
        } else if (ext === ".toml") {
            // For TOML, prepend header comments and stringify
            const TOML = await import("@iarna/toml");
            // TOML.stringify expects JsonMap, cast final appropriately
            const tomlContent = TOML.stringify(final as any);
            return header + tomlContent;
        } else if (ext === ".properties") {
            // .properties output is already normalized by the merge strategy;
            // keep template comments intact by not prepending generated headers.
            let content: string;
            if (typeof final === "string") {
                content = final;
            } else {
                const fallback = typeof final === "object" && final !== null ? final : {};
                content = `${JSON.stringify(fallback, null, 2)}\n`;
            }
            return content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
        } else if ([".ts", ".js", ".mjs", ".cjs"].includes(ext)) {
            // For JS/TS, prepend JSDoc header
            const content = typeof final === "string" ? final : JSON.stringify(final, null, 2);
            return `${header}\n${content}`;
        } else if ([".md", ".markdown"].includes(ext)) {
            // For Markdown, prepend HTML-comment header followed by a blank line
            if (typeof final !== "string") {
                throw new Error(
                    `Merged Markdown for ${path.relative(this.options.projectRoot, targetPath)} is not text. Use a Markdown strategy (markdown-concat or markdown-sections).`,
                );
            }
            return final === "" ? `${header}\n` : `${header}\n\n${final}`;
        } else {
            // For text files, prepend hash header
            const content = typeof final === "string" ? final : JSON.stringify(final, null, 2);
            return header + content;
        }
    }

    private async wouldRemoveTargetChange(targetPath: string): Promise<boolean> {
        try {
            await fs.lstat(targetPath);
            return true;
        } catch (error: unknown) {
            if (this.isEnoentError(error)) {
                return false;
            }
            throw error;
        }
    }

    private async wouldSymlinkTargetChange(
        sourcePath: string,
        targetPath: string,
    ): Promise<boolean> {
        return !(await this.symlinkManager.isSymlinkTo(targetPath, sourcePath));
    }

    private async wouldCopyTargetChange(sourcePath: string, targetPath: string): Promise<boolean> {
        let targetStats: Awaited<ReturnType<typeof fs.lstat>>;
        try {
            targetStats = await fs.lstat(targetPath);
        } catch (error: unknown) {
            if (this.isEnoentError(error)) {
                return true;
            }
            throw error;
        }

        if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
            return true;
        }

        const [sourceBuffer, targetBuffer] = await Promise.all([
            fs.readFile(sourcePath),
            fs.readFile(targetPath),
        ]);
        return !sourceBuffer.equals(targetBuffer);
    }

    private async wouldMergedTargetChange(
        targetPath: string,
        expectedContent: string,
    ): Promise<boolean> {
        let targetStats: Awaited<ReturnType<typeof fs.lstat>>;
        try {
            targetStats = await fs.lstat(targetPath);
        } catch (error: unknown) {
            if (this.isEnoentError(error)) {
                return true;
            }
            throw error;
        }

        if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
            return true;
        }

        const currentContent = await fs.readFile(targetPath, "utf-8");
        return currentContent !== expectedContent;
    }

    private shouldGeneratePropertiesForSingleSource(targetPath: string, source: Source): boolean {
        if (path.extname(targetPath).toLowerCase() !== ".properties") {
            return false;
        }

        const sourceName = path.basename(source.path).toLowerCase();
        return (
            sourceName.endsWith(".template.properties") ||
            sourceName.endsWith(".overrides.properties")
        );
    }

    private isEnoentError(error: unknown): boolean {
        return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
        );
    }
}

/**
 * Match a target path (relative to project root) against config glob patterns.
 * A pattern matches either the full relative path or the file name.
 */
function matchesTargetPattern(relativePath: string, patterns: string[] | undefined): boolean {
    return (patterns ?? []).some(
        (pattern) =>
            minimatch(relativePath, pattern) || minimatch(path.basename(relativePath), pattern),
    );
}
