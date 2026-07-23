{ pkgs, ... }:

{
  packages = [
    pkgs.ffmpeg
  ];

  languages.javascript = {
    enable = true;
    bun.enable = true;
  };
}
