/** Small dependency-free client for bounded filtering, live invalidation and support preview. */
export const CONSOLE_JS = `
(() => {
  "use strict";

  const query = document.querySelector("#record-query");
  const state = document.querySelector("#record-state");
  const result = document.querySelector("#filter-result");
  // Re-queried rather than captured once: the record list is replaced in place
  // when the live feed reports a change, and a captured array would keep
  // filtering rows that are no longer on the page.
  let rows = Array.from(document.querySelectorAll("[data-filter-row]"));
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
  const markStale = (label) => {
    setLive("stale", label || "Changes available");
    if (refresh) refresh.hidden = false;
  };

  /**
   * Bring the records up to date without asking a human to press a button.
   *
   * The feed deliberately strips payloads, so the client knows THAT something
   * changed and never WHAT - it cannot rebuild a row from the event. So it
   * re-fetches this exact view and swaps the record list, which is also why
   * the filter inputs live outside the swapped container: a refresh that
   * discards what someone typed is a refresh they stop trusting.
   *
   * On failure it degrades to the old behaviour rather than pretending: a
   * stale badge and a button that reloads.
   */
  let refreshing = false;
  const refreshRecords = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const response = await fetch(location.href, { headers: { Accept: "text/html" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
      const fresh = parsed.querySelector("#record-results");
      const target = document.querySelector("#record-results");
      if (!fresh || !target) throw new Error("record list not found");
      target.innerHTML = fresh.innerHTML;
      rows = Array.from(document.querySelectorAll("[data-filter-row]"));
      applyFilter();
      setLive("connected", "Live connection");
      if (refresh) refresh.hidden = true;
    } catch {
      markStale("Changes available");
    } finally {
      refreshing = false;
    }
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
      void refreshRecords();
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
        // Caught up on the cursor; bring the records with it rather than
        // leaving a badge behind after a recovery that succeeded.
        await refreshRecords();
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
