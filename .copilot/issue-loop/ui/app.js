const token = document.querySelector('meta[name="dashboard-token"]').content;
let state = null;
let selectedId = null;
let showCompletedPrs = false;

const headers = {
  "x-dashboard-token": token,
};
const actionHeaders = {
  ...headers,
  "x-dashboard-action": "1",
  "content-type": "application/json",
};
const openPhases = new Set();
const approvalDrafts = new Map();
let lastInteractionAt = 0;

document.getElementById("refreshBtn").addEventListener("click", load);
document.getElementById("toggleCompletedPrsBtn").addEventListener("click", () => {
  lastInteractionAt = Date.now();
  showCompletedPrs = !showCompletedPrs;
  render();
});
document.addEventListener(
  "scroll",
  () => {
    lastInteractionAt = Date.now();
  },
  { capture: true, passive: true },
);
document.addEventListener(
  "pointerdown",
  () => {
    lastInteractionAt = Date.now();
  },
  { capture: true },
);
setInterval(() => {
  if (document.activeElement?.tagName === "TEXTAREA") return;
  if (openPhases.size > 0) return;
  if (Date.now() - lastInteractionAt < 5000) return;
  void load({ preserveOpen: true, background: true });
}, 2000);

async function load(options = {}) {
  const scrollSnapshot = captureScrollSnapshot();
  const res = await fetch("/api/state", { headers });
  state = await res.json();
  if (
    options.background &&
    (document.activeElement?.tagName === "TEXTAREA" ||
      openPhases.size > 0 ||
      Date.now() - lastInteractionAt < 5000)
  ) {
    return;
  }
  selectedId ??= state.issues[0]?.id;
  render();
  if (options.preserveOpen) restoreScrollSnapshot(scrollSnapshot);
}

function render() {
  document.getElementById("modeBadge").textContent = state.mode.agentRunsEnabled
    ? "Local + Copilot text runs"
    : "Local read-only";
  renderIssues();
  renderPRs();
  renderDetail();
}

function renderPRs() {
  const list = document.getElementById("prList");
  list.textContent = "";
  const allPrs = state.prs ?? [];
  const visiblePrs = showCompletedPrs ? allPrs : allPrs.filter(isActivePr);
  const hiddenCount = allPrs.length - visiblePrs.length;
  document.getElementById("prSectionTitle").textContent = showCompletedPrs
    ? `Pull requests (${allPrs.length})`
    : `Active pull requests (${visiblePrs.length})`;
  document.getElementById("toggleCompletedPrsBtn").textContent = showCompletedPrs
    ? "Hide merged/closed"
    : `Show merged/closed${hiddenCount ? ` (${hiddenCount})` : ""}`;
  for (const pr of visiblePrs) {
    const card = el("article", { className: `pr-card copy-surface ${pr.status ?? "unknown"}` });
    card.append(
      el("span", { className: `pr-badge ${pr.status ?? "unknown"}`, text: pr.statusLabel ?? prStatusLabel(pr) }),
      el("span", { className: "pr-number", text: `PR #${pr.number}` }),
      el("span", { className: "pr-title", text: pr.title }),
      el("span", {
        className: "pr-meta",
        text: `${prDate(pr) || pr.mergeStateStatus || "no date"} · issues ${issueListText(pr)}`,
      }),
      linkEl("Open PR", pr.url, "open-link"),
      copyButton("Copy PR", () => copyablePrText(pr)),
    );
    list.append(card);
  }
  if (!list.children.length) {
    list.append(el("div", {
      className: "empty-prs",
      text: showCompletedPrs ? "No pull requests found." : "No active pull requests. Merged/closed PRs are hidden.",
    }));
  }
}

function renderIssues() {
  const list = document.getElementById("issueList");
  list.textContent = "";
  for (const issue of state.issues) {
    const running = issue.phases.some((phase) => phase.status === "running");
    const redo = issue.phases.filter((phase) => phase.status === "needs-redo").length;
    const item = el("div", { className: `issue-item copy-surface ${issue.id === selectedId ? "active" : ""}` });
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.append(
      el("span", { className: "issue-number", text: `#${issue.number}` }),
      el("span", { className: "issue-title", text: issue.title }),
      renderIssuePrPills(issue),
      el("div", {
        className: "issue-meta",
        text: `${issue.source} · ${issue.phases.filter((p) => ["complete", "approved"].includes(p.status)).length}/${issue.phases.length} phases${running ? " · running" : ""}${redo ? ` · ${redo} redo` : ""}`,
      }),
    );
    item.addEventListener("click", () => {
      lastInteractionAt = Date.now();
      selectedId = issue.id;
      render();
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      lastInteractionAt = Date.now();
      selectedId = issue.id;
      render();
    });
    list.append(item);
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
  const related = el("div", { className: "related-prs" });
  const relatedPrs = relatedPrsForDisplay(issue);
  if (relatedPrs.length) {
    related.append(el("div", { className: "mini-title", text: `${showCompletedPrs ? "Related PRs" : "Active related PRs"} (${relatedPrs.length})` }));
    for (const pr of relatedPrs) {
      related.append(renderRelatedPr(pr));
    }
    const hiddenCompleted = (issue.relatedPrs ?? []).filter((pr) => !isActivePr(pr)).length;
    if (!showCompletedPrs && hiddenCompleted) {
      related.append(el("div", { className: "artifact-empty", text: `${hiddenCompleted} merged/closed related PRs hidden.` }));
    }
  } else {
    const hiddenCompleted = (issue.relatedPrs ?? []).filter((pr) => !isActivePr(pr)).length;
    related.append(el("div", {
      className: "mini-title",
      text: hiddenCompleted && !showCompletedPrs ? "No active related PRs" : "No related PR yet",
    }));
    if (hiddenCompleted && !showCompletedPrs) {
      related.append(el("div", { className: "artifact-empty", text: `${hiddenCompleted} merged/closed related PRs hidden.` }));
    }
  }
  title.append(related);
  title.append(renderArtifactSummary(issue));
  title.append(copyButton("Copy issue summary", () => copyableIssueText(issue)));
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
  const phaseKey = `${issue.id}:${phase.id}`;
  if (openPhases.has(phaseKey)) card.classList.add("open");
  template.querySelector(".phase-index").textContent = String(index + 1).padStart(2, "0");
  template.querySelector(".phase-title").textContent = phase.title;
  const status = template.querySelector(".phase-status");
  status.textContent = phase.statusLabel ?? phase.status;
  status.classList.add(phase.status);
  template.querySelector(".phase-output").textContent = phase.output || "(no output yet)";
  const header = template.querySelector(".phase-header");
  header.addEventListener("click", () => {
    lastInteractionAt = Date.now();
    card.classList.toggle("open");
    if (card.classList.contains("open")) openPhases.add(phaseKey);
    else openPhases.delete(phaseKey);
  });
  if (phase.status === "running") {
    template.querySelector(".phase-output").textContent =
      `${phase.activeActions.map((action) => action.message).join("\n")}\n\n${phase.output || ""}`;
  }
  template.querySelector(".phase-output").after(copyButton("Copy output", () => phase.output || ""));
  const artifacts = phase.artifacts ?? [];
  if (artifacts.length) {
    const artifactList = el("div", { className: "artifact-list" });
    for (const artifact of artifacts) {
      const item = el("div", { className: "artifact-chip" });
      item.append(
        el("span", { className: "artifact-id", text: artifact.displayId ?? artifact.id ?? "artifact" }),
        el("span", { className: "artifact-text", text: artifact.summary || artifact.title || artifact.path || "" }),
        copyButton("Copy", () => copyableArtifactText(artifact)),
      );
      artifactList.append(item);
    }
    template.querySelector(".phase-output").after(artifactList);
  }

  const approve = template.querySelector(".approve-btn");
  const approvalForm = template.querySelector(".approval-form");
  const approvalNote = approvalForm.note;
  const approvalDraftKey = `${phaseKey}:approval-note`;
  approve.disabled = !phase.canApprove;
  approve.title = phase.sideEffect;
  approvalNote.value = approvalDrafts.get(approvalDraftKey) ?? "";
  approvalNote.addEventListener("input", () => {
    approvalDrafts.set(approvalDraftKey, approvalNote.value);
  });
  approve.addEventListener("click", (event) => {
    event.stopPropagation();
    approvalForm.classList.toggle("hidden");
    if (!approvalForm.classList.contains("hidden")) approvalNote.focus();
  });
  approvalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await post(`/api/issues/${issue.id}/phases/${phase.id}/approve`, {
      approver: "local-maintainer",
      spec: issue.spec,
      issueInputSha: issue.requirementsIssueInputSha,
      note: approvalNote.value,
    });
    approvalDrafts.delete(approvalDraftKey);
  });
  template.querySelector(".approval-cancel-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    approvalForm.classList.add("hidden");
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
  const transitions = phase.transitions ?? [];
  const actions = phase.activeActions ?? [];
  log.textContent = [
    ...actions.map((item) => `Running ${item.type}: ${item.message}`),
    ...approvals.map((item) =>
      `Approved by ${item.approver} at ${item.createdAt}${item.note ? `\nNote: ${item.note}` : ""}`,
    ),
    ...feedback.map((item) => `Feedback ${item.createdAt}: ${item.feedback}\n${item.agentResult}`),
    ...transitions.map((item) => `Transition ${item.from ?? "derived"} -> ${item.to}: ${item.message}`),
  ].join("\n\n");
  log.after(copyButton("Copy log", () => log.textContent));

  return template;
}

function renderIssuePrPills(issue) {
  const wrap = el("div", { className: "issue-pr-pills" });
  const prs = relatedPrsForDisplay(issue);
  const hiddenCompleted = (issue.relatedPrs ?? []).filter((pr) => !isActivePr(pr)).length;
  if (!prs.length) {
    wrap.append(el("span", {
      className: "issue-pr-pill empty",
      text: hiddenCompleted && !showCompletedPrs ? "no active PR" : "no PR",
    }));
    if (hiddenCompleted && !showCompletedPrs) {
      wrap.append(el("span", { className: "issue-pr-pill hidden-count", text: `${hiddenCompleted} hidden` }));
    }
    return wrap;
  }
  const counts = prs.reduce((acc, pr) => {
    const status = pr.status ?? "unknown";
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  for (const status of ["open", "draft", "merged", "closed", "unknown"]) {
    if (!counts[status]) continue;
    wrap.append(el("span", { className: `issue-pr-pill ${status}`, text: `${counts[status]} ${status}` }));
  }
  if (hiddenCompleted && !showCompletedPrs) {
    wrap.append(el("span", { className: "issue-pr-pill hidden-count", text: `${hiddenCompleted} hidden` }));
  }
  return wrap;
}

function relatedPrsForDisplay(issue) {
  const prs = issue.relatedPrs ?? [];
  return showCompletedPrs ? prs : prs.filter(isActivePr);
}

function isActivePr(pr) {
  return (pr.status ?? "").toLowerCase() === "open" || (pr.status ?? "").toLowerCase() === "draft";
}

function renderRelatedPr(pr) {
  const card = el("div", { className: `related-pr-card copy-surface ${pr.status ?? "unknown"}` });
  card.append(
    el("span", { className: `pr-badge ${pr.status ?? "unknown"}`, text: pr.statusLabel ?? prStatusLabel(pr) }),
    el("span", { className: "related-pr-number", text: `#${pr.number}` }),
    el("span", { className: "related-pr-title", text: pr.title }),
    el("span", {
      className: "related-pr-meta",
      text: `${prDate(pr) || pr.mergeStateStatus || "no date"} · ${pr.mergeStateStatus ?? "unknown"}`,
    }),
    linkEl("Open", pr.url, "open-link"),
    copyButton("Copy", () => copyablePrText(pr)),
  );
  return card;
}

function prStatusLabel(pr) {
  if (pr.mergedAt || pr.state === "MERGED") return "MERGED";
  if (pr.state === "CLOSED") return "CLOSED";
  if (pr.isDraft) return "DRAFT";
  if (pr.state === "OPEN") return "OPEN";
  return "UNKNOWN";
}

function prDate(pr) {
  const value = pr.mergedAt || pr.closedAt;
  return value ? new Date(value).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
}

function issueListText(pr) {
  const issues = pr.relatedIssues?.length ? pr.relatedIssues : pr.closingIssues;
  return issues?.length ? issues.map((number) => `#${number}`).join(", ") : "none";
}

function renderArtifactSummary(issue) {
  const wrap = el("div", { className: "artifact-summary" });
  const artifacts = issue.automationSummary?.artifacts ?? [];
  wrap.append(el("div", { className: "mini-title", text: "Automation artifacts" }));
  if (!artifacts.length) {
    wrap.append(el("div", { className: "artifact-empty", text: "No durable artifacts yet." }));
    return wrap;
  }
  for (const artifact of artifacts.slice(-8)) {
    const item = el("div", { className: "artifact-row" });
    item.append(
      el("span", { className: "artifact-id", text: artifact.displayId ?? artifact.id }),
      el("span", { className: "artifact-phase", text: artifact.phase ?? "" }),
      el("span", { className: "artifact-text", text: artifact.summary || artifact.title || artifact.path || "" }),
      copyButton("Copy", () => copyableArtifactText(artifact)),
    );
    wrap.append(item);
  }
  return wrap;
}

function linkEl(text, href, className) {
  const link = el("a", { className, text });
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.addEventListener("click", (event) => event.stopPropagation());
  return link;
}

function copyButton(label, getText) {
  const button = el("button", { className: "text-copy-btn", text: label });
  button.type = "button";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const original = button.textContent;
    try {
      await copyText(getText());
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = original;
      }, 1200);
    } catch {
      button.textContent = "Copy failed";
      setTimeout(() => {
        button.textContent = original;
      }, 1600);
    }
  });
  return button;
}

async function copyText(text) {
  const value = String(text ?? "");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.append(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

function copyablePrText(pr) {
  return [
    `PR #${pr.number}: ${pr.title}`,
    `Status: ${pr.statusLabel ?? prStatusLabel(pr)}`,
    `Issues: ${issueListText(pr)}`,
    `Merge state: ${pr.mergeStateStatus ?? "unknown"}`,
    `URL: ${pr.url}`,
  ].join("\n");
}

function copyableIssueText(issue) {
  return [
    `Issue #${issue.number}: ${issue.title}`,
    `Labels: ${(issue.labels ?? []).join(", ") || "none"}`,
    `Related PRs: ${
      issue.relatedPrs?.length
        ? issue.relatedPrs.map((pr) => `#${pr.number} ${pr.statusLabel ?? prStatusLabel(pr)}`).join(", ")
        : "none"
    }`,
    `URL: ${issue.url ?? ""}`,
  ].join("\n");
}

function copyableArtifactText(artifact) {
  return [
    `${artifact.displayId ?? artifact.id}: ${artifact.title ?? ""}`,
    `Phase: ${artifact.phase ?? ""}`,
    `Summary: ${artifact.summary ?? ""}`,
    `Path: ${artifact.path ?? ""}`,
  ].join("\n");
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

function captureScrollSnapshot() {
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    scrollables: [...document.querySelectorAll(".phase-output, pre, .detail, .issues")].map((node, index) => ({
      index,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
  };
}

function restoreScrollSnapshot(snapshot) {
  requestAnimationFrame(() => {
    window.scrollTo(snapshot.windowX, snapshot.windowY);
    const nodes = [...document.querySelectorAll(".phase-output, pre, .detail, .issues")];
    for (const item of snapshot.scrollables) {
      const node = nodes[item.index];
      if (!node) continue;
      node.scrollTop = item.top;
      node.scrollLeft = item.left;
    }
  });
}

load().catch((error) => {
  document.body.textContent = error instanceof Error ? error.message : String(error);
});
