/** upstream 메모리 캐시 hit → Express JSON/XML 응답 */

export function sendUpstreamCacheHit(res, cacheProbe) {
  if (!cacheProbe.hit) return false;
  res.setHeader("X-Nexvia-Cache", "hit");
  const rawText =
    typeof cacheProbe.data === "string" ? cacheProbe.data : String(cacheProbe.data ?? "");
  res.status(cacheProbe.status);
  if (cacheProbe.contentType.includes("json") || rawText.trim().startsWith("{")) {
    try {
      res.json(JSON.parse(rawText));
    } catch {
      res.type("application/json").send(rawText);
    }
    return true;
  }
  if (cacheProbe.contentType.includes("xml")) {
    res.type("application/xml");
  }
  res.send(cacheProbe.data);
  return true;
}
