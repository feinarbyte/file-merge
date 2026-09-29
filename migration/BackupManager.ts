/**
 * Backup Manager
 *
 * Creates and manages backups of configuration files during migration
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BackupManifest } from "../core/types.js";

export class BackupManager {
    private backupRoot: string;

    constructor(projectRoot: string) {
        this.backupRoot = path.join(projectRoot, ".file-merge", "backups");
    }

    /**
     * Create a timestamped backup of the specified files
     */
    async createBackup(files: string[]): Promise<BackupManifest> {
        // Create timestamp (ISO format, safe for filenames)
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, -5); // Remove milliseconds
        const backupDir = path.join(this.backupRoot, timestamp);

        // Create backup directory
        await fs.mkdir(backupDir, { recursive: true });

        const manifest: BackupManifest = {
            timestamp,
            files: [],
        };

        console.log(`💾 Creating backup in ${backupDir}...\n`);

        for (const file of files) {
            try {
                // Check if file exists
                await fs.access(file);

                // Calculate relative path for backup structure
                const relativePath = path.relative(process.cwd(), file);
                const backupPath = path.join(backupDir, relativePath);

                // Ensure backup directory exists
                await fs.mkdir(path.dirname(backupPath), { recursive: true });

                // Copy file
                await fs.copyFile(file, backupPath);

                // Calculate hash
                const hash = await this.hashFile(file);

                manifest.files.push({
                    original: file,
                    backup: backupPath,
                    hash,
                });

                console.log(`  ✅ Backed up ${relativePath}`);
            } catch (error: unknown) {
                if (
                    typeof error === "object" &&
                    error !== null &&
                    "code" in error &&
                    error.code === "ENOENT"
                ) {
                    console.log(`  ⏭️  Skipped ${file} (does not exist)`);
                } else {
                    console.error(`  ❌ Failed to backup ${file}:`, error);
                }
            }
        }

        // Write manifest
        const manifestPath = path.join(backupDir, "manifest.json");
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

        console.log(`\n📝 Backup manifest written to ${manifestPath}`);

        return manifest;
    }

    /**
     * Restore files from a backup
     */
    async restore(timestamp: string): Promise<void> {
        const backupDir = path.join(this.backupRoot, timestamp);
        const manifestPath = path.join(backupDir, "manifest.json");

        console.log(`🔄 Restoring from backup ${timestamp}...\n`);

        // Load manifest
        const manifestContent = await fs.readFile(manifestPath, "utf-8");
        const manifest: BackupManifest = JSON.parse(manifestContent);

        for (const entry of manifest.files) {
            try {
                // Verify backup file hash
                const currentHash = await this.hashFile(entry.backup);
                if (currentHash !== entry.hash) {
                    console.warn(`  ⚠️  Hash mismatch for ${entry.backup}, continuing anyway`);
                }

                // Restore file
                await fs.mkdir(path.dirname(entry.original), { recursive: true });
                await fs.copyFile(entry.backup, entry.original);

                console.log(`  ✅ Restored ${path.relative(process.cwd(), entry.original)}`);
            } catch (error) {
                console.error(`  ❌ Failed to restore ${entry.original}:`, error);
            }
        }

        console.log("\n✅ Restore completed");
    }

    /**
     * List all available backups
     */
    async listBackups(): Promise<string[]> {
        try {
            const entries = await fs.readdir(this.backupRoot, {
                withFileTypes: true,
            });
            return entries
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
                .sort()
                .reverse(); // Most recent first
        } catch (error: unknown) {
            if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
            ) {
                return [];
            }
            throw error;
        }
    }

    /**
     * Clean up old backups, keeping only the specified number
     */
    async cleanup(retention: number): Promise<void> {
        const backups = await this.listBackups();

        if (backups.length <= retention) {
            console.log(
                `ℹ️  ${backups.length} backups exist, keeping all (retention: ${retention})`,
            );
            return;
        }

        const toDelete = backups.slice(retention);
        console.log(`🧹 Removing ${toDelete.length} old backups...\n`);

        for (const backup of toDelete) {
            const backupDir = path.join(this.backupRoot, backup);
            try {
                await fs.rm(backupDir, { recursive: true });
                console.log(`  ✅ Removed ${backup}`);
            } catch (error) {
                console.error(`  ❌ Failed to remove ${backup}:`, error);
            }
        }

        console.log(`\n✅ Cleanup completed, ${retention} backups retained`);
    }

    /**
     * Calculate SHA-256 hash of a file
     */
    private async hashFile(filePath: string): Promise<string> {
        const content = await fs.readFile(filePath);
        return crypto.createHash("sha256").update(content).digest("hex");
    }
}
