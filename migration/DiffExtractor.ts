/**
 * Diff Extractor
 *
 * Extracts differences between master templates and current files
 * Creates override files with only the differences
 */

import type { ConfigContent, DiffExtractionOptions, ExtractedDiff } from "../core/types.js";

export class DiffExtractor {
    /**
     * Extract differences between master and current content
     */
    extract(
        masterContent: ConfigContent,
        currentContent: ConfigContent,
        options: DiffExtractionOptions,
    ): ExtractedDiff {
        const strategy = options.strategy;

        let diff: ConfigContent | null;

        if (strategy === "minimal") {
            diff = this.minimalDiff(masterContent, currentContent);
        } else if (strategy === "smart-extract") {
            diff = this.smartJsonDiff(masterContent, currentContent);
        } else {
            // preserve-all
            diff = this.preserveAllDiff(masterContent, currentContent);
        }

        return {
            content: diff,
            metadata: {
                extractedAt: new Date(),
                strategy,
                linesChanged: this.countChanges(diff),
            },
        };
    }

    /**
     * Smart diff - only extract semantic differences
     * This is the recommended default
     */
    private smartJsonDiff(master: ConfigContent, current: ConfigContent): ConfigContent | null {
        if (typeof current !== "object" || current === null) {
            return current !== master ? current : null;
        }

        if (!this.isObject(master) || master === null) {
            return current; // Master is not an object, return current
        }

        const diff: Record<string, unknown> = {};
        let hasChanges = false;

        for (const [key, value] of Object.entries(current)) {
            // Key doesn't exist in master - include it
            if (typeof master === "object" && !(key in master)) {
                diff[key] = value;
                hasChanges = true;
                continue;
            }

            // Get master value
            const masterValue = (master as Record<string, unknown>)[key];

            // Value is object - recurse
            if (this.isObject(value) && this.isObject(masterValue)) {
                const nested = this.smartJsonDiff(
                    masterValue as ConfigContent,
                    value as ConfigContent,
                );
                if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
                    diff[key] = nested;
                    hasChanges = true;
                }
                continue;
            }

            // Value is different - include it
            if (!this.deepEqual(masterValue, value)) {
                diff[key] = value;
                hasChanges = true;
            }
        }

        return hasChanges ? (diff as ConfigContent) : null;
    }

    /**
     * Minimal diff - only overriding values
     */
    private minimalDiff(master: ConfigContent, current: ConfigContent): ConfigContent | null {
        return this.smartJsonDiff(master, current);
    }

    /**
     * Preserve-all diff - everything not in master
     */
    private preserveAllDiff(master: ConfigContent, current: ConfigContent): ConfigContent {
        if (typeof current !== "object" || current === null) {
            return current;
        }

        if (!this.isObject(master) || master === null) {
            return current; // Master is not an object, return current
        }

        const diff: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(current)) {
            if (typeof master === "object" && !(key in master)) {
                diff[key] = value;
            } else {
                const masterValue = (master as Record<string, unknown>)[key];
                if (this.isObject(value) && this.isObject(masterValue)) {
                    const nested = this.preserveAllDiff(
                        masterValue as ConfigContent,
                        value as ConfigContent,
                    );
                    if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
                        diff[key] = nested;
                    }
                }
            }
        }

        return diff as ConfigContent;
    }

    /**
     * Check if value is a plain object
     */
    private isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    /**
     * Deep equality check
     */
    private deepEqual(a: unknown, b: unknown): boolean {
        if (a === b) return true;
        if (a == null || b == null) return false;
        if (typeof a !== typeof b) return false;

        if (typeof a === "object" && typeof b === "object") {
            if (Array.isArray(a) !== Array.isArray(b)) return false;

            if (Array.isArray(a) && Array.isArray(b)) {
                if (a.length !== b.length) return false;
                for (let i = 0; i < a.length; i++) {
                    if (!this.deepEqual(a[i], b[i])) return false;
                }
                return true;
            }

            const keysA = Object.keys(a as object);
            const keysB = Object.keys(b as object);
            if (keysA.length !== keysB.length) return false;

            for (const key of keysA) {
                if (!keysB.includes(key)) return false;
                if (
                    !this.deepEqual(
                        (a as Record<string, unknown>)[key],
                        (b as Record<string, unknown>)[key],
                    )
                )
                    return false;
            }
            return true;
        }

        return false;
    }

    /**
     * Count number of changed properties
     */
    private countChanges(diff: ConfigContent | null): number {
        if (typeof diff !== "object" || diff === null) {
            return 0;
        }

        let count = 0;

        for (const value of Object.values(diff)) {
            count++;
            if (this.isObject(value)) {
                count += this.countChanges(value);
            }
        }

        return count;
    }

    /**
     * Analyze differences and categorize them
     */
    analyzeDiff(
        master: ConfigContent,
        current: ConfigContent,
    ): {
        identical: boolean;
        addedKeys: string[];
        modifiedKeys: string[];
        deletedKeys: string[];
    } {
        const addedKeys: string[] = [];
        const modifiedKeys: string[] = [];
        const deletedKeys: string[] = [];

        if (
            typeof current !== "object" ||
            current === null ||
            typeof master !== "object" ||
            master === null
        ) {
            return {
                identical: this.deepEqual(master, current),
                addedKeys: [],
                modifiedKeys: [],
                deletedKeys: [],
            };
        }

        // Find added and modified keys
        for (const key of Object.keys(current)) {
            if (!(key in master)) {
                addedKeys.push(key);
            } else if (
                !this.deepEqual(
                    (master as Record<string, unknown>)[key],
                    (current as Record<string, unknown>)[key],
                )
            ) {
                modifiedKeys.push(key);
            }
        }

        // Find deleted keys
        for (const key of Object.keys(master)) {
            if (!(key in current)) {
                deletedKeys.push(key);
            }
        }

        const identical =
            addedKeys.length === 0 && modifiedKeys.length === 0 && deletedKeys.length === 0;

        return {
            identical,
            addedKeys,
            modifiedKeys,
            deletedKeys,
        };
    }
}
