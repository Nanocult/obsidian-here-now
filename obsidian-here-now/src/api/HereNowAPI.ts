import { requestUrl, RequestUrlParam } from 'obsidian';
import HereNowSyncPlugin from '../main';

export interface HereNowFile {
  path: string;
  name: string;
  size: number;
  contentType: string;
  lastModified: string; // ISO 8601
  hash?: string; // ETag or custom hash
  metadata?: Record<string, any>;
}

export interface DriveInfo {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  totalSize: number;
}

export interface SiteInfo {
  slug: string;
  url: string;
  driveId: string;
  publishedAt?: string;
  version?: string;
}

export abstract class HereNowAPI {
  constructor(
    protected plugin: HereNowSyncPlugin,
    protected apiKey: string
  ) {}

  protected get baseUrl(): string {
    return this.plugin.settings.apiBaseUrl;
  }

  protected getAuthHeaders(): Record<string, string> {
    return this.plugin.authManager.getAuthHeaders(this.apiKey);
  }

  protected async request<T>(options: RequestUrlParam): Promise<T> {
    const response = await requestUrl({
      ...options,
      headers: { ...this.getAuthHeaders(), ...options.headers },
      throw: false,
      timeout: this.plugin.settings.requestTimeoutMs
    });

    if (!response.ok) {
      throw new Error(`API Error ${response.status}: ${response.text}`);
    }

    return response.json as T;
  }

  /**
   * Encode a file path for URL use (handle nested folders)
   */
  protected encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  /**
   * Compute SHA-256 hash of file content for change detection
   */
  protected async computeHash(content: ArrayBuffer): Promise<string> {
    const buffer = await crypto.subtle.digest('SHA-256', content);
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Get file size in MB
   */
  protected getSizeMB(sizeBytes: number): number {
    return sizeBytes / (1024 * 1024);
  }

  /**
   * Check if file is considered "large" based on settings
   */
  protected isLargeFile(sizeBytes: number): boolean {
    if (!this.plugin.settings.throttleLargeFiles) return false;
    return this.getSizeMB(sizeBytes) > this.plugin.settings.largeFileThresholdMB;
  }
}