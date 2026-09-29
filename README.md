# @feinarbyte/file-merge

File fragment merger - batteries included, dlx-ready.

Merge files from templates, fragments, and overrides with intelligent strategies for YAML, JSON, GitLab CI, Docker Compose, TypeScript configs, Markdown, text files, and more.

## Installation

```bash
# Using pnpm dlx (recommended)
pnpm dlx @feinarbyte/file-merge

# Using npx
npx @feinarbyte/file-merge

# Or install globally
pnpm add -g @feinarbyte/file-merge
```

## Configuration

Create a config file in your project root to customize behavior:

```bash
# Create YAML config (recommended)
file-merge init

# Or create JSON config
file-merge init --json
```

### YAML Configuration (Recommended)

```yaml
# .file-merge.config.yaml
templatesDir: config-templates

# Glob patterns with negation support
fragmentPatterns:
  - "**/*.fragment.*"        # Include all fragment files
  - "!node_modules/**"       # Exclude node_modules
  - "!dist/**"               # Exclude dist
  # Advanced: Exclude folder but include specific patterns
  # - "!folderA/folderB/**"
  # - "folderA/folderB/catalog.*.fragment.*"

ignorePatterns:
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/.git/**"
```

### JSON Configuration

```json
{
  "templatesDir": "config-templates",
  "fragmentPatterns": [
    "**/*.fragment.*",
    "!node_modules/**",
    "!dist/**"
  ],
  "ignorePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/.git/**"
  ]
}
```

### Configuration Options

- **`noSymlink`** - Copy single-source outputs instead of creating symlinks (default: `false`)
- **`copyPatterns`** - Per-file glob patterns (relative to project root) for targets that should be **copied** instead of symlinked when they have a single source (default: `[]`)
- **`templatesDir`** - Directory containing template files with `__` prefix (default: `"atom-framework/config-templates"`)
- **`fragmentPatterns`** - Glob patterns to discover fragment files. **Supports negation with `!` prefix**
  - Example: `["**/*.fragment.*", "!node_modules/**", "!folderA/**", "folderA/catalog.*.fragment.*"]`
- **`ignorePatterns`** - Additional patterns to ignore (applied after fragmentPatterns)
- **`modules`** - Optional module activation filtering (atom-framework specific)
  - `activeDir` - Directory where active modules are symlinked
  - `sourceDir` - Directory containing available modules
- **`watchPatterns`** - Patterns to watch in watch mode (optional, auto-derived if not set)

### Copy instead of symlink (per file)

By default, targets with a **single source** (typically a template) are symlinked to keep a single canonical file.
If you need a **real file** (for example `.gitignore` in some environments), configure per-target copy rules:

```yaml
# .file-merge.config.yaml
copyPatterns:
  - ".gitignore"
```

### Config File Formats

File-merge automatically detects and loads config files in this order:
1. `.file-merge.config.yaml` (recommended)
2. `.file-merge.config.yml`
3. `.file-merge.config.json`

If no config file exists, file-merge uses default patterns suitable for the atom-framework structure.

### Custom Config Location

You can specify a custom config file location:

```bash
# Use a different config file
file-merge apply --config configs/prod.config.json

# Use a shared config from parent directory
file-merge apply --config ../shared-config.json

# Watch with custom config
file-merge watch --config my-config.json
```

## Usage

### Apply Merging

```bash
file-merge apply
```

Options:
- `--dry-run` - Show what would be generated without writing files
- `--check` - Check if apply would change files (no writes, exits with code 1 when changes are needed)
- `--verbose` - Detailed output
- `--filter <patterns...>` - Only process files matching patterns
- `--config <path>` - Path to config file (default: auto-detect `.yaml`, `.yml`, or `.json`)

### Check Mode (CI / pre-commit)

```bash
file-merge apply --check
```

`--check` runs the same merge logic as `apply` but does not write files.

- Exit code `0`: all managed targets already match the expected state.
- Exit code `1`: one or more managed targets would change.
- Output includes `CHANGED <path>` lines and a final summary (`N changed, M unchanged, T total`).

Use `--dry-run` when you want informational output only without failing automation.

**CI example:**
```bash
file-merge validate
file-merge apply --check
```

**Pre-commit hook example (`.git/hooks/pre-commit`):**
```bash
#!/bin/sh
set -e
file-merge apply --check
```

### Watch Mode

```bash
file-merge watch
```

Automatically regenerates merged files when source files change.

Options:
- `--verbose` - Detailed output
- `--config <path>` - Path to config file (default: auto-detect `.yaml`, `.yml`, or `.json`)

### Migration

```bash
# Analyze existing files
file-merge migrate analyze

# Extract differences into override files
file-merge migrate extract --strategy smart
```

### Validation

```bash
file-merge validate
```

### Status

```bash
file-merge status [file]
```

## Features

- **Configurable** - Customize templates directory, fragment patterns, and module locations via `.file-merge.config.json`
- **Template-based merging** - Define templates in configurable templates directory (default: `config-templates/`)
- **Fragment merging** - Merge fragments from packages/modules using configurable patterns
- **Override support** - Override templates with project-specific changes
- **Smart merge strategies** - Auto-detects merge strategy based on file type
- **Template variables** - Use `{{VARIABLE}}` syntax in filenames and paths (resolved from environment variables)
- **Module filtering** - Only include fragments from active modules (configurable)
- **Supported formats**: YAML, JSON, TOML, GitLab CI, Docker Compose, TypeScript configs, VS Code tasks, Markdown (`.md`, `.markdown`), text files (.gitignore, .dockerignore), and more

## Template Variables

File-merge supports template variables using `{{VARIABLE}}` syntax:

- **In template filenames**: `atom-framework/config-templates/__{{ENV}}.yaml` → resolves to `{{ENV}}.yaml` in project root
- **In fragment `_targetPath`**: `_targetPath: "config/{{ENV}}.json"` → resolves to the target path

Variables are resolved from environment variables. If a required variable is missing, the tool will fail with a clear error message.

If you need a literal `{{...}}` token in generated output (for another tool to consume), escape it with a leading backslash:

- `\{{VARIABLE}}` → preserved as literal `{{VARIABLE}}` (no env substitution)

**Example:**
```yaml
# Fragment file: packages/my-package/config.fragment.yaml
_targetPath: "config/{{ENV}}/settings.json"
# ... rest of fragment content
```

If `ENV=production`, this fragment will target `config/production/settings.json`.

Literal placeholder example (e.g. for `mise`):

```toml
[env]
_.path = ['\{{config_root}}/node_modules/.bin']
```

## Merge Strategies

- `deep-merge` - Deep merge for JSON objects
- `yaml-merge` - Deep merge for YAML files
- `toml-merge` - Deep merge for TOML files
- `gitlab-ci` - GitLab CI/CD configuration merging
- `docker-compose` - Docker Compose file merging
- `tsconfig` - TypeScript config merging
- `vscode-tasks` - VS Code tasks.json merging
- `properties-merge` - Deterministic Java `.properties` merge with template/override precedence
- `append-lines` - Line-by-line appending (for .gitignore, etc.)
- `markdown-concat` - Default for `.md` / `.markdown`. Joins sources in priority order with one blank line
- `markdown-sections` - Like `markdown-concat`, but merges a later `## Heading` into the earlier section with the same text
- `replace` - Last source wins

### Markdown

A Markdown target such as `AGENTS.md` works like any other target:

- **Template only** (`atom-framework/config-templates/__AGENTS.md`): `AGENTS.md` is a symlink to the template.
- **Template plus override or fragments**: `AGENTS.md` is generated. The template comes first, then fragments by `_priority`, then `AGENTS.overrides.md`.

The generated file starts with an HTML comment, because `#` is a heading in Markdown:

```markdown
<!-- 🤖 GENERATED FILE - DO NOT EDIT DIRECTLY
     Edit source files instead:
       • file://./atom-framework/config-templates/__AGENTS.md
       • file://./AGENTS.overrides.md
     To regenerate: pnpm config:apply -->
```

`markdown-concat` strips one trailing newline from each source and joins them with a blank line.
Internal whitespace and duplicate lines are kept, and the result ends with exactly one newline.
Sources that are empty or whitespace-only are skipped.

`markdown-sections` is opt-in. With it, an override can add bullets to an existing template section without repeating the heading:

```markdown
---
_mergeStrategy: markdown-sections
---

## Learned Workspace Facts

- This project deploys with Helm.
```

Headings match on their trimmed text. Only `##` headings are merged, and headings inside fenced code blocks are ignored.
When a list item follows a list item, no blank line is inserted. Everything that doesn't match is appended like `markdown-concat`.

**Selecting the strategy.** Overrides and fragments can set `_mergeStrategy` in front matter. The first source in priority order that sets it wins. An override's front matter is only treated as metadata if it contains `_`-prefixed keys, and it is removed from the output.

**Fragments** use front matter for their metadata, for example `packages/foo/agents.fragment.md`:

```markdown
---
_targetPath: AGENTS.md
_priority: 50
---

## Foo package

Notes contributed by the foo package.
```

The front matter and the blank lines right after it are not included in the output.

**`file-merge override AGENTS.md`** creates `AGENTS.overrides.md` starting with an explanatory `<!-- file-merge override ... -->` comment. That comment is not copied into the generated file.

**`file-merge migrate analyze` / `extract`** treat Markdown as text and do a line diff against the template, ignoring the generated header.
Lines added inside an existing `##` section are extracted under that heading, and the override then gets `_mergeStrategy: markdown-sections`.
Lines removed from the template can't be expressed in an override. `extract` prints a warning for them.

### GitLab CI job name prefix override (per fragment)

When merging `.gitlab-ci.yml` using the `gitlab-ci` strategy, file-merge normally prefixes jobs based on the fragment file’s folder hierarchy.

You can override this per fragment using `__gitlabJobPrefix`:

```yaml
_targetPath: .gitlab-ci.yml
__gitlabJobPrefix: deploy   # "" disables prefixing

build:
  stage: build
  script:
    - echo "hello"
```

## Development

This project uses [mise](https://mise.jdx.dev/) for tool version management.

```bash
# Install tools (node, pnpm)
mise install

# Install dependencies
pnpm install

# Build
pnpm run build

# Watch mode
pnpm run dev

# Tests (builds, then runs node --test)
pnpm test
```

## Releasing

Releases are automated via GitHub Actions (`.github/workflows/publish.yml`). When a version tag is pushed, the workflow runs the tests and publishes the package to npm using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored in GitHub. The package's settings on npmjs.com list `feinarbyte/file-merge` with the workflow `publish.yml` as trusted publisher.

```bash
# Patch release (bug fixes): 2.0.1 → 2.0.2
pnpm run release:patch

# Minor release (new features): 2.0.1 → 2.1.0
pnpm run release:minor

# Major release (breaking changes): 2.0.1 → 3.0.0
pnpm run release:major
```

Each release command will:
1. Bump the version in `package.json`
2. Create a git commit with message `chore(release): vX.Y.Z`
3. Create a git tag `vX.Y.Z`
4. Push the commit and tag to origin

The GitHub Actions publish workflow then automatically publishes to npm.

### Manual Publishing

If you need to publish manually:

```bash
# Make sure you're logged in to npm with access to @feinarbyte scope
pnpm login

# Publish (will automatically build via prepublishOnly)
pnpm publish --access public
```

## Migration from Hardcoded Paths

If you're using an older version with hardcoded `atom-framework/` paths, file-merge will continue to work with the default configuration. To customize for your project:

1. Run `file-merge init` to create `.file-merge.config.json`
2. Edit the config to match your project structure
3. Update `templatesDir`, `fragmentPatterns`, and `modules` paths as needed

Example for a different structure:

```json
{
  "templatesDir": "config-templates",
  "fragmentPatterns": [
    "src/**/*.fragment.*",
    "libs/**/*.fragment.*"
  ],
  "modules": {
    "activeDir": "enabled-modules",
    "sourceDir": "src/modules"
  }
}
```

## License

MIT

