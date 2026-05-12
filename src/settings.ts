import { PluginSettingTab, Setting, App, Notice } from 'obsidian';
import HereNowSyncPlugin from './main';
import { ApiKeyModal } from './ui/modals/ApiKeyModal';
import { SyncLogger } from './utils/logger';

export interface HereNowSyncSettings {
  // Authentication (API key stored in SecretStorage, not here)
  apiKeyLabel: string;
  
  // Sync configuration
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  syncScope: 'entire-vault' | 'specific-folders';
  includedFolders: string[];
  excludedPatterns: string[];
  
  // Storage target
  defaultTarget: 'drive' | 'site';
  driveId?: string;
  siteSlug?: string;
  autoPublishToSite: boolean; // Auto-publish after successful Drive sync
  
  // Conflict resolution
  conflictStrategy: 'timestamp-wins' | 'local-wins' | 'remote-wins' | 'keep-both';
  enableManualMerge: boolean;
  
  // Deletion behavior
  trashFolderName: string;
  
  // Offline & performance
  enableOfflineQueue: boolean;
  maxQueueSize: number;
  throttleLargeFiles: boolean;
  largeFileThresholdMB: number;
  
  // UI preferences
  showNotifications: boolean;
  showDetailedLogs: boolean;
  
  // Advanced
  apiBaseUrl: string; // Allow self-hosted here.now instances
  requestTimeoutMs: number;
}

export const DEFAULT_SETTINGS: HereNowSyncSettings = {
  apiKeyLabel: '',
  
  syncEnabled: true,
  syncIntervalMinutes: 15,
  syncScope: 'entire-vault',
  includedFolders: [],
  excludedPatterns: ['*.tmp', '*.log', '.DS_Store', 'node_modules/**'],
  
  defaultTarget: 'drive',
  driveId: undefined,
  siteSlug: undefined,
  autoPublishToSite: false,
  
  conflictStrategy: 'timestamp-wins',
  enableManualMerge: true,
  
  trashFolderName: '.trash',
  
  enableOfflineQueue: true,
  maxQueueSize: 100,
  throttleLargeFiles: true,
  largeFileThresholdMB: 10,
  
  showNotifications: true,
  showDetailedLogs: false,
  
  apiBaseUrl: 'https://here.now/api/v1',
  requestTimeoutMs: 30000,
};

export class HereNowSyncSettingTab extends PluginSettingTab {
  plugin: HereNowSyncPlugin;

  constructor(app: App, plugin: HereNowSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Header
    containerEl.createEl('h2', { text: 'here.now Sync Settings' });
    containerEl.createEl('p', { 
      text: 'Sync your Obsidian vault with here.now Drives (private) or Sites (public).',
      cls: 'mod-info'
    });

    // ===== AUTHENTICATION SECTION =====
    containerEl.createEl('h3', { text: '🔐 Authentication' });
    
    new Setting(containerEl)
      .setName('here.now API Key')
      .setDesc('Stored securely in your OS keychain. Get yours from here.now dashboard.')
      .addButton(button => button
        .setButtonText(this.plugin.settings.apiKeyLabel || 'Configure API Key')
        .setCta()
        .onClick(async () => {
          const modal = new ApiKeyModal(this.app, this.plugin);
          modal.open();
        })
      )
      .addExtraButton(button => button
        .setIcon('refresh-cw')
        .setTooltip('Test connection')
        .onClick(async () => {
          const result = await this.plugin.authManager.testConnection();
          if (result.success) {
            new Notice('✅ Connected to here.now successfully');
          } else {
            new Notice(`❌ Connection failed: ${result.error}`);
          }
        })
      );

    // ===== SYNC CONFIGURATION =====
    containerEl.createEl('h3', { text: '🔄 Sync Configuration' });
    
    new Setting(containerEl)
      .setName('Enable Periodic Sync')
      .setDesc('Automatically sync changes at regular intervals')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncEnabled)
        .onChange(async (value) => {
          this.plugin.settings.syncEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync Interval')
      .setDesc('How often to check for changes (when periodic sync is enabled)')
      .addDropdown(dropdown => dropdown
        .addOption('5', 'Every 5 minutes')
        .addOption('15', 'Every 15 minutes')
        .addOption('30', 'Every 30 minutes')
        .addOption('60', 'Every hour')
        .addOption('120', 'Every 2 hours')
        .setValue(this.plugin.settings.syncIntervalMinutes.toString())
        .onChange(async (value) => {
          this.plugin.settings.syncIntervalMinutes = parseInt(value);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync Scope')
      .setDesc('Choose which folders to sync')
      .addDropdown(dropdown => dropdown
        .addOption('entire-vault', 'Entire vault')
        .addOption('specific-folders', 'Specific folders only')
        .setValue(this.plugin.settings.syncScope)
        .onChange(async (value: 'entire-vault' | 'specific-folders') => {
          this.plugin.settings.syncScope = value;
          await this.plugin.saveSettings();
          this.display(); // Re-render to show/hide folder selector
        })
      );

    // Show folder selector only if specific folders mode
    if (this.plugin.settings.syncScope === 'specific-folders') {
      new Setting(containerEl)
        .setName('Included Folders')
        .setDesc('Folders to sync (one per line, relative to vault root)')
        .addTextArea(text => text
          .setPlaceholder('Notes\nProjects/Work\nDiaries')
          .setValue(this.plugin.settings.includedFolders.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.includedFolders = value
              .split('\n')
              .map(f => f.trim())
              .filter(f => f.length > 0);
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl)
      .setName('Exclude Patterns')
      .setDesc('Glob patterns to exclude (e.g., *.tmp, .obsidian/**)')
      .addTextArea(text => text
        .setPlaceholder('*.tmp\n*.log\nnode_modules/**\n.cache/**')
        .setValue(this.plugin.settings.excludedPatterns.join('\n'))
        .onChange(async (value) => {
          this.plugin.settings.excludedPatterns = value
            .split('\n')
            .map(p => p.trim())
            .filter(p => p.length > 0);
          await this.plugin.saveSettings();
        })
      );

    // ===== STORAGE TARGET =====
    containerEl.createEl('h3', { text: '📦 Storage Target' });
    
    new Setting(containerEl)
      .setName('Default Sync Target')
      .setDesc('Where to store synced files')
      .addDropdown(dropdown => dropdown
        .addOption('drive', '🔒 Drive (private storage)')
        .addOption('site', '🌐 Site (public URL)')
        .setValue(this.plugin.settings.defaultTarget)
        .onChange(async (value: 'drive' | 'site') => {
          this.plugin.settings.defaultTarget = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.defaultTarget === 'drive') {
      new Setting(containerEl)
        .setName('Drive ID')
        .setDesc('Optional: Specific Drive ID (leave empty to use default)')
        .addText(text => text
          .setPlaceholder('auto-discover')
          .setValue(this.plugin.settings.driveId || '')
          .onChange(async (value) => {
            this.plugin.settings.driveId = value || undefined;
            await this.plugin.saveSettings();
          })
        );
    }

    if (this.plugin.settings.defaultTarget === 'site' || this.plugin.settings.siteSlug) {
      new Setting(containerEl)
        .setName('Site Slug')
        .setDesc('Your here.now Site slug (e.g., "my-notes") for public publishing')
        .addText(text => text
          .setPlaceholder('my-notes')
          .setValue(this.plugin.settings.siteSlug || '')
          .onChange(async (value) => {
            this.plugin.settings.siteSlug = value || undefined;
            await this.plugin.saveSettings();
          })
        );
    }

    // Auto-publish toggle (only shown when Drive is default but Site is configured)
    if (this.plugin.settings.defaultTarget === 'drive' && this.plugin.settings.siteSlug) {
      new Setting(containerEl)
        .setName('Auto-publish to Site')
        .setDesc('After syncing to Drive, automatically publish snapshot to your Site')
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.autoPublishToSite)
          .onChange(async (value) => {
            this.plugin.settings.autoPublishToSite = value;
            await this.plugin.saveSettings();
          })
        );
    }

    // ===== CONFLICT RESOLUTION =====
    containerEl.createEl('h3', { text: '⚔️ Conflict Resolution' });
    
    new Setting(containerEl)
      .setName('Conflict Strategy')
      .setDesc('When the same file is modified in both locations')
      .addDropdown(dropdown => dropdown
        .addOption('timestamp-wins', '🕐 Newest file wins (last-write-wins)')
        .addOption('local-wins', '💻 Local version always wins')
        .addOption('remote-wins', '☁️ Remote version always wins')
        .addOption('keep-both', '📋 Keep both versions (add .conflict suffix)')
        .setValue(this.plugin.settings.conflictStrategy)
        .onChange(async (value) => {
          this.plugin.settings.conflictStrategy = value as any;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Manual Merge Prompt')
      .setDesc('Show a dialog to manually resolve conflicts when they occur')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableManualMerge)
        .onChange(async (value) => {
          this.plugin.settings.enableManualMerge = value;
          await this.plugin.saveSettings();
        })
      );

    // ===== DELETION BEHAVIOR =====
    containerEl.createEl('h3', { text: '🗑️ Deletion Handling' });
    
    new Setting(containerEl)
      .setName('Trash Folder Name')
      .setDesc('Files deleted locally are moved here instead of being deleted remotely')
      .addText(text => text
        .setValue(this.plugin.settings.trashFolderName)
        .onChange(async (value) => {
          this.plugin.settings.trashFolderName = value || '.trash';
          await this.plugin.saveSettings();
        })
      )
      .addExtraButton(button => button
        .setIcon('info')
        .setTooltip('This folder is automatically excluded from sync')
      );

    // ===== OFFLINE & PERFORMANCE =====
    containerEl.createEl('h3', { text: '⚡ Offline & Performance' });
    
    new Setting(containerEl)
      .setName('Enable Offline Queue')
      .setDesc('Queue changes when offline and sync automatically when reconnected')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableOfflineQueue)
        .onChange(async (value) => {
          this.plugin.settings.enableOfflineQueue = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Throttle Large Files')
      .setDesc('Pause sync of large files on metered connections')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.throttleLargeFiles)
        .onChange(async (value) => {
          this.plugin.settings.throttleLargeFiles = value;
          await this.plugin.saveSettings();
        })
      );

    if (this.plugin.settings.throttleLargeFiles) {
      new Setting(containerEl)
        .setName('Large File Threshold')
        .setDesc('Files larger than this will be throttled (MB)')
        .addText(text => text
          .setValue(this.plugin.settings.largeFileThresholdMB.toString())
          .onChange(async (value: string) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.largeFileThresholdMB = num;
              await this.plugin.saveSettings();
            }
          })
        )
        .then(setting => {
          setting.controlEl.querySelector('input')?.setAttribute('type', 'number');
        });
    }

    // ===== UI PREFERENCES =====
    containerEl.createEl('h3', { text: '🎨 UI Preferences' });
    
    new Setting(containerEl)
      .setName('Show Notifications')
      .setDesc('Display modal notifications for sync events')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showNotifications)
        .onChange(async (value) => {
          this.plugin.settings.showNotifications = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Show Detailed Logs')
      .setDesc('Output verbose sync logs to developer console')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showDetailedLogs)
        .onChange(async (value) => {
          this.plugin.settings.showDetailedLogs = value;
          await this.plugin.saveSettings();
        })
      );

    // ===== DIAGNOSTICS =====
    containerEl.createEl('h3', { text: '📋 Diagnostics' });
    
    new Setting(containerEl)
      .setName('View Sync Logs')
      .setDesc('View and export sync logs for troubleshooting')
      .addButton(button => button
        .setButtonText('📋 View Logs')
        .onClick(() => {
          const logs = SyncLogger.getRecent(30);
          if (!logs || logs.length === 0) {
            new Notice('No sync logs available');
            return;
          }
          const logText = logs.map((entry) => {
            const date = new Date(entry.timestamp).toLocaleTimeString();
            const level = entry.level === 'error' ? '❌' : entry.level === 'warn' ? '⚠️' : 'ℹ️';
            return `${date} ${level} [${entry.category}] ${entry.message}`;
          }).join('\n');
          navigator.clipboard.writeText(logText);
          new Notice(`📋 ${logs.length} recent logs copied to clipboard`, 4000);
          console.log('=== here.now Sync Logs ===\n' + logText);
        })
      )
      .addButton(button => button
        .setButtonText('📤 Export All')
        .onClick(() => {
          const text = SyncLogger.exportAsText();
          navigator.clipboard.writeText(text);
          new Notice(`📋 Exported ${SyncLogger.getLogs().length} entries to clipboard`, 4000);
          console.log(text);
        })
      )
      .addButton(button => button
        .setButtonText('🗑️ Clear')
        .onClick(() => {
          SyncLogger.clear();
          new Notice('🗑️ Logs cleared', 3000);
        })
      );

    // ===== ADVANCED =====
    containerEl.createEl('h3', { text: '⚙️ Advanced' });
    
    new Setting(containerEl)
      .setName('API Base URL')
      .setDesc('Custom here.now API endpoint (for self-hosted instances)')
      .addText(text => text
        .setValue(this.plugin.settings.apiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value || 'https://here.now/api/v1';
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Request Timeout')
      .setDesc('Maximum time to wait for API responses (milliseconds)')
      .addText(text => text
        .setValue(this.plugin.settings.requestTimeoutMs.toString())
        .onChange(async (value: string) => {
          const num = parseInt(value);
          if (!isNaN(num) && num > 1000) {
            this.plugin.settings.requestTimeoutMs = num;
            await this.plugin.saveSettings();
          }
        })
      )
      .then(setting => {
        setting.controlEl.querySelector('input')?.setAttribute('type', 'number');
      });

    // Footer
    containerEl.createEl('hr');
    const footer = containerEl.createEl('p', { cls: 'mod-muted' });
    footer.innerHTML = `
      Obsidian <a href="https://github.com/Nanocult/obsidian-here-now" target="_blank">here.now Sync</a> Plugin v${this.plugin.manifest.version} • 
      <a href="https://here.now/docs" target="_blank">here.now Docs</a> • 
      <a href="https://docs.obsidian.md" target="_blank">Obsidian Dev Docs</a>
    `;
  }
}