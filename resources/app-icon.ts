import { defineImageResource } from "../lib/image";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Medina">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#1e1b4b"/>
      <stop offset="0.54" stop-color="#5b21b6"/>
      <stop offset="1" stop-color="#0f766e"/>
    </linearGradient>
    <linearGradient id="m" x1="0.1" x2="0.9" y1="0.2" y2="0.85">
      <stop offset="0" stop-color="#f8fafc"/>
      <stop offset="1" stop-color="#c4b5fd"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <path d="M218 748V306c0-34 40-51 64-27l230 230 230-230c24-24 64-7 64 27v442h-128V501L548 631c-20 20-52 20-72 0L346 501v247H218Z" fill="url(#m)"/>
  <path d="M196 778c116-46 220-59 312-40 114 24 209 9 322-51" fill="none" stroke="#67e8f9" stroke-width="42" stroke-linecap="round" opacity="0.42"/>
</svg>`;

const MONOCHROME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Medina">
  <path d="M218 748V306c0-34 40-51 64-27l230 230 230-230c24-24 64-7 64 27v442h-128V501L548 631c-20 20-52 20-72 0L346 501v247H218Z" fill="#000"/>
</svg>`;

export const appIconResource = defineImageResource({
  name: "app-icon",
  prompt: 'Big "M" with abstract wave texture, purple-leaning palette',
  content: ICON_SVG,
  background: "#1e1b4b",
  outputs: [
    { key: "icon.svg", contentType: "image/svg+xml" },
    { key: "icon-monochrome.svg", contentType: "image/svg+xml", content: MONOCHROME_SVG },
    { key: "icon-192.png", contentType: "image/png", size: 192 },
    { key: "icon-512.png", contentType: "image/png", size: 512 },
    { key: "icon-maskable-192.png", contentType: "image/png", size: 192, variant: "maskable" },
    { key: "icon-maskable-512.png", contentType: "image/png", size: 512, variant: "maskable" },
    { key: "apple-touch-icon.png", contentType: "image/png", size: 180, variant: "maskable" },
  ],
});

export const appIconOutputs = appIconResource.map((entry) => ({
  contentType: entry.output.contentType,
  definition: entry.definition,
  outputKey: entry.outputKey,
  route: `/${entry.route}`,
}));
