const token = document.querySelector('meta[name="dashboard-token"]').content;

const headers = { "x-dashboard-token": token };
const actionHeaders = { ...headers, "x-dashboard-action": "1", "content-type": "application/json" };

// ---- persistent UI state (survives 2s polls; never reset by a refresh) -----
let state = null;
let selectedId = null;
const selectedPhaseByIssue = new Map();
let scanAll = false;
let filter = "all";
let showCompletedPrs = false;
const collapsedCtx = new Set();
const openForms = new Set();       // `${issueId}:${phaseId}:approval|feedback`
const approvalDrafts = new Map();
const feedbackDrafts = new Map();
const expandedOutputs = new Set();
let lastInteractionAt = 0;
let loadedOnce = false;
let historyOpen = false;
let historyTab = "issues";
let historyPrFilter = "all";
let historyData = null; // { closedIssues: [] } fetched on demand

const density = localStorage.getItem("vb.density") === "cozy" ? "cozy" : "compact";
document.body.dataset.density = density;
if (localStorage.getItem("vb.leftCollapsed") === "1") document.body.classList.add("left-collapsed");
if (localStorage.getItem("vb.rightCollapsed") === "1") document.body.classList.add("right-collapsed");

const PHASE_SHORT = {
  requirements: "Reqs",
  spec: "Spec",
  "adversarial-review": "Adversarial",
  implementation: "Impl",
  "agent-pr-review": "PR review",
  verification: "Verify",
  finalization: "Finalize",
  "human-pr-review": "Human",
  "self-reflection": "Reflect",
};
const DONE = new Set(["complete", "approved", "local-approved", "recovered"]);

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
byId("refreshBtn").addEventListener("click", () => load());
byId("densityCompact").addEventListener("click", () => setDensity("compact"));
byId("densityCozy").addEventListener("click", () => setDensity("cozy"));
byId("helpBtn").addEventListener("click", () => byId("helpPopover").classList.toggle("hidden"));
byId("collapseLeft").addEventListener("click", () => toggleRail("left"));
byId("showLeft").addEventListener("click", () => toggleRail("left"));
byId("collapseRight").addEventListener("click", () => toggleRail("right"));
byId("showRight").addEventListener("click", () => toggleRail("right"));
byId("historyBtn").addEventListener("click", toggleHistory);
byId("historyClose").addEventListener("click", closeHistory);
byId("historyBackdrop").addEventListener("click", closeHistory);
for (const tab of document.querySelectorAll("#historyOverlay .otab")) {
  tab.addEventListener("click", () => { historyTab = tab.dataset.tab; renderHistory(); });
}
setDensityButtons();

document.addEventListener("scroll", markInteraction, { capture: true, passive: true });
document.addEventListener("pointerdown", markInteraction, { capture: true });
document.addEventListener("keydown", onKeydown);

setInterval(() => {
  if (isUserBusy()) return;
  void load({ background: true });
}, 2000);

function markInteraction() { lastInteractionAt = Date.now(); }
function isUserBusy() {
  const tag = document.activeElement?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return true;
  if (openForms.size > 0) return true;
  return Date.now() - lastInteractionAt < 4000;
}

// ---------------------------------------------------------------------------
// data load
// ---------------------------------------------------------------------------
async function load(options = {}) {
  let data;
  try {
    const res = await fetch("/api/state", { headers });
    if (!res.ok) throw new Error(`state ${res.status}`);
    data = await res.json();
    hideError();
  } catch (err) {
    if (options.background) return;
    showError(`Cannot reach dashboard server: ${err.message}`);
    return;
  }
  state = data;
  loadedOnce = true;
  if (options.background && isUserBusy()) return; // keep the user's view stable
  if (!selectedId || !state.issues.some((i) => i.id === selectedId)) {
    selectedId = state.issues[0]?.id ?? null;
  }
  render();
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function render() {
  const scroll = snapshotScroll();
  renderTopbar();
  renderFilters();
  renderIssues();
  renderDetail();
  renderRight();
  restoreScroll(scroll);
}

function renderTopbar() {
  const live = state.mode?.agentRunsEnabled;
  const badge = byId("modeBadge");
  badge.textContent = live ? "Local + Copilot runs" : "Local read-only";
  badge.classList.toggle("live", Boolean(live));

  const counts = prCounts(state.prs ?? []);
  const el = byId("topPrCounts");
  el.textContent = "";
  const order = [["open", "open"], ["draft", "draft"], ["merged", "merged"], ["closed", "closed"]];
  const parts = order.filter(([k]) => counts[k]).map(([k, label]) => `${counts[k]} ${label}`);
  if (parts.length) {
    el.append(node("span", { class: "pill-dot", text: "PRs" }), document.createTextNode(" " + parts.join(" · ")));
  }
}

function renderFilters() {
  const wrap = byId("issueFilters");
  wrap.textContent = "";
  const issues = state.issues ?? [];
  const defs = [
    ["all", "All", issues.length],
    ["action", "Needs action", issues.filter((i) => matchFilter(i, "action")).length],
    ["running", "Running", issues.filter((i) => matchFilter(i, "running")).length],
    ["ineligible", "Ineligible", issues.filter((i) => matchFilter(i, "ineligible")).length],
    ["haspr", "Has PR", issues.filter((i) => matchFilter(i, "haspr")).length],
  ];
  for (const [key, label, n] of defs) {
    const chip = node("button", { class: `filter-chip ${filter === key ? "is-on" : ""}` });
    chip.type = "button";
    chip.setAttribute("role", "tab");
    chip.setAttribute("aria-selected", String(filter === key));
    chip.append(document.createTextNode(label), node("span", { class: "chip-n", text: String(n) }));
    chip.addEventListener("click", () => { markInteraction(); filter = key; render(); });
    wrap.append(chip);
  }
}

function visibleIssues() {
  const issues = (state.issues ?? []).filter((i) => matchFilter(i, filter));
  return issues.sort((a, b) => urgencyRank(a) - urgencyRank(b) || b.number - a.number);
}

function renderIssues() {
  const list = byId("issueList");
  list.textContent = "";
  const issues = visibleIssues();
  byId("issueCount").textContent = issues.length ? `(${issues.length})` : "";
  if (!issues.length) {
    list.append(node("div", { class: "empty-note", text: loadedOnce ? "No issues match this filter." : "Loading…" }));
    return;
  }
  for (const issue of issues) {
    const dom = dominantState(issue);
    const done = doneCount(issue);
    const row = node("div", { class: `issue-row s-${dom.key} ${issue.id === selectedId ? "active" : ""}` });
    row.tabIndex = -1;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(issue.id === selectedId));
    row.dataset.id = issue.id;

    const state1 = node("span", { class: "ir-state" });
    state1.append(node("span", { class: "dot" }), node("span", { class: "state-tag", text: dom.label }));

    const foot = node("div", { class: "ir-foot" });
    const prog = node("span", { class: "progress" });
    const fill = node("i");
    fill.style.width = `${Math.round((done / issue.phases.length) * 100)}%`;
    prog.append(fill);
    foot.append(prog, node("span", { class: "ir-progress-label", text: `${done}/${issue.phases.length}` }));
    const activePr = (issue.relatedPrs ?? []).find(isActivePr);
    if (activePr) foot.append(node("span", { class: `ir-pr ${activePr.status}`, text: `#${activePr.number}` }));

    row.append(
      node("span", { class: "ir-num", text: `#${issue.number}` }),
      state1,
      node("span", { class: "ir-title", text: issue.title }),
      foot,
    );
    row.addEventListener("click", () => selectIssue(issue.id));
    list.append(row);
  }
}

function renderDetail() {
  const detail = byId("issueDetail");
  detail.textContent = "";
  const issue = state.issues.find((i) => i.id === selectedId);
  if (!issue) {
    detail.append(skeleton());
    return;
  }
  const dom = dominantState(issue);

  // header
  const head = node("div", { class: "detail-head" });
  const main = node("div", { class: "dh-main" });
  main.append(node("div", { class: "dh-num", text: `#${issue.number}` }), node("h2", { class: "dh-title", text: issue.title }));
  if ((issue.labels ?? []).length) {
    const labels = node("div", { class: "labels" });
    for (const label of issue.labels) labels.append(node("span", { class: "label", text: label }));
    main.append(labels);
  }
  const acts = node("div", { class: "dh-actions" });
  const reflect = node("button", { class: "btn", text: "Self-reflect" });
  reflect.type = "button";
  reflect.addEventListener("click", () => runReflection(issue.id));
  acts.append(copyButton("Copy issue", () => copyableIssueText(issue)), reflect);
  head.append(main, acts);
  detail.append(head);

  if (issue.eligibility?.eligible === false) detail.append(eligStrip(issue));

  // blocker / next-action strip (the eligibility strip already covers ineligible)
  if (dom.key !== "ineligible") detail.append(blockerStrip(issue, dom));

  // phase pipeline rail
  detail.append(phaseRail(issue));

  // phase detail panel OR scan-all
  if (scanAll) detail.append(scanTable(issue));
  else detail.append(phasePanel(issue, currentPhase(issue)));
}

function eligStrip(issue) {
  const first = issue.eligibility?.reasons?.[0];
  const notEnrolled = first?.code === "MISSING_REQUIRED_LABEL";
  const strip = node("div", { class: "elig-strip" });
  strip.append(
    node("span", { class: "elig-badge", text: notEnrolled ? "Not enrolled" : "Ineligible" }),
    node("span", { class: "elig-msg", text: first?.message ?? "This issue is not eligible for automation." }),
  );
  if (notEnrolled) strip.append(node("span", { class: "elig-help", text: "The driver skips it until enrollment is fixed — this is not a phase-1 failure." }));
  return strip;
}

function blockerStrip(issue, dom) {
  const phase = currentPhase(issue);
  const strip = node("div", { class: `blocker s-${dom.key}` });
  const msg = dom.key === "ineligible"
    ? (issue.eligibility?.reasons?.[0]?.message ?? "Not eligible.")
    : firstLine(phase?.output) || `${phase?.title ?? "Phase"} — ${phase?.statusLabel ?? phase?.status ?? "idle"}`;
  strip.append(
    node("span", { class: "blocker-state", text: dom.label }),
    node("span", { class: "blocker-msg", text: msg }),
  );
  return strip;
}

function phaseRail(issue) {
  const wrap = node("div", { class: "prail-wrap" });
  const top = node("div", { class: "prail-top" });
  const scanBtn = node("button", { class: `btn btn-mini ${scanAll ? "btn-accent" : ""}`, text: scanAll ? "Focus view" : "Scan all" });
  scanBtn.type = "button";
  scanBtn.addEventListener("click", () => { markInteraction(); scanAll = !scanAll; render(); });
  top.append(node("span", { class: "prail-legend", text: "Pipeline" }), scanBtn);
  wrap.append(top);

  const rail = node("div", { class: "prail" });
  rail.setAttribute("role", "tablist");
  const selId = currentPhase(issue)?.id;
  issue.phases.forEach((phase, index) => {
    const node1 = node("button", { class: `pnode p-${phase.status} ${phase.id === selId ? "active" : ""}` });
    node1.type = "button";
    node1.setAttribute("role", "tab");
    node1.setAttribute("aria-selected", String(phase.id === selId));
    node1.title = `${phase.title} — ${phase.statusLabel ?? phase.status}`;
    const track = node("span", { class: "pnode-track" });
    track.append(node("span", { class: "pnode-dot" }));
    node1.append(
      track,
      node("span", { class: "pnode-idx", text: String(index + 1).padStart(2, "0") }),
      node("span", { class: "pnode-label", text: shortLabel(phase) }),
    );
    node1.addEventListener("click", () => selectPhase(issue.id, phase.id));
    rail.append(node1);
  });
  wrap.append(rail);
  return wrap;
}

function scanTable(issue) {
  const wrap = node("div", { class: "scan" });
  const selId = currentPhase(issue)?.id;
  issue.phases.forEach((phase, index) => {
    const row = node("div", { class: `scan-row ${phase.id === selId ? "active" : ""}` });
    row.append(
      node("span", { class: "scan-idx", text: String(index + 1).padStart(2, "0") }),
      node("span", { class: "scan-name", text: phase.title }),
      statusChip(phase),
      node("span", { class: "scan-summary", text: firstLine(phase.output) || "—" }),
    );
    row.addEventListener("click", () => { selectPhase(issue.id, phase.id); scanAll = false; render(); });
    wrap.append(row);
  });
  return wrap;
}

function phasePanel(issue, phase) {
  if (!phase) return node("div", { class: "empty-note", text: "No phase selected." });
  const panel = node("div", { class: "ppanel" });

  const headRow = node("div", { class: "ppanel-head" });
  const actions = node("div", { class: "ppanel-actions" });
  if (phase.recoverable) {
    const recover = node("button", { class: "btn btn-signal btn-mini", text: "Recover" });
    recover.type = "button";
    recover.title = "Planning-only: records recovery intent and plan; the CLI driver executes recovery.";
    recover.addEventListener("click", () => runRecover(issue.id, phase.id));
    actions.append(recover);
  }
  const approveBtn = node("button", { class: "btn btn-mini", text: "Approve" });
  approveBtn.type = "button";
  approveBtn.disabled = !phase.canApprove;
  approveBtn.title = phase.sideEffect ?? "";
  const feedbackBtn = node("button", { class: "btn btn-mini", text: "Revision" });
  feedbackBtn.type = "button";
  feedbackBtn.disabled = !phase.canGiveFeedback;
  actions.append(approveBtn, feedbackBtn);
  headRow.append(
    node("span", { class: "ppanel-idx", text: String(issue.phases.indexOf(phase) + 1).padStart(2, "0") }),
    node("span", { class: "ppanel-title", text: phase.title }),
    statusChip(phase),
    actions,
  );
  panel.append(headRow);

  const body = node("div", { class: "ppanel-body" });

  // output
  const outputText = phase.status === "running" && phase.activeActions?.length
    ? `${phase.activeActions.map((a) => a.message).join("\n")}\n\n${phase.output || ""}`
    : (phase.output || "(no output yet)");
  const outKey = `${issue.id}:${phase.id}`;
  const pre = node("pre", { class: `output ${expandedOutputs.has(outKey) ? "expanded" : ""}`, text: outputText });
  body.append(pre);
  const outTools = node("div", { class: "inline-tools" });
  if (outputText.length > 400) {
    const exp = node("button", { class: "copy-btn", text: expandedOutputs.has(outKey) ? "Collapse" : "Expand" });
    exp.type = "button";
    exp.addEventListener("click", () => { toggleSet(expandedOutputs, outKey); render(); });
    outTools.append(exp);
  }
  outTools.append(copyButton("Copy output", () => phase.output || ""));
  body.append(outTools);

  // artifacts for this phase
  if ((phase.artifacts ?? []).length) {
    body.append(node("div", { class: "field-label", text: "Phase artifacts" }));
    const chips = node("div", { class: "chips" });
    for (const a of phase.artifacts) chips.append(artifactChip(a));
    body.append(chips);
  }

  // recovery
  const recovery = recoveryPanel(phase);
  if (recovery) body.append(recovery);

  // approval + feedback forms
  body.append(approvalForm(issue, phase, approveBtn));
  body.append(feedbackForm(issue, phase, feedbackBtn));

  // log
  const log = phaseLogText(phase);
  if (log) {
    body.append(node("div", { class: "field-label", text: "Activity" }));
    body.append(node("div", { class: "phase-log", text: log }));
    body.append(copyButton("Copy log", () => log));
  }

  panel.append(body);
  return panel;
}

function approvalForm(issue, phase, approveBtn) {
  const key = `${issue.id}:${phase.id}:approval`;
  const draftKey = `${issue.id}:${phase.id}`;
  const form = node("form", { class: `pform ${openForms.has(key) ? "" : "hidden"}` });
  form.append(node("label", { class: "field-label", text: "Optional note for the next agent" }));
  const ta = node("textarea");
  ta.name = "note";
  ta.maxLength = 4000;
  ta.placeholder = "Add maintainer guidance before approving, or leave blank.";
  ta.value = approvalDrafts.get(draftKey) ?? "";
  ta.addEventListener("input", () => approvalDrafts.set(draftKey, ta.value));
  form.append(ta);
  const rowBtns = node("div", { class: "form-row" });
  const submit = node("button", { class: "btn btn-accent btn-mini", text: "Approve with note" });
  submit.type = "submit";
  const cancel = node("button", { class: "btn btn-mini", text: "Cancel" });
  cancel.type = "button";
  cancel.addEventListener("click", () => { openForms.delete(key); render(); });
  rowBtns.append(submit, cancel);
  form.append(rowBtns);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    openForms.delete(key);
    await post(`/api/issues/${issue.id}/phases/${phase.id}/approve`, {
      approver: "local-maintainer",
      spec: issue.spec,
      issueInputSha: issue.requirementsIssueInputSha,
      note: ta.value,
    });
    approvalDrafts.delete(draftKey);
  });
  approveBtn.addEventListener("click", () => {
    toggleSet(openForms, key);
    openForms.delete(`${issue.id}:${phase.id}:feedback`);
    render();
    if (openForms.has(key)) requestAnimationFrame(() => ta.focus());
  });
  return form;
}

function feedbackForm(issue, phase, feedbackBtn) {
  const key = `${issue.id}:${phase.id}:feedback`;
  const draftKey = `${issue.id}:${phase.id}:fb`;
  const form = node("form", { class: `pform ${openForms.has(key) ? "" : "hidden"}` });
  form.append(node("label", { class: "field-label", text: "Human feedback" }));
  const ta = node("textarea");
  ta.name = "feedback";
  ta.placeholder = "Decision, reason, requested change, acceptance criteria";
  ta.value = feedbackDrafts.get(draftKey) ?? "";
  ta.addEventListener("input", () => feedbackDrafts.set(draftKey, ta.value));
  form.append(ta);
  const check = node("label", { class: "checkline" });
  const box = node("input");
  box.type = "checkbox";
  box.name = "runAgent";
  check.append(box, document.createTextNode("Run local Copilot text session"));
  form.append(check);
  const rowBtns = node("div", { class: "form-row" });
  const submit = node("button", { class: "btn btn-accent btn-mini", text: "Send feedback" });
  submit.type = "submit";
  const cancel = node("button", { class: "btn btn-mini", text: "Cancel" });
  cancel.type = "button";
  cancel.addEventListener("click", () => { openForms.delete(key); render(); });
  rowBtns.append(submit, cancel);
  form.append(rowBtns);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    openForms.delete(key);
    await post(`/api/issues/${issue.id}/phases/${phase.id}/feedback`, { feedback: ta.value, runAgent: box.checked });
    feedbackDrafts.delete(draftKey);
  });
  feedbackBtn.addEventListener("click", () => {
    toggleSet(openForms, key);
    openForms.delete(`${issue.id}:${phase.id}:approval`);
    render();
    if (openForms.has(key)) requestAnimationFrame(() => ta.focus());
  });
  return form;
}

function recoveryPanel(phase) {
  if (!phase.recoverable && !phase.recovery) return null;
  const r = phase.recovery ?? {};
  const panel = node("div", { class: "recovery" });
  panel.append(
    node("div", { class: "recovery-title", text: "Recovery" }),
    node("div", { class: "recovery-note", text: "Dashboard Recover is planning-only: it records intent + a plan; the CLI driver executes." }),
  );
  const grid = node("div", { class: "recovery-grid" });
  const cells = [
    ["State", r.state ?? (phase.recoverable ? "recoverable" : "idle")],
    ["Tier", r.currentTier ?? "none"],
    ["Models tried", r.modelsTried?.length ? r.modelsTried.join(", ") : "none"],
    ["Budget used", fmtObj(r.budgetUsed) || "—"],
    ["Last reason", r.lastReason ?? "none"],
    ["Next action", r.nextAction ?? "awaiting Recover / CLI driver"],
    ["Why human", r.whyHuman ?? "not human-gated"],
  ];
  for (const [k, v] of cells) {
    const cell = node("div", { class: "rcell" });
    cell.append(node("b", { text: k }), node("span", { text: String(v ?? "unknown") }));
    grid.append(cell);
  }
  panel.append(grid);
  return panel;
}

// ---------------------------------------------------------------------------
// right rail: PRs + artifacts
// ---------------------------------------------------------------------------
function renderRight() {
  const panel = byId("contextPanel");
  panel.textContent = "";
  const issue = state.issues.find((i) => i.id === selectedId);

  const prs = issue ? relatedPrsForDisplay(issue) : [];
  const prSection = ctxSection("related-prs", `Related PRs`, prs.length, (body) => {
    if (!issue) { body.append(node("div", { class: "empty-note", text: "Select an issue." })); return; }
    const toggle = node("button", { class: "btn btn-mini pr-toggle", text: showCompletedPrs ? "Hide merged/closed" : "Show merged/closed" });
    toggle.type = "button";
    toggle.addEventListener("click", () => { markInteraction(); showCompletedPrs = !showCompletedPrs; render(); });
    if (!prs.length) body.append(node("div", { class: "empty-note", text: showCompletedPrs ? "No related PRs." : "No active related PRs." }));
    for (const pr of prs) body.append(prRow(pr));
    body.append(toggle);
  });
  panel.append(prSection);

  const artifacts = issue?.automationSummary?.artifacts ?? [];
  const artSection = ctxSection("artifacts", "Artifact trail", artifacts.length, (body) => {
    if (!artifacts.length) { body.append(node("div", { class: "empty-note", text: "No durable artifacts yet." })); return; }
    for (const a of artifacts.slice(-12).reverse()) body.append(artifactChip(a, true));
  });
  panel.append(artSection);
}

function ctxSection(id, title, count, fill) {
  const wrap = node("div", { class: "ctx-section" });
  const collapsed = collapsedCtx.has(id);
  const head = node("button", { class: "ctx-head" });
  head.type = "button";
  head.setAttribute("aria-expanded", String(!collapsed));
  head.append(node("span", { text: title }), node("span", { class: "ctx-n", text: String(count) }));
  head.addEventListener("click", () => { toggleSet(collapsedCtx, id); render(); });
  const body = node("div", { class: `ctx-body ${collapsed ? "collapsed" : ""}` });
  if (!collapsed) fill(body);
  wrap.append(head, body);
  return wrap;
}

function prRow(pr) {
  const row = node("a", { class: `pr-row ${pr.status ?? "unknown"}` });
  row.href = pr.url;
  row.target = "_blank";
  row.rel = "noreferrer";
  row.append(
    node("span", { class: `pr-badge ${pr.status ?? "unknown"}`, text: pr.statusLabel ?? prStatusLabel(pr) }),
    node("span", { class: "pr-num", text: `#${pr.number}` }),
    node("span", { class: "pr-title", text: pr.title }),
    node("span", { class: "pr-meta", text: `${prDate(pr) || pr.mergeStateStatus || "—"} · issues ${issueListText(pr)}` }),
  );
  return row;
}

function artifactChip(a, withPhase = false) {
  const chip = node("div", { class: "chip-row" });
  chip.append(node("span", { class: "artifact-id", text: a.displayId ?? a.id ?? "artifact" }));
  if (withPhase) chip.append(node("span", { class: "artifact-phase", text: a.phase ?? "" }));
  else chip.append(node("span", { class: "artifact-phase", text: "" }));
  chip.append(
    node("span", { class: "artifact-text", text: a.summary || a.title || a.path || "" }),
    copyButton("Copy", () => copyableArtifactText(a)),
  );
  return chip;
}

// ---------------------------------------------------------------------------
// selection + phase helpers
// ---------------------------------------------------------------------------
function selectIssue(id) { markInteraction(); selectedId = id; render(); }
function selectPhase(issueId, phaseId) { markInteraction(); selectedPhaseByIssue.set(issueId, phaseId); render(); }

function currentPhase(issue) {
  const stored = selectedPhaseByIssue.get(issue.id);
  const found = stored && issue.phases.find((p) => p.id === stored);
  if (found) return found;
  return issue.phases.find((p) => p.id === pickDefaultPhaseId(issue)) ?? issue.phases[0];
}

function pickDefaultPhaseId(issue) {
  const p = issue.phases;
  const pick =
    p.find((x) => x.status === "needs-human") ||
    p.find((x) => x.status === "running") ||
    p.find((x) => x.status === "needs-revision" || x.status === "needs-redo") ||
    [...p].reverse().find((x) => DONE.has(x.status)) ||
    p[0];
  return pick?.id;
}

function dominantState(issue) {
  if (issue.eligibility?.eligible === false) return { key: "ineligible", label: "Ineligible" };
  const st = issue.phases.map((p) => p.status);
  if (st.includes("needs-human")) return { key: "needshuman", label: "Needs human" };
  if (st.includes("running")) return { key: "running", label: "Running" };
  if (st.some((s) => s === "needs-revision" || s === "needs-redo")) return { key: "revision", label: "Revision" };
  const done = doneCount(issue);
  if (done === issue.phases.length) return { key: "complete", label: "Complete" };
  if (done > 0) return { key: "progress", label: "In progress" };
  return { key: "idle", label: "Idle" };
}

function doneCount(issue) { return issue.phases.filter((p) => DONE.has(p.status)).length; }

function urgencyRank(issue) {
  return { needshuman: 0, revision: 1, running: 2, progress: 3, complete: 4, idle: 5, ineligible: 6 }[dominantState(issue).key] ?? 9;
}

function matchFilter(issue, key) {
  const dom = dominantState(issue).key;
  if (key === "all") return true;
  if (key === "action") return dom === "needshuman" || dom === "revision" || issue.phases.some((p) => p.recoverable);
  if (key === "running") return dom === "running";
  if (key === "ineligible") return issue.eligibility?.eligible === false;
  if (key === "haspr") return (issue.relatedPrs ?? []).some(isActivePr);
  return true;
}

function shortLabel(phase) { return PHASE_SHORT[phase.id] ?? (phase.title || "").split(/\s+/)[0]; }

function statusChip(phase) {
  return node("span", { class: `status-chip ${phase.status}`, text: phase.statusLabel ?? phase.status });
}

function phaseLogText(phase) {
  const feedback = phase.feedback ?? [];
  const approvals = phase.approvals ?? [];
  const transitions = phase.transitions ?? [];
  const actions = phase.activeActions ?? [];
  return [
    ...actions.map((i) => `Running ${i.type}: ${i.message}`),
    ...approvals.map((i) => `Approved by ${i.approver} at ${i.createdAt}${i.note ? `\nNote: ${i.note}` : ""}`),
    ...feedback.map((i) => `Feedback ${i.createdAt}: ${i.feedback}\n${i.agentResult}`),
    ...transitions.map((i) => `Transition ${i.from ?? "derived"} -> ${i.to}: ${i.message}`),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// PR helpers
// ---------------------------------------------------------------------------
function prCounts(prs) {
  return prs.reduce((acc, pr) => { const s = pr.status ?? "unknown"; acc[s] = (acc[s] ?? 0) + 1; return acc; }, {});
}
function relatedPrsForDisplay(issue) {
  const prs = issue.relatedPrs ?? [];
  return showCompletedPrs ? prs : prs.filter(isActivePr);
}
function isActivePr(pr) { const s = (pr.status ?? "").toLowerCase(); return s === "open" || s === "draft"; }
function prStatusLabel(pr) {
  if (pr.mergedAt || pr.state === "MERGED") return "MERGED";
  if (pr.state === "CLOSED") return "CLOSED";
  if (pr.isDraft) return "DRAFT";
  if (pr.state === "OPEN") return "OPEN";
  return "UNKNOWN";
}
function prDate(pr) {
  const v = pr.mergedAt || pr.closedAt;
  return v ? new Date(v).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
}
function issueListText(pr) {
  const issues = pr.relatedIssues?.length ? pr.relatedIssues : pr.closingIssues;
  return issues?.length ? issues.map((n) => `#${n}`).join(", ") : "none";
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
async function runReflection(issueId) { await post(`/api/issues/${issueId}/reflect`, { runAgent: false }); }
async function runRecover(issueId, phaseId) {
  const out = await post(`/api/issues/${issueId}/phases/${phaseId}/recover`, {});
  if (out) toast("Recovery plan recorded (planning-only).", "ok");
}

async function post(url, body) {
  markInteraction();
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: mutationHeaders(), body: JSON.stringify(body) });
  } catch (err) {
    toast(`Request failed: ${err.message}`, "err");
    return null;
  }
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) { toast(data.error || `Request failed (${res.status})`, "err"); return null; }
  if (data.state) state = data.state;
  render();
  return data;
}

function mutationHeaders() {
  const out = { ...actionHeaders };
  if (state?.security?.nonce) out["x-dashboard-nonce"] = state.security.nonce;
  return out;
}

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------
function onKeydown(e) {
  const typing = ["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName);
  if (e.key === "Escape") {
    if (historyOpen) { closeHistory(); return; }
    byId("helpPopover").classList.add("hidden");
    return;
  }
  if (typing) return;
  if (e.key === "?" || (e.shiftKey && e.key === "/")) { e.preventDefault(); byId("helpPopover").classList.toggle("hidden"); return; }
  if (e.key.toLowerCase() === "h") { e.preventDefault(); toggleHistory(); return; }
  if (e.key === "[") { e.preventDefault(); toggleRail("left"); return; }
  if (e.key === "]") { e.preventDefault(); toggleRail("right"); return; }
  if (e.key === "/") { e.preventDefault(); byId("issueFilters").querySelector(".filter-chip")?.focus(); return; }
  if (e.key.toLowerCase() === "r") { e.preventDefault(); void load(); return; }
  if (e.key.toLowerCase() === "s") { e.preventDefault(); markInteraction(); scanAll = !scanAll; render(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveIssue(e.key === "ArrowDown" ? 1 : -1); return; }
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); movePhase(e.key === "ArrowRight" ? 1 : -1); return; }
}

function moveIssue(delta) {
  const issues = visibleIssues();
  if (!issues.length) return;
  const idx = Math.max(0, issues.findIndex((i) => i.id === selectedId));
  const next = issues[(idx + delta + issues.length) % issues.length];
  selectIssue(next.id);
  byId("issueList").querySelector(".issue-row.active")?.scrollIntoView({ block: "nearest" });
}

function movePhase(delta) {
  const issue = state?.issues.find((i) => i.id === selectedId);
  if (!issue) return;
  const idx = issue.phases.findIndex((p) => p.id === currentPhase(issue).id);
  const next = issue.phases[(idx + delta + issue.phases.length) % issue.phases.length];
  selectPhase(issue.id, next.id);
}

// ---------------------------------------------------------------------------
// misc UI
// ---------------------------------------------------------------------------
function setDensity(d) { document.body.dataset.density = d; localStorage.setItem("vb.density", d); setDensityButtons(); }
function setDensityButtons() {
  byId("densityCompact").classList.toggle("is-on", document.body.dataset.density === "compact");
  byId("densityCozy").classList.toggle("is-on", document.body.dataset.density === "cozy");
}
function toggleRail(side) {
  const cls = side === "left" ? "left-collapsed" : "right-collapsed";
  const collapsed = document.body.classList.toggle(cls);
  localStorage.setItem(`vb.${side}Collapsed`, collapsed ? "1" : "0");
  byId(side === "left" ? "collapseLeft" : "collapseRight")?.setAttribute("aria-expanded", String(!collapsed));
}

// ---------------------------------------------------------------------------
// history overlay (closed issues + all PRs) — hidden by default
// ---------------------------------------------------------------------------
function toggleHistory() { if (historyOpen) closeHistory(); else void openHistory(); }
async function openHistory() {
  historyOpen = true;
  byId("historyOverlay").classList.remove("hidden");
  if (!historyData) {
    try {
      const res = await fetch("/api/history", { headers });
      historyData = res.ok ? await res.json() : { closedIssues: [] };
    } catch { historyData = { closedIssues: [] }; }
  }
  renderHistory();
}
function closeHistory() { historyOpen = false; byId("historyOverlay").classList.add("hidden"); }

function renderHistory() {
  for (const tab of document.querySelectorAll("#historyOverlay .otab")) {
    tab.classList.toggle("is-on", tab.dataset.tab === historyTab);
    tab.setAttribute("aria-selected", String(tab.dataset.tab === historyTab));
  }
  const closedIssues = historyData?.closedIssues ?? [];
  const prs = state?.prs ?? [];
  byId("histIssueN").textContent = String(closedIssues.length);
  byId("histPrN").textContent = String(prs.length);

  const filters = byId("historyFilters");
  const body = byId("historyBody");
  filters.textContent = "";
  body.textContent = "";

  if (historyTab === "issues") {
    if (!closedIssues.length) { body.append(node("div", { class: "empty-note", text: "No closed issues." })); return; }
    for (const issue of closedIssues) body.append(histIssueRow(issue));
    return;
  }

  const counts = prCounts(prs);
  const defs = [["all", "All", prs.length], ["open", "Open", counts.open || 0], ["draft", "Draft", counts.draft || 0], ["merged", "Merged", counts.merged || 0], ["closed", "Closed", counts.closed || 0]];
  for (const [key, label, n] of defs) {
    const chip = node("button", { class: `filter-chip ${historyPrFilter === key ? "is-on" : ""}` });
    chip.type = "button";
    chip.append(document.createTextNode(label), node("span", { class: "chip-n", text: String(n) }));
    chip.addEventListener("click", () => { historyPrFilter = key; renderHistory(); });
    filters.append(chip);
  }
  const visible = (historyPrFilter === "all" ? prs : prs.filter((p) => (p.status ?? "unknown") === historyPrFilter)).slice().sort((a, b) => b.number - a.number);
  if (!visible.length) { body.append(node("div", { class: "empty-note", text: "No pull requests match." })); return; }
  for (const pr of visible) body.append(histPrRow(pr));
}

function histIssueRow(issue) {
  const row = node("a", { class: "hist-row" });
  row.href = issue.url; row.target = "_blank"; row.rel = "noreferrer";
  row.append(
    node("span", { class: "hist-num", text: `#${issue.number}` }),
    node("span", { class: "hist-title", text: issue.title }),
    node("span", { class: "hist-date", text: fmtDate(issue.closedAt) }),
    node("span", { class: "hist-link", text: "Open ↗" }),
  );
  if ((issue.labels ?? []).length) {
    const labels = node("div", { class: "hist-labels" });
    for (const l of issue.labels) labels.append(node("span", { class: "hist-label", text: l }));
    row.append(labels);
  }
  return row;
}

function histPrRow(pr) {
  const row = node("a", { class: "hist-row" });
  row.href = pr.url; row.target = "_blank"; row.rel = "noreferrer";
  row.append(
    node("span", { class: `pr-badge ${pr.status ?? "unknown"}`, text: pr.statusLabel ?? prStatusLabel(pr) }),
    node("span", { class: "hist-title", text: pr.title }),
    node("span", { class: "hist-date", text: `#${pr.number}${prDate(pr) ? ` · ${prDate(pr)}` : ""}` }),
    node("span", { class: "hist-link", text: "Open ↗" }),
  );
  return row;
}

function fmtDate(v) {
  return v ? new Date(v).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "";
}

function toast(text, kind = "") {
  const box = byId("toast");
  const item = node("div", { class: `toast-item ${kind}`, text });
  box.append(item);
  setTimeout(() => item.remove(), 4200);
}
function showError(text) { const b = byId("errorBanner"); b.textContent = text; b.classList.remove("hidden"); }
function hideError() { byId("errorBanner").classList.add("hidden"); }

function skeleton() {
  const sk = node("div", { class: "skeleton" });
  sk.append(node("div", { class: "sk-line short" }), node("div", { class: "sk-line" }), node("div", { class: "sk-line" }), node("div", { class: "sk-line short" }));
  return sk;
}

// ---------------------------------------------------------------------------
// copy helpers
// ---------------------------------------------------------------------------
function copyButton(label, getText) {
  const b = node("button", { class: "copy-btn", text: label });
  b.type = "button";
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    const original = b.textContent;
    try { await copyText(getText()); b.textContent = "Copied"; }
    catch { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = original; }, 1200);
  });
  return b;
}
async function copyText(text) {
  const value = String(text ?? "");
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const ta = document.createElement("textarea");
  ta.value = value; ta.setAttribute("readonly", "");
  ta.style.position = "fixed"; ta.style.left = "-9999px";
  document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
}
function copyableIssueText(issue) {
  return [
    `Issue #${issue.number}: ${issue.title}`,
    `Labels: ${(issue.labels ?? []).join(", ") || "none"}`,
    `Eligibility: ${issue.eligibility?.eligible === false ? issue.eligibility.reasons?.[0]?.message : "eligible"}`,
    `Related PRs: ${(issue.relatedPrs ?? []).map((p) => `#${p.number} ${p.statusLabel ?? prStatusLabel(p)}`).join(", ") || "none"}`,
    `URL: ${issue.url ?? ""}`,
  ].join("\n");
}
function copyableArtifactText(a) {
  return [`${a.displayId ?? a.id}: ${a.title ?? ""}`, `Phase: ${a.phase ?? ""}`, `Summary: ${a.summary ?? ""}`, `Path: ${a.path ?? ""}`].join("\n");
}

// ---------------------------------------------------------------------------
// scroll preservation across re-renders
// ---------------------------------------------------------------------------
function snapshotScroll() {
  return {
    issues: byId("issueList")?.scrollTop ?? 0,
    center: byId("issueDetail")?.scrollTop ?? 0,
    context: byId("contextPanel")?.scrollTop ?? 0,
  };
}
function restoreScroll(s) {
  requestAnimationFrame(() => {
    const list = byId("issueList"); if (list) list.scrollTop = s.issues;
    const center = byId("issueDetail"); if (center) center.scrollTop = s.center;
    const ctx = byId("contextPanel"); if (ctx) ctx.scrollTop = s.context;
  });
}

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
function byId(id) { return document.getElementById(id); }
function node(tag, { class: cls, text } = {}) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function toggleSet(set, key) { if (set.has(key)) set.delete(key); else set.add(key); }
function firstLine(text) { return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ""; }
function fmtObj(v) {
  if (!v) return "";
  if (typeof v !== "object") return String(v);
  return Object.entries(v).map(([k, n]) => `${k}: ${n}`).join(", ");
}

load().catch((err) => showError(err instanceof Error ? err.message : String(err)));
