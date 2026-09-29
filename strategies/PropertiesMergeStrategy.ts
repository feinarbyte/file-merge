import * as path from "node:path";
import type { MergeContext, MergeStrategy, ValidationResult } from "../core/types.js";

const BACKSLASH = "\\";
const ESCAPED_BACKSLASH = String.raw`\\`;
const ESCAPED_SPACE = String.raw`\ `;
const ESCAPED_TAB = String.raw`\t`;
const ESCAPED_NEWLINE = String.raw`\n`;
const ESCAPED_CARRIAGE_RETURN = String.raw`\r`;
const ESCAPED_FORM_FEED = String.raw`\f`;

interface ParsedPropertyEntry {
    key: string;
    value: string;
    leadingTrivia: string[];
}

type ParsedToken =
    | {
          type: "comment";
          text: string;
      }
    | {
          type: "blank";
      }
    | {
          type: "property";
          key: string;
      };

interface ParsedPropertiesDocument {
    tokens: ParsedToken[];
    entries: ParsedPropertyEntry[];
}

interface ParsedSourceDocument {
    sourcePath: string;
    isTemplate: boolean;
    document: ParsedPropertiesDocument;
}

interface MergedPropertiesState {
    mergedValues: Map<string, string>;
    discoveredKeys: string[];
}

interface TemplatePropertiesState {
    primaryTemplate?: ParsedPropertiesDocument;
    templateKeys: Set<string>;
}

/**
 * Merge strategy for Java .properties files.
 *
 * Precedence: template < override
 * Ordering:
 *  - keys from template in template order
 *  - override-only keys appended in override order
 *
 * Output is normalized to `key=value` for property entries.
 */
export class PropertiesMergeStrategy implements MergeStrategy<string> {
    name = "properties-merge";

    validate(content: string): ValidationResult {
        if (typeof content !== "string") {
            return {
                valid: false,
                errors: ["Content must be a string for .properties merge"],
            };
        }
        return { valid: true };
    }

    merge(sources: string[], context: MergeContext): string {
        const parsedSources = this.parseSources(sources, context);
        const mergedState = this.collectMergedState(parsedSources);
        const templateState = this.collectTemplateState(parsedSources);
        const appendedEntries = this.collectOverrideOnlyEntries(parsedSources, templateState.templateKeys);

        const outputLines = this.buildOutputLines(
            templateState.primaryTemplate,
            appendedEntries,
            mergedState.discoveredKeys,
            mergedState.mergedValues,
        );

        trimTrailingBlankLines(outputLines);
        if (outputLines.length === 0) {
            return "";
        }

        return `${outputLines.join("\n")}\n`;
    }

    private parseSources(sources: string[], context: MergeContext): ParsedSourceDocument[] {
        return sources.map((source, index) => {
            const sourcePath = context.sourcePaths[index] ?? "";
            return {
                sourcePath,
                isTemplate: this.isTemplateSource(sourcePath),
                document: parsePropertiesDocument(source),
            };
        });
    }

    private collectMergedState(parsedSources: ParsedSourceDocument[]): MergedPropertiesState {
        const mergedValues = new Map<string, string>();
        const discoveredKeys: string[] = [];
        const seenDiscoveredKeys = new Set<string>();

        for (const source of parsedSources) {
            for (const entry of source.document.entries) {
                if (!seenDiscoveredKeys.has(entry.key)) {
                    seenDiscoveredKeys.add(entry.key);
                    discoveredKeys.push(entry.key);
                }
                mergedValues.set(entry.key, entry.value);
            }
        }

        return { mergedValues, discoveredKeys };
    }

    private collectTemplateState(parsedSources: ParsedSourceDocument[]): TemplatePropertiesState {
        let primaryTemplate: ParsedPropertiesDocument | undefined;
        const templateKeys = new Set<string>();

        for (const source of parsedSources) {
            if (!source.isTemplate) {
                continue;
            }

            primaryTemplate ??= source.document;
            for (const entry of source.document.entries) {
                templateKeys.add(entry.key);
            }
        }

        return { primaryTemplate, templateKeys };
    }

    private collectOverrideOnlyEntries(
        parsedSources: ParsedSourceDocument[],
        templateKeys: Set<string>,
    ): ParsedPropertyEntry[] {
        const appendedEntries: ParsedPropertyEntry[] = [];
        const seenAppendedKeys = new Set<string>();

        for (const source of parsedSources) {
            if (source.isTemplate) {
                continue;
            }

            for (const entry of source.document.entries) {
                if (templateKeys.has(entry.key) || seenAppendedKeys.has(entry.key)) {
                    continue;
                }
                seenAppendedKeys.add(entry.key);
                appendedEntries.push(entry);
            }
        }

        return appendedEntries;
    }

    private buildOutputLines(
        primaryTemplate: ParsedPropertiesDocument | undefined,
        appendedEntries: ParsedPropertyEntry[],
        discoveredKeys: string[],
        mergedValues: Map<string, string>,
    ): string[] {
        const outputLines: string[] = [];
        const emittedKeys = new Set<string>();

        this.emitTemplateSection(outputLines, emittedKeys, mergedValues, primaryTemplate);
        this.emitAppendedOverrideSection(outputLines, emittedKeys, mergedValues, appendedEntries);
        this.emitFallbackSection(outputLines, emittedKeys, mergedValues, discoveredKeys);

        return outputLines;
    }

    private emitTemplateSection(
        outputLines: string[],
        emittedKeys: Set<string>,
        mergedValues: Map<string, string>,
        primaryTemplate: ParsedPropertiesDocument | undefined,
    ): void {
        if (!primaryTemplate) {
            return;
        }

        // Keep template comments/blank lines where practical by replaying template token stream.
        for (const token of primaryTemplate.tokens) {
            switch (token.type) {
                case "comment":
                    outputLines.push(token.text);
                    break;
                case "blank":
                    outputLines.push("");
                    break;
                case "property":
                    this.emitPropertyIfAvailable(outputLines, emittedKeys, mergedValues, token.key);
                    break;
            }
        }
    }

    private emitAppendedOverrideSection(
        outputLines: string[],
        emittedKeys: Set<string>,
        mergedValues: Map<string, string>,
        appendedEntries: ParsedPropertyEntry[],
    ): void {
        for (const entry of appendedEntries) {
            if (emittedKeys.has(entry.key)) {
                continue;
            }

            const finalValue = mergedValues.get(entry.key);
            if (finalValue === undefined) {
                continue;
            }

            appendTrivia(outputLines, entry.leadingTrivia);
            outputLines.push(formatPropertyLine(entry.key, finalValue));
            emittedKeys.add(entry.key);
        }
    }

    private emitFallbackSection(
        outputLines: string[],
        emittedKeys: Set<string>,
        mergedValues: Map<string, string>,
        discoveredKeys: string[],
    ): void {
        // Fallback for keys not covered by template/appended ordering.
        for (const key of discoveredKeys) {
            this.emitPropertyIfAvailable(outputLines, emittedKeys, mergedValues, key);
        }
    }

    private emitPropertyIfAvailable(
        outputLines: string[],
        emittedKeys: Set<string>,
        mergedValues: Map<string, string>,
        key: string,
    ): void {
        if (emittedKeys.has(key)) {
            return;
        }

        const finalValue = mergedValues.get(key);
        if (finalValue === undefined) {
            return;
        }

        outputLines.push(formatPropertyLine(key, finalValue));
        emittedKeys.add(key);
    }

    private isTemplateSource(sourcePath: string): boolean {
        const fileName = path.basename(sourcePath).toLowerCase();
        if (fileName.endsWith(".template.properties")) {
            return true;
        }
        return fileName.startsWith("__") && fileName.endsWith(".properties");
    }
}

function parsePropertiesDocument(content: string): ParsedPropertiesDocument {
    const tokens: ParsedToken[] = [];
    const entries: ParsedPropertyEntry[] = [];
    const logicalLines = toLogicalLines(content);

    let pendingTrivia: string[] = [];

    for (const line of logicalLines) {
        const trimmedStart = line.trimStart();
        if (trimmedStart.length === 0) {
            tokens.push({ type: "blank" });
            pendingTrivia.push("");
            continue;
        }

        const firstChar = trimmedStart[0];
        if (firstChar === "#" || firstChar === "!") {
            tokens.push({ type: "comment", text: line });
            pendingTrivia.push(line);
            continue;
        }

        const { key, value } = parsePropertyLine(line);
        tokens.push({ type: "property", key });
        entries.push({
            key,
            value,
            leadingTrivia: [...pendingTrivia],
        });
        pendingTrivia = [];
    }

    return { tokens, entries };
}

function toLogicalLines(content: string): string[] {
    const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const physicalLines = normalized.split("\n");
    const logicalLines: string[] = [];

    for (let i = 0; i < physicalLines.length; i++) {
        let current = physicalLines[i] ?? "";

        while (hasLineContinuation(current) && i + 1 < physicalLines.length) {
            current = current.slice(0, -1);
            const next = (physicalLines[i + 1] ?? "").replace(/^[ \t\f]+/u, "");
            current += next;
            i++;
        }

        logicalLines.push(current);
    }

    return logicalLines;
}

function hasLineContinuation(line: string): boolean {
    let backslashCount = 0;
    for (let i = line.length - 1; i >= 0; i--) {
        if (line[i] !== "\\") {
            break;
        }
        backslashCount++;
    }
    return backslashCount % 2 === 1;
}

function parsePropertyLine(line: string): { key: string; value: string } {
    const keyStart = skipWhitespaceFrom(line, 0);
    const { keyEnd, valueStart } = locatePropertyBoundary(line, keyStart);

    const keyRaw = line.slice(keyStart, keyEnd);
    const valueRaw = valueStart < line.length ? line.slice(valueStart) : "";

    return {
        key: unescapePropertiesValue(keyRaw),
        value: unescapePropertiesValue(valueRaw),
    };
}

function locatePropertyBoundary(
    line: string,
    keyStart: number,
): {
    keyEnd: number;
    valueStart: number;
} {
    let escaped = false;

    for (let index = keyStart; index < line.length; index++) {
        const char = line[index];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === BACKSLASH) {
            escaped = true;
            continue;
        }

        if (isKeyValueSeparator(char)) {
            return {
                keyEnd: index,
                valueStart: index + 1,
            };
        }

        if (isWhitespace(char)) {
            return locateBoundaryAfterWhitespace(line, index);
        }
    }

    return {
        keyEnd: line.length,
        valueStart: line.length,
    };
}

function locateBoundaryAfterWhitespace(
    line: string,
    whitespaceIndex: number,
): {
    keyEnd: number;
    valueStart: number;
} {
    let valueStart = skipWhitespaceFrom(line, whitespaceIndex + 1);
    const candidate = line[valueStart];
    if (candidate !== undefined && isKeyValueSeparator(candidate)) {
        valueStart = skipWhitespaceFrom(line, valueStart + 1);
    }

    return {
        keyEnd: whitespaceIndex,
        valueStart,
    };
}

function skipWhitespaceFrom(line: string, index: number): number {
    let cursor = index;
    while (cursor < line.length && isWhitespace(line[cursor])) {
        cursor++;
    }
    return cursor;
}

function isKeyValueSeparator(char: string): boolean {
    return char === "=" || char === ":";
}

function isWhitespace(char: string): boolean {
    return char === " " || char === "\t" || char === "\f";
}

function unescapePropertiesValue(value: string): string {
    let result = "";

    for (let i = 0; i < value.length; i++) {
        const char = value[i];

        if (char !== "\\") {
            result += char;
            continue;
        }

        if (i === value.length - 1) {
            result += "\\";
            continue;
        }

        const next = value[++i];
        switch (next) {
            case "t":
                result += "\t";
                break;
            case "n":
                result += "\n";
                break;
            case "r":
                result += "\r";
                break;
            case "f":
                result += "\f";
                break;
            case "u": {
                const hex = value.slice(i + 1, i + 5);
                if (/^[\da-fA-F]{4}$/u.test(hex)) {
                    result += String.fromCodePoint(Number.parseInt(hex, 16));
                    i += 4;
                } else {
                    result += "u";
                }
                break;
            }
            default:
                result += next;
                break;
        }
    }

    return result;
}

function formatPropertyLine(key: string, value: string): string {
    return `${escapePropertyKey(key)}=${escapePropertyValue(value)}`;
}

function escapePropertyKey(key: string): string {
    let result = "";

    for (const char of key) {
        switch (char) {
            case BACKSLASH:
                result += ESCAPED_BACKSLASH;
                break;
            case " ":
                result += ESCAPED_SPACE;
                break;
            case "\t":
                result += ESCAPED_TAB;
                break;
            case "\n":
                result += ESCAPED_NEWLINE;
                break;
            case "\r":
                result += ESCAPED_CARRIAGE_RETURN;
                break;
            case "\f":
                result += ESCAPED_FORM_FEED;
                break;
            case "=":
            case ":":
            case "#":
            case "!":
                result += `\\${char}`;
                break;
            default:
                result += char;
                break;
        }
    }

    return result;
}

function escapePropertyValue(value: string): string {
    let result = "";

    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        switch (char) {
            case BACKSLASH:
                result += ESCAPED_BACKSLASH;
                break;
            case "\t":
                result += ESCAPED_TAB;
                break;
            case "\n":
                result += ESCAPED_NEWLINE;
                break;
            case "\r":
                result += ESCAPED_CARRIAGE_RETURN;
                break;
            case "\f":
                result += ESCAPED_FORM_FEED;
                break;
            case " ":
                if (i === 0 || i === value.length - 1) {
                    result += ESCAPED_SPACE;
                } else {
                    result += " ";
                }
                break;
            default:
                result += char;
                break;
        }
    }

    return result;
}

function appendTrivia(outputLines: string[], triviaLines: string[]): void {
    const trimmedTrivia = [...triviaLines];
    while (trimmedTrivia.at(-1)?.trim().length === 0) {
        trimmedTrivia.pop();
    }

    if (trimmedTrivia.length === 0) {
        return;
    }

    if (
        outputLines.length > 0 &&
        outputLines.at(-1) !== "" &&
        trimmedTrivia[0] !== ""
    ) {
        outputLines.push("");
    }

    outputLines.push(...trimmedTrivia);
}

function trimTrailingBlankLines(lines: string[]): void {
    while (lines.at(-1) === "") {
        lines.pop();
    }
}
