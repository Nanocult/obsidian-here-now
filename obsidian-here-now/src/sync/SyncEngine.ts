import { Notice, TFile, Platform } from 'obsidian';
import HereNowSyncPlugin from '../main';
import { DriveAPI } from '../api/DriveAPI';
import { SitesAPI } from '../api/SitesAPI';
import { HereNowFile } from '../api/HereNowAPI';
import { computeFileHash } from '../utils/hash';
import { normalizePath } from '../utils/path';

export type SyncOperation = 
  | { type: 'upload'; file: TFile }
  | { type: 'download'; remoteFile: HereNowFile }
  | { type: 'delete-remote'; path: string }
  | { type: 'move-to-trash'; path: string };

export interface SyncPlan {
  operations: SyncOperation[];
  summary: {
    uploads: number;
    downloads: number;
    deletes: number;
    conflicts: number;
  };
  timestamp: number;
}

export interface SyncOptions {
  source: 'manual' | 'timer' | 'startup' | 'event';
  full?: boolean; // Force full sync vs incremental
}

export class SyncEngine {
  private driveApi: DriveAPI;
  private sitesApi: SitesAPI;
  private checksumCache: Map<string, string> = new Map();
  private remoteCache: Map<string, HereNowFile> = new Map();
  private isSyncing = false;
  private abortController: AbortController | null = null;

  constructor(private plugin: HereNowSyncPlugin) {
    // APIs will be initialized when API key is available
  }

  private async initAPIs(): Promise<boolean> {
    const apiKey = await this.plugin.authManager.getApiKey();
    if (!apiKey) {
      console.error('❌ Cannot initialize APIs: no API key');
      return false;
    }
    
    this.driveApi = new DriveAPI(this.plugin, apiKey);
    this.sitesApi = new SitesAPI(this.plugin, apiKey);
    return true;
  }

  /**
   * Trigger manual sync from UI/command
   */
  async triggerManualSync(): Promise<void> {
    if (this.isSyncing) {
      new Notice('⏳ Sync already in progress...');
      return;
    }
    
    if (!(await this.plugin.authManager.hasValidKey())) {
      new Notice('⚠️ Please configure your here.now API key first');
      return;
    }
    
    await this.triggerSync({ source: 'manual', full: false });
  }

  /**
   * Main sync entry point
   */
  async triggerSync(options: SyncOptions): Promise<void> {
    if (this.isSyncing) {
      console.log('⏭️ Sync already running, skipping');
      return;
    }

    if (!(await this.plugin.authManager.hasValidKey())) {
      console.log('⏭️ No valid API key, skipping sync');
      return;
    }

    this.isSyncing = true;
    this.abortController = new AbortController();
    this.plugin.statusBar.updateStatus('🔄 Starting sync...');

    try {
      // Initialize APIs
      if (!await this.initAPIs()) {
        throw new Error('Failed to initialize here.now APIs');
      }

      // Get drive info
      const driveId = this.plugin.settings.driveId || 
        (await this.driveApi.getDefaultDrive()).id;
      
      this.plugin.statusBar.updateStatus(`🔄 Connected to Drive: ${driveId}`);

      // Detect changes
      this.plugin.statusBar.updateStatus('🔍 Detecting changes...');
      const plan = await this.detectChanges(driveId, options.full || false);
      
      if (plan.operations.length === 0) {
        this.plugin.statusBar.updateLastSync(Date.now());
        new Notice('✅ Vault is up to date', 3000);
        return;
      }

      // Execute sync operations
      await this.executeSyncPlan(driveId, plan, options);
      
      // Auto-publish to Site if enabled
      if (this.plugin.settings.autoPublishToSite && 
          this.plugin.settings.siteSlug &&
          plan.operations.some(op => op.type === 'upload')) {
        await this.publishToSite();
      }
      
      // Update UI
      this.plugin.statusBar.updateLastSync(Date.now());
      const msg = `✅ Synced: ${plan.summary.uploads}↑ ${plan.summary.downloads}↓`;
      if (this.plugin.settings.showNotifications) {
        new Notice(msg, 4000);
      }
      
    } catch (error: any) {
      console.error('❌ Sync failed:', error);
      this.plugin.statusBar.showError(error.message || 'Sync failed');
      if (this.plugin.settings.showNotifications) {
        new Notice(`❌ Sync error: ${error.message}`, 6000);
      }
    } finally {
      this.isSyncing = false;
      this.abortController = null;
    }
  }

  /**
   * Detect changes between local vault and remote Drive
   */
  private async detectChanges(driveId: string, fullSync: boolean): Promise<SyncPlan> {
    const operations: SyncOperation[] = [];
    const summary = { uploads: 0, downloads: 0, deletes: 0, conflicts: 0 };
    
    // Get local files (respecting sync scope and exclusions)
    const localFiles = await this.getLocalFiles();
    
    // Get remote files from Drive
    const remoteFiles = fullSync 
      ? await this.fetchAllRemoteFiles(driveId)
      : this.remoteCache; // Use cache for incremental
    
    // Compare and build operations
    for (const [path, localFile] of localFiles) {
      const remoteFile = remoteFiles.get(path);
      const localHash = await computeFileHash(this.plugin.app.vault, localFile);
      
      if (!remoteFile) {
        // New local file → upload
        operations.push({ type: 'upload', file: localFile });
        summary.uploads++;
        this.checksumCache.set(path, localHash);
      } else if (remoteFile.hash !== localHash) {
        // Modified file → resolve conflict
        const action = await this.resolveConflict(localFile, remoteFile, localHash);
        if (action === 'upload') {
          operations.push({ type: 'upload', file: localFile });
          summary.uploads++;
          this.checksumCache.set(path, localHash);
        } else if (action === 'download') {
          operations.push({ type: 'download', remoteFile });
          summary.downloads++;
        } else if (action === 'keep-both') {
          // Create conflict copy locally
          await this.createConflictCopy(localFile, remoteFile);
          summary.conflicts++;
        }
        // 'skip' means user will handle manually
      }
      // Else: unchanged, skip
    }
    
    // Handle remote-only files (new on remote, not in trash)
    for (const [path, remoteFile] of remoteFiles) {
      if (!localFiles.has(path) && !this.isInTrash(path)) {
        operations.push({ type: 'download', remoteFile });
        summary.downloads++;
      }
    }
    
    // Note: We don't handle remote deletions automatically
    // User must manually delete from Drive if needed
    
    return { operations, summary, timestamp: Date.now() };
  }

  /**
   * Get all local files respecting sync settings
   */
  private async getLocalFiles(): Promise<Map<string, TFile>> {
    const files = new Map<string, TFile>();
    const vault = this.plugin.app.vault;
    
    for (const file of vault.getMarkdownFiles()) {
      if (this.plugin.shouldExcludePath(file.path)) continue;
      files.set(file.path, file);
    }
    
    // Also include non-markdown files (images, PDFs, etc.)
    for (const file of vault.getFiles()) {
      if (this.plugin.shouldExcludePath(file.path)) continue;
      if (!files.has(file.path)) {
        files.set(file.path, file);
      }
    }
    
    return files;
  }

  /**
   * Fetch all remote files from Drive
   */
  private async fetchAllRemoteFiles(driveId: string): Promise<Map<string, HereNowFile>> {
    const remoteFiles = new Map<string, HereNowFile>();
    
    // List files with empty prefix to get root level
    const files = await this.driveApi.listFiles(driveId);
    
    for (const file of files) {
      // Skip trash folder
      if (file.path.startsWith('.trash/')) continue;
      
      // Only sync files in included scope
      if (this.plugin.shouldExcludePath(file.path)) continue;
      
      remoteFiles.set(file.path, file);
    }
    
    // Update cache
    this.remoteCache = remoteFiles;
    return remoteFiles;
  }

  /**
   * Resolve conflict using configured strategy
   */
  private async resolveConflict(
    local: TFile, 
    remote: HereNowFile, 
    localHash: string
  ): Promise<'upload' | 'download' | 'keep-both' | 'skip'> {
    const localMtime = local.stat.mtime;
    const remoteMtime = new Date(remote.lastModified).getTime();
    
    // Manual merge prompt (if enabled)
    if (this.plugin.settings.enableManualMerge) {
      // In production, show modal with diff viewer
      // For now, default to timestamp strategy
      console.log(`⚔️ Conflict detected: ${local.path}`);
    }
    
    // Apply configured strategy
    switch (this.plugin.settings.conflictStrategy) {
      case 'timestamp-wins':
        return localMtime > remoteMtime ? 'upload' : 'download';
      case 'local-wins':
        return 'upload';
      case 'remote-wins':
        return 'download';
      case 'keep-both':
        return 'keep-both';
      default:
        return 'upload'; // Safe default
    }
  }

  /**
   * Create a conflict copy of a file
   */
  private async createConflictCopy(local: TFile, remote: HereNowFile): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const conflictPath = local.path.replace(
      /\.md$/, 
      `.conflict-${timestamp}.md`
    );
    
    // Download remote version to conflict file
    const remoteContent = await this.driveApi.downloadFile(
      this.plugin.settings.driveId || (await this.driveApi.getDefaultDrive()).id,
      remote.path
    );
    
    await this.plugin.app.vault.createBinary(conflictPath, remoteContent);
    new Notice(`📋 Created conflict copy: ${conflictPath}`, 5000);
  }

  /**
   * Execute a sync plan
   */
  private async executeSyncPlan(
    driveId: string, 
    plan: SyncPlan, 
    options: SyncOptions
  ): Promise<void> {
    const total = plan.operations.length;
    
    for (let i = 0; i < total; i++) {
      if (this.abortController?.signal.aborted) {
        console.log('🛑 Sync cancelled by user');
        break;
      }
      
      const op = plan.operations[i];
      this.plugin.statusBar.showSyncProgress(i + 1, total);
      
      try {
        switch (op.type) {
          case 'upload':
            await this.executeUpload(driveId, op.file);
            break;
          case 'download':
            await this.executeDownload(driveId, op.remoteFile);
            break;
          case 'delete-remote':
            // We don't auto-delete remote files (trash policy)
            console.log(`⏭️ Skipping remote delete: ${op.path}`);
            break;
          case 'move-to-trash':
            await this.plugin.trashManager.handleLocalDeletion(op.path);
            break;
        }
      } catch (error: any) {
        console.error(`❌ Failed to execute ${op.type} for ${op.type === 'upload' ? op.file.path : op.type === 'download' ? op.remoteFile.path : op.path}:`, error);
        // Continue with other operations
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Upload a local file to Drive
   */
  private async executeUpload(driveId: string, file: TFile): Promise<void> {
    const vault = this.plugin.app.vault;
    
    // Read file content
    const content = file.extension === 'md' 
      ? await vault.read(file)
      : await vault.readBinary(file);
    
    const contentBuffer = typeof content === 'string' 
      ? new TextEncoder().encode(content) 
      : content;
    
    const contentType = file.extension === 'md' 
      ? 'text/markdown; charset=utf-8'
      : this.getMimeType(file.extension);
    
    // Upload via Drive API
    await this.driveApi.uploadFile(
      driveId, 
      file.path, 
      contentBuffer, 
      contentType
    );
    
    // Update cache
    const hash = await computeFileHash(vault, file);
    this.checksumCache.set(file.path, hash);
    
    if (this.plugin.settings.showDetailedLogs) {
      console.log(`⬆️ Uploaded: ${file.path} (${(contentBuffer.byteLength / 1024).toFixed(1)} KB)`);
    }
  }

  /**
   * Download a remote file to local vault
   */
  private async executeDownload(driveId: string, remoteFile: HereNowFile): Promise<void> {
    const vault = this.plugin.app.vault;
    const content = await this.driveApi.downloadFile(driveId, remoteFile.path);
    
    // Create or update local file
    const localFile = vault.getAbstractFileByPath(remoteFile.path);
    
    if (localFile instanceof TFile) {
      // Update existing
      if (remoteFile.contentType.startsWith('text/')) {
        const text = new TextDecoder().decode(content);
        await vault.modify(localFile, text);
      } else {
        await vault.modifyBinary(localFile, content);
      }
    } else {
      // Create new
      if (remoteFile.contentType.startsWith('text/')) {
        const text = new TextDecoder().decode(content);
        await vault.create(remoteFile.path, text);
      } else {
        await vault.createBinary(remoteFile.path, content);
      }
    }
    
    // Update cache
    this.checksumCache.set(remoteFile.path, remoteFile.hash || '');
    
    if (this.plugin.settings.showDetailedLogs) {
      console.log(`⬇️ Downloaded: ${remoteFile.path} (${(content.byteLength / 1024).toFixed(1)} KB)`);
    }
  }

  /**
   * Publish current Drive state to configured Site
   */
  async publishToSite(): Promise<void> {
    if (!this.plugin.settings.siteSlug) {
      console.log('⏭️ No Site slug configured, skipping publish');
      return;
    }
    
    if (!this.driveApi || !this.sitesApi) {
      if (!await this.initAPIs()) {
        throw new Error('Cannot publish: API not initialized');
      }
    }
    
    const driveId = this.plugin.settings.driveId || 
      (await this.driveApi!.getDefaultDrive()).id;
    
    this.plugin.statusBar.updateStatus('🌐 Publishing to Site...');
    
    try {
      const site = await this.sitesApi!.publishFromDrive({
        driveId,
        slug: this.plugin.settings.siteSlug!,
        title: `${this.plugin.app.vault.getName()} - Auto-published`,
        description: `Synced from Obsidian on ${new Date().toLocaleString()}`
      });
      
      const msg = `🌐 Published to: ${site.url}`;
      console.log(msg);
      if (this.plugin.settings.showNotifications) {
        new Notice(msg, 5000);
      }
      return site;
      
    } catch (error: any) {
      console.error('❌ Publish failed:', error);
      throw new Error(`Failed to publish to Site: ${error.message}`);
    }
  }

  /**
   * Cancel ongoing sync operation
   */
  cancelOngoingSync(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.plugin.statusBar.updateStatus('🛑 Sync cancelled');
    }
  }

  /**
   * Check if path is in trash folder
   */
  private isInTrash(path: string): boolean {
    return path.startsWith(this.plugin.settings.trashFolderName + '/');
  }

  /**
   * Get MIME type for file extension
   */
  private getMimeType(extension: string): string {
    const types: Record<string, string> = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'pdf': 'application/pdf',
      'svg': 'image/svg+xml',
      'mp4': 'video/mp4',
      'mp3': 'audio/mpeg',
      'zip': 'application/zip',
      'json': 'application/json',
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript'
    };
    return types[extension.toLowerCase()] || 'application/octet-stream';
  }
}