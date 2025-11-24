/**
 * Core type definitions for the unified configuration manager
 */

/**
 * JSON-compatible value types
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Configuration content can be any valid JSON value or plain text
 */
export type ConfigContent = JsonValue | string;

export interface Fragment {
  /** Absolute path to the fragment file */
  path: string;
  /** Parsed content of the fragment */
  content: ConfigContent;
  /** Fragment metadata extracted from reserved properties */
  metadata: FragmentMetadata;
  /** Directory relative to project root where fragment was found */
  relativeDir: string;
}

export interface FragmentMetadata {
  /** Target file path(s) relative to project root */
  _targetPath: string | string[];
  /** Override auto-detected merge strategy */
  _mergeStrategy?: string;
  /** Merge priority (default: 100, higher = later) */
  _priority?: number;
  /** Conditional application rules */
  _conditions?: FragmentConditions;
  /** Force copy instead of symlink */
  _copy?: boolean;
  /** Include only from active modules (default: true) */
  _activeOnly?: boolean;
}

export interface FragmentConditions {
  /** Only apply if all listed modules are active */
  activeModules?: string[];
  /** Only apply in specific environment */
  env?: string;
  /** Only apply on specific platform */
  platform?: string;
}

export interface Source {
  /** Type of source */
  type: "template" | "fragment" | "override";
  /** Absolute path to source file */
  path: string;
  /** Parsed content */
  content: ConfigContent;
  /** Metadata (for fragments) */
  metadata?: FragmentMetadata;
  /** Priority for merging */
  priority: number;
  /** Resolved relative path (with template variables resolved) */
  resolvedRelativePath?: string;
}

export interface MergeStrategy<T = ConfigContent> {
  /** Strategy name */
  name: string;
  /** Validate content can be merged with this strategy */
  validate(content: T): ValidationResult;
  /** Merge multiple sources into single result */
  merge(sources: T[], context: MergeContext): T;
  /** Optional post-processing after merge */
  postProcess?(result: T, context: MergeContext): T;
}

export interface MergeContext {
  /** Target file path */
  targetPath: string;
  /** Relative path from project root */
  relativePath: string;
  /** Source file paths in merge order */
  sourcePaths: string[];
  /** Active modules */
  activeModules: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

export enum ErrorSeverity {
  ERROR = "error",
  WARNING = "warning",
  INFO = "info",
}

export interface ConfigError {
  severity: ErrorSeverity;
  code: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface BackupManifest {
  timestamp: string;
  files: Array<{
    original: string;
    backup: string;
    hash: string;
  }>;
}

export interface ExtractedDiff {
  content: ConfigContent;
  metadata: {
    extractedAt: Date;
    strategy: string;
    linesChanged: number;
  };
}

export interface DiffExtractionOptions {
  strategy: "preserve-all" | "smart-extract" | "minimal";
  commentExtraction: boolean;
}

export interface ConfigManagerOptions {
  /** Project root directory */
  projectRoot: string;
  /** Dry run mode (don't write files) */
  dryRun?: boolean;
  /** Verbose output */
  verbose?: boolean;
  /** Filter patterns for files to process */
  filter?: string[];
  /** Configuration (loaded from .file-merge.config.json or defaults) */
  config?: import('./FileMergeConfig.js').FileMergeConfig;
  /** Path to config file (overrides default .file-merge.config.json) */
  configPath?: string;
}
