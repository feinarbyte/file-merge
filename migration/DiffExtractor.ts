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
     * Line diff for text files (used for Markdown).
     *
     * Returns the lines of `current` that are not part of `master`, in order.
     * If `current` simply extends `master`, the extension is returned verbatim.
     * Otherwise separate groups of added lines are joined with a blank line.
     * Removed lines can't be expressed by an append-only override; they are only counted.
     */
    extractTextLines(
        master: string,
        current: string,
        options: { markdownSections?: boolean } = {},
    ): {
        added: string;
        addedLines: number;
        removedLines: number;
        identical: boolean;
        /** True if hunks were prefixed with an existing "## Heading" (markdownSections option) */
        usesSections: boolean;
    } {
        const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
        const masterText = normalize(master);
        const currentText = normalize(current);

        if (masterText === currentText) {
            return {
                added: "",
                addedLines: 0,
                removedLines: 0,
                identical: true,
                usesSections: false,
            };
        }

        const finish = (text: string, removedLines: number, usesSections = false) => {
            const added = text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
            return {
                added: added ? `${added}\n` : "",
                addedLines: added ? added.split("\n").filter((l) => l.trim() !== "").length : 0,
                removedLines,
                identical: false,
                usesSections: usesSections && added !== "",
            };
        };

        // Fast path: current = master + appended content
        // (skipped in section mode so appended lines keep their "## Heading")
        if (
            masterText === "" ||
            (!options.markdownSections && currentText.startsWith(`${masterText}\n`))
        ) {
            return finish(currentText.slice(masterText.length), 0);
        }

        const a = masterText.split("\n");
        const b = currentText.split("\n");
        const n = a.length;
        const m = b.length;

        // LCS table (suffix lengths)
        const width = m + 1;
        const lcs = new Uint32Array((n + 1) * width);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                lcs[i * width + j] =
                    a[i] === b[j]
                        ? lcs[(i + 1) * width + j + 1] + 1
                        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
            }
        }

        const isH2 = (line: string) => /^##[ \t]+\S/.test(line);
        const hunks: string[][] = [];
        let hunk: string[] = [];
        let removedLines = 0;
        let usesSections = false;
        // Last "## Heading" of `current` that is shared with the template
        let sharedHeading: string | undefined;
        let hunkHeading: string | undefined;
        let i = 0;
        let j = 0;
        const closeHunk = () => {
            if (hunk.some((line) => line.trim() !== "")) {
                const firstLine = hunk.find((line) => line.trim() !== "") ?? "";
                if (options.markdownSections && hunkHeading && !isH2(firstLine)) {
                    hunks.push([hunkHeading, "", ...hunk]);
                    usesSections = true;
                } else {
                    hunks.push(hunk);
                }
            }
            hunk = [];
        };

        while (i < n || j < m) {
            if (i < n && j < m && a[i] === b[j]) {
                closeHunk();
                if (isH2(b[j])) sharedHeading = b[j];
                i++;
                j++;
            } else if (j < m && (i >= n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
                if (hunk.length === 0) hunkHeading = sharedHeading;
                // A new heading inside the hunk starts a new (unshared) section
                if (isH2(b[j])) sharedHeading = undefined;
                hunk.push(b[j]);
                j++;
            } else {
                if (a[i].trim() !== "") removedLines++;
                i++;
            }
        }
        closeHunk();

        const text = hunks
            .map((lines) =>
                lines
                    .join("\n")
                    .replace(/^(?:[ \t]*\n)+/, "")
                    .replace(/\s+$/, ""),
            )
            .join("\n\n");
        return finish(text, removedLines, usesSections);
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
