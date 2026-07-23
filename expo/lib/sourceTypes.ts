import type { MedinaIconName } from "../components/Icon";
import { connectGoogleUrl, type SourceConfig } from "./medina";

export type SourceFieldDef = {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
};

export type SourceTypeDef = {
  type: string;
  label: string;
  icon: MedinaIconName;
  editable: boolean;
  fields: SourceFieldDef[];
  subtitle: (source: SourceConfig) => string;
  connect?: {
    label: string;
    reconnectLabel: string;
    help: string;
    url: (source?: SourceConfig) => string;
  };
};

const sourceTypes: Record<string, SourceTypeDef> = {
  "google-drive": {
    type: "google-drive",
    label: "Google Drive",
    icon: "cloud",
    editable: true,
    fields: [
      {
        key: "folderId",
        label: "Folder ID",
        placeholder: "Google Drive folder ID",
        help: "The ID from the folder URL: drive.google.com/drive/folders/<ID>",
      },
    ],
    subtitle: (source) => source.account || (source.folderId ? `Folder ${source.folderId}` : "Not connected"),
    connect: {
      label: "Connect Google Drive",
      reconnectLabel: "Reconnect Google Drive",
      help: "Grants read-only Drive access. Opens Google consent in a new tab.",
      url: (source) => connectGoogleUrl(source ? { sourceId: source.id } : {}),
    },
  },
  filesystem: {
    type: "filesystem",
    label: "Filesystem",
    icon: "hardDrive",
    editable: false,
    fields: [
      {
        key: "path",
        label: "Path",
        help: "Configured by the Medina instance operator.",
      },
    ],
    subtitle: (source) => source.path || "No path configured",
  },
};

export function getSourceTypeDef(type: string): SourceTypeDef {
  return sourceTypes[type] ?? {
    type,
    label: type,
    icon: "folder",
    editable: false,
    fields: [],
    subtitle: () => "Managed by the Medina instance",
  };
}

export function addableSourceTypes(): SourceTypeDef[] {
  return Object.values(sourceTypes).filter((def) => def.connect !== undefined);
}
