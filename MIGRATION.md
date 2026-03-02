# Migration Guide: v1.x to v2.0

## Breaking Changes in v2.0

Version 2.0 introduces configurable paths to make the tool project-agnostic.

### What Changed?

**Before (v1.x):** Hardcoded paths
- Templates: `atom-framework/config-templates`
- Fragments: `atom-framework/**/*.fragment.*`, `packages/**/*.fragment.*`, etc.
- Modules: `modules/` and `atom-framework/modules/`

**After (v2.0):** Configurable via `.file-merge.config.json`

### Migration Steps

#### Option 1: Continue Using Defaults (No Changes Needed)

If your project already uses the `atom-framework/` structure, **no changes are required**. The tool defaults to the original paths for backward compatibility.

#### Option 2: Customize for Your Project

1. **Create config file:**
   ```bash
   npx file-merge init
   ```

2. **Edit `.file-merge.config.json`:**
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

3. **Move your templates** (optional):
   ```bash
   mv atom-framework/config-templates config-templates
   ```

4. **Test the configuration:**
   ```bash
   npx file-merge apply --dry-run --verbose
   ```

   For CI or pre-commit checks, use:
   ```bash
   npx file-merge apply --check
   ```
   `--check` does not write files and exits with code `1` when files would change.

### Configuration Options

See [README.md](./README.md#configuration) for full documentation.

**Key options:**
- `templatesDir` - Where template files with `__` prefix are located
- `fragmentPatterns` - Glob patterns to find fragment files
- `ignorePatterns` - Patterns to ignore when discovering fragments
- `modules.activeDir` - Where active modules are symlinked
- `modules.sourceDir` - Where available modules are stored
- `watchPatterns` - Patterns to watch in watch mode (auto-derived if not set)

### API Changes

#### ConfigManager

**Before:**
```typescript
const manager = new ConfigManager({ projectRoot });
await manager.apply();
```

**After (same API, but loads config automatically):**
```typescript
const manager = new ConfigManager({ projectRoot });
await manager.apply(); // Now loads .file-merge.config.json
```

You can also pass config explicitly:
```typescript
const manager = new ConfigManager({ 
  projectRoot,
  config: { templatesDir: "my-templates" }
});
await manager.apply();
```

### New Features

1. **Init command:** `file-merge init` creates example config file
2. **Configurable watch patterns:** Customize what `file-merge watch` monitors
3. **Flexible module locations:** Not limited to `atom-framework/` structure

### Troubleshooting

**Issue:** Can't find templates after upgrading

**Solution:** Either:
- Keep templates in `atom-framework/config-templates/` (default), or
- Run `file-merge init` and set `templatesDir` to your actual location

**Issue:** Fragments not being discovered

**Solution:** 
- Check `fragmentPatterns` in your config
- Run `file-merge apply --verbose` to see what's being discovered

**Issue:** Config file not being loaded

**Solution:**
- Ensure `.file-merge.config.json` is in project root (where you run the command)
- Check JSON syntax with `npx jsonlint .file-merge.config.json`

