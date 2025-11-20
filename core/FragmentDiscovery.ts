/**
 * Fragment Discovery
 *
 * Discovers fragment files across multiple locations
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";
import type {
  ConfigContent,
  Fragment,
  FragmentMetadata,
  JsonValue,
} from "./types.js";
import { TemplateVariableResolver } from "./TemplateVariableResolver.js";

export class FragmentDiscovery {
  constructor(private projectRoot: string) {}

  /**
   * Discover all fragment files across the project
   * Returns unfiltered list (ActiveModuleFilter applies filtering later)
   */
  async discoverFragments(): Promise<Fragment[]> {
    const searchLocations = [
      "atom-framework/**/*.fragment.*",
      "packages/**/*.fragment.*",
      "apps/**/*.fragment.*",
      "deployment/**/*.fragment.*",
      "*.fragment.*",
    ];

    const fragments: Fragment[] = [];

    for (const pattern of searchLocations) {
      const fullPattern = path.join(this.projectRoot, pattern);
      const fragmentPaths = await glob(fullPattern, {
        nodir: true,
        ignore: [
          "**/node_modules/**",
          "**/dist/**",
          "**/.git/**",
          "**/atom-framework/templates/**", // Exclude bootstrap templates
        ],
      });

      fragmentPaths.sort();

      for (const fragmentPath of fragmentPaths) {
        try {
          const fragment = await this.loadFragment(fragmentPath);
          if (fragment) {
            fragments.push(fragment);
          }
        } catch (error) {
          console.error(`❌ Failed to load fragment ${fragmentPath}:`, error);
        }
      }
    }

    return fragments.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Load and parse a fragment file
   */
  private async loadFragment(filePath: string): Promise<Fragment | null> {
    const ext = path.extname(filePath).toLowerCase();
    const content = await fs.readFile(filePath, "utf-8");
    const relativeDir = path.dirname(path.relative(this.projectRoot, filePath));

    let parsed: JsonValue | undefined;

    // Parse based on extension
    if ([".json", ".jsonc", ".json5"].includes(ext)) {
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        console.error(`❌ Invalid JSON in ${filePath}:`, error);
        return null;
      }
    } else if ([".yaml", ".yml"].includes(ext)) {
      const YAML = await import("yaml");
      try {
        parsed = YAML.parse(content);
      } catch (error) {
        console.error(`❌ Invalid YAML in ${filePath}:`, error);
        return null;
      }
    } else if (ext === ".toml") {
      const TOML = await import("@iarna/toml");
      try {
        parsed = TOML.parse(content) as JsonValue;
      } catch (error) {
        console.error(`❌ Invalid TOML in ${filePath}:`, error);
        return null;
      }
    } else if (ext === ".txt") {
      // For .txt files, extract metadata from special comments
      const metadata = this.extractTextMetadata(content);
      if (!metadata._targetPath) {
        console.error(`❌ Fragment ${filePath} missing _targetPath`);
        return null;
      }
      
      // Resolve template variables in _targetPath
      try {
        if (typeof metadata._targetPath === "string") {
          metadata._targetPath = TemplateVariableResolver.resolve(metadata._targetPath);
        } else if (Array.isArray(metadata._targetPath)) {
          metadata._targetPath = metadata._targetPath.map(path => 
            TemplateVariableResolver.resolve(path)
          );
        }
      } catch (error) {
        console.error(`❌ Failed to resolve template variables in _targetPath for ${filePath}:`, error);
        throw error;
      }
      
      return {
        path: filePath,
        content: this.stripMetadata(content),
        metadata,
        relativeDir,
      };
    } else {
      console.warn(`⚠️  Unsupported fragment format: ${filePath}`);
      return null;
    }

    if (!parsed) {
      console.error(`❌ Failed to parse ${filePath}`);
      return null;
    }

    // Extract metadata
    const metadata = this.extractMetadata(parsed);

    if (!metadata._targetPath) {
      console.error(`❌ Fragment ${filePath} missing _targetPath`);
      return null;
    }

    // Resolve template variables in _targetPath
    try {
      if (typeof metadata._targetPath === "string") {
        metadata._targetPath = TemplateVariableResolver.resolve(metadata._targetPath);
      } else if (Array.isArray(metadata._targetPath)) {
        metadata._targetPath = metadata._targetPath.map(path => 
          TemplateVariableResolver.resolve(path)
        );
      }
    } catch (error) {
      console.error(`❌ Failed to resolve template variables in _targetPath for ${filePath}:`, error);
      throw error;
    }

    // Remove metadata properties from content
    const cleanContent = this.removeMetadataProperties(parsed);

    return {
      path: filePath,
      content: cleanContent,
      metadata,
      relativeDir,
    };
  }

  /**
   * Extract metadata properties from parsed content
   */
  private extractMetadata(content: JsonValue): FragmentMetadata {
    // Content should be an object with metadata properties
    if (
      typeof content !== "object" ||
      content === null ||
      Array.isArray(content)
    ) {
      throw new Error("Fragment content must be an object");
    }

    const contentObj = content as Record<string, JsonValue>;

    const metadata: FragmentMetadata = {
      _targetPath: contentObj._targetPath as string | string[],
    };

    if (contentObj._mergeStrategy !== undefined)
      metadata._mergeStrategy = contentObj._mergeStrategy as string;
    if (contentObj._priority !== undefined)
      metadata._priority = contentObj._priority as number;
    if (contentObj._conditions !== undefined)
      metadata._conditions = contentObj._conditions as typeof metadata._conditions;
    if (contentObj._copy !== undefined) metadata._copy = contentObj._copy as boolean;
    if (contentObj._activeOnly !== undefined)
      metadata._activeOnly = contentObj._activeOnly as boolean;

    return metadata;
  }

  /**
   * Remove metadata properties from content
   */
  private removeMetadataProperties(content: JsonValue): ConfigContent {
    if (typeof content !== "object" || content === null) {
      return content;
    }

    const clean: Record<string, JsonValue> | JsonValue[] = Array.isArray(
      content,
    )
      ? [...content]
      : { ...(content as Record<string, JsonValue>) };

    // Remove all properties starting with _
    if (!Array.isArray(clean)) {
      for (const key of Object.keys(clean)) {
        if (key.startsWith("_")) {
          delete (clean as Record<string, JsonValue>)[key];
        }
      }
    }

    return clean as ConfigContent;
  }

  /**
   * Extract metadata from text file using special comment format
   * Example:
   *   _targetPath=.gitignore
   *   _mergeStrategy=append-lines
   *   _copy=true
   */
  private extractTextMetadata(content: string): FragmentMetadata {
    const metadata: FragmentMetadata = {
      _targetPath: "",
    };

    const lines = content.split("\n");
    for (const line of lines) {
      const match = line.match(/^_(\w+)=(.+)$/);
      if (match) {
        const [, key, value] = match;
        if (key === "targetPath") {
          metadata._targetPath = value.trim();
        } else if (key === "mergeStrategy") {
          metadata._mergeStrategy = value.trim();
        } else if (key === "priority") {
          metadata._priority = Number.parseInt(value.trim(), 10);
        } else if (key === "copy") {
          metadata._copy = value.trim().toLowerCase() === "true";
        } else if (key === "activeOnly") {
          metadata._activeOnly = value.trim().toLowerCase() === "true";
        }
      }
    }

    return metadata;
  }

  /**
   * Remove metadata lines from text content
   */
  private stripMetadata(content: string): string {
    const lines = content.split("\n");
    const filtered = lines.filter((line) => !line.match(/^_\w+=/));
    return filtered.join("\n");
  }
}
