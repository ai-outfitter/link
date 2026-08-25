const panel = document.querySelector<HTMLElement>(".review-panel");
const select = document.getElementById("review-scan") as HTMLSelectElement | null;
const prepare = document.getElementById("prepare-review") as HTMLButtonElement | null;
const workspace = document.getElementById("review-workspace") as HTMLElement | null;
const status = document.getElementById("review-status");
const token = document.querySelector<HTMLMetaElement>('meta[name="link-request-token"]')?.content ?? "";
const mutationHeaders = { "content-type": "application/json", "x-link-request-token": token };

function ids() { const [scope, scan_id] = (select?.value ?? "|").split("|"); return { scope, scan_id }; }
function escape(value: string) { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }

async function load(scope: string, scan: string, review: string) {
  const response = await fetch(`/api/reviews?scope=${encodeURIComponent(scope)}&scan=${encodeURIComponent(scan)}&review=${encodeURIComponent(review)}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.status);
  renderLoaded(body, scope, scan, review);
}

function renderLoaded(body: any, scope: string, scan: string, review: string) {
  if (!workspace) return;
  workspace.hidden = false;
  if (body.status === "waiting") {
    workspace.insertAdjacentHTML("beforeend", `<p class="pending">Waiting for <code>${escape(body.review.result_path)}</code>. Run a command, then <button id="load-result">Load result</button></p>`);
    document.getElementById("load-result")?.addEventListener("click", () => load(scope, scan, review).catch(showError));
    return;
  }
  for (const score of body.scores ?? []) {
    const el = document.querySelector<HTMLElement>(`[data-reviewed-score="${CSS.escape(score.organization)}"]`);
    if (el) { el.textContent = String(score.reviewed_level); el.nextElementSibling!.textContent = `scanner ${score.scanner_level}`; }
  }
  const decisions = new Map((body.decisions ?? []).map((item: any) => [item.target, item.decision]));
  workspace.innerHTML = `<h3>Pending evidence claims</h3>${body.result.claims.map((claim: any) => `<article class="claim"><div><strong>${escape(claim.target)}</strong> <span class="badge">${escape(claim.scanner_status)} → ${escape(claim.proposed_status)}</span><p>${escape(claim.rationale)}</p><ul>${claim.evidence.map((e: any) => `<li><code>${escape(e.repository)}${e.path ? `/${escape(e.path)}` : ""}</code> — ${escape(e.observation)}</li>`).join("")}</ul></div><div class="claim-actions"><button data-target="${escape(claim.target)}" data-decision="accepted">Accept</button><button data-target="${escape(claim.target)}" data-decision="rejected">Reject</button><span>${escape(decisions.get(claim.target) ?? "pending")}</span></div></article>`).join("")}`;
  workspace.querySelectorAll<HTMLButtonElement>("[data-decision]").forEach((button) => button.addEventListener("click", async () => {
    const response = await fetch("/api/reviews", { method: "PATCH", headers: mutationHeaders, body: JSON.stringify({ scope, scan_id: scan, review_id: review, target: button.dataset.target, decision: button.dataset.decision }) });
    const next = await response.json(); if (!response.ok) throw new Error(next.error); renderLoaded(next, scope, scan, review);
  }));
}

function showError(error: unknown) { if (status) status.textContent = `Review error: ${error}`; }

prepare?.addEventListener("click", async () => {
  const { scope, scan_id } = ids();
  if (status) status.textContent = "Preparing…";
  try {
    const response = await fetch("/api/reviews", { method: "POST", headers: mutationHeaders, body: JSON.stringify({ scope, scan_id }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error ?? response.status);
    if (workspace) {
      workspace.hidden = false;
      workspace.innerHTML = `<div class="command-tabs"><h3>Copy one command</h3>${Object.entries(body.commands).map(([name, command]) => `<details ${name === "codex" ? "open" : ""}><summary>${escape(name)}</summary><pre><code>${escape(String(command))}</code></pre></details>`).join("")}<p class="warning">${escape(body.warning)}</p></div>`;
    }
    if (status) status.textContent = "Prepared";
    await load(scope, scan_id, body.review_id);
  } catch (error) { showError(error); }
});
