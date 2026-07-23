import {
  downloadDriveFile,
  exportTargetForFile,
  listDriveFiles,
  refreshAccessToken,
  type DriveFile,
} from "../lib/gdrive";
import {
  registerSourceDefinition,
  type Source,
  type SourceConfig,
  type SourceFile,
  type SourceFactoryOptions,
} from "../lib/source";

type GdriveSourceConfig = SourceConfig & {
  refreshToken: string;
  folderId?: string;
};

function toSourceFile(file: DriveFile): SourceFile {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    md5Checksum: file.md5Checksum,
    modifiedTime: file.modifiedTime,
    size: file.size ? Number(file.size) : undefined,
  };
}

class GoogleDriveSource implements Source {
  readonly config: GdriveSourceConfig;
  private readonly env?: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private accessToken?: Promise<string>;

  constructor(config: SourceConfig, options?: SourceFactoryOptions) {
    this.config = config as GdriveSourceConfig;
    this.env = options?.env;
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  private getAccessToken() {
    this.accessToken ??= refreshAccessToken(this.config.refreshToken, { env: this.env, fetchImpl: this.fetchImpl });
    return this.accessToken;
  }

  async listFiles(): Promise<SourceFile[]> {
    if (!this.config.folderId?.trim()) throw new Error("Google Drive folder ID is not configured.");
    const accessToken = await this.getAccessToken();
    const files = await listDriveFiles({
      folderId: this.config.folderId,
      accessToken,
      fetchImpl: this.fetchImpl,
    });
    return files.map(toSourceFile);
  }

  async fetchFile(file: SourceFile): Promise<{ body: ArrayBuffer; contentType: string; filename: string }> {
    const accessToken = await this.getAccessToken();
    const driveFile: DriveFile = {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType ?? "application/octet-stream",
      md5Checksum: file.md5Checksum,
      modifiedTime: file.modifiedTime,
      size: file.size !== undefined ? String(file.size) : undefined,
    };
    const body = await downloadDriveFile({ file: driveFile, accessToken, fetchImpl: this.fetchImpl });
    const target = exportTargetForFile(driveFile);
    return {
      body,
      contentType: target?.mimeType ?? "application/octet-stream",
      filename: target?.filename ?? file.name,
    };
  }
}

registerSourceDefinition({
  type: "google-drive",
  secretKeys: ["refreshToken"],
  validate(config) {
    if (typeof config.refreshToken !== "string" || !config.refreshToken) throw new Error("Google Drive refresh token is required.");
    if (config.folderId !== undefined && typeof config.folderId !== "string") throw new Error("Google Drive folder ID must be a string.");
  },
  create: (config, options) => new GoogleDriveSource(config, options),
});
