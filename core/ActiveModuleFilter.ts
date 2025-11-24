/**
 * Active Module Filter
 *
 * Filters fragments based on module activation status.
 * A module is active if it's symlinked from atom-framework/modules/ to modules/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Fragment } from "./types.js";
import type { FileMergeConfig } from "./FileMergeConfig.js";

export class ActiveModuleFilter {
  private modulesDir: string;
  private sourceModulesDir: string;
  private activeModulesCache: Set<string> | null = null;

  constructor(
    private projectRoot: string,
    private config: FileMergeConfig
  ) {
    if (!config.modules?.activeDir || !config.modules?.sourceDir) {
      throw new Error("ActiveModuleFilter requires modules.activeDir and modules.sourceDir in config");
    }
    this.modulesDir = path.join(projectRoot, config.modules.activeDir);
    this.sourceModulesDir = path.join(projectRoot, config.modules.sourceDir);
  }

  /**
   * Check if a module is active (symlinked from source modules dir to active modules dir)
   */
  isModuleActive(moduleName: string): boolean {
    const targetPath = path.join(this.modulesDir, moduleName);
    const sourcePath = path.join(this.sourceModulesDir, moduleName);

    // Check if target exists
    if (!fs.existsSync(targetPath)) {
      return false;
    }

    // Check if it's a symlink
    try {
      const stats = fs.lstatSync(targetPath);
      if (!stats.isSymbolicLink()) {
        return false;
      }

      // Check if it points to source modules directory
      const linkTarget = fs.readlinkSync(targetPath);
      const resolvedTarget = path.resolve(this.modulesDir, linkTarget);
      const resolvedSource = path.resolve(sourcePath);

      return resolvedTarget === resolvedSource;
    } catch {
      return false;
    }
  }

  /**
   * Filter fragments based on _activeOnly setting and module activation
   */
  filterFragments(fragments: Fragment[]): Fragment[] {
    if (!this.config.modules?.sourceDir) {
      return fragments; // No filtering if modules not configured
    }

    // Build regex to match source modules directory pattern
    const sourceModulesDir = this.config.modules.sourceDir;
    const sourceModulesPattern = sourceModulesDir.replace(/\\/g, "[/\\\\]");
    const modulePathRegex = new RegExp(
      `${sourceModulesPattern}[/\\\\]([^/\\\\]+)`
    );

    return fragments.filter((fragment) => {
      // Fragments outside source modules directory are always included
      if (!fragment.path.includes(sourceModulesDir)) {
        return true;
      }

      // Extract module name from path
      const match = fragment.path.match(modulePathRegex);
      if (!match) {
        return true; // Not in modules dir, include it
      }

      const moduleName = match[1];
      const activeOnly = fragment.metadata._activeOnly ?? true; // Default: true

      if (activeOnly === false) {
        // Always include (e.g., catalog files)
        return true;
      }

      // Only include if module is active
      return this.isModuleActive(moduleName);
    });
  }

  /**
   * Get list of all active modules
   */
  getActiveModules(): string[] {
    if (this.activeModulesCache) {
      return Array.from(this.activeModulesCache);
    }

    if (!fs.existsSync(this.modulesDir)) {
      this.activeModulesCache = new Set();
      return [];
    }

    const entries = fs.readdirSync(this.modulesDir, { withFileTypes: true });
    const active = entries
      .filter((entry) => entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => this.isModuleActive(name));

    this.activeModulesCache = new Set(active);
    return active;
  }

  /**
   * Clear the active modules cache
   */
  clearCache(): void {
    this.activeModulesCache = null;
  }

  /**
   * Check if fragment conditions are satisfied
   */
  checkConditions(fragment: Fragment): boolean {
    const conditions = fragment.metadata._conditions;
    if (!conditions) {
      return true; // No conditions = always apply
    }

    // Check activeModules condition
    if (conditions.activeModules) {
      const activeModules = this.getActiveModules();
      const allActive = conditions.activeModules.every((module) =>
        activeModules.includes(module),
      );
      if (!allActive) {
        return false;
      }
    }

    // Check env condition (future)
    if (conditions.env) {
      const currentEnv = process.env.NODE_ENV || "development";
      if (conditions.env !== currentEnv) {
        return false;
      }
    }

    // Check platform condition (future)
    if (conditions.platform) {
      if (conditions.platform !== process.platform) {
        return false;
      }
    }

    return true;
  }

  /**
   * Filter fragments by both activation status and conditions
   */
  filterFragmentsWithConditions(fragments: Fragment[]): Fragment[] {
    return this.filterFragments(fragments).filter((fragment) =>
      this.checkConditions(fragment),
    );
  }
}
