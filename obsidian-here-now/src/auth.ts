import { Notice } from 'obsidian';
import HereNowSyncPlugin from './main';

export class AuthManager {
  private static readonly SECRET_KEY_NAME = 'here-now-api-key';
  
  constructor(private plugin: HereNowSyncPlugin) {}

  /**
   * Save API key to Obsidian's secure SecretStorage
   */
  async saveApiKey(key: string): Promise<void> {
    if (!key || key.trim().length === 0) {
      throw new Error('API key cannot be empty');
    }
    
    // Store encrypted key in OS keychain via SecretStorage
    await this.plugin.app.keyVault.setSecret(AuthManager.SECRET_KEY_NAME, key.trim());
    
    // Store only a label/timestamp in regular settings (not the key itself)
    this.plugin.settings.apiKeyLabel = `Key saved on ${new Date().toLocaleDateString()}`;
    await this.plugin.saveSettings();
    
    console.log('✅ API key saved securely');
  }

  /**
   * Retrieve API key from SecretStorage
   */
  async getApiKey(): Promise<string | null> {
    try {
      return await this.plugin.app.keyVault.getSecret(AuthManager.SECRET_KEY_NAME);
    } catch (error) {
      console.error('❌ Failed to retrieve API key:', error);
      return null;
    }
  }

  /**
   * Check if a valid API key is configured
   */
  async hasValidKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key && key.length > 20; // Basic validation
  }

  /**
   * Clear stored API key
   */
  async clearApiKey(): Promise<void> {
    await this.plugin.app.keyVault.deleteSecret(AuthManager.SECRET_KEY_NAME);
    this.plugin.settings.apiKeyLabel = '';
    await this.plugin.saveSettings();
    console.log('🗑️ API key cleared');
  }

  /**
   * Test connection to here.now API
   */
  async testConnection(): Promise<{ success: boolean; error?: string; driveInfo?: any }> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return { success: false, error: 'No API key configured' };
    }

    try {
      const response = await requestUrl({
        url: `${this.plugin.settings.apiBaseUrl}/drives/default`,
        method: 'GET',
        headers: this.getAuthHeaders(apiKey),
        throw: false,
        timeout: this.plugin.settings.requestTimeoutMs
      });

      if (response.status === 200) {
        const driveInfo = JSON.parse(response.text);
        return { success: true, driveInfo };
      }
      
      return { 
        success: false, 
        error: `HTTP ${response.status}: ${response.text.substring(0, 200)}` 
      };
      
    } catch (error: any) {
      return { 
        success: false, 
        error: `Connection failed: ${error.message || 'Unknown error'}` 
      };
    }
  }

  /**
   * Get standard auth headers for here.now API requests
   */
  getAuthHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-HereNow-Client': `obsidian-plugin/here-now-sync@${this.plugin.manifest.version}`,
      'User-Agent': `Obsidian/${this.plugin.app.getVersion()} here-now-sync/${this.plugin.manifest.version}`
    };
  }

  /**
   * Get headers for presigned URL requests (no auth needed)
   */
  getPresignedHeaders(contentType: string): Record<string, string> {
    return {
      'Content-Type': contentType,
      'Accept': '*/*'
    };
  }
}