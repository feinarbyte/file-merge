/**
 * Symlink Manager
 *
 * Creates and manages symlinks for single-source configuration files
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export class SymlinkManager {
    /**
     * Create a symlink from target to source
     * Removes existing file/symlink if present
     */
    async createSymlink(sourcePath: string, targetPath: string): Promise<void> {
        // Remove existing file/symlink if it exists
        try {
            const stats = await fs.lstat(targetPath);
            if (stats.isSymbolicLink() || stats.isFile()) {
                await fs.unlink(targetPath);
            } else if (stats.isDirectory()) {
                throw new Error(`Cannot replace ${targetPath}: is a directory`);
            }
        } catch (error: unknown) {
            if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code !== "ENOENT"
            ) {
                throw error;
            }
            // File doesn't exist, that's fine
        }

        // Ensure target directory exists
        await fs.mkdir(path.dirname(targetPath), { recursive: true });

        // Create relative symlink (more portable)
        const relPath = path.relative(path.dirname(targetPath), sourcePath);
        await fs.symlink(relPath, targetPath);

        console.log(`  🔗 ${path.relative(process.cwd(), targetPath)} → ${relPath}`);
    }

    /**
     * Check if target is a symlink pointing to source
     */
    async isSymlinkTo(targetPath: string, sourcePath: string): Promise<boolean> {
        try {
            const stats = await fs.lstat(targetPath);
            if (!stats.isSymbolicLink()) {
                return false;
            }

            const linkTarget = await fs.readlink(targetPath);
            const resolvedTarget = path.resolve(path.dirname(targetPath), linkTarget);
            const resolvedSource = path.resolve(sourcePath);

            return resolvedTarget === resolvedSource;
        } catch {
            return false;
        }
    }

    /**
     * Copy file instead of symlinking
     * Used when _copy: true is set
     */
    async copyFile(sourcePath: string, targetPath: string): Promise<void> {
        // Remove existing file/symlink if it exists
        // (Important: copying onto a symlink would overwrite the symlink target)
        try {
            const stats = await fs.lstat(targetPath);
            if (stats.isSymbolicLink() || stats.isFile()) {
                await fs.unlink(targetPath);
            } else if (stats.isDirectory()) {
                throw new Error(`Cannot replace ${targetPath}: is a directory`);
            }
        } catch (error: unknown) {
            if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code !== "ENOENT"
            ) {
                throw error;
            }
            // File doesn't exist, that's fine
        }

        // Ensure target directory exists
        await fs.mkdir(path.dirname(targetPath), { recursive: true });

        // Copy file
        await fs.copyFile(sourcePath, targetPath);

        console.log(`  📄 Copied ${path.relative(process.cwd(), targetPath)}`);
    }

    /**
     * Remove symlink or file
     */
    async remove(targetPath: string): Promise<void> {
        try {
            await fs.unlink(targetPath);
            console.log(`  🗑️  Removed ${path.relative(process.cwd(), targetPath)}`);
        } catch (error: unknown) {
            if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code !== "ENOENT"
            ) {
                throw error;
            }
        }
    }
}
