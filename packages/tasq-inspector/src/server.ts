import {
  CONSOLE_STREAM_ENVELOPE_CONTRACT_VERSION,
  ConsoleSection,
  ConsoleStreamEnvelope as ConsoleStreamEnvelopeSchema,
  TaskStatus,
  UuidV7,
  type Clock,
  type ConsoleEventBatch,
  type ConsoleStreamEnvelope,
  type TaskStatus as TaskStatusT,
} from "@tasq/schema";
import {
  buildConsoleEventBatch,
  buildConsoleHealth,
  buildConsoleOverview,
  buildConsolePage,
  buildInspectorIndex,
  ConsoleLiveCursorError,
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
import { systemConsoleScheduler, type ConsoleScheduler } from "./scheduler.js";

export interface TasqInspectorHandlerOptions {
  db: TasqDb;
  workspaceId: string;
  clock: Clock;
  scheduler?: ConsoleScheduler;
  livePollIntervalMs?: number;
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

function streamResponse(body: ReadableStream<Uint8Array> | null): Response {
  const headers = inspectorSecurityHeaders("text/event-stream; charset=utf-8");
  headers.set("X-Accel-Buffering", "no");
  return new Response(body, { status: 200, headers });
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

function parseLiveCursor(request: Request, url: URL): string | null {
  const query = url.searchParams.get("cursor");
  const header = request.headers.get("Last-Event-ID");
  if (query && header && query !== header) {
    throw new Error("console live cursor conflicts with Last-Event-ID");
  }
  const cursor = query || header || null;
  if (cursor && cursor.length > 2048) throw new Error("console live cursor is too long");
  return cursor;
}

function livePollInterval(value: number | undefined): number {
  const interval = value ?? 1_000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000) {
    throw new Error("livePollIntervalMs must be between 1 and 60000");
  }
  return interval;
}

function encodeSse(kind: ConsoleStreamEnvelope["kind"], envelope: ConsoleStreamEnvelope, cursor?: string): Uint8Array {
  const lines = [
    ...(cursor ? [`id: ${cursor}`] : []),
    `event: ${kind}`,
    `data: ${JSON.stringify(envelope)}`,
    "",
    "",
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

function batchEnvelope(batch: ConsoleEventBatch): ConsoleStreamEnvelope {
  if (batch.hasMore) {
    return ConsoleStreamEnvelopeSchema.parse({
      contractVersion: CONSOLE_STREAM_ENVELOPE_CONTRACT_VERSION,
      workspaceId: batch.workspaceId,
      kind: "overflow",
      batch,
      recovery: {
        transport: "poll",
        href: "/api/console/events",
        cursor: batch.nextCursor,
      },
    });
  }
  return ConsoleStreamEnvelopeSchema.parse({
    contractVersion: CONSOLE_STREAM_ENVELOPE_CONTRACT_VERSION,
    workspaceId: batch.workspaceId,
    kind: batch.mode,
    batch,
  });
}

function createConsoleEventStream(options: {
  db: TasqDb;
  workspaceId: string;
  clock: Clock;
  scheduler: ConsoleScheduler;
  pollIntervalMs: number;
  limit: number;
  initial: ConsoleEventBatch;
  signal: AbortSignal;
  onError?: (error: unknown) => void;
}): ReadableStream<Uint8Array> {
  let cursor = options.initial.nextCursor;
  let initial: ConsoleEventBatch | null = options.initial;
  let ended = false;
  const streamAbort = new AbortController();
  if (options.signal.aborted) streamAbort.abort();
  else options.signal.addEventListener("abort", () => streamAbort.abort(), { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ended) return;
      let batch: ConsoleEventBatch;
      if (initial) {
        batch = initial;
        initial = null;
      } else {
        await options.scheduler.wait(options.pollIntervalMs, streamAbort.signal);
        if (ended || streamAbort.signal.aborted) {
          ended = true;
          controller.close();
          return;
        }
        try {
          batch = await buildConsoleEventBatch(options.db, {
            workspaceId: options.workspaceId,
            clock: options.clock,
            cursor,
            limit: options.limit,
          });
        } catch (error) {
          if (error instanceof ConsoleLiveCursorError) {
            const envelope = ConsoleStreamEnvelopeSchema.parse({
              contractVersion: CONSOLE_STREAM_ENVELOPE_CONTRACT_VERSION,
              workspaceId: options.workspaceId,
              kind: "gap",
              problem: error.problem,
            });
            controller.enqueue(encodeSse("gap", envelope));
            ended = true;
            controller.close();
            return;
          }
          options.onError?.(error);
          controller.error(error);
          return;
        }
      }
      cursor = batch.nextCursor;
      if (batch.returned === 0 && batch.mode === "changes") {
        // A comment keeps intermediaries alive without inventing a timestamp
        // or an authoritative client-side freshness state.
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        return;
      }
      const envelope = batchEnvelope(batch);
      controller.enqueue(encodeSse(envelope.kind, envelope, batch.nextCursor));
      if (envelope.kind === "overflow") {
        ended = true;
        controller.close();
      }
    },
    cancel() {
      ended = true;
      streamAbort.abort();
    },
  }, { highWaterMark: 1 });
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
  const scheduler = options.scheduler ?? systemConsoleScheduler;
  const pollIntervalMs = livePollInterval(options.livePollIntervalMs);
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
      if (pathname === "/api/console/events") {
        try {
          return finalize(json(await buildConsoleEventBatch(options.db, {
            workspaceId,
            now: requestNow,
            cursor: parseLiveCursor(request, url),
            limit: parseLimit(url.searchParams.get("limit")),
          }), 200, head));
        } catch (error) {
          if (error instanceof ConsoleLiveCursorError) {
            return finalize(json({ error: error.problem }, 409, head));
          }
          throw error;
        }
      }
      if (pathname === "/api/console/stream") {
        const cursor = parseLiveCursor(request, url);
        const limit = parseLimit(url.searchParams.get("limit"));
        try {
          const initial = await buildConsoleEventBatch(options.db, {
            workspaceId,
            now: requestNow,
            cursor,
            limit,
          });
          return finalize(streamResponse(head ? null : createConsoleEventStream({
            db: options.db,
            workspaceId,
            clock: options.clock,
            scheduler,
            pollIntervalMs,
            limit,
            initial,
            signal: request.signal,
            onError: options.onError,
          })));
        } catch (error) {
          if (error instanceof ConsoleLiveCursorError) {
            return finalize(json({ error: error.problem }, 409, head));
          }
          throw error;
        }
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
