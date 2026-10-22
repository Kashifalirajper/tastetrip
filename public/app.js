const $ = (s) => document.querySelector(s);
const form = $("#trip-form");
const go = $("#go");
const errBox = $("#form-error");

const PRESETS = [
  { destination: "Tokyo", days: "3", music: "Radiohead, Khruangbin", film: "Lost in Translation", books: "Haruki Murakami", food: "ramen, specialty coffee", vibe: "late-night, record stores, hidden bars", budget: "Mid-range" },
  { destination: "Paris", days: "2", music: "Daft Punk", film: "Amélie, Before Sunset", books: "", food: "natural wine, bistro", vibe: "cinematic, classic, romantic", budget: "Splurge" },
  { destination: "Lisbon", days: "2", music: "", film: "", books: "Fernando Pessoa, Sally Rooney", food: "seafood, pastries", vibe: "cozy bookshops and viewpoints", budget: "Budget" },
];

document.querySelectorAll("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => {
    const p = PRESETS[Number(b.dataset.preset)];
    for (const [k, v] of Object.entries(p)) form.elements[k].value = v;
    form.elements.destination.focus();
  }),
);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (o) => {
  const s = JSON.stringify(o ?? {});
  return s.length > 220 ? s.slice(0, 220) + "…" : s;
};
const pct = (a) => (typeof a === "number" ? Math.round(Math.max(0, Math.min(1, a)) * 100) : null);

function show(id, on) { $(id).hidden = !on; }

let evidence = [];

function logItem(html) {
  const li = document.createElement("li");
  li.innerHTML = html;
  $("#log").appendChild(li);
  li.scrollIntoView({ block: "nearest" });
  return li;
}

function renderToolResult(ev) {
  const okish = ["ok", "partial", "degraded"].includes(ev.status);
  const tops = (ev.top ?? []).map((t) => `${esc(t.name)}${pct(t.affinity) !== null ? ` (${pct(t.affinity)}%)` : ""}`).join(", ");
  return `<span class="tool">${esc(ev.tool)}</span><span class="pill ${okish ? "ok" : "bad"}">${esc(ev.status)}${ev.cached ? " · cached" : ""}</span>
    <div class="args">${esc(short(ev.args))}</div>
    <div class="tops">${esc(ev.summary ?? "")}${tops ? `<br><strong>Top:</strong> ${tops}` : ""}</div>
    ${ev.error ? `<div class="args">${esc(ev.error.code)}: ${esc(ev.error.recovery)}</div>` : ""}`;
}

function renderPlan(plan, input) {
  const g = plan.grounding ?? { verified: 0, total: 0 };
  const days = (plan.days ?? []).map((d) => `
    <section class="panel day">
      <h3>Day ${esc(d.day)} <small>${esc(d.theme)}</small></h3>
      <ol class="stops">
        ${(d.stops ?? []).map((s) => {
          const q = s.qloo;
          const p = q ? pct(q.affinity) : null;
          const mapQ = encodeURIComponent(`${s.name} ${q?.address ?? input.destination}`);
          return `<li class="stop">
            <div class="when">${esc(s.time)}</div>
            <div>
              <div class="stop-name">${esc(s.name)} <span class="cat">· ${esc(s.category)}</span></div>
              <p class="why">${esc(s.why)}</p>
              <div class="meta">
                ${q
                  ? `<span class="pill ok">From Qloo</span>${p !== null ? `<span class="aff">Affinity <span class="bar"><i style="width:${p}%"></i></span> ${p}%</span>` : ""}`
                  : `<span class="pill bad">Not verified by Qloo</span>`}
                ${q?.address ? `<span>${esc(q.address)}</span>` : ""}
                <a class="map" href="https://www.google.com/maps/search/?api=1&query=${mapQ}" target="_blank" rel="noopener">Map ↗</a>
              </div>
            </div>
          </li>`;
        }).join("")}
      </ol>
    </section>`).join("");

  $("#plan").innerHTML = `
    <section class="panel plan-head">
      <h2>${esc(plan.title)}</h2>
      <p>${esc(plan.summary)}</p>
      <div class="chips">${(plan.taste_profile ?? []).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
      ${plan.base_neighborhood ? `<div class="base"><strong>Stay near: ${esc(plan.base_neighborhood.name)}</strong>${esc(plan.base_neighborhood.why)}</div>` : ""}
      <div class="grounding">${g.verified} of ${g.total} stops verified against live Qloo results</div>
    </section>
    ${days}
    ${(plan.limitations ?? []).length ? `<section class="panel limits"><strong>Limitations</strong><ul>${plan.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></section>` : ""}`;
}

function renderEvidence() {
  $("#evidence-list").innerHTML = evidence.map((e) => `<li>${renderToolResult(e)}</li>`).join("");
  $("#evidence-count").textContent = `(${evidence.length} Qloo call${evidence.length === 1 ? "" : "s"})`;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errBox.hidden = true;
  const input = Object.fromEntries(new FormData(form).entries());
  if (!input.destination.trim()) return fail("Please enter a destination city.");
  if (![input.music, input.film, input.books, input.food].some((v) => v.trim())) return fail("Add at least one favorite: music, film/TV, books or food.");

  go.disabled = true;
  go.textContent = "Planning…";
  evidence = [];
  $("#log").innerHTML = "";
  show("#empty", false);
  show("#plan", false);
  show("#evidence", false);
  show("#progress", true);
  $("#status-text").textContent = "Starting the agent…";

  try {
    const res = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let done = false;
    const pending = new Map();
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (!ev || !data) continue;
        const payload = JSON.parse(data);
        if (ev === "status") $("#status-text").textContent = payload.message;
        else if (ev === "tool_call") {
          const li = logItem(`<span class="tool">${esc(payload.tool)}</span> <span class="args">${esc(short(payload.args))}</span>`);
          pending.set(payload.tool + JSON.stringify(payload.args), li);
        } else if (ev === "tool_result") {
          evidence.push(payload);
          const key = payload.tool + JSON.stringify(payload.args);
          const li = pending.get(key);
          if (li) { li.innerHTML = renderToolResult(payload); pending.delete(key); }
          else logItem(renderToolResult(payload));
        } else if (ev === "plan") {
          renderPlan(payload, input);
          renderEvidence();
          show("#progress", false);
          show("#plan", true);
          show("#evidence", true);
          $("#plan").scrollIntoView({ behavior: "smooth", block: "start" });
          done = true;
        } else if (ev === "error") {
          throw new Error(payload.message);
        }
      }
    }
    if (!done) throw new Error("The connection closed before the plan was ready. Please try again.");
  } catch (err) {
    show("#progress", false);
    if ($("#plan").hidden) show("#empty", true);
    fail(err.message);
  } finally {
    go.disabled = false;
    go.textContent = "Plan my trip";
  }
});

function fail(msg) {
  errBox.textContent = msg;
  errBox.hidden = false;
}
