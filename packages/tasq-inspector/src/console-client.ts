/** Small dependency-free client for bounded filtering, live invalidation and support preview. */
export const CONSOLE_JS = `
(() => {
  "use strict";

  const query = document.querySelector("#record-query");
  const state = document.querySelector("#record-state");
  const result = document.querySelector("#filter-result");
  const rows = Array.from(document.querySelectorAll("[data-filter-row]"));
  const applyFilter = () => {
    const needle = (query?.value || "").trim().toLowerCase();
    const wantedState = state?.value || "";
    let visible = 0;
    for (const row of rows) {
      const matchesText = !needle || (row.dataset.filterText || "").includes(needle);
      const matchesState = !wantedState || row.dataset.filterState === wantedState;
      row.hidden = !(matchesText && matchesState);
      if (!row.hidden) visible++;
    }
    if (result) result.textContent = "Showing " + visible + " of " + rows.length + " loaded records.";
  };
  query?.addEventListener("input", applyFilter);
  state?.addEventListener("change", applyFilter);

  const liveStatus = document.querySelector("#live-status");
  const refresh = document.querySelector("#refresh-view");
  const setLive = (value, label) => {
    if (!liveStatus) return;
    liveStatus.dataset.state = value;
    liveStatus.textContent = label;
  };
  refresh?.addEventListener("click", () => location.reload());
  const markStale = () => {
    setLive("stale", "Changes available");
    if (refresh) refresh.hidden = false;
  };

  let cursor = document.body.dataset.liveCursor || "";
  let source = null;
  let intentionalClose = false;

  const connect = () => {
    intentionalClose = false;
    setLive("connecting", "Connecting");
    source = new EventSource("/api/console/stream?cursor=" + encodeURIComponent(cursor));
    source.addEventListener("open", () => setLive("connected", "Live connection"));
    source.addEventListener("changes", (event) => {
      if (event.lastEventId) cursor = event.lastEventId;
      markStale();
    });
    source.addEventListener("gap", () => {
      intentionalClose = true;
      source?.close();
      setLive("gap", "History gap. Refresh required");
      if (refresh) refresh.hidden = false;
    });
    source.addEventListener("overflow", async (event) => {
      intentionalClose = true;
      source?.close();
      setLive("catching-up", "Catching up with polling");
      try {
        const envelope = JSON.parse(event.data);
        cursor = envelope.recovery.cursor;
        while (true) {
          const response = await fetch("/api/console/events?limit=100&cursor=" + encodeURIComponent(cursor), {
            headers: { Accept: "application/json" },
          });
          if (!response.ok) throw new Error("Polling recovery returned HTTP " + response.status);
          const batch = await response.json();
          cursor = batch.nextCursor;
          if (!batch.hasMore) break;
        }
        markStale();
        connect();
      } catch (error) {
        setLive("disconnected", "Recovery failed. Refresh required");
        if (refresh) refresh.hidden = false;
      }
    });
    source.addEventListener("error", () => {
      if (!intentionalClose) setLive("disconnected", "Disconnected. Retrying");
    });
  };
  if (cursor && "EventSource" in window) connect();
  else setLive("disconnected", "Live transport unavailable");

  const previewButton = document.querySelector("#preview-support");
  const preview = document.querySelector("#support-preview");
  const previewCode = preview?.querySelector("pre");
  const download = document.querySelector("#download-support");
  const supportError = document.querySelector("#support-error");
  let supportObjectUrl = null;
  previewButton?.addEventListener("click", async () => {
    previewButton.disabled = true;
    previewButton.textContent = "Building preview";
    if (supportError) supportError.hidden = true;
    if (download) download.hidden = true;
    try {
      const response = await fetch("/api/console/support-bundle", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Support preview returned HTTP " + response.status);
      const bundle = await response.json();
      const reviewedJson = JSON.stringify(bundle, null, 2) + "\\n";
      if (previewCode) previewCode.textContent = reviewedJson;
      if (preview) preview.hidden = false;
      if (download) {
        if (supportObjectUrl) URL.revokeObjectURL(supportObjectUrl);
        supportObjectUrl = URL.createObjectURL(new Blob([reviewedJson], { type: "application/json" }));
        download.href = supportObjectUrl;
        download.hidden = false;
      }
      previewButton.textContent = "Refresh preview";
    } catch (error) {
      if (supportError) {
        supportError.textContent = error instanceof Error ? error.message : "Support preview failed.";
        supportError.hidden = false;
      }
      previewButton.textContent = "Retry preview";
    } finally {
      previewButton.disabled = false;
    }
  });
  addEventListener("pagehide", () => {
    if (supportObjectUrl) URL.revokeObjectURL(supportObjectUrl);
  }, { once: true });
})();
`;
