---
"@signalridge/pi-plan-mode": minor
---

`plan_mode_question` now asks a batch as a navigable sequence instead of a one-way run.

The questions still arrive together and are answered one screen at a time, which is the right shape — a single screen holding four multi-option questions does not fit a terminal. What was missing was the navigation: no sense of how many questions remained, and no way back, so a misread option could only be fixed by cancelling the whole batch and making the model ask again.

Each prompt now shows its position (`[2/4]`), and every question after the first offers a Back choice that returns to the previous one. Answers are held by position rather than appended, so revising one overwrites it instead of leaving a stale answer sitting behind its correction. An empty free-form answer now re-asks that question rather than cancelling the batch — opening the editor and thinking better of it is a correction, not a decision to discard everything already answered.

A single question is unchanged: no position marker, and no Back affordance that could only ever cancel. Cancellation semantics are otherwise identical, including the plan-mode-ended check after every prompt.
