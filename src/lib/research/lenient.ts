/**
 * The model sometimes sends tool arguments in the wrong shape: snake_case names, a wrapper object
 * ({"note": {...}}), a different key for the same thing ("source_url" for "url"), or a question's
 * text where a number was asked for. A run that rejects every such call stalls, so each tool
 * normalises what it receives before validating it.
 */

const camel = (key: string) => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

type Bag = Record<string, unknown>;

function asBag(raw: unknown): Bag | undefined {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Bag).map(([key, item]) => [camel(key), item]));
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const first = (...values: unknown[]) => values.find((value) => value !== undefined && value !== null && value !== "");

export function normalizeNote(raw: unknown): unknown {
  const bag = asBag(raw);
  if (!bag) return raw;
  // {"note": {...}} wraps the real fields.
  const inner = bag.note && typeof bag.note === "object" && !Array.isArray(bag.note) ? asBag(bag.note) : undefined;
  const o: Bag = inner ? { ...bag, ...inner, note: undefined } : bag;
  const url = first(o.url, o.sourceUrl, o.link, o.source, o.pageUrl);
  const body = [text(o.note), text(o.summary), text(o.finding), text(o.content), text(o.text), text(o.description), text(o.context)]
    .filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index)
    .join(" — ");
  return {
    url,
    title: first(o.title, o.sourceTitle, o.name, o.pageTitle) ?? url,
    subQuestion: first(o.subQuestion, o.subquestion, o.question, o.q, o.sub) ?? 1,
    note: body || text(o.quote) || "(no summary given)",
    quote: first(o.quote, o.quotation, o.excerpt, o.passage, o.verse),
  };
}

export function normalizeReport(raw: unknown): unknown {
  if (typeof raw === "string") {
    const bag = asBag(raw);
    return bag ? normalizeReport(bag) : { markdown: raw };
  }
  const bag = asBag(raw);
  if (!bag) return raw;
  const inner = Object.keys(bag).length === 1 ? asBag(Object.values(bag)[0]) : undefined;
  const o = inner ?? bag;
  return { markdown: first(o.markdown, o.report, o.reportMarkdown, o.content, o.text, o.body, o.output) };
}

export function normalizePlan(raw: unknown): unknown {
  const bag = asBag(raw);
  if (!bag) return raw;
  const inner = Object.keys(bag).length === 1 ? asBag(Object.values(bag)[0]) : undefined;
  const o = inner ?? bag;
  const listOf = (value: unknown) =>
    Array.isArray(value) ? value.map((item) => text(item)).filter((item): item is string => Boolean(item)) : text(value) ? [text(value)!] : undefined;
  const title = text(first(o.reportTitle, o.title, o.name));
  const questions = listOf(first(o.subQuestions, o.questions, o.subquestions));
  return {
    reportTitle: title ?? "Research report",
    subQuestions: questions && questions.length > 0 ? questions : [title ?? "The question as asked"],
    searchTerms: listOf(first(o.searchTerms, o.terms, o.keywords, o.queries)) ?? [title ?? "dharma"],
  };
}

/** Passes everything through, only repairing key names and one level of wrapping. */
export function normalizeLoose(raw: unknown): unknown {
  const bag = asBag(raw);
  if (!bag) return raw ?? {};
  const keys = Object.keys(bag);
  const only = keys.length === 1 ? asBag(bag[keys[0]]) : undefined;
  return only ?? bag;
}

/** Resolves a sub-question given as a number, a numeric string, or the question's own words. */
export function resolveSubQuestion(value: unknown, subQuestions: string[]): number {
  const count = Math.max(subQuestions.length, 1);
  const asNumber = typeof value === "number" ? value : typeof value === "string" && /^\s*q?\d+\s*$/i.test(value) ? Number(value.replace(/\D/g, "")) : NaN;
  if (Number.isInteger(asNumber) && asNumber >= 1) return Math.min(asNumber, count);
  if (typeof value === "string" && subQuestions.length > 0) {
    const words = (input: string) => new Set(input.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    const wanted = words(value);
    let best = 1;
    let bestScore = 0;
    subQuestions.forEach((question, index) => {
      const have = words(question);
      const shared = [...wanted].filter((word) => have.has(word)).length;
      const score = shared / Math.max(wanted.size, have.size, 1);
      if (score > bestScore) {
        bestScore = score;
        best = index + 1;
      }
    });
    return best;
  }
  return 1;
}
