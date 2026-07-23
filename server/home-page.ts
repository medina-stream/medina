import { getRequestPublicBase } from "./public-base";
import { renderMarkdownDocument } from "./markdown";

type HomeInfo = {
  agentsUrl: string;
  endpoint: string;
  ownerName: string;
  tokenHelp: string;
};

export function createHomeInfo(baseUrl: string): HomeInfo {
  return {
    agentsUrl: `${baseUrl}/agents.md`,
    endpoint: process.env.MEDINA_ROOT?.trim() || baseUrl,
    ownerName: "Scott Raymond",
    tokenHelp: "Ask the server owner for the token or look in the local Medina deployment config.",
  };
}

function interpolate(markdown: string, info: HomeInfo) {
  return markdown.replace(/{{(\w+)}}/g, (_, key: keyof HomeInfo) => info[key] ?? "");
}

export function createHomeHtml(markdown: string, info: HomeInfo) {
  return renderMarkdownDocument(interpolate(markdown, info), { title: "Medina" });
}

export async function serveHomePage(req: Request) {
  const markdown = await Bun.file("./docs/home.md").text();
  return new Response(createHomeHtml(markdown, createHomeInfo(getRequestPublicBase(req))), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
