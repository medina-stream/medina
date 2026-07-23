export function getRequestPublicBase(input: Request | { req: { raw: Request; url: string } }) {
  const req = input instanceof Request ? input : input.req.raw;
  const requestUrl = input instanceof Request ? input.url : input.req.url;
  const url = new URL(requestUrl);
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const host = forwardedHost || req.headers.get("host") || url.host;
  url.host = host;
  url.protocol = forwardedProto ? `${forwardedProto}:` : url.protocol;
  return url.origin;
}
