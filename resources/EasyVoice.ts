export type Source = {
  name: string;
  provider: "gdrive";
  folderId: string;
};

export function EasyVoice(env: Env): Source {
  return { name: "easy-voice", provider: "gdrive", folderId: env.GDRIVE_FOLDER_ID };
}
