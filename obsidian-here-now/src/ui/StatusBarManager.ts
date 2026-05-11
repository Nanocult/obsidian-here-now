import { Plugin, Notice } from 'obsidian';
import HereNowSyncPlugin from '../main';
import moment from 'moment';

export class StatusBarManager {
  private statusBarItem: HTMLElement;
  private lastSyncTime: number | null = null;
  private syncStartTime: number | null = null;

  constructor(private plugin: HereNowSyncPlugin) {
    this.statusBarItem = plugin.addStatusBarItem();
    this.statusBarItem.addClass('here-now-sync-status');
    this.statusBarItem.addEventListener('click', () => {
      // Click to trigger manual sync
      plugin.syncEngine.triggerManualSync();
    });
    this.updateStatus('⚪ Not synced');
  }

  /**
   * Update status bar text
   */
  updateStatus(message: string): void {
    this.statusBarItem.setText(message);
    this.statusBarItem.removeClass('syncing', 'error');
  }

  /**
   * Show sync progress with percentage
   */
  showSyncProgress(current: number, total: number): void {
    if (this.syncStartTime === null) {
      this.syncStartTime = Date.now();
    }
    
    const percent = Math.round((current / total) * 100);
    const elapsed = Math.round((Date.now() - this.syncStartTime) / 1000);
    
    this.statusBarItem.setText(`🔄 ${percent}% (${current}/${total}) • ${elapsed}s`);
    this.statusBarItem.addClass('syncing');
  }

  /**
   * Update last successful sync time
   */
  updateLastSync(timestamp: number): void {
    this.lastSyncTime = timestamp;
    this.syncStartTime = null;
    
    const timeStr = moment(timestamp).fromNow();
    this.statusBarItem.setText(`✅ Synced ${timeStr}`);
    this.statusBarItem.removeClass('syncing', 'error');
  }

  /**
   * Show error state
   */
  showError(message: string): void {
    this.statusBarItem.setText(`❌ Error`);
    this.statusBarItem.addClass('error');
    
    if (this.plugin.settings.showNotifications) {
      new Notice(`Sync error: ${message}`, 6000);
    }
    
    // Auto-clear error state after 10 seconds
    setTimeout(() => {
      if (this.lastSyncTime) {
        this.updateLastSync(this.lastSyncTime);
      }
    }, 10000);
  }

  /**
   * Show detailed sync summary
   */
  showSummary(summary: {
    uploads: number;
    downloads: number;
    conflicts: number;
    duration: number;
  }): void {
    const parts = [];
    if (summary.uploads > 0) parts.push(`↑${summary.uploads}`);
    if (summary.downloads > 0) parts.push(`↓${summary.downloads}`);
    if (summary.conflicts > 0) parts.push(`⚔️${summary.conflicts}`);
    
    const message = `✅ Synced ${parts.join(' ')} in ${summary.duration}s`;
    this.updateStatus(message);
    
    if (this.plugin.settings.showNotifications) {
      new Notice(message, 4000);
    }
  }

  /**
   * Get last sync time for display
   */
  getLastSyncDisplay(): string {
    if (!this.lastSyncTime) return 'Never';
    return moment(this.lastSyncTime).format('MMM D, HH:mm');
  }
}