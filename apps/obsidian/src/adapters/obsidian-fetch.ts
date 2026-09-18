import { requestUrl, type RequestUrlParam } from "obsidian";

export function createObsidianFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    let body: string | ArrayBuffer | undefined;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof ArrayBuffer) body = init.body;
    else if (init?.body instanceof Uint8Array) {
      const copy = new Uint8Array(init.body.byteLength);
      copy.set(init.body);
      body = copy.buffer;
    }
    else if (init?.body instanceof Blob) body = await init.body.arrayBuffer();
    const param: RequestUrlParam = { url, method, headers, body, throw: false };
    const res = await requestUrl(param);
    return new Response(res.arrayBuffer, {
      status: res.status,
      headers: res.headers,
    });
  };
}
