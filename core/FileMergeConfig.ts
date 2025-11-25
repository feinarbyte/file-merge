/**
 * Configuration schema for file-merge
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * JSON comment style options
 */
export type JsonCommentStyleType = "$comment" | "jsonc" | "none";

/**
 * JSON comment style configuration
 */
export interface JsonCommentStyleConfig {
  /**
   * Default comment style for JSON files
   * @default "$comment"
   */
  default?: JsonCommentStyleType;
  
  /**
   * Glob patterns for files that should use JSONC-style comments (// ...)
   * Only applies to .json files
   */
  jsonc?: string[];
  
  /**
   * Glob patterns for files that should have no header comment
   */
  none?: string[];
}

export interface FileMergeConfig {
  /**
   * Directory containing template files with __ prefix
   * Relative to project root
   * @default "atom-framework/config-templates"
   */
  templatesDir?: string;

  /**
   * Glob patterns for discovering fragment files
   * Relative to project root
   * @default ["atom-framework / ** / *.fragment.*", "packages / ** / *.fragment.*", "apps / ** / *.fragment.*", "deployment / ** / *.fragment.*", "*.fragment.*"]
   */
  fragmentPatterns?: string[];

  /**
   * Glob patterns to ignore when discovering fragments
   * @default ["** / node_modules / **", "** / dist / **", "** / .git / **", "** / atom-framework / templates / **"]
   */
  ignorePatterns?: string[];

  /**
   * Module directories configuration for active module filtering
   * Optional: Only needed if you want symlink-based module activation filtering
   * If not specified, all fragments matching fragmentPatterns will be included
   */
  modules?: {
    /**
     * Directory where active modules are symlinked
     * Relative to project root
     * @default "modules"
     */
    activeDir?: string;
    
    /**
     * Directory containing available modules
     * Relative to project root
     * @default "atom-framework/modules"
     */
    sourceDir?: string;
  };

  /**
   * Watch mode patterns
   * Patterns to watch for changes in watch mode
   * If not specified will be derived from templatesDir and fragmentPatterns
   */
  watchPatterns?: string[];

  /**
   * JSON comment style configuration
   * Controls how generated headers are added to JSON files
   * @default { default: "$comment" }
   */
  jsonCommentStyle?: JsonCommentStyleConfig;
}

export class FileMergeConfigLoader {
  private static readonly CONFIG_FILENAMES = [
    ".file-merge.config.yaml",
    ".file-merge.config.yml", 
    ".file-merge.config.json"
  ];
  
  /**
   * Default configuration (for backward compatibility with atom-framework)
   */
  private static readonly DEFAULTS: FileMergeConfig = {
    templatesDir: "atom-framework/config-templates",
    fragmentPatterns: [
      "atom-framework/**/*.fragment.*",
      "packages/**/*.fragment.*",
      "apps/**/*.fragment.*",
      "deployment/**/*.fragment.*",
      "*.fragment.*",
    ],
    ignorePatterns: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/atom-framework/templates/**",
    ],
    modules: {
      activeDir: "modules",
      sourceDir: "atom-framework/modules",
    },
    watchPatterns: [],
  };

  /**
   * Load configuration from project root or specified path
   * Falls back to defaults if config file doesn't exist
   * Supports both YAML (.yaml, .yml) and JSON (.json) formats
   */
  static async load(projectRoot: string, configPath?: string): Promise<FileMergeConfig> {
    let resolvedConfigPath: string;
    
    if (configPath) {
      // User specified a config path
      resolvedConfigPath = path.isAbsolute(configPath) 
        ? configPath 
        : path.join(projectRoot, configPath);
    } else {
      // Try each default config filename in order
      for (const filename of this.CONFIG_FILENAMES) {
        const testPath = path.join(projectRoot, filename);
        try {
          await fs.access(testPath);
          resolvedConfigPath = testPath;
          break;
        } catch {
          // File doesn't exist, try next
        }
      }
      
      // If no config file found, use defaults
      if (!resolvedConfigPath!) {
        const defaults = { ...this.DEFAULTS };
        defaults.watchPatterns = this.deriveWatchPatterns(this.DEFAULTS);
        return defaults;
      }
    }

    try {
      const configContent = await fs.readFile(resolvedConfigPath, "utf-8");
      const ext = path.extname(resolvedConfigPath).toLowerCase();
      
      let userConfig: FileMergeConfig;
      if (['.yaml', '.yml'].includes(ext)) {
        // Parse YAML
        const YAML = await import("yaml");
        userConfig = YAML.parse(configContent);
      } else {
        // Parse JSON
        userConfig = JSON.parse(configContent);
      }

      // Merge with defaults, but keep modules undefined if not specified by user
      const config: FileMergeConfig = {
        templatesDir: userConfig.templatesDir ?? this.DEFAULTS.templatesDir!,
        fragmentPatterns: userConfig.fragmentPatterns ?? this.DEFAULTS.fragmentPatterns!,
        ignorePatterns: userConfig.ignorePatterns ?? this.DEFAULTS.ignorePatterns!,
        modules: userConfig.modules !== undefined ? {
          activeDir: userConfig.modules?.activeDir ?? this.DEFAULTS.modules!.activeDir,
          sourceDir: userConfig.modules?.sourceDir ?? this.DEFAULTS.modules!.sourceDir,
        } : undefined,
        watchPatterns: userConfig.watchPatterns ?? this.deriveWatchPatterns(userConfig),
        jsonCommentStyle: userConfig.jsonCommentStyle,
      };

      return config;
    } catch (error: unknown) {
      // Config file doesn't exist or is invalid - use defaults
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // Derive watch patterns from defaults
        const defaults = { ...this.DEFAULTS };
        defaults.watchPatterns = this.deriveWatchPatterns(this.DEFAULTS);
        return defaults;
      }

      // Invalid JSON or other error
      throw new Error(
        `Failed to load config from ${resolvedConfigPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Derive watch patterns from config
   * If not explicitly set, generates patterns from templatesDir and fragmentPatterns
   */
  private static deriveWatchPatterns(config: FileMergeConfig): string[] {
    const patterns: string[] = [];

    // Add templates directory pattern
    if (config.templatesDir) {
      patterns.push(`${config.templatesDir}/**/*`);
    }

    // Add fragment patterns (they already include **/*.fragment.*)
    if (config.fragmentPatterns) {
      patterns.push(...config.fragmentPatterns);
    }

    // Add override patterns
    patterns.push("**/*.overrides.*");

    return patterns;
  }

  /**
   * Create example config file
   */
  static async createExample(projectRoot: string, format: 'yaml' | 'json' = 'yaml', force = false): Promise<void> {
    const filename = format === 'yaml' ? '.file-merge.config.yaml' : '.file-merge.config.json';
    const configPath = path.join(projectRoot, filename);

    // Check if any config already exists
    if (!force) {
      for (const testFilename of this.CONFIG_FILENAMES) {
        const testPath = path.join(projectRoot, testFilename);
        try {
          await fs.access(testPath);
          throw new Error(`Config file already exists: ${testPath}\nUse --force to overwrite`);
        } catch (error: unknown) {
          // File doesn't exist - that's what we want
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
      }
    }

    const exampleConfig: FileMergeConfig = {
      templatesDir: "config-templates",
      fragmentPatterns: [
        "**/*.fragment.*",
        "!node_modules/**",
        "!dist/**",
      ],
      ignorePatterns: [
        "**/node_modules/**",
        "**/dist/**",
        "**/.git/**",
      ],
    };

    let content: string;
    if (format === 'yaml') {
      const YAML = await import("yaml");
      content = '# File-merge configuration\n' +
                '# Supports both YAML and JSON formats\n\n' +
                '# Directory containing template files with __ prefix\n' +
                'templatesDir: config-templates\n\n' +
                '# Glob patterns for discovering fragment files\n' +
                '# Use ! prefix to exclude patterns\n' +
                'fragmentPatterns:\n' +
                '  - "**/*.fragment.*"        # Include all fragment files\n' +
                '  - "!node_modules/**"       # Exclude node_modules\n' +
                '  - "!dist/**"               # Exclude dist\n' +
                '  # Example: Include only specific folders\n' +
                '  # - "packages/**/*.fragment.*"\n' +
                '  # - "apps/**/*.fragment.*"\n' +
                '  # Example: Exclude folder but include specific patterns\n' +
                '  # - "!folderA/folderB/**"\n' +
                '  # - "folderA/folderB/catalog.*.fragment.*"\n\n' +
                '# Patterns to ignore (applied after fragmentPatterns)\n' +
                'ignorePatterns:\n' +
                '  - "**/node_modules/**"\n' +
                '  - "**/dist/**"\n' +
                '  - "**/.git/**"\n\n' +
                '# Optional: Module activation filtering (atom-framework specific)\n' +
                '# Uncomment if you need symlink-based module filtering\n' +
                '# modules:\n' +
                '#   activeDir: modules\n' +
                '#   sourceDir: available-modules\n\n' +
                '# JSON comment style configuration\n' +
                '# Controls how generated headers are added to JSON files\n' +
                '# Options: "$comment" (default), "jsonc", "none"\n' +
                '# jsonCommentStyle:\n' +
                '#   default: "$comment"           # Default style for JSON files\n' +
                '#   jsonc:                        # Files matching these patterns use // comments\n' +
                '#     - "biome.json"\n' +
                '#     - "tsconfig*.json"\n' +
                '#     - ".vscode/**/*.json"\n' +
                '#     - "turbo.json"\n' +
                '#   none:                         # Files matching these patterns have no header\n' +
                '#     - "package.json"\n';
    } else {
      content = JSON.stringify(exampleConfig, null, 2) + "\n";
    }
    
    await fs.writeFile(configPath, content, "utf-8");

    console.log(`✅ Created example config: ${configPath}`);
  }
}

