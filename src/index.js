const MANIFEST_CONTENT_TYPES = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
];

const DEFAULT_REQUEST_HEADERS = {
  Accept: "*/*",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
};

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

function parseHeaders(input) {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
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

function makeResponseHeaders(upstream, manifest) {
  const headers = new Headers(CORS_HEADERS);

  upstream.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      normalized === "content-encoding" ||
      normalized === "transfer-encoding" ||
      normalized === "access-control-allow-origin" ||
      normalized === "access-control-expose-headers"
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

async function proxyStream(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return text("Method not allowed", { status: 405 });
  }

  const requestUrl = new URL(request.url);
  const targetUrl = requestUrl.searchParams.get("url");
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
      headers: makeResponseHeaders(upstream, manifest),
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
      rewriteManifest(bodyText, upstream.url || targetUrl, requestUrl, configuredHeaders),
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: makeResponseHeaders(upstream, true),
      },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: makeResponseHeaders(upstream, false),
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

    return text("Not found", { status: 404 });
  },
};
