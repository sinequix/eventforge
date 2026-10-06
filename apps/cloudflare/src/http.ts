export function problem(
  status: number,
  code: string,
  detail: string,
  requestId = crypto.randomUUID(),
  extraHeaders?: HeadersInit,
): Response {
  return Response.json(
    { type: "about:blank", title: code, status, code, retryable: status >= 500, detail, requestId },
    {
      status,
      headers: { "content-type": "application/problem+json", ...extraHeaders },
    },
  );
}

export function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extraHeaders },
  });
}

export async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown; raw: string } | { ok: false; response: Response }> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes)
    return { ok: false, response: problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large.") };
  let raw: string;
  try {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            return {
              ok: false,
              response: problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large."),
            };
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      response: problem(400, "INVALID_JSON", "Request body must be valid JSON."),
    };
  }
  if (raw.length > maxBytes)
    return { ok: false, response: problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large.") };
  if (!raw.trim())
    return {
      ok: false,
      response: problem(400, "INVALID_JSON", "Request body must be valid JSON."),
    };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown, raw };
  } catch {
    return {
      ok: false,
      response: problem(400, "INVALID_JSON", "Request body must be valid JSON."),
    };
  }
}
