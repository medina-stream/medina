import type React from "react";
import Feather from "@react-native-vector-icons/feather";

export type MedinaIconName =
  | "account"
  | "home"
  | "menu"
  | "record"
  | "stop"
  | "play"
  | "pause"
  | "more"
  | "transcripts"
  | "settings"
  | "setup"
  | "upload"
  | "mic"
  | "events"
  | "refresh"
  | "bell"
  | "check"
  | "chevronRight"
  | "chevronLeft"
  | "folder"
  | "hardDrive"
  | "cloud"
  | "plus"
  | "trash"
  | "skipBack"
  | "skipForward"
  | "close";

type IconProps = {
  name: MedinaIconName;
  size?: number;
  color?: string;
};

type FeatherName = React.ComponentProps<typeof Feather>["name"];

const featherNames: Record<MedinaIconName, FeatherName> = {
  account: "user",
  home: "home",
  menu: "menu",
  record: "circle",
  stop: "square",
  play: "play",
  pause: "pause",
  more: "more-horizontal",
  transcripts: "book-open",
  settings: "settings",
  setup: "sliders",
  upload: "upload-cloud",
  mic: "mic",
  events: "activity",
  refresh: "refresh-cw",
  bell: "bell",
  check: "check",
  chevronRight: "chevron-right",
  chevronLeft: "chevron-left",
  folder: "folder",
  hardDrive: "hard-drive",
  cloud: "cloud",
  plus: "plus",
  trash: "trash-2",
  skipBack: "skip-back",
  skipForward: "skip-forward",
  close: "x",
};

export function Icon({ name, size = 20, color = "#fff" }: IconProps) {
  return <Feather name={featherNames[name]} size={size} color={color} />;
}
