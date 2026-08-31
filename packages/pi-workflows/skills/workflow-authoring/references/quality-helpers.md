# Verify and judge

Keep work IDs outside helper results that may omit failed agents.

| Call | Contract |
| --- | --- |
| `verify(item, { reviewers: number, threshold: number, lens: string | string[], strength })` | Defaults: 2 reviewers, inclusive `0.5`, one lens or a cycled array, and `strength: "low"` — reviewers are numerous and narrow, and the vote carries the gate rather than any one reviewer's depth. Returns `{ real, realCount, total, votes }`. Failed reviewers are omitted; successful votes are the denominator; zero survivors means `real: false`. |
| `judgePanel(attempts, { judges: number, rubric: string, strength })` | Defaults: 3 judges, `"overall quality and correctness"`, and `strength: "low"`. Failed judgments are omitted. Returns the highest mean `{ index, attempt, score, judgments }`; input order wins ties; empty input returns `undefined`. |
