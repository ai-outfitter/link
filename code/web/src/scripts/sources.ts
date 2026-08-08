// Client logic for the sources panel: register a source, trigger a rescan,
// reload when the new report is written.
const form = document.getElementById("add-source-form") as HTMLFormElement | null;
const input = document.getElementById("source-target") as HTMLInputElement | null;
const rescan = document.getElementById("rescan") as HTMLButtonElement | null;
const statusEl = document.getElementById("scan-status");

function setStatus(text: string) {
  if (statusEl) statusEl.textContent = text;
}

function setBusy(busy: boolean) {
  form?.querySelectorAll("button").forEach((b) => (b.disabled = busy));
}

async function scan() {
  setBusy(true);
  setStatus("scanning… (30–90s for github orgs)");
  try {
    const res = await fetch("/api/scan", { method: "POST" });
    const body = await res.json();
    if (!res.ok) {
      setStatus(`scan failed: ${body.output ?? res.status}`);
      return;
    }
    setStatus("done — reloading");
    location.reload();
  } catch (error) {
    setStatus(`scan failed: ${error}`);
  } finally {
    setBusy(false);
  }
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = input?.value.trim();
  if (!target) return;
  setBusy(true);
  setStatus(`adding ${target}…`);
  try {
    const res = await fetch("/api/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(`add failed: ${body.error ?? res.status}`);
      return;
    }
    if (input) input.value = "";
    await scan();
  } catch (error) {
    setStatus(`add failed: ${error}`);
  } finally {
    setBusy(false);
  }
});

rescan?.addEventListener("click", scan);
