import { HereNowAPI, HereNowFile, DriveInfo } from './HereNowAPI';

export class DriveAPI extends HereNowAPI {
  /**
   * Get or create default Drive for this user
   */
  async getDefaultDrive(): Promise<DriveInfo> {
    return this.request<DriveInfo>({
      url: `${this.baseUrl}/drives/default`,
      method: 'GET'
    });
  }

  /**
   * Get specific Drive by ID
   */
  async getDrive(driveId: string): Promise<DriveInfo> {
    return this.request<DriveInfo>({
      url: `${this.baseUrl}/drives/${driveId}`,
      method: 'GET'
    });
  }

  /**
   * List files in a Drive with optional prefix filtering
   */
  async listFiles(driveId: string, prefix: string = ''): Promise<HereNowFile[]> {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    
    const response = await this.request<{ files: HereNowFile[] }>({
      url: `${this.baseUrl}/drives/${driveId}/files?${params}`,
      method: 'GET'
    });
    
    return response.files;
  }

  /**
   * Get presigned URL for uploading a file
   */
  async getUploadUrl(
    driveId: string, 
    path: string, 
    contentType: string,
    size: number
  ): Promise<{ uploadUrl: string; etag: string; expiresAt: string }> {
    return this.request({
      url: `${this.baseUrl}/drives/${driveId}/files/uploads`,
      method: 'POST',
      body: JSON.stringify({
        path,
        contentType,
        size,
        ifNoneMatch: '*' // Prevent overwriting unless intended
      })
    });
  }

  /**
   * Upload file content to presigned URL
   */
  async uploadToPresignedUrl(
    uploadUrl: string, 
    content: ArrayBuffer, 
    contentType: string
  ): Promise<void> {
    await requestUrl({
      url: uploadUrl,
      method: 'PUT',
      headers: this.plugin.authManager.getPresignedHeaders(contentType),
      body: content,
      throw: true
    });
  }

  /**
   * Finalize upload with ETag precondition
   */
  async finalizeUpload(
    driveId: string, 
    path: string, 
    etag: string
  ): Promise<HereNowFile> {
    return this.request<HereNowFile>({
      url: `${this.baseUrl}/drives/${driveId}/files/finalize`,
      method: 'POST',
      body: JSON.stringify({ path, etag })
    });
  }

  /**
   * Complete upload workflow: get URL → upload → finalize
   */
  async uploadFile(
    driveId: string, 
    path: string, 
    content: ArrayBuffer, 
    contentType: string
  ): Promise<HereNowFile> {
    const size = content.byteLength;
    
    // Step 1: Get presigned URL
    const { uploadUrl, etag } = await this.getUploadUrl(driveId, path, contentType, size);
    
    // Step 2: Upload to presigned URL
    await this.uploadToPresignedUrl(uploadUrl, content, contentType);
    
    // Step 3: Finalize
    return await this.finalizeUpload(driveId, path, etag);
  }

  /**
   * Download file content from Drive
   */
  async downloadFile(driveId: string, path: string): Promise<ArrayBuffer> {
    const encodedPath = this.encodePath(path);
    const response = await requestUrl({
      url: `${this.baseUrl}/drives/${driveId}/files/${encodedPath}`,
      method: 'GET',
      headers: this.getAuthHeaders(),
      throw: true
    });
    return response.arrayBuffer;
  }

  /**
   * Delete file from Drive (use with caution - we prefer trash)
   */
  async deleteFile(driveId: string, path: string): Promise<void> {
    const encodedPath = this.encodePath(path);
    await this.request({
      url: `${this.baseUrl}/drives/${driveId}/files/${encodedPath}`,
      method: 'DELETE'
    });
  }

  /**
   * Move file to trash prefix (soft delete)
   */
  async moveToTrash(driveId: string, path: string): Promise<void> {
    // here.now doesn't have native trash, so we rename with prefix
    const trashPath = `.trash/${path}`;
    // Note: This requires a move/rename API endpoint
    // For MVP, we skip remote trash and rely on local trash only
    console.log(`🗑️ Remote trash not implemented: ${path} → ${trashPath}`);
  }
}