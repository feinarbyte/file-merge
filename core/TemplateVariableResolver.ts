/**
 * Template Variable Resolver
 *
 * Resolves {{VARIABLE}} placeholders in strings using environment variables
 */

export class TemplateVariableResolver {
    private static readonly UNESCAPED_VARIABLE_PATTERN = /(?<!\\)\{\{(\w+)\}\}/g;
    private static readonly ESCAPED_VARIABLE_PATTERN = /\\(\{\{\w+\}\})/g;

    /**
     * Resolve template variables in a string
     * @param template String containing {{VARIABLE}} placeholders
     * @returns Resolved string with variables substituted
     * @throws Error if any variable is not set in environment
     */
    static resolve(template: string): string {
        let result = template;
        const missingVars: string[] = [];

        const matches = Array.from(template.matchAll(this.UNESCAPED_VARIABLE_PATTERN));

        for (const match of matches) {
            const varName = match[1];
            const envValue = process.env[varName];

            if (envValue === undefined) {
                if (!missingVars.includes(varName)) {
                    missingVars.push(varName);
                }
            } else {
                result = result.replace(match[0], envValue);
            }
        }

        if (missingVars.length > 0) {
            throw new Error(
                `Missing required environment variables: ${missingVars.join(", ")}\n` +
                    `Template: ${template}`,
            );
        }

        // Unescape literal placeholders (e.g. \{{VAR}} -> {{VAR}})
        return result.replace(this.ESCAPED_VARIABLE_PATTERN, "$1");
    }

    /**
     * Check if a string contains template variables
     */
    static hasVariables(template: string): boolean {
        return /(?<!\\)\{\{\w+\}\}/.test(template);
    }

    /**
     * Extract all variable names from a template
     */
    static extractVariables(template: string): string[] {
        const matches = Array.from(template.matchAll(this.UNESCAPED_VARIABLE_PATTERN));
        return [...new Set(matches.map((m) => m[1]))];
    }
}
