/**
 * Template Discovery
 *
 * Discovers template files in config-templates directory.
 * Supported naming conventions:
 *  - __filename.ext (legacy)
 *  - filename.template.properties
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";
import type { FileMergeConfig } from "./FileMergeConfig.js";
import { TemplateVariableResolver } from "./TemplateVariableResolver.js";
import type { ConfigContent, Source } from "./types.js";

export class TemplateDiscovery {
    constructor(
        private projectRoot: string,
        private config: FileMergeConfig,
    ) {}

    /**
     * Discover all template files in configured templates directory
     * Template files can use __ prefix (legacy) or .template.properties suffix.
     */
    async discoverTemplates(): Promise<Source[]> {
        const templatesDir = path.join(
            this.projectRoot,
            this.config.templatesDir ?? "config-templates",
        );

        // Check if templates directory exists
        try {
            await fs.access(templatesDir);
        } catch {
            console.warn(`⚠️  Templates directory not found: ${templatesDir}`);
            return [];
        }

        // Find all supported template naming patterns.
        const [legacyTemplatePaths, propertiesTemplatePaths] = await Promise.all([
            glob(path.join(templatesDir, "**/__*"), {
                nodir: true,
                dot: true, // Include hidden files like __.gitignore
            }),
            glob(path.join(templatesDir, "**/*.template.properties"), {
                nodir: true,
                dot: true,
            }),
        ]);
        const templatePaths = Array.from(new Set([...legacyTemplatePaths, ...propertiesTemplatePaths]));

        templatePaths.sort();

        const templates: Source[] = [];

        for (const templatePath of templatePaths) {
            try {
                const _relativePath = path.relative(templatesDir, templatePath);

                // Resolve template variables in the relative path (filename) FIRST
                // This allows us to skip templates early if variables aren't available
                let resolvedRelativePath: string;
                try {
                    resolvedRelativePath = TemplateVariableResolver.resolve(_relativePath);
                } catch (error) {
                    // If variables can't be resolved, skip this template (override file can still provide values)
                    console.warn(
                        `⚠️  Skipping template ${templatePath}: template variables not resolved (${error instanceof Error ? error.message : String(error)})`,
                    );
                    continue;
                }

                // Only load content if filename resolution succeeded
                // Check for unresolved variables in raw content before loading
                const rawContent = await fs.readFile(templatePath, "utf-8");
                if (TemplateVariableResolver.hasVariables(rawContent)) {
                    try {
                        // Try to resolve - if it fails, skip this template
                        TemplateVariableResolver.resolve(rawContent);
                    } catch (error) {
                        // Variables can't be resolved - skip template (override/fragment can provide values)
                        console.warn(
                            `⚠️  Skipping template ${templatePath}: content has unresolved template variables (${error instanceof Error ? error.message : String(error)})`,
                        );
                        continue;
                    }
                }

                const content = await this.loadFile(templatePath);

                // Text files are valid templates - they will be symlinked or copied, not parsed as objects
                // Only skip if it's a JSON file that failed to parse (indicated by string content for JSON files)
                const ext = path.extname(templatePath).toLowerCase();
                const basename = path.basename(templatePath).toLowerCase();
                const isJsonFile =
                    [".json", ".jsonc", ".json5"].includes(ext) ||
                    basename.endsWith(".json") ||
                    basename.endsWith(".jsonc");

                // Allow all text files by default - only skip JSON files that returned text (failed to parse)
                if (typeof content === "string" && isJsonFile) {
                    console.warn(
                        `⚠️  Skipping template ${templatePath}: content is text (likely invalid JSON after variable resolution)`,
                    );
                    continue;
                }

                // All other text files (TypeScript, shell scripts, markdown, config files, etc.) are valid

                templates.push({
                    type: "template",
                    path: templatePath,
                    content,
                    priority: 0, // Templates have lowest priority
                    resolvedRelativePath, // Store resolved path for target path calculation
                });
            } catch (error) {
                // Template failed to load (invalid JSON, missing variables, etc.) - skip it
                console.warn(
                    `⚠️  Skipping template ${templatePath}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        return templates.sort((a, b) => {
            const relA = a.resolvedRelativePath ?? path.relative(templatesDir, a.path);
            const relB = b.resolvedRelativePath ?? path.relative(templatesDir, b.path);
            return relA.localeCompare(relB) || a.path.localeCompare(b.path);
        });
    }

    /**
     * Get target path for a template file
     * Removes __ prefix and maps to project root
     * Resolves template variables in the path
     */
    getTargetPath(templatePath: string, resolvedRelativePath?: string): string {
        const templatesDir = path.join(
            this.projectRoot,
            this.config.templatesDir ?? "config-templates",
        );

        let relativePath: string;
        if (resolvedRelativePath) {
            // Use already resolved path
            relativePath = resolvedRelativePath;
        } else {
            // Resolve variables in relative path
            const rawRelativePath = path.relative(templatesDir, templatePath);
            relativePath = TemplateVariableResolver.resolve(rawRelativePath);
        }

        const targetRelative = this.mapTemplateRelativePath(relativePath);

        // Resolve any remaining variables in the target path (in case variables are in directory parts)
        const fullyResolved = TemplateVariableResolver.resolve(targetRelative);

        return path.join(this.projectRoot, fullyResolved);
    }

    private mapTemplateRelativePath(relativePath: string): string {
        const parsed = path.parse(relativePath);

        if (parsed.base.startsWith("__")) {
            // Legacy __filename.ext -> filename.ext
            const targetBase = parsed.base.replace(/^__/, "");
            return path.join(parsed.dir, targetBase);
        }

        if (/\.template\.properties$/iu.test(parsed.base)) {
            // New filename.template.properties -> filename.properties
            const targetBase = parsed.base.replace(/\.template\.properties$/iu, ".properties");
            return path.join(parsed.dir, targetBase);
        }

        return relativePath;
    }

    /**
     * Load file content based on extension
     */
    private async loadFile(filePath: string): Promise<ConfigContent> {
        const ext = path.extname(filePath).toLowerCase();
        let content = await fs.readFile(filePath, "utf-8");

        // Resolve template variables in content
        // Missing variables should throw - they must be set in mise.toml or environment
        if (TemplateVariableResolver.hasVariables(content)) {
            content = TemplateVariableResolver.resolve(content);
        }

        if ([".json", ".jsonc", ".json5"].includes(ext) || filePath.endsWith(".code-workspace")) {
            // For JSON/JSONC, parse it after variable resolution
            // .code-workspace files are JSONC (allow trailing commas)
            try {
                // Try strict JSON first
                return JSON.parse(content);
            } catch (error) {
                // If strict JSON fails, try to parse as JSONC (remove trailing commas)
                // This handles VS Code workspace files which allow trailing commas
                try {
                    const cleaned = content.replace(/,(\s*[}\]])/g, "$1");
                    return JSON.parse(cleaned);
                } catch (jsoncError) {
                    // If both fail, throw error (invalid template)
                    throw new Error(
                        `Failed to parse JSON/JSONC in ${filePath} after variable resolution: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
        } else if ([".yaml", ".yml"].includes(ext)) {
            // For YAML, we'll parse it using the yaml library
            const YAML = await import("yaml");
            return YAML.parse(content);
        } else if (ext === ".toml") {
            // For TOML, parse it using @iarna/toml
            const TOML = await import("@iarna/toml");
            try {
                return TOML.parse(content) as ConfigContent;
            } catch (error) {
                throw new Error(
                    `Failed to parse TOML in ${filePath} after variable resolution: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        } else if (ext === ".npmrc" || filePath.endsWith(".npmrc")) {
            // .npmrc files are text files (INI-like format), not JSON
            // Return as text so they can be symlinked/copied
            return content;
        } else {
            // For other files, return as text
            return content;
        }
    }
}
