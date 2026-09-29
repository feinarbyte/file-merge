/**
 * Override Discovery
 *
 * Discovers project-specific override files (*.overrides.*)
 * These have the highest priority in the merge process
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";
import { isMarkdownPath, parseFrontMatter, stripOverrideComment } from "./MarkdownUtils.js";
import type { ConfigContent, FragmentMetadata, Source } from "./types.js";

export class OverrideDiscovery {
    constructor(private projectRoot: string) {}

    /**
     * Discover all override files in project root
     * Pattern: *.overrides.{json,yaml,txt}
     */
    async discoverOverrides(): Promise<Source[]> {
        const pattern = path.join(this.projectRoot, "**/*.overrides.*");
        const overridePaths = await glob(pattern, {
            nodir: true,
            ignore: [
                "**/node_modules/**",
                "**/dist/**",
                "**/.git/**",
                "**/atom-framework/**", // Don't search in framework
            ],
        });

        overridePaths.sort();

        const overrides: Source[] = [];

        for (const overridePath of overridePaths) {
            try {
                const source: Source = isMarkdownPath(overridePath)
                    ? await this.loadMarkdownOverride(overridePath)
                    : {
                          type: "override",
                          path: overridePath,
                          content: await this.loadFile(overridePath),
                          priority: 1000, // Overrides have highest priority
                      };

                overrides.push(source);
            } catch (error) {
                console.error(`❌ Failed to load override ${overridePath}:`, error);
            }
        }

        return overrides.sort((a, b) => a.path.localeCompare(b.path));
    }

    /**
     * Get target path for an override file
     * Removes .overrides from filename
     */
    getTargetPath(overridePath: string): string {
        const relative = path.relative(this.projectRoot, overridePath);
        // Remove .overrides from the filename
        // e.g., tsconfig.overrides.json -> tsconfig.json
        const targetRelative = relative.replace(/\.overrides\.([^.]+)$/, ".$1");

        return path.join(this.projectRoot, targetRelative);
    }

    /**
     * Load a Markdown override.
     * - Removes the explanatory comment written by `config:override`
     * - Optional front matter may select the merge strategy:
     *     ---
     *     _mergeStrategy: markdown-sections
     *     ---
     *   Front matter is only treated as metadata if it contains `_`-prefixed keys.
     */
    private async loadMarkdownOverride(overridePath: string): Promise<Source> {
        let content = await fs.readFile(overridePath, "utf-8");
        let metadata: FragmentMetadata | undefined;

        const frontMatter = parseFrontMatter(content);
        if (frontMatter && Object.keys(frontMatter.data).some((key) => key.startsWith("_"))) {
            content = frontMatter.body;
            const strategy = frontMatter.data._mergeStrategy;
            if (typeof strategy === "string") {
                metadata = {
                    _targetPath: path.relative(this.projectRoot, this.getTargetPath(overridePath)),
                    _mergeStrategy: strategy,
                };
            }
        }

        return {
            type: "override",
            path: overridePath,
            content: stripOverrideComment(content),
            metadata,
            priority: 1000,
        };
    }

    /**
     * Load file content based on extension
     */
    private async loadFile(filePath: string): Promise<ConfigContent> {
        const ext = path.extname(filePath).toLowerCase();
        const content = await fs.readFile(filePath, "utf-8");

        // .code-workspace files are JSONC (JSON with comments and trailing commas allowed)
        if ([".json", ".jsonc", ".json5", ".code-workspace"].includes(ext)) {
            try {
                // Try strict JSON first
                return JSON.parse(content);
            } catch {
                // If strict JSON fails, try to parse as JSONC (remove trailing commas)
                // This handles VS Code workspace files which allow trailing commas
                try {
                    const cleaned = content.replace(/,(\s*[}\]])/g, "$1");
                    return JSON.parse(cleaned);
                } catch {
                    return content;
                }
            }
        } else if ([".yaml", ".yml"].includes(ext)) {
            const YAML = await import("yaml");
            return YAML.parse(content);
        } else if (ext === ".toml") {
            const TOML = await import("@iarna/toml");
            try {
                return TOML.parse(content) as ConfigContent;
            } catch {
                return content;
            }
        } else {
            return content;
        }
    }
}
