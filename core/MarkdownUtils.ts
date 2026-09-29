/**
 * Markdown helpers shared by discovery, header generation and override creation
 */

import * as path from "node:path";
import YAML from "yaml";

export const MARKDOWN_EXTENSIONS = [".md", ".markdown"];

/**
 * Marker that starts the explanatory comment written by `config:override`
 * into new Markdown override files. The comment is stripped before merging.
 */
export const OVERRIDE_COMMENT_MARKER = "<!-- file-merge override";

export function isMarkdownPath(filePath: string): boolean {
    return MARKDOWN_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Parse a leading YAML front-matter block (`---\n...\n---`).
 * Returns null if the content has no front matter or it isn't a YAML mapping.
 * The returned body has the front matter and any blank lines directly after it removed.
 */
export function parseFrontMatter(
    content: string,
): { data: Record<string, unknown>; body: string } | null {
    const match = content.match(FRONT_MATTER_RE);
    if (!match) return null;

    let data: unknown;
    try {
        data = YAML.parse(match[1]);
    } catch {
        return null;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return null;
    }

    const body = content.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
    return { data: data as Record<string, unknown>, body };
}

/**
 * Remove the explanatory HTML comment that `config:override` puts at the top
 * of a new Markdown override file (plus the blank lines after it).
 */
export function stripOverrideComment(content: string): string {
    const trimmed = content.replace(/^\s+/, "");
    if (!trimmed.startsWith(OVERRIDE_COMMENT_MARKER)) return content;
    const end = trimmed.indexOf("-->");
    if (end === -1) return content;
    return trimmed.slice(end + 3).replace(/^[ \t]*(?:\r?\n)*/, "");
}
