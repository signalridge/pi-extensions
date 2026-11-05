import { stripVTControlCharacters } from "node:util";
import type { ModelPairCount, ResponseStats } from "./storage/queries.js";

const PREVIEW_PAIRS = 6;

/** The initial list holds the statistics row and at most six pairs. Kit may
 * show fewer at compact heights; its range indicator tracks that overflow. */
export function responsePreviewLines(stats: ResponseStats): string[] {
  return [
    `${stats.count} cycles · ${stats.llmCalls} LLM calls · average ${decimal(stats.average)} · P95 ${stats.p95}`,
    `Initial preview: up to ${PREVIEW_PAIRS} pairs; ${Math.max(0, stats.modelPairs.length - PREVIEW_PAIRS)} more pairs hidden (page/search).`,
    "Requested -> reported; missing reports are not matches.",
  ];
}

/** Small review source; Kit owns live-height scrolling, paging, keys and themes. */
export function responseReviewContent(stats: ResponseStats): string {
  const pairs = stats.modelPairs;
  return [
    `${stats.count} cycles · ${stats.llmCalls} LLM calls`,
    `Calls/cycle: average ${decimal(stats.average)} · median ${decimal(stats.median)} · P95 ${stats.p95} · maximum ${stats.maximum}`,
    `Distribution: 1 call ${stats.distribution.one} · 2–3 ${stats.distribution.twoToThree} · 4–6 ${stats.distribution.fourToSix} · 7+ ${stats.distribution.sevenPlus}`,
    "",
    "Requested -> explicitly reported model (calls)",
    ...pairs
      .slice(0, PREVIEW_PAIRS)
      .map((pair) => `${pair.count} · ${preview(modelPairLabel(pair))} · ${modelPairStatus(pair)}`),
    ...(pairs.length === 0 ? ["No model pairs in this range."] : []),
    `${Math.max(0, pairs.length - PREVIEW_PAIRS)} model pairs hidden from preview.`,
    "Missing reports are unknown, not matches. Return to the list to browse all pairs.",
  ].join("\n");
}

export function responsePairItems(pairs: readonly ModelPairCount[]) {
  return pairs.map((pair, index) => ({
    // Stable within this immutable range snapshot; never use untrusted model text as a route.
    id: `pair-${index}`,
    label: preview(modelPairLabel(pair)),
    searchText: modelPairLabel(pair),
    statusText: `${pair.count} calls · ${modelPairStatus(pair)}`,
    detailDocument: {
      format: { kind: "text" as const },
      content: [
        `Requested provider: ${display(pair.provider ?? "unknown")}`,
        `Requested model: ${display(pair.model ?? "unknown")}`,
        `Reported model: ${pair.responseModel === undefined ? "not reported" : display(pair.responseModel)}`,
        `Relationship: ${modelPairStatus(pair)}`,
        `Calls: ${pair.count}`,
        "",
        "Requested identity is the finalized assistant's concrete dispatch, not initial model selection.",
        "Reported identity is only AssistantMessage.responseModel; no provider identity or equivalence is inferred.",
        "Metadata only; token and cost accounting is unchanged. No repricing or provider lookup.",
      ].join("\n"),
    },
  }));
}

function modelPairLabel(pair: ModelPairCount): string {
  return `${display(pair.provider ?? "unknown")}/${display(pair.model ?? "unknown")} -> ${pair.responseModel === undefined ? "not reported" : display(pair.responseModel)}`;
}

function modelPairStatus(pair: ModelPairCount): string {
  if (pair.responseModel === undefined) return "Not reported";
  if (pair.model === undefined) return "Request unknown";
  return pair.model === pair.responseModel ? "Same ID" : "Different ID";
}

function display(value: string): string {
  // Also sanitize bidi controls before text becomes search metadata or RPC labels.
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
}

function preview(value: string): string {
  const points = Array.from(value);
  return points.length <= 80 ? value : `${points.slice(0, 79).join("")}…`;
}

function decimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}
