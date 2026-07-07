const token = document.querySelector('meta[name="dashboard-token"]').content;
let state = null;
let selectedId = null;

const headers = {
  "x-dashboard-token": token,
};
const actionHeaders = {
  ...headers,
  "x-dashboard-action": "1",
  "content-type": "application/json",
};

document.getElementById("refreshBtn").addEventListener("click", load);

async function load() {
  const res = await fetch("/api/state", { headers });
  state = await res.json();
  selectedId ??= state.issues[0]?.id;
  render();
}

function render() {
  document.getElementById("modeBadge").textContent = state.mode.agentRunsEnabled
    ? "Local + Copilot text runs"
    : "Local demo-safe";
  renderIssues();
  renderDetail();
}

function renderIssues() {
  const list = document.getElementById("issueList");
  list.textContent = "";
  for (const issue of state.issues) {
    const btn = el("button", { className: `issue-item ${issue.id === selectedId ? "active" : ""}` });
    btn.append(
      el("span", { className: "issue-number", text: `#${issue.number}` }),
      el("span", { className: "issue-title", text: issue.title }),
      el("div", {
        className: "issue-meta",
        text: `${issue.source} · ${issue.phases.filter((p) => ["complete", "approved"].includes(p.status)).length}/${issue.phases.length} phases`,
      }),
    );
    btn.addEventListener("click", () => {
      selectedId = issue.id;
      render();
    });
    list.append(btn);
  }
}

function renderDetail() {
  const issue = state.issues.find((item) => item.id === selectedId);
  const detail = document.getElementById("issueDetail");
  detail.textContent = "";
  if (!issue) return;
  const wrap = el("div", { className: "detail-inner" });
  const head = el("div", { className: "detail-head" });
  const title = el("div");
  title.append(el("div", { className: "issue-number", text: `#${issue.number}` }), el("h2", { text: issue.title }));
  const labels = el("div", { className: "labels" });
  for (const label of issue.labels ?? []) labels.append(el("span", { className: "label", text: label }));
  title.append(labels);
  const reflect = el("button", { className: "reflection-btn", text: "Run self-reflection" });
  reflect.addEventListener("click", () => runReflection(issue.id));
  head.append(title, reflect);
  wrap.append(head);

  for (const [index, phase] of issue.phases.entries()) {
    wrap.append(renderPhase(issue, phase, index));
  }
  detail.append(wrap);
}

function renderPhase(issue, phase, index) {
  const template = document.getElementById("phaseTemplate").content.cloneNode(true);
  const card = template.querySelector(".phase-card");
  template.querySelector(".phase-index").textContent = String(index + 1).padStart(2, "0");
  template.querySelector(".phase-title").textContent = phase.title;
  const status = template.querySelector(".phase-status");
  status.textContent = phase.status;
  status.classList.add(phase.status);
  template.querySelector(".phase-output").textContent = phase.output || "(no output yet)";
  const header = template.querySelector(".phase-header");
  header.addEventListener("click", () => card.classList.toggle("open"));

  const approve = template.querySelector(".approve-btn");
  approve.disabled = !phase.canApprove;
  approve.title = phase.sideEffect;
  approve.addEventListener("click", async (event) => {
    event.stopPropagation();
    await post(`/api/issues/${issue.id}/phases/${phase.id}/approve`, {
      approver: "local-maintainer",
      spec: issue.spec,
    });
  });

  const feedbackBtn = template.querySelector(".feedback-btn");
  const form = template.querySelector(".feedback-form");
  feedbackBtn.disabled = !phase.canGiveFeedback;
  feedbackBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    form.classList.toggle("hidden");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await post(`/api/issues/${issue.id}/phases/${phase.id}/feedback`, {
      feedback: form.feedback.value,
      runAgent: form.runAgent.checked,
    });
  });

  const log = template.querySelector(".phase-log");
  const feedback = phase.feedback ?? [];
  const approvals = phase.approvals ?? [];
  log.textContent = [
    ...approvals.map((item) => `Approved by ${item.approver} at ${item.createdAt}`),
    ...feedback.map((item) => `Feedback ${item.createdAt}: ${item.feedback}\n${item.agentResult}`),
  ].join("\n\n");

  return template;
}

async function runReflection(issueId) {
  await post(`/api/issues/${issueId}/reflect`, { runAgent: false });
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: actionHeaders,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Request failed");
    return;
  }
  state = data.state;
  render();
}

function el(tag, { className, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

load().catch((error) => {
  document.body.textContent = error instanceof Error ? error.message : String(error);
});
