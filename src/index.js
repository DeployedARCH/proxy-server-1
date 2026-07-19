const MANIFEST_CONTENT_TYPES = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
];

const DEFAULT_REQUEST_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
};

const BROWSER_FETCH_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "cross-site",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
};

const COOKIE_JAR_NAME = "__basement_proxy_cookie_jar";
const MAX_COOKIE_JAR_AGE = 60 * 60 * 6;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

function text(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

function makeCorsHeaders(request) {
  return {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
  };
}

function parseHeaders(input) {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function encodeBase64Url(input) {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function parseRequestCookies(value) {
  return Object.fromEntries(
    (value ?? "")
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf("=");
        if (separatorIndex === -1) return [entry, ""];
        return [
          entry.slice(0, separatorIndex),
          entry.slice(separatorIndex + 1),
        ];
      }),
  );
}

function readCookieJar(request) {
  const cookie = parseRequestCookies(request.headers.get("Cookie"));
  const encoded = cookie[COOKIE_JAR_NAME];
  if (!encoded) return {};

  try {
    const parsed = JSON.parse(decodeBase64Url(encoded));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function serializeCookieJar(jar) {
  return `${COOKIE_JAR_NAME}=${encodeBase64Url(JSON.stringify(jar))}; Path=/; Max-Age=${MAX_COOKIE_JAR_AGE}; SameSite=None; Secure; HttpOnly`;
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;]+)/g).map((item) => item.trim());
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  return splitSetCookieHeader(headers.get("set-cookie"));
}

function mergeCookieHeader(existing, additions) {
  const cookies = new Map();
  for (const entry of splitSetCookieHeader(existing).join(";").split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    cookies.set(trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1));
  }

  for (const cookie of additions) {
    const pair = cookie.split(";", 1)[0]?.trim();
    if (!pair) continue;
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) continue;
    const name = pair.slice(0, separatorIndex);
    const value = pair.slice(separatorIndex + 1);
    if (/;\s*max-age=0(?:;|$)/i.test(cookie)) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }

  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function isManifestUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().includes(".m3u8");
  } catch {
    return false;
  }
}

function isManifestResponse(targetUrl, response) {
  const contentType = response.headers.get("content-type") || "";
  return (
    isManifestUrl(targetUrl) ||
    MANIFEST_CONTENT_TYPES.some((type) =>
      contentType.toLowerCase().includes(type),
    )
  );
}

function isValidManifestText(value) {
  return value.trimStart().startsWith("#EXTM3U");
}

function makeProxyUrl(requestUrl, targetUrl, headers) {
  const proxyUrl = new URL("/api/stream", requestUrl.origin);
  proxyUrl.searchParams.set("url", targetUrl);
  const headerEntries = Object.entries(headers ?? {}).filter(
    ([, value]) => value != null && value !== "",
  );
  if (headerEntries.length > 0) {
    proxyUrl.searchParams.set(
      "headers",
      JSON.stringify(Object.fromEntries(headerEntries)),
    );
  }
  return proxyUrl.toString();
}

function rewriteManifest(bodyText, manifestUrl, requestUrl, headers) {
  const rewriteUriAttribute = (line) =>
    line.replace(/URI="([^"]+)"/g, (match, uri) => {
      try {
        return `URI="${makeProxyUrl(
          requestUrl,
          new URL(uri, manifestUrl).toString(),
          headers,
        )}"`;
      } catch {
        return match;
      }
    });

  return bodyText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) return rewriteUriAttribute(line);

      try {
        return makeProxyUrl(
          requestUrl,
          new URL(trimmed, manifestUrl).toString(),
          headers,
        );
      } catch {
        return line;
      }
    })
    .join("\n");
}

function makeUpstreamHeaders(request, configuredHeaders) {
  const headers = new Headers(DEFAULT_REQUEST_HEADERS);

  for (const [key, value] of Object.entries(configuredHeaders ?? {})) {
    if (value != null && value !== "") headers.set(key, String(value));
  }

  for (const headerName of [
    "Range",
    "If-Range",
    "If-None-Match",
    "If-Modified-Since",
  ]) {
    const value = request.headers.get(headerName);
    if (value) headers.set(headerName, value);
  }

  return headers;
}

function makeResponseHeaders(upstream, manifest, request) {
  const headers = new Headers(makeCorsHeaders(request));

  upstream.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      normalized === "content-encoding" ||
      normalized === "transfer-encoding" ||
      normalized === "access-control-allow-origin" ||
      normalized === "access-control-expose-headers" ||
      normalized === "set-cookie"
    ) {
      return;
    }
    headers.set(key, value);
  });

  if (manifest) {
    headers.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    headers.delete("Content-Length");
    headers.delete("Content-Range");
  }

  return headers;
}

function getTargetParam(url) {
  return url.searchParams.get("destination") || url.searchParams.get("url");
}

function makeGenericRequestHeaders(configuredHeaders) {
  const headers = new Headers(DEFAULT_REQUEST_HEADERS);

  for (const [key, value] of Object.entries(configuredHeaders ?? {})) {
    if (value != null && value !== "") headers.set(key, String(value));
  }

  return headers;
}

function attachCookieJar(headers, cookieJar, targetHost) {
  if (hasHeaderCaseInsensitive(Object.fromEntries(headers.entries()), "Cookie")) {
    return;
  }
  const cookie = cookieJar[targetHost];
  if (cookie) headers.set("Cookie", cookie);
}

function deleteHeaderCaseInsensitive(headers, headerName) {
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase() === headerName.toLowerCase()) headers.delete(key);
  }
}

function hasHeaderCaseInsensitive(headers, headerName) {
  return Object.keys(headers ?? {}).some(
    (key) => key.toLowerCase() === headerName.toLowerCase(),
  );
}

function makeGenericRequestHeaderVariants(configuredHeaders) {
  const baseHeaders = makeGenericRequestHeaders(configuredHeaders);
  const browserHeaders = makeGenericRequestHeaders({
    ...BROWSER_FETCH_HEADERS,
    ...(configuredHeaders ?? {}),
  });
  const extensionLikeHeaders = new Headers(browserHeaders);

  deleteHeaderCaseInsensitive(extensionLikeHeaders, "Origin");
  deleteHeaderCaseInsensitive(extensionLikeHeaders, "Referer");

  const variants = [baseHeaders, browserHeaders, extensionLikeHeaders];
  const seen = new Set();

  return variants.filter((headers) => {
    const key = JSON.stringify([...headers.entries()].sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchWithHeaderFallbacks(
  targetUrl,
  request,
  configuredHeaders,
  body,
  cookieJar,
  targetHost,
) {
  const method = request.method.toUpperCase();
  const requestBody = method === "GET" || method === "HEAD" ? undefined : body;
  const variants = makeGenericRequestHeaderVariants(configuredHeaders);
  let lastResponse = null;

  for (const headers of variants) {
    attachCookieJar(headers, cookieJar, targetHost);
    const response = await fetch(targetUrl, {
      method,
      headers,
      body: requestBody,
      redirect: "follow",
    });

    if (response.status !== 403 && response.status !== 429) {
      return response;
    }

    lastResponse?.body?.cancel?.();
    lastResponse = response;
  }

  return lastResponse;
}

async function proxyRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: makeCorsHeaders(request) });
  }

  const requestUrl = new URL(request.url);
  const targetUrl = getTargetParam(requestUrl);
  if (!targetUrl) return text("Missing destination", { status: 400 });

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return text("Invalid destination", { status: 400 });
  }

  if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
    return text("Unsupported protocol", { status: 400 });
  }

  const configuredHeaders = parseHeaders(requestUrl.searchParams.get("headers"));
  const method = request.method.toUpperCase();
  const cookieJar = readCookieJar(request);
  const targetHost = parsedTarget.hostname;
  const contentType = request.headers.get("Content-Type");
  if (
    contentType &&
    method !== "GET" &&
    method !== "HEAD" &&
    !hasHeaderCaseInsensitive(configuredHeaders, "Content-Type")
  ) {
    configuredHeaders["Content-Type"] = contentType;
  }
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  const upstream = await fetchWithHeaderFallbacks(
    targetUrl,
    request,
    configuredHeaders,
    body,
    cookieJar,
    targetHost,
  );
  const upstreamCookies = getSetCookieHeaders(upstream.headers);
  if (upstreamCookies.length > 0) {
    cookieJar[targetHost] = mergeCookieHeader(cookieJar[targetHost], upstreamCookies);
  }
  const responseHeaders = makeResponseHeaders(upstream, false, request);
  if (upstreamCookies.length > 0) {
    responseHeaders.append("Set-Cookie", serializeCookieJar(cookieJar));
  }

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function proxyStream(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: makeCorsHeaders(request) });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return text("Method not allowed", { status: 405 });
  }

  const requestUrl = new URL(request.url);
  const targetUrl = getTargetParam(requestUrl);
  if (!targetUrl) return text("Missing url", { status: 400 });

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return text("Invalid url", { status: 400 });
  }

  if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
    return text("Unsupported protocol", { status: 400 });
  }

  const configuredHeaders = parseHeaders(requestUrl.searchParams.get("headers"));
  const upstreamHeaders = makeUpstreamHeaders(request, configuredHeaders);
  const cookieJar = readCookieJar(request);
  attachCookieJar(upstreamHeaders, cookieJar, parsedTarget.hostname);

  const upstream = await fetch(targetUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: upstreamHeaders,
    redirect: "follow",
  });
  const manifest = isManifestResponse(targetUrl, upstream);

  if (request.method === "HEAD") {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: makeResponseHeaders(upstream, manifest, request),
    });
  }

  if (manifest) {
    const bodyText = await upstream.text();
    if (!isValidManifestText(bodyText)) {
      return text(
        `Invalid HLS manifest from upstream (${upstream.status}): ${bodyText.slice(
          0,
          160,
        )}`,
        { status: 502 },
      );
    }

    return new Response(
      rewriteManifest(
        bodyText,
        upstream.url || targetUrl,
        requestUrl,
        configuredHeaders,
      ),
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: makeResponseHeaders(upstream, true, request),
      },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: makeResponseHeaders(upstream, false, request),
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, type: "basement-stream-proxy-worker" });
    }

    if (url.pathname === "/api/stream") {
      try {
        return await proxyStream(request);
      } catch (error) {
        return text(error?.message || "Proxy failed", { status: 502 });
      }
    }

    if (url.pathname === "/api/request") {
      try {
        return await proxyRequest(request);
      } catch (error) {
        return text(error?.message || "Proxy failed", { status: 502 });
      }
    }

    return text("Not found", { status: 404 });
  },
};
