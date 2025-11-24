/**
 * FileManager
 *
 * Manages adding and removing files from config management
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SymlinkManager } from './SymlinkManager.js';
import { TemplateDiscovery } from './TemplateDiscovery.js';
import { FileMergeConfigLoader, type FileMergeConfig } from './FileMergeConfig.js';

export interface AddFileOptions {
  /** Overwrite if template already exists */
  force?: boolean;
  /** Don't create symlink (copy instead) */
  noSymlink?: boolean;
  /** Keep original file as override */
  keepOriginal?: boolean;
}

export class FileManager {
  private symlinkManager: SymlinkManager;
  private templateDiscovery!: TemplateDiscovery;
  private templatesDir!: string;
  private gitignorePath: string;
  private config!: FileMergeConfig;

  constructor(private projectRoot: string) {
    this.symlinkManager = new SymlinkManager();
    this.gitignorePath = path.join(projectRoot, '.gitignore');
  }

  private async init(): Promise<void> {
    if (!this.config) {
      this.config = await FileMergeConfigLoader.load(this.projectRoot);
      this.templateDiscovery = new TemplateDiscovery(this.projectRoot, this.config);
      this.templatesDir = path.join(this.projectRoot, this.config.templatesDir ?? "config-templates");
    }
  }

  /**
   * Add existing file to config management
   */
  async addFile(filePath: string, options: AddFileOptions = {}): Promise<void> {
    await this.init();

    // 1. Validate and resolve paths
    const absoluteFilePath = path.resolve(this.projectRoot, filePath);
    const relativeFilePath = path.relative(this.projectRoot, absoluteFilePath);

    // Check file exists
    try {
      await fs.access(absoluteFilePath);
    } catch {
      throw new Error(`File not found: ${relativeFilePath}`);
    }

    // 2. Determine template path
    const templatePath = this.getTemplatePath(relativeFilePath);
    const absoluteTemplatePath = path.join(this.projectRoot, templatePath);

    // Check if already managed
    if (!options.force) {
      try {
        await fs.access(absoluteTemplatePath);
        throw new Error(`File already managed: ${templatePath} exists. Use --force to overwrite.`);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        // ENOENT is expected - template doesn't exist yet
      }
    }

    console.log('✅ Adding file to config management\n');

    // 3. Create templates directory if needed
    await fs.mkdir(path.dirname(absoluteTemplatePath), { recursive: true });

    // 4. Store original content if keeping as override
    let originalContent: Buffer | undefined;
    if (options.keepOriginal) {
      originalContent = await fs.readFile(absoluteFilePath);
    }

    // 5. Move file to templates
    await fs.rename(absoluteFilePath, absoluteTemplatePath);
    console.log(`  📁 Moved: ${relativeFilePath}`);
    console.log(`      → ${templatePath}`);

    // 6. Create symlink or copy back
    if (options.noSymlink) {
      await fs.copyFile(absoluteTemplatePath, absoluteFilePath);
      console.log(`\n  📄 Copied back: ${relativeFilePath} (copy mode)`);
    } else {
      await this.symlinkManager.createSymlink(absoluteTemplatePath, absoluteFilePath);
      console.log(`\n  🔗 Symlinked: ${relativeFilePath}`);
      console.log(`      → ${templatePath}`);
    }

    // 7. Update .gitignore
    await this.updateGitIgnore(relativeFilePath);
    console.log(`\n  📝 Added to .gitignore: ${relativeFilePath}`);

    // 8. Create override with original content if requested
    if (options.keepOriginal && originalContent) {
      const overridePath = this.getOverridePath(relativeFilePath);
      const absoluteOverridePath = path.join(this.projectRoot, overridePath);
      await fs.writeFile(absoluteOverridePath, originalContent);
      console.log(`\n  📋 Created override: ${overridePath}`);
    }

    console.log('\n✅ File added to config management');
    console.log('\nNext steps:');
    console.log(`  • File is now managed and will be ${options.noSymlink ? 'copied' : 'symlinked'}`);
    console.log(`  • To add project-specific overrides: pnpm config:override ${relativeFilePath}`);
    console.log('  • To regenerate: pnpm config:apply');
  }

  /**
   * Remove file from management (revert to unmanaged)
   */
  async removeFile(filePath: string): Promise<void> {
    await this.init();

    const absoluteFilePath = path.resolve(this.projectRoot, filePath);
    const relativeFilePath = path.relative(this.projectRoot, absoluteFilePath);

    // Find template
    const templatePath = this.getTemplatePath(relativeFilePath);
    const absoluteTemplatePath = path.join(this.projectRoot, templatePath);

    // Check template exists
    try {
      await fs.access(absoluteTemplatePath);
    } catch {
      throw new Error(`File not managed: ${templatePath} not found`);
    }

    console.log('🔄 Removing file from config management\n');

    // 1. Copy template to original location (overwrite symlink/generated file)
    if (await this.fileExists(absoluteFilePath)) {
      await fs.unlink(absoluteFilePath);
    }
    await fs.copyFile(absoluteTemplatePath, absoluteFilePath);
    console.log(`  📄 Restored: ${relativeFilePath}`);

    // 2. Delete template
    await fs.unlink(absoluteTemplatePath);
    console.log(`  🗑️  Removed template: ${templatePath}`);

    // 3. Delete override if exists
    const overridePath = this.getOverridePath(relativeFilePath);
    const absoluteOverridePath = path.join(this.projectRoot, overridePath);
    if (await this.fileExists(absoluteOverridePath)) {
      await fs.unlink(absoluteOverridePath);
      console.log(`  🗑️  Removed override: ${overridePath}`);
    }

    // 4. Remove from .gitignore
    await this.removeFromGitIgnore(relativeFilePath);
    console.log(`  📝 Removed from .gitignore: ${relativeFilePath}`);

    console.log('\n✅ File removed from config management');
  }

  /**
   * Get template path for a given file
   */
  private getTemplatePath(filePath: string): string {
    const parsed = path.parse(filePath);
    return path.join(
      this.config.templatesDir ?? "config-templates",
      parsed.dir,
      `__${parsed.base}`
    );
  }

  /**
   * Get override path for a given file
   */
  private getOverridePath(filePath: string): string {
    const parsed = path.parse(filePath);
    const extWithoutDot = parsed.ext.slice(1); // Remove leading dot
    return path.join(
      parsed.dir,
      `${parsed.name}.overrides${extWithoutDot ? `.${extWithoutDot}` : ''}`
    );
  }

  /**
   * Update .gitignore to ignore a generated file
   */
  private async updateGitIgnore(filePath: string): Promise<void> {
    let gitignoreContent = '';

    // Read existing .gitignore if it exists
    if (await this.fileExists(this.gitignorePath)) {
      gitignoreContent = await fs.readFile(this.gitignorePath, 'utf-8');
    }

    // Check if already in .gitignore
    const lines = gitignoreContent.split('\n');
    const normalizedPath = filePath.replace(/\\/g, '/');

    if (lines.some(line => line.trim() === normalizedPath)) {
      return; // Already in .gitignore
    }

    // Add section if not present
    if (!gitignoreContent.includes('# Config Manager - Generated Files')) {
      gitignoreContent += '\n# Config Manager - Generated Files\n';
    }

    // Add file
    gitignoreContent += `${normalizedPath}\n`;

    await fs.writeFile(this.gitignorePath, gitignoreContent);
  }

  /**
   * Remove file from .gitignore
   */
  private async removeFromGitIgnore(filePath: string): Promise<void> {
    if (!(await this.fileExists(this.gitignorePath))) {
      return;
    }

    const content = await fs.readFile(this.gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const normalizedPath = filePath.replace(/\\/g, '/');

    // Remove the line
    const filteredLines = lines.filter(line => line.trim() !== normalizedPath);

    await fs.writeFile(this.gitignorePath, filteredLines.join('\n'));
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
