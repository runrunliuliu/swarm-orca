# Discussion: when several agents should argue, and how it ends

Applies to questions the user wants debated, cross-reviewed, or answered by an independent second
opinion. It also applies when you are deciding whether to propose that yourself. It grants no
operations, budget, concurrency or write access.

This is the single source for the protocol. Roles, permissions, commands, startup, concurrency and
lifecycle stay with the existing contracts and the version-matched runtime guides; do not restate
or fork them here. A discussion is one read-only review mode, not a second orchestration system and
not a new scheduling identity.

## 1. Default: do not convene

Settle the question with one agent, one check, or one small experiment whenever that is enough. The
eligibility judgement starts no execution flow; it only returns a verdict and the missing inputs.

Disqualifiers — any one ends it:

- one verification settles it (test, command, authoritative document, log);
- the work is execution, style preference, a single localized edit, or a mechanical migration;
- what is missing is information, not judgement;
- the question is an existing owner's already-decided call with no open trade-off;
- the budget or deadline cannot fund two full exchanges;
- no actionable next step can come out of a conclusion.

The last disqualifier does not cover discussing the *risk* of an existing decision. That is a
different question from re-deciding it.

## 2. Escalation must be argued item by item

Every item is required. One missing item means no escalation:

1. the decision, and the default plan if nobody discusses it;
2. the specific error that would be missed, and its impact — separated into existing evidence and
   unverified risk hypothesis, so an invented disaster cannot authorize itself;
3. the assumption or blind spot the independent view will test;
4. why the cheaper alternative is insufficient, written as a concrete action (which test, which log),
   not "check it";
5. the conclusion's owner, who must already hold the relevant authorization; the discussants cannot
   appoint themselves or each other;
6. total budget and deadline, counted per decision.

## 3. Eligibility is not authorization

A verdict that a question deserves discussion authorizes nothing. Starting Agents, creating a Run,
writing files, merging, deploying and restarting each keep their own authorization and gates. Never
read a verdict, a decision record, or a resolved gate as permission to act.

## 4. Default panel; debate only for opposing claims

Run an independent panel with drafts invisible to each other. Use debate only when incompatible
claims already exist and each has support. Model or effort selection does not create a supervisor.

Record independence as four separate facts — author isolation, draft visibility, context exposure,
model diversity. A same-model, same-context self-rebuttal is not independent corroboration, but it
is not worthless either; record what it actually was rather than scoring it zero.

## 5. Exchange cap

One exchange is one complete round trip of positions and evidence between the parties. The second
and later exchanges cover only the open points that can still change the conclusion.

The shared default is two exchanges. A deployment policy may set a different cap; the effective cap
is a policy value, not part of this protocol, and the record states which one applied. A cap is an
upper bound, never a target: end as soon as an exchange produces no increment that affects the
conclusion.

Investigation, experiments, synthesis, adjudication and rework are not extra exchanges. They draw on
the same total budget and the same deadline.

## 6. One decision owner, fixed before the first exchange

Fix in advance: the owner, who adjudicates without taking part in the argument, the evaluation
criteria, and the permission scope. Adjudication confers no new permission. Where a non-participant
judges, they must already hold decision authority for that domain; a coordinator only qualifies
when it is not a party. If the only authorized owner is a participant, non-participants produce
recommendations only, and the outcome is `escalate-value-choice`.

Adjudicate by the fixed criteria, item by item, with reasons — never by vote count or confidence.
Do not introduce a new option or new decisive fact in the final turn; mark it as unverified and
carry it forward.

The record lists the items that will not be revisited while the current baseline and dependencies
hold, and tags each next step as one of: covered by verified existing authorization, run under the
existing gates; confirmed outside that authorization, needs separate authorization; authorization
unverified, pause that action and return it to the original responsible party. A dependency lapsing
reopens the item under rule 8. These tags grant nothing.

## 7. One fixed-shape record

Write these fields in this order:

1. decision and baseline;
2. options and the evidence for each;
3. open points;
4. conclusion and reasons;
5. end state — `decided`, `insufficient-evidence`, `escalate-value-choice`, or `stopped-budget`;
6. next-step owner and the original authorization it rests on;
7. invalidation and reopen conditions;
8. archival state.

Never force a choice at the deadline. Packaging missing evidence as a conclusion is a false
convergence and costs more than no conclusion. `insufficient-evidence` and `escalate-value-choice`
are legitimate outcomes with named owners:

| State | Meaning | Owner | Reopen |
| --- | --- | --- | --- |
| `decided` | a call was made, with reasons and invalidation conditions | original owner | invalidation condition triggers or is falsified |
| `insufficient-evidence` | neither side's evidence distinguishes the options | original responsible party (investigate or experiment) | new evidence separates the options |
| `escalate-value-choice` | the split is priority or permission, not evidence | owner holding decision authority | owner changes the priority |
| `stopped-budget` | budget or deadline exhausted | original owner | budget is re-approved |

A read-only request never gains write access from "the record must be archived". Deliver the record
in the answer, and mark it `pending archival` until an already-authorized party persists it.
"Recorded" is not "written and archived".

## 8. Reopening does not reset the account

Identify each decision with a stable identifier, and treat the decision point, baseline and key
evidence set as revisable fields. Renaming the question, replacing participants, switching worktree
or Run, or revising a field does not create a fresh cumulative account.

Resume only when one of these holds: the baseline changed in a way that affects the conclusion, a
recorded invalidation condition triggered, new evidence separates the options, the authorized owner
supplies a pending value or permission choice, or the budget or deadline was approved differently.
Append the reason to the original record.

Resuming does not start another exchange. If one is genuinely needed, re-check eligibility and
authorization first, and keep accumulating elapsed time, tokens and starts; a budget adjustment does
not zero past consumption.

## Deployment policy values

A deployment policy may fix four values; it must not restate this protocol, roles or permissions:

- the default exchange cap;
- whether discussions are read-only by default, or may write inside an already-authorized scope;
- the concurrency cap shared with any enclosing Run, recorded as a maximum, never as a target;
- the default agent, and the model only when the owner named one.

Whatever a policy sets is recorded in the decision record along with the authorization it came from.
A policy default never authorizes a launch, and it does not survive into a decision that the record
does not name. Where a policy default conflicts with an explicit user instruction in the current
task, the instruction wins.

## Promoting this into a standalone skill

Only after at least two recorded routing failures — the user asked for a discussion and this entry
was not loaded or returned no verdict — and after showing that the entry description cannot be
corrected instead. Installing anything new is separately authorized.
