/**
 * builtins.ts — the five curated built-in workflow patterns.
 *
 * `deep-research` · `adversarial-review` · `code-review` · `multi-perspective`
 * · `codebase-audit`. Each descriptor builds a static script that reads its
 * inputs from `args`, so caller input is never interpolated into source (no
 * escaping hazards). The scripts are written once here and reached through both
 * the `workflow` tool's `name` input and the `/name` slash commands, so the two
 * entry points cannot drift apart.
 *
 * Divergence from upstream: upstream injects host-side `web_search`/`web_fetch`
 * tools for deep research; we do not — agents reach web access through their
 * own configured tools (pi-web-access / MCP). Documented in the README.
 */

export interface BuiltinWorkflowDescriptor {
  /** Also the slash-command name (without the leading `/`). */
  name: string;
  description: string;
  script: string;
  /**
   * The `args` key that a bare slash-command argument fills.
   *
   * Each script reads its own named inputs (`question`, `task`, `topic`, …) and
   * none of them reads a generic `prompt`, so the command handler must know
   * which key the user's text belongs in. Getting this wrong is silent: the
   * script simply runs with an empty input and still fans out agents.
   *
   * `code-review` is the exception — its `diff` is not something a user types,
   * so its command resolves a diff first (see `code-review-scope.ts`) and
   * passes `diff` plus `diffSource` itself.
   */
  primaryArg: string;
}

const DEEP_RESEARCH_SCRIPT = `export const meta = {
  name: 'deep_research',
  description: 'Deep research: parallel queries, cross-checked claims, cited report',
  phases: [
    { title: 'Queries' },
    { title: 'Gather' },
    { title: 'Verify' },
    { title: 'Report' },
  ],
}

const question = (args && args.question) || ''
const angles = (args && args.angles) || 4
const minSupport = (args && args.minSupport) || 2

phase('Queries')
const plan = await agent(
  'You are planning web research for this question:\\n' + question +
  '\\n\\nProduce ' + angles + ' diverse, specific search queries that together cover the question from different angles. ' +
  'Use your web search tools when helpful to refine them.',
  { label: 'plan queries', schema: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] } }
)
const planned = plan && Array.isArray(plan.queries) ? plan.queries.filter((q) => typeof q === 'string' && q.trim().length > 0) : []
const queries = (planned.length > 0 ? planned : [question]).slice(0, angles)

phase('Gather')
const gathered = await parallel(queries.map((q, i) => () =>
  agent(
    'Research this query using your web search and fetch tools.\\nQuery: ' + q +
    '\\n\\nSteps: (1) run a web search for the query; (2) fetch the most relevant result URLs; ' +
    '(3) extract concrete, verifiable factual claims, each tagged with the exact source URL it came from. ' +
    'Do NOT invent sources or claims — report only what the fetched pages actually say.',
    { label: 'research ' + (i + 1), schema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, claims: { type: 'array', items: { type: 'string' } } }, required: ['url', 'claims'] } } }, required: ['sources'] } }
  )
))
const allSources = gathered.filter(Boolean).flatMap((g) => (g && g.sources) || [])

phase('Verify')
const verdict = await agent(
  'Cross-check these research sources. Group claims that assert the same fact across different source URLs. ' +
  'Keep a claim only if it is supported by at least ' + minSupport + ' distinct source URLs OR by one clearly authoritative source. ' +
  'Discard claims found in a single weak source or that conflict with others.\\n\\nSOURCES JSON:\\n' + JSON.stringify(allSources),
  { label: 'cross-check', schema: { type: 'object', properties: { supported: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } }, required: ['claim', 'sources'] } }, discarded: { type: 'array', items: { type: 'string' } } }, required: ['supported'] } }
)

phase('Report')
const report = await agent(
  'Write a concise, well-structured research report that answers the question using ONLY the supported claims below. ' +
  'Cite source URLs inline next to each claim. If the evidence is thin, say so explicitly.\\n\\n' +
  'QUESTION: ' + question + '\\n\\nSUPPORTED CLAIMS JSON:\\n' + JSON.stringify((verdict && verdict.supported) || []),
  { label: 'write report' }
)

return { question, queries, supported: (verdict && verdict.supported) || [], report }`;

const ADVERSARIAL_REVIEW_SCRIPT = `export const meta = {
  name: 'adversarial_review',
  description: 'Adversarial review: findings cross-checked by independent skeptics',
  phases: [
    { title: 'Investigate' },
    { title: 'Refute' },
    { title: 'Consensus' },
  ],
}

const task = (args && args.task) || ''
const reviewers = (args && args.reviewers) || 2
const threshold = (args && args.threshold) || 0.5

phase('Investigate')
const investigation = await agent(
  'Investigate the following and list concrete, individually-checkable findings:\\n' + task,
  { label: 'investigate', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } }
)
const findings = (investigation && Array.isArray(investigation.findings) ? investigation.findings : [])

phase('Refute')
const judged = await parallel(findings.map((f, i) => () =>
  parallel(Array.from({ length: reviewers }, (_, r) => () =>
    agent(
      'You are a skeptical reviewer. Try to REFUTE this finding for the task below. ' +
      'Default to real=false when uncertain. Investigate with the available tools if needed.\\n\\n' +
      'TASK: ' + task + '\\nFINDING: ' + f,
      { label: 'refute ' + (i + 1) + '.' + (r + 1), schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real'] } }
    )
  )).then((votes) => {
    const valid = votes.filter(Boolean)
    const realCount = valid.filter((v) => v && v.real).length
    const ratio = valid.length ? realCount / valid.length : 0
    return { finding: f, realVotes: realCount, totalVotes: valid.length, survives: ratio >= threshold }
  })
))

phase('Consensus')
const survivors = judged.filter(Boolean).filter((j) => j.survives)
const report = await agent(
  'Synthesize the surviving findings into a concise review. For each finding, note the skeptic agreement ' +
  '(realVotes/totalVotes). Do not include findings that failed the refutation pass.\\n\\n' +
  'TASK: ' + task + '\\n\\nSURVIVING FINDINGS JSON:\\n' + JSON.stringify(survivors),
  { label: 'consensus report' }
)

return { findings, judged: judged.filter(Boolean), survivors, report }`;

const CODE_REVIEW_SCRIPT = `export const meta = {
  name: 'code_review',
  description: 'Multi-angle parallel code review with a verify pass',
  phases: [
    { title: 'Scan' },
    { title: 'Verify' },
    { title: 'Report' },
  ],
}

const diff = (args && args.diff) || ''
const diffSource = (args && args.diffSource) || 'provided diff'

phase('Scan')
const finders = await parallel([
  () => agent('You are a correctness reviewer. Find bugs, race conditions, error-handling gaps, and edge-case failures in this diff.\\n\\n' + diff, { label: 'correctness', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } }),
  () => agent('You are a reuse reviewer. Find duplicated logic, reinvented wheels, and missed opportunities to reuse existing code or libraries.\\n\\n' + diff, { label: 'reuse', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } }),
  () => agent('You are a simplification reviewer. Find over-engineering, unnecessary complexity, and simpler alternatives.\\n\\n' + diff, { label: 'simplification', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } }),
  () => agent('You are an efficiency reviewer. Find performance problems, avoidable allocations, and scaling risks.\\n\\n' + diff, { label: 'efficiency', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } }),
  () => agent('You are an architecture reviewer. Assess the change at the right altitude: design fit, layering, boundaries, and future maintenance.\\n\\n' + diff, { label: 'altitude', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } }),
])
const candidates = finders.filter(Boolean).flatMap((f) => (f && f.findings) || [])

phase('Verify')
const verified = await parallel(candidates.map((finding, i) => () =>
  agent('You are a skeptical verifier. For this candidate finding, check whether it is a REAL issue in the diff. ' +
    'Default to real=false when uncertain.\\n\\nCANDIDATE: ' + finding + '\\n\\nDIFF:\\n' + diff,
    { label: 'verify ' + (i + 1), schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real'] } })
))

phase('Report')
const ranked = candidates
  .map((finding, i) => ({ finding, verified: verified[i] }))
  .filter((item) => item.verified && item.verified.real)
const report = await agent(
  'Write a ranked code review report for this diff (' + diffSource + '). ' +
  'Include only verified findings, ordered by severity, each with a concrete location and fix suggestion.\\n\\n' +
  'VERIFIED FINDINGS JSON:\\n' + JSON.stringify(ranked),
  { label: 'final report' }
)

return { candidates, ranked, report }`;

const MULTI_PERSPECTIVE_SCRIPT = `export const meta = {
  name: 'multi_perspective',
  description: 'Evaluate a topic from multiple independent perspectives',
  phases: [
    { title: 'Perspectives' },
    { title: 'Synthesis' },
  ],
}

const topic = (args && args.topic) || ''
const perspectives = (args && Array.isArray(args.perspectives) && args.perspectives.length > 0 ? args.perspectives : ['technical', 'product', 'security', 'user experience', 'maintainability'])

phase('Perspectives')
const views = await parallel(perspectives.map((p, i) => () =>
  agent('Evaluate this topic from the perspective of: ' + p + '. Be concrete and specific; note risks, trade-offs, and what matters most from this angle.\\n\\nTOPIC: ' + topic,
    { label: 'perspective ' + (i + 1), schema: { type: 'object', properties: { angle: { type: 'string' }, points: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } } }, required: ['angle', 'points', 'risks'] } })
))

phase('Synthesis')
const synthesis = await agent(
  'Synthesize these perspectives into a balanced assessment. Identify where perspectives agree, where they conflict, and give a bottom-line recommendation with the key trade-offs.\\n\\nTOPIC: ' + topic + '\\n\\nPERSPECTIVES JSON:\\n' + JSON.stringify(views.filter(Boolean)),
  { label: 'synthesis' }
)

return { views: views.filter(Boolean), synthesis }`;

const CODEBASE_AUDIT_SCRIPT = `export const meta = {
  name: 'codebase_audit',
  description: 'Audit a codebase for health, risk, and debt across dimensions',
  phases: [
    { title: 'Map' },
    { title: 'Audit' },
    { title: 'Report' },
  ],
}

const root = (args && args.root) || cwd
const focus = (args && args.focus) || ''

phase('Map')
const map = await agent(
  'Explore the codebase at ' + root + ' and produce a structural map: top-level modules, entry points, ' +
  'data flow, and where complexity concentrates. Use the available file tools.\\n' +
  (focus ? 'Focus area: ' + focus + '\\n' : ''),
  { label: 'map', schema: { type: 'object', properties: { modules: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, purpose: { type: 'string' }, risk: { type: 'string' } }, required: ['name', 'purpose'] } }, entryPoints: { type: 'array', items: { type: 'string' } }, complexityHotspots: { type: 'array', items: { type: 'string' } } }, required: ['modules'] } }
)

phase('Audit')
const audits = await parallel([
  () => agent('Audit this codebase for correctness risks: error handling, boundary conditions, concurrency, security. Use file tools.\\n\\nSTRUCTURE:\\n' + JSON.stringify(map), { label: 'correctness', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } }, severity: { type: 'string' } }, required: ['findings'] } }),
  () => agent('Audit this codebase for maintainability: coupling, duplication, naming, test coverage, documentation. Use file tools.\\n\\nSTRUCTURE:\\n' + JSON.stringify(map), { label: 'maintainability', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } }, severity: { type: 'string' } }, required: ['findings'] } }),
  () => agent('Audit this codebase for operational health: dependencies, build, deployment, observability, secrets handling. Use file tools.\\n\\nSTRUCTURE:\\n' + JSON.stringify(map), { label: 'operations', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } }, severity: { type: 'string' } }, required: ['findings'] } }),
])

phase('Report')
const report = await agent(
  'Write a codebase health audit report: overall health score, ranked findings across dimensions with concrete locations, ' +
  'and a prioritized remediation roadmap.\\n\\nSTRUCTURE:\\n' + JSON.stringify(map) + '\\n\\nAUDITS JSON:\\n' + JSON.stringify(audits.filter(Boolean)),
  { label: 'audit report' }
)

return { map, audits: audits.filter(Boolean), report }`;

export const BUILTIN_WORKFLOWS: Readonly<Record<string, BuiltinWorkflowDescriptor>> = {
  "deep-research": {
    name: "deep-research",
    description: "Deep research: parallel queries, cross-checked claims, cited report",
    script: DEEP_RESEARCH_SCRIPT,
    primaryArg: "question",
  },
  "adversarial-review": {
    name: "adversarial-review",
    description: "Adversarial review: findings cross-checked by independent skeptics",
    script: ADVERSARIAL_REVIEW_SCRIPT,
    primaryArg: "task",
  },
  "code-review": {
    name: "code-review",
    description: "Multi-angle parallel code review with a verify pass",
    script: CODE_REVIEW_SCRIPT,
    primaryArg: "diff",
  },
  "multi-perspective": {
    name: "multi-perspective",
    description: "Evaluate a topic from multiple independent perspectives",
    script: MULTI_PERSPECTIVE_SCRIPT,
    primaryArg: "topic",
  },
  "codebase-audit": {
    name: "codebase-audit",
    description: "Audit a codebase for health, risk, and debt across dimensions",
    script: CODEBASE_AUDIT_SCRIPT,
    // `root` already defaults to cwd, so free text is the more useful refinement:
    // "/codebase-audit packages/pi-goal" reads as a focus the map agent honours.
    primaryArg: "focus",
  },
};

/**
 * Every `args.<key>` a builtin script reads, keyed by workflow name.
 *
 * Kept next to the scripts so a test can assert that each `primaryArg` is a key
 * its script actually consumes — the failure mode this guards against is silent
 * (an unread key means an empty input, not an error).
 */
export const BUILTIN_SCRIPT_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
  "deep-research": ["angles", "minSupport", "question"],
  "adversarial-review": ["reviewers", "task", "threshold"],
  "code-review": ["diff", "diffSource"],
  "multi-perspective": ["perspectives", "topic"],
  "codebase-audit": ["focus", "root"],
};
