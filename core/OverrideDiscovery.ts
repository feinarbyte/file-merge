/**
 * Override Discovery
 *
 * Discovers project-specific override files (*.overrides.*)
 * These have the highest priority in the merge process
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";
import type { ConfigContent, Source } from "./types.js";

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
        const content = await this.loadFile(overridePath);

        overrides.push({
          type: "override",
          path: overridePath,
          content,
          priority: 1000, // Overrides have highest priority
        });
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
   * Load file content based on extension
   */
  private async loadFile(filePath: string): Promise<ConfigContent> {
    const ext = path.extname(filePath).toLowerCase();
    const content = await fs.readFile(filePath, "utf-8");

    if ([".json", ".jsonc", ".json5"].includes(ext)) {
      try {
        return JSON.parse(content);
      } catch {
        return content;
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
