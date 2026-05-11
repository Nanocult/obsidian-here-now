import { Plugin, Notice, TFile, TFolder, Platform } from 'obsidian';
import { HereNowSyncSettings, DEFAULT_SETTINGS, HereNowSyncSettingTab } from './settings';
import { AuthManager } from './auth';
import { SyncEngine } from './sync/SyncEngine';
import { StatusBarManager } from './ui/StatusBarManager';
import { OfflineQueue } from './sync/OfflineQueue';
import { TrashManager } from './sync/TrashManager';

export default class HereNowSyncPlugin extends Plugin {
  settings: HereNowSyncSettings;
  
  // Core components
  authManager: AuthManager;
  syncEngine: SyncEngine;
  statusBar: StatusBarManager;
  offlineQueue: OfflineQueue;
  trashManager: TrashManager;
  
  // State
  private syncIntervalId: number | null = null;
  private isSyncing = false;

  async onload() {
    await this.loadSettings();
    
    // Initialize managers
    this.authManager = new AuthManager(this);
    this.trashManager = new TrashManager(this);
    this.statusBar = new StatusBarManager(this);
    this.offlineQueue = new OfflineQueue(this);
    this.syncEngine = new SyncEngine(this);
    
    // Register settings tab
    this.addSettingTab(new HereNowSyncSettingTab(this.app, this));
    
    // Register commands
    this.addCommands();
    
    // Register ribbon icon
    this.addRibbonIcon('cloud-sync', 'Sync with here.now', async () => {
      await this.syncEngine.triggerManualSync();
    });
    
    // Register file event listeners
    this.registerVaultEvents();
    
    // Start periodic sync timer
    this.startPeriodicSync();
    
    // Initial sync after layout ready (if API key configured)
    this.app.workspace.onLayoutReady(async () => {
      if (await this.authManager.hasValidKey()) {
        // Small delay to let vault fully load
        setTimeout(async () => {
          await this.syncEngine.triggerSync({ 
            source: 'startup', 
            full: true // Full sync on first run after startup
          });
        }, 2000);
      }
    });
    
    // Listen for online/offline events
    window.addEventListener('online', () => {
      this.statusBar.updateStatus('🌐 Back online - syncing queued changes...');
      this.offlineQueue.processQueue();
    });
    window.addEventListener('offline', () => {
      this.statusBar.updateStatus('📴 Offline - changes will sync when reconnected');
    });
    
    console.log('✅ here.now Sync plugin loaded');
  }

  async onunload() {
    // Clean up periodic sync timer
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    
    // Cancel any ongoing sync operations
    this.syncEngine.cancelOngoingSync();
    
    console.log('🔌 here.now Sync plugin unloaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Restart periodic sync if interval changed
    this.startPeriodicSync();
  }

  private addCommands() {
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now with here.now',
      callback: async () => {
        if (!(await this.authManager.hasValidKey())) {
          new Notice('⚠️ Please configure your here.now API key first');
          return;
        }
        await this.syncEngine.triggerManualSync();
      }
    });
    
    this.addCommand({
      id: 'toggle-sync',
      name: 'Toggle periodic sync',
      callback: () => {
        this.settings.syncEnabled = !this.settings.syncEnabled;
        this.saveSettings();
        new Notice(`Periodic sync ${this.settings.syncEnabled ? 'enabled' : 'disabled'}`);
      }
    });
    
    this.addCommand({
      id: 'publish-to-site',
      name: 'Publish current vault to here.now Site',
      callback: async () => {
        if (!this.settings.siteSlug) {
          new Notice('⚠️ Configure a Site slug in settings first');
          return;
        }
        await this.syncEngine.publishToSite();
      }
    });
  }

  private registerVaultEvents() {
    // Handle file creation
    this.registerEvent(
      this.app.vault.on('create', async (file) => {
        if (file instanceof TFile && this.trashManager.isSyncable(file.path)) {
          this.offlineQueue.enqueue({ type: 'upload', file });
        }
      })
    );
    
    // Handle file modification
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (file instanceof TFile && this.trashManager.isSyncable(file.path)) {
          this.offlineQueue.enqueue({ type: 'upload', file });
        }
      })
    );
    
    // Handle file deletion - move to trash instead of remote delete
    this.registerEvent(
      this.app.vault.on('delete', async (file) => {
        if (file instanceof TFile) {
          // Note: file is already deleted, so we can't move it
          // Instead, we should intercept before deletion via a custom delete command
          // For now, log that remote cleanup may be needed
          console.log(`🗑️ File deleted locally: ${file.path} (remote cleanup pending)`);
        }
      })
    );
    
    // Handle file rename
    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (file instanceof TFile && this.trashManager.isSyncable(file.path)) {
          // Treat rename as delete old + create new
          this.offlineQueue.enqueue({ type: 'delete-remote', path: oldPath });
          this.offlineQueue.enqueue({ type: 'upload', file });
        }
      })
    );
  }

  private startPeriodicSync() {
    // Clear existing interval
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    
    // Only start if sync is enabled and API key is configured
    if (!this.settings.syncEnabled) {
      return;
    }
    
    const intervalMinutes = this.settings.syncIntervalMinutes;
    const intervalMs = intervalMinutes * 60 * 1000;
    
    this.syncIntervalId = window.setInterval(async () => {
      if (this.isSyncing) {
        console.log('⏭️ Skipping periodic sync - another sync is in progress');
        return;
      }
      
      if (!(await this.authManager.hasValidKey())) {
        console.log('⏭️ Skipping periodic sync - no valid API key');
        return;
      }
      
      await this.syncEngine.triggerSync({ source: 'timer', full: false });
    }, intervalMs);
    
    console.log(`⏱️ Periodic sync started: every ${intervalMinutes} minutes`);
  }

  // Helper: Check if a path should be excluded from sync
  shouldExcludePath(path: string): boolean {
    // Always exclude trash folder
    if (path.startsWith(this.settings.trashFolderName + '/')) {
      return true;
    }
    
    // Always exclude Obsidian config
    if (path.startsWith('.obsidian/')) {
      return true;
    }
    
    // Check user-defined exclude patterns
    if (this.settings.excludedPatterns.some(pattern => {
      // Simple glob matching - in production, use minimatch library
      const regex = new RegExp(
        pattern
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')
      );
      return regex.test(path);
    })) {
      return true;
    }
    
    // Check if sync scope is limited to specific folders
    if (this.settings.syncScope === 'specific-folders' && this.settings.includedFolders.length > 0) {
      return !this.settings.includedFolders.some(folder => 
        path === folder || path.startsWith(folder + '/')
      );
    }
    
    return false;
  }
}