import { ConsoleSection, TaskStatus, UuidV7, type Clock, type TaskStatus as TaskStatusT } from "@tasq/schema";
import {
  buildConsoleHealth,
  buildConsoleOverview,
  buildConsolePage,
  buildInspectorIndex,
  inspectCommitment,
  type TasqDb,
} from "@tasq/core";
import {
  INSPECTOR_CSS,
  renderCommitmentPage,
  renderInspectorError,
  renderInspectorIndex,
} from "./render.js";
import { isLoopbackHost } from "./loopback.js";

export interface TasqInspectorHandlerOptions {
  db: TasqDb;
  workspaceId: string;
  clock: Clock;
  onError?: (error: unknown) => void;
}

export function inspectorSecurityHeaders(contentType: string): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

function response(
  body: string,
  status: number,
  contentType: string,
  head: boolean,
  extra?: Record<string, string>,
): Response {
  const headers = inspectorSecurityHeaders(contentType);
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  return new Response(head ? null : body, { status, headers });
}

function json(body: unknown, status: number, head: boolean): Response {
  return response(JSON.stringify(body), status, "application/json; charset=utf-8", head);
}

function html(body: string, status: number, head: boolean): Response {
  return response(body, status, "text/html; charset=utf-8", head);
}

function errorResponse(pathname: string, status: number, code: string, message: string, head: boolean) {
  if (pathname.startsWith("/api/")) {
    return json({ error: { code, message } }, status, head);
  }
  return html(renderInspectorError(status, message), status, head);
}

function parseLimit(value: string | null): number {
  if (value == null) return 50;
  if (!/^\d+$/.test(value)) throw new Error("limit must be an integer between 1 and 100");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return limit;
}

function parseStatus(value: string | null): TaskStatusT | null {
  if (value == null || value === "") return null;
  const parsed = TaskStatus.safeParse(value);
  if (!parsed.success) throw new Error("status is not a supported commitment status");
  return parsed.data;
}

function parseQuery(value: string | null): string | null {
  if (value == null || value.trim() === "") return null;
  const query = value.trim();
  if (query.length > 200) throw new Error("query must be at most 200 characters");
  return query;
}

function commitmentId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const parsed = UuidV7.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

export function createTasqInspectorHandler(options: TasqInspectorHandlerOptions) {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) throw new Error("workspaceId must not be blank");
  return async (request: Request): Promise<Response> => {
    const requestNow = options.clock.now();
    const finalize = (result: Response): Response => {
      // Bun otherwise injects the device wall clock into the HTTP Date header.
      // Bind transport metadata to the same host-supplied instant as the read.
      result.headers.set("Date", new Date(requestNow).toUTCString());
      return result;
    };
    const head = request.method === "HEAD";
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (request.method !== "GET" && !head) {
      const denied = errorResponse(
        pathname,
        405,
        "method_not_allowed",
        "This surface is read-only. Only GET and HEAD are accepted.",
        false,
      );
      denied.headers.set("Allow", "GET, HEAD");
      return finalize(denied);
    }
    // A loopback socket alone does not stop DNS rebinding. Reject a foreign
    // Host-derived request URL before reading any workspace data.
    if (!isLoopbackHost(url.hostname)) {
      return finalize(errorResponse(
        pathname,
        421,
        "non_loopback_host",
        "Inspector requests must use a loopback hostname.",
        head,
      ));
    }
    try {
      if (pathname === "/assets/inspector.css") {
        return finalize(response(INSPECTOR_CSS, 200, "text/css; charset=utf-8", head));
      }
      if (pathname === "/" || pathname === "/api/index") {
        const snapshot = await buildInspectorIndex(options.db, {
          workspaceId,
          status: parseStatus(url.searchParams.get("status")),
          query: parseQuery(url.searchParams.get("q")),
          limit: parseLimit(url.searchParams.get("limit")),
          now: requestNow,
        });
        return finalize(pathname === "/api/index"
          ? json(snapshot, 200, head)
          : html(renderInspectorIndex(snapshot), 200, head));
      }
      if (pathname === "/api/console/overview") {
        return finalize(json(await buildConsoleOverview(options.db, {
          workspaceId,
          now: requestNow,
        }), 200, head));
      }
      if (pathname === "/api/console/health") {
        return finalize(json(await buildConsoleHealth(options.db, {
          workspaceId,
          now: requestNow,
        }), 200, head));
      }
      if (pathname.startsWith("/api/console/")) {
        const parsedSection = ConsoleSection.safeParse(pathname.slice("/api/console/".length));
        if (!parsedSection.success) {
          return finalize(errorResponse(pathname, 400, "invalid_console_section", "Console section is invalid.", head));
        }
        return finalize(json(await buildConsolePage(options.db, {
          workspaceId,
          section: parsedSection.data,
          limit: parseLimit(url.searchParams.get("limit")),
          cursor: url.searchParams.get("cursor"),
          now: requestNow,
        }), 200, head));
      }
      const apiId = commitmentId(pathname, "/api/commitments/");
      const pageId = commitmentId(pathname, "/commitments/");
      const id = apiId ?? pageId;
      if (id) {
        const snapshot = await inspectCommitment(options.db, id, {
          workspaceId,
          now: requestNow,
        });
        if (!snapshot) {
          return finalize(errorResponse(pathname, 404, "not_found", "Commitment not found in this workspace.", head));
        }
        return finalize(apiId
          ? json(snapshot, 200, head)
          : html(renderCommitmentPage(snapshot), 200, head));
      }
      if (pathname.startsWith("/api/commitments/") || pathname.startsWith("/commitments/")) {
        return finalize(errorResponse(pathname, 400, "invalid_commitment_id", "Commitment ID is invalid.", head));
      }
      return finalize(errorResponse(pathname, 404, "not_found", "Inspector route not found.", head));
    } catch (error) {
      options.onError?.(error);
      const message = error instanceof Error && (
        error.message.startsWith("limit ") || error.message.startsWith("query ") ||
        error.message.startsWith("status ") || error.message.startsWith("console ")
      ) ? error.message : "The inspector could not build this read projection.";
      const status = message === "The inspector could not build this read projection." ? 500 : 400;
      return finalize(errorResponse(pathname, status, status === 400 ? "invalid_request" : "internal_error", message, head));
    }
  };
}
