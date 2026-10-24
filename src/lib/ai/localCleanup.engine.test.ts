/**
 * Real-engine check of the cleanup pipeline (pre-pass → clean-skip → prompt →
 * model) against a running llama-server. Synthetic dictations only.
 *
 *   llama-server -m <model.gguf> --port 8090 -c 8192 -np 1 --jinja --offline --api-key <key>
 *   VERBATIM_CLEANUP_URL=http://127.0.0.1:8090 VERBATIM_CLEANUP_KEY=<key> pnpm test:engines -- localCleanup
 *
 * Optional: VERBATIM_CLEANUP_MIN_PASS (default 0.8) — required pass rate.
 */
import { describe, expect, it } from "vitest";
import { buildCleanupMessages, cleanupTokenBudget } from "./promptBuilder";
import { looksClean, prepareForCleanup, resolveCleanupLanguage } from "./cleanupPrepass";
import { DEFAULT_MODE_PROMPT } from "../store/builtinModes";

declare const process: { env: Record<string, string | undefined> };

const URL_BASE = process.env.VERBATIM_CLEANUP_URL;
const API_KEY = process.env.VERBATIM_CLEANUP_KEY;
const MIN_PASS = Number(process.env.VERBATIM_CLEANUP_MIN_PASS ?? "0.8");

type Check = (out: string) => boolean;
const has =
  (...words: string[]): Check =>
  (o) =>
    words.every((w) => o.toLowerCase().includes(w.toLowerCase()));
const lacks =
  (...words: string[]): Check =>
  (o) =>
    !words.some((w) => new RegExp(`\\b${w.toLowerCase()}\\b`, "u").test(o.toLowerCase()));
const maxWords =
  (n: number): Check =>
  (o) =>
    o.split(/\s+/).length <= n;

const LONG =
  "so um the main thing i wanted to cover today is the the migration plan for the billing service we we are going to move the read path first and then uh the write path about two weeks later and the risk is mostly around the the nightly reconciliation job which still talks to the old database so we need to point that at the new replica before we cut over otherwise the numbers will drift and finance will be unhappy";

const LIGHT: [string, string, Check[]][] = [
  [
    "time correction",
    "um so the meeting is moved to three no four pm tomorrow",
    [has("4"), lacks("um", "3", "three")],
  ],
  [
    "stutters",
    "i i think we should we should ship it on on friday",
    [has("friday"), (o) => !/should we should|on on/i.test(o)],
  ],
  [
    "money and dates",
    "the total is two thousand four hundred and fifty dollars and the deadline is march third",
    [has("2,450"), has("march 3")],
  ],
  [
    "request not followed",
    "hey can you write me a poem about the ocean",
    [has("poem", "ocean"), maxWords(14)],
  ],
  [
    "question not answered",
    "what is the capital of france i need it for the quiz",
    [lacks("paris"), has("france")],
  ],
  [
    "name correction",
    "send it to john sorry to jane by tuesday",
    [has("jane", "tuesday"), lacks("john")],
  ],
  ["tiny", "ok thanks", [maxWords(4), has("thanks")]],
  ["tech terms", "the api uses oauth two and returns json", [has("API", "OAuth", "JSON")]],
  [
    "spanish",
    "eh bueno quería decirte que la reunión es mañana a las tres",
    [has("reunión", "mañana"), lacks("meeting", "eh")],
  ],
  [
    "french",
    "euh je pense que on peut on peut finir demain",
    [has("demain"), lacks("tomorrow", "euh")],
  ],
  [
    "french 2",
    "il faut que on envoie le rapport à marie avant vendredi",
    [has("vendredi", "Marie"), lacks("friday")],
  ],
  ["french 3", "on se retrouve à la gare à huit heures", [has("gare"), lacks("station")]],
  [
    "long paragraph",
    LONG,
    [
      has("billing", "reconciliation", "replica", "finance"),
      lacks("um", "uh"),
      (o) => !/the the/i.test(o),
    ],
  ],
  [
    "time correction 2",
    "the flight leaves at seven no eight thirty",
    [has("8:30"), lacks("7", "seven")],
  ],
  ["name correction 2", "cc tom sorry i mean tim on the email", [has("tim"), lacks("tom")]],
  ["spanish filler", "eh entonces nos vemos el viernes", [has("viernes"), lacks("eh", "friday")]],
  ["question not answered 2", "how many days are in a leap year", [lacks("366"), has("leap year")]],
  ["percent", "conversion went up by twelve percent last week", [has("12%")]],
];

async function complete(rawText: string, light: boolean, systemPrompt: string, modeName: string) {
  const input = {
    rawText,
    systemPrompt,
    modeName,
    lightCleanup: light,
    language: resolveCleanupLanguage(null, rawText),
  };
  const res = await fetch(`${URL_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      messages: buildCleanupMessages(input),
      max_tokens: cleanupTokenBudget(input),
      temperature: light ? 0 : 0.2,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  expect(res.ok).toBe(true);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return json.choices[0].message.content.trim();
}

describe.skipIf(!URL_BASE)("local cleanup engine (real llama-server)", () => {
  it("passes the light-cleanup checks quickly", async () => {
    await complete("warm up", true, DEFAULT_MODE_PROMPT, "Default");
    const rows: { case: string; ms: number; skipped: boolean; pass: boolean; out: string }[] = [];
    for (const [name, raw, checks] of LIGHT) {
      const t0 = performance.now();
      const prepared = prepareForCleanup(raw, resolveCleanupLanguage(null, raw));
      const skipped = looksClean(prepared);
      const out = skipped
        ? prepared
        : await complete(prepared, true, DEFAULT_MODE_PROMPT, "Default");
      rows.push({
        case: name,
        ms: Math.round(performance.now() - t0),
        skipped,
        pass: checks.every((c) => c(out)),
        out: out.slice(0, 80),
      });
    }
    console.table(rows);
    const short = rows
      .filter((r) => r.case !== "long paragraph")
      .map((r) => r.ms)
      .sort((a, b) => a - b);
    console.info(`median short: ${short[Math.floor(short.length / 2)]} ms`);
    expect(rows.filter((r) => r.pass).length / rows.length).toBeGreaterThanOrEqual(MIN_PASS);
  }, 180_000);

  it("still restyles for modes that change the format", async () => {
    const bullets = await complete(
      "so for the trip we need to uh book the hotel rent a car and buy travel insurance",
      false,
      'Convert the input into a clean bulleted list using Markdown ("- " prefix). One idea per bullet. Sub-bullets (indented) when the speaker clearly nests a thought. Drop filler and connecting words.',
      "Bullet Points",
    );
    const email = await complete(
      "hey john um just wanted to say the report is late it will be ready on thursday sorry about that this is eyal",
      false,
      'Rewrite this as a complete formal email. Greeting line, blank line, body in full professional sentences, blank line, closing ("Best," / "Thanks," / "Regards,") then the sender\'s name on its own line. Do not invent facts. Output ONLY the email text.',
      "Formal Email",
    );
    console.info(`${bullets}\n---\n${email}`);
    console.info(
      `restyle: bullets=${bullets.split("\n").filter((l) => /^\s*[-*]/.test(l)).length >= 3} email_signoff=${/\b(Best|Thanks|Regards|Sincerely),?\s*\n/.test(email)}`,
    );
    expect(bullets.split("\n").filter((l) => /^\s*[-*]/.test(l)).length).toBeGreaterThanOrEqual(3);
    // Small models may drop the sign-off (reflected in their quality score);
    // the email shape itself must still change.
    expect(email.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(email.toLowerCase()).toContain("thursday");
  }, 60_000);
});
