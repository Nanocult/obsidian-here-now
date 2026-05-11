import { App, Modal, Setting, Notice } from 'obsidian';
import HereNowSyncPlugin from '../../main';

export class ApiKeyModal extends Modal {
  private apiKeyInput: HTMLInputElement;
  private testResult: HTMLElement;

  constructor(app: App, private plugin: HereNowSyncPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    this.setTitle('Configure here.now API Key');
    
    // Description
    contentEl.createEl('p', {
      text: 'Enter your here.now API key to enable sync. Your key is stored securely in your OS keychain and never synced.'
    });
    
    contentEl.createEl('p').innerHTML = `
      <a href="https://here.now/dashboard/api-keys" target="_blank">
        Get your API key from here.now dashboard →
      </a>
    `;
    
    // API Key input
    new Setting(contentEl)
      .setName('API Key')
      .setDesc('Starts with "hn_" or "here_"')
      .addText(text => {
        this.apiKeyInput = text.inputEl;
        text.inputEl.type = 'password';
        text.inputEl.placeholder = 'hn_xxxxxxxxxxxxxxxxxxxx';
        text.setPlaceholder('Enter your API key');
      });
    
    // Test connection button
    new Setting(contentEl)
      .setName('Test Connection')
      .setDesc('Verify your API key works before saving')
      .addButton(button => button
        .setButtonText('Test')
        .onClick(async () => {
          const key = this.apiKeyInput.value.trim();
          if (!key) {
            new Notice('⚠️ Please enter an API key first');
            return;
          }
          
          button.setButtonText('Testing...').setDisabled(true);
          
          // Temporarily set key for testing
          const originalKey = await this.plugin.authManager.getApiKey();
          await this.plugin.authManager.saveApiKey(key);
          
          const result = await this.plugin.authManager.testConnection();
          
          // Restore original key if test failed
          if (!result.success && originalKey) {
            await this.plugin.authManager.saveApiKey(originalKey);
          }
          
          // Show result
          if (result.success) {
            this.testResult.setText('✅ Connection successful!');
            this.testResult.addClass('valid');
            new Notice('✅ API key is valid', 3000);
          } else {
            this.testResult.setText(`❌ ${result.error}`);
            this.testResult.addClass('invalid');
            new Notice(`❌ ${result.error}`, 5000);
          }
          
          button.setButtonText('Test').setDisabled(false);
        })
      );
    
    // Test result display
    this.testResult = contentEl.createEl('p', { cls: 'test-result' });
    
    // Save button
    new Setting(contentEl)
      .addButton(button => button
        .setButtonText('Save & Close')
        .setCta()
        .onClick(async () => {
          const key = this.apiKeyInput.value.trim();
          if (!key) {
            new Notice('⚠️ API key cannot be empty');
            return;
          }
          
          try {
            await this.plugin.authManager.saveApiKey(key);
            new Notice('✅ API key saved securely');
            this.close();
            
            // Trigger initial sync if this is first setup
            if (!this.plugin.settings.apiKeyLabel) {
              setTimeout(() => {
                this.plugin.syncEngine.triggerSync({ 
                  source: 'startup', 
                  full: true 
                });
              }, 1000);
            }
          } catch (error: any) {
            new Notice(`❌ Failed to save: ${error.message}`);
          }
        })
      )
      .addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => this.close())
      );
    
    // Load existing key label if available
    if (this.plugin.settings.apiKeyLabel) {
      this.apiKeyInput.placeholder = this.plugin.settings.apiKeyLabel;
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}