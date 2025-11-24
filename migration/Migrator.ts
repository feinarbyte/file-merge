/**
 * Migrator
 *
 * Orchestrates migration from existing configuration to new system
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TemplateDiscovery } from "../core/TemplateDiscovery.js";
import { FileMergeConfigLoader, type FileMergeConfig } from "../core/FileMergeConfig.js";
import type { ConfigContent, DiffExtractionOptions } from "../core/types.js";
import { BackupManager } from "./BackupManager.js";
import { DiffExtractor } from "./DiffExtractor.js";

export class Migrator {
  private templateDiscovery!: TemplateDiscovery;
  private diffExtractor: DiffExtractor;
  private backupManager: BackupManager;
  private config!: FileMergeConfig;

  constructor(private projectRoot: string) {
    this.diffExtractor = new DiffExtractor();
    this.backupManager = new BackupManager(projectRoot);
  }

  private async init(): Promise<void> {
    if (!this.config) {
      this.config = await FileMergeConfigLoader.load(this.projectRoot);
      this.templateDiscovery = new TemplateDiscovery(this.projectRoot, this.config);
    }
  }

  /**
   * Analyze existing configuration and report differences
   */
  async analyze(): Promise<void> {
    await this.init();

    console.log("📊 Analyzing existing configuration...\n");

    const templates = await this.templateDiscovery.discoverTemplates();
    const results: {
      identical: string[];
      extractable: Array<{ file: string; changes: number }>;
      needsReview: string[];
    } = {
      identical: [],
      extractable: [],
      needsReview: [],
    };

    for (const template of templates) {
      const targetPath = this.templateDiscovery.getTargetPath(template.path);
      const relativePath = path.relative(this.projectRoot, targetPath);

      try {
        // Check if current file exists
        await fs.access(targetPath);

        // Load current file
        const currentContent = await this.loadFile(targetPath);

        // Analyze diff
        const analysis = this.diffExtractor.analyzeDiff(
          template.content,
          currentContent,
        );

        if (analysis.identical) {
          results.identical.push(relativePath);
        } else {
          const changeCount =
            analysis.addedKeys.length +
            analysis.modifiedKeys.length +
            analysis.deletedKeys.length;

          if (changeCount > 20) {
            results.needsReview.push(relativePath);
          } else {
            results.extractable.push({
              file: relativePath,
              changes: changeCount,
            });
          }
        }
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          // File doesn't exist - will be created from template
          continue;
        }
        console.error(`  ❌ Error analyzing ${relativePath}:`, error);
      }
    }

    // Print report
    console.log("📊 Migration Analysis Report\n");
    console.log("═".repeat(60));

    if (results.identical.length > 0) {
      console.log("\n✅ Files Identical to Master (will be symlinked):");
      for (const file of results.identical) {
        console.log(`  ✓ ${file}`);
      }
    }

    if (results.extractable.length > 0) {
      console.log("\n📝 Files with Extractable Differences:");
      for (const { file, changes } of results.extractable) {
        console.log(`  📝 ${file} (${changes} changes)`);
      }
    }

    if (results.needsReview.length > 0) {
      console.log("\n⚠️  Files Requiring Manual Review:");
      for (const file of results.needsReview) {
        console.log(`  ⚠️  ${file} (complex differences)`);
      }
    }

    console.log(`\n${"═".repeat(60)}`);
    console.log("\n📋 Summary:");
    console.log(`  Identical: ${results.identical.length}`);
    console.log(`  Extractable: ${results.extractable.length}`);
    console.log(`  Needs Review: ${results.needsReview.length}`);

    if (results.extractable.length > 0) {
      console.log("\n💡 Next Steps:");
      console.log(
        '  1. Run "pnpm config:migrate extract" to auto-extract differences',
      );
      console.log("  2. Review generated override files");
      console.log('  3. Run "pnpm config:apply" to regenerate from templates');
    }
  }

  /**
   * Extract differences into override files
   */
  async extract(
    options: {
      strategy?: "smart-extract" | "minimal" | "preserve-all";
      force?: boolean;
      backup?: boolean;
    } = {},
  ): Promise<void> {
    await this.init();

    const {
      strategy = "smart-extract",
      force = false,
      backup = true,
    } = options;

    console.log("🔄 Extracting configuration overrides...\n");

    const templates = await this.templateDiscovery.discoverTemplates();
    const filesToBackup: string[] = [];
    const extracted: string[] = [];

    // First pass: identify what to extract
    for (const template of templates) {
      const targetPath = this.templateDiscovery.getTargetPath(template.path);

      try {
        await fs.access(targetPath);
        filesToBackup.push(targetPath);
      } catch {
        // File doesn't exist, skip
      }
    }

    // Create backup if requested
    if (backup && filesToBackup.length > 0) {
      await this.backupManager.createBackup(filesToBackup);
      console.log("");
    }

    // Extract overrides
    const extractOptions: DiffExtractionOptions = {
      strategy,
      commentExtraction: true,
    };

    for (const template of templates) {
      const targetPath = this.templateDiscovery.getTargetPath(template.path);
      const relativePath = path.relative(this.projectRoot, targetPath);

      try {
        // Check if current file exists
        await fs.access(targetPath);

        // Load current file
        const currentContent = await this.loadFile(targetPath);

        // Extract diff
        const result = this.diffExtractor.extract(
          template.content,
          currentContent,
          extractOptions,
        );

        if (!result.content || Object.keys(result.content).length === 0) {
          console.log(`  ⏭️  Skipped ${relativePath} (no differences)`);
          continue;
        }

        // Create override file path
        const ext = path.extname(targetPath);
        const base = path.basename(targetPath, ext);
        const overridePath = path.join(
          path.dirname(targetPath),
          `${base}.overrides${ext}`,
        );

        // Check if override file already exists
        if (!force) {
          try {
            await fs.access(overridePath);
            console.log(
              `  ⚠️  Skipped ${relativePath} (override exists, use --force to overwrite)`,
            );
            continue;
          } catch {
            // Override doesn't exist, proceed
          }
        }

        // Write override file
        await this.writeFile(overridePath, result.content);

        extracted.push(relativePath);
        console.log(
          `  ✅ Created ${path.relative(this.projectRoot, overridePath)} (${result.metadata.linesChanged} changes)`,
        );
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          // File doesn't exist - will be created from template
          continue;
        }
        console.error(`  ❌ Error extracting ${relativePath}:`, error);
      }
    }

    console.log(`\n${"═".repeat(60)}`);
    console.log(`\n✅ Extracted ${extracted.length} override files`);

    if (extracted.length > 0) {
      console.log("\n💡 Next Steps:");
      console.log("  1. Review generated override files");
      console.log('  2. Run "pnpm config:apply" to regenerate from templates');
      console.log("  3. Test that everything works");
      console.log("  4. Commit override files: git add **/*.overrides.*");
    }
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
    } else {
      return content;
    }
  }

  /**
   * Write file with appropriate formatting
   */
  private async writeFile(
    filePath: string,
    content: ConfigContent,
  ): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if ([".json", ".jsonc", ".json5"].includes(ext)) {
      await fs.writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`);
    } else if ([".yaml", ".yml"].includes(ext)) {
      const YAML = await import("yaml");
      await fs.writeFile(filePath, YAML.stringify(content));
    } else if (ext === ".toml") {
      const TOML = await import("@iarna/toml");
      await fs.writeFile(filePath, TOML.stringify(content as any));
    } else {
      const text =
        typeof content === "string"
          ? content
          : JSON.stringify(content, null, 2);
      await fs.writeFile(filePath, text);
    }
  }
}
