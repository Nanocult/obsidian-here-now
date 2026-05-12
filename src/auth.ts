import { requestUrl } from 'obsidian';
import HereNowSyncPlugin from './main';

export class AuthManager {
  private static readonly SECRET_KEY_NAME = 'here-now-api-key';
  
  constructor(private plugin: HereNowSyncPlugin) {}

  /**
   * Check if the Obsidian version supports KeyVault (SecretStorage)
   */
  private supportsKeyVault(): boolean {
    return !!(this.plugin.app as any).keyVault;
  }

  /**
   * Save API key to Obsidian's secure SecretStorage (or fallback to settings)
   */
  async saveApiKey(key: string): Promise<void> {
    if (!key || key.trim().length === 0) {
      throw new Error('API key cannot be empty');
    }
    
    const trimmedKey = key.trim();

    if (this.supportsKeyVault()) {
      // Store encrypted key in OS keychain via SecretStorage
      await (this.plugin.app as any).keyVault.setSecret(AuthManager.SECRET_KEY_NAME, trimmedKey);
      // Store only a label/timestamp in regular settings (not the key itself)
      this.plugin.settings.apiKeyLabel = `Key saved on ${new Date().toLocaleDateString()}`;
      
    } else {
      // Fallback: store in plugin settings (less secure but works on all Obsidian versions)
      this.plugin.settings.apiKeyLabel = 'Key configured';
      // Store the key directly in settings as fallback
      (this.plugin.settings as any).__apiKey = trimmedKey;
    }
    
    await this.plugin.saveSettings();
    console.log('✅ API key saved securely');
  }

  /**
   * Retrieve API key from SecretStorage or fallback
   */
  async getApiKey(): Promise<string | null> {
    if (this.supportsKeyVault()) {
      try {
        return await (this.plugin.app as any).keyVault.getSecret(AuthManager.SECRET_KEY_NAME);
      } catch (error) {
        console.error('❌ Failed to retrieve API key from keyVault:', error);
        return null;
      }
    }
    
    // Fallback: retrieve from settings
    return (this.plugin.settings as any).__apiKey || null;
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
    if (this.supportsKeyVault()) {
      await (this.plugin.app as any).keyVault.deleteSecret(AuthManager.SECRET_KEY_NAME);
    }
    
    this.plugin.settings.apiKeyLabel = '';
    delete (this.plugin.settings as any).__apiKey;
    await this.plugin.saveSettings();
    console.log('🗑️ API key cleared');
  }

  /**
   * Test connection to here.now API using a provided key (without saving it first)
   */
  async testConnectionWithKey(key: string): Promise<{ success: boolean; error?: string; driveInfo?: any }> {
    if (!key || key.trim().length === 0) {
      return { success: false, error: 'No API key provided' };
    }

    const trimmedKey = key.trim();

    try {
      const response = await requestUrl({
        url: `${this.plugin.settings.apiBaseUrl}/drives/default`,
        method: 'GET',
        headers: this.getAuthHeaders(trimmedKey),
        throw: false
      });

      if (response.status === 200) {
        let driveInfo;
        try { driveInfo = JSON.parse(response.text); } catch {}
        return { success: true, driveInfo };
      }
      
      return { 
        success: false, 
        error: `HTTP ${response.status}: ${response.text.substring(0, 200)}` 
      };
      
    } catch (error: any) {
      const message = error.message || String(error);
      
      // Detect common Electron network errors and provide helpful guidance
      let userMessage: string;
      
      if (message.includes('TUNNEL_CONNECTION_FAILED') || message.includes('tunnel')) {
        userMessage = 'Connection blocked by proxy/VPN. If you use a corporate network or VPN, try:\n' +
          '1. Disable VPN temporarily\n' +
          '2. Configure proxy in Obsidian settings (Settings → About → Network proxy)\n' +
          '3. Check your firewall settings';
      } else if (message.includes('ENOTFOUND') || message.includes('DNS')) {
        userMessage = 'DNS resolution failed. Check your internet connection.\n' +
          'The domain "here.now" could not be resolved.';
      } else if (message.includes('ECONNREFUSED') || message.includes('Connection refused')) {
        userMessage = 'Connection refused by the server. The API might be down or your custom URL is wrong.';
      } else if (message.includes('ETIMEDOUT') || message.includes('timeout')) {
        userMessage = 'Connection timed out. Check your internet speed or increase the Request Timeout in Advanced settings.';
      } else if (message.includes('ENETUNREACH') || message.includes('network is unreachable')) {
        userMessage = 'Network is unreachable. Check if you are online.';
      } else if (message.includes('CERT') || message.includes('certificate') || message.includes('SSL')) {
        userMessage = 'SSL/TLS certificate error. Usually caused by corporate proxies intercepting connections.';
      } else {
        userMessage = `Connection failed: ${message.substring(0, 300)}`;
      }
      
      return { 
        success: false, 
        error: userMessage 
      };
    }
  }

  /**
   * Test connection to here.now API (using saved key)
   */
  async testConnection(): Promise<{ success: boolean; error?: string; driveInfo?: any }> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return { success: false, error: 'No API key configured' };
    }

    return this.testConnectionWithKey(apiKey);
  }

  /**
   * Get standard auth headers for here.now API requests
   */
  getAuthHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-HereNow-Client': `obsidian-plugin/obsidian-here-now@${this.plugin.manifest.version}`,
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