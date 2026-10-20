# Evaluation: does Nemotron make the morning report better — without lying?

Code: [`apps-script/Evals.gs`](../apps-script/Evals.gs). Results land in the Google Sheet tabs
`Eval Cases`, `Eval Results`, `Eval Judgments`, `Eval Summary`, `Blind Review`.

![How the evaluation works](diagrams/eval-pipeline_en.png)

## What we compare

For every night the code computes all numbers, verdicts and a **template report** (headline, subline, tip, why).
That template is what the user gets with no AI at all. Nemotron (`nvidia/Nemotron-3_5-Lightning`) gets the same
facts and verdicts and writes its own version, which then passes the code's checks (one retry, then per-field fallback).

So there are three versions of each report:

| Version | What it is |
|---|---|
| **Template** | code only, no AI |
| **Nemotron, first answer** | the model on its own, before any check — how good the model really is |
| **Shown to user** | Nemotron + checks + retry + fallback — what actually arrives in Telegram |

## Cases (26: 3 real nights, 23 synthetic)

| Group | What | Examples |
|---|---|---|
| `real` | real nights from the sensor + Oura since 15 Oct | `R_2026-10-17` |
| `synthetic` | one clear situation each | hot room & body worse · hot room & body fine · stuffy · cold · window open all night · short night with a fine room · perfect room & bad body |
| `broken` | missing or contradictory input | no Oura · no room · no CO₂ sensor · **8-minute sleep fragment (incident INC-001)** · merged broken night · no baseline yet · reed says open while CO₂ says closed |
| `trap` | values that tempt mistakes | CO₂ above threshold 29.6 % (shown as 30 %, rule is ≥ 30 %) · 20.04 °C (shown as 20.0, counts as warm) · zero deep/REM · many numbers at once · everything better than usual |

Cases are frozen into the `Eval Cases` tab first, with the exact model input, so every run and every judge sees the same thing.

## Level 1 — automatic checks (code)

| Check | Hard? | Rule |
|---|---|---|
| numbers | ✅ | every number in `why` appears in the input |
| format | ✅ | length limits, no digits in short fields, English only |
| body | ✅ | headline/subline don't say the body was fine when ≥ 2 sleep metrics were worse (or bad when none were) |
| no_cause | ✅ | no "caused / due to"; no causes at all when < 3 h of sleep was recorded |
| room | ✅ | headline/subline get the room direction right (humidity high/low, warm/cold, stuffy/fresh) |
| hedge | quality | single-night links use "may", "is consistent with", "coincides with" |
| tip_target | quality | the tip addresses the main suspect (heat → radiator/cooling, stuffy → window/air, cold → warming) |
| headline_room | quality | the headline names the right room problem (or none) |

**Hard** checks mean "the report would be wrong". The code must guarantee them for the version shown to the user.

## Level 2 — stability

Each case runs 3 times. We report how often the AI status is the same in all runs and how often all runs pass.

## Level 3 — usefulness (blind)

Two judge models from **different families**, both on Nebius Token Factory:
`nvidia/Nemotron-3-Ultra-550b-a55b` and the first available model from another family
(Qwen3.5-397B, else Qwen3-235B, DeepSeek-V4-Pro, GLM-5.3, Kimi-K3 — the Token Factory catalogue changes, so `Evals.gs` checks `/models` at the start of each run and keeps the same judges for the whole run).

- The judge sees the facts and verdicts and two reports, **X** and **Y**, without knowing which is AI.
- Rubric, 1–5 each: accuracy · explanation · actionability · clarity · honesty; then a winner (X / Y / tie).
- **Every pair is judged twice** — Nemotron as X, then as Y. If the verdict flips with the order, it counts as a tie,
  and the flip rate is reported as the judge's self-consistency.
- Temperature 0, reasoning off, strict JSON.
- We also report how often the two judges agree.

I do the same comparison by hand in the `Blind Review` tab (order randomised, key hidden).

## What the evals already found (before any real model call)

Running the pipeline offline on the cases exposed three bugs in the **code**, not the model:

1. The template said **"solid night"** when two sleep metrics were worse than usual (threshold was 3).
2. With no bedroom data, the template said **"The room wasn't the problem tonight"** — a claim with no data behind it.
3. A **cold room had no room→body link at all**, so the model was told "no clear link" even when sleep got worse.

The first live quick check (2 cases, real models) found one more thing: Nemotron wrote **"humidity low"** in a subline
when humidity was **69 %** (above the 40–60 % range) — and **both judge models gave that report 5/5 for accuracy**.
LLM judges miss direction errors in short phrases, so the code now checks direction (humidity high/low, warm/cold,
stuffy/fresh) in the headline and subline as a hard check, before the report is sent.

The first full run found two more:
- Nemotron advised **"Open window wider"** on a night when the window had been open 100 % of the time. One judge caught it in
  one order and missed it in the other. Now a hard check (`tip_contradiction`).
- Our own direction check was **too strict**: it rejected "cool room" at 18.4 °C, which is true (cool is in the sleep range).
  Fixed so only strong words (cold, chilly, hot, too warm) count as wrong when the temperature is in range. The published
  numbers come from the run after this fix.

And the real incident of 19 Oct (INC-001) became a test case: Nemotron wrote *"Your body coped — the room didn't"*
on an 8-minute sleep fragment with 5 worse metrics — it copied an example phrase from its own prompt.
The `body` and `no_cause` checks now catch exactly this.

## Results

### v1 — Nemotron writes from facts (run `20261019-1223`, Code_v2.gs 2.1.3)

[`eval-results/2026-10-19_v1_summary.csv`](eval-results/2026-10-19_v1_summary.csv) · 26 cases × 3 runs · judges Nemotron-3-Ultra and Qwen3.5-397B

| | Template (no AI) | Nemotron, first answer | Shown to user |
|---|---|---|---|
| Hard checks (no lies) | 100 % | 63 % | **100 %** |
| Invented numbers | 0 | **0 / 78** | 0 |

| Judge | Nemotron wins | Template wins | Tie / order-dependent |
|---|---|---|---|
| Nemotron-3-Ultra | 27 % | 46 % | 27 % |
| Qwen3.5-397B | 35 % | 54 % | 12 % |

Judges agree with each other on 18 / 18 stable cases; self-consistency 81 %.
**By group:** Nemotron wins **61 %** of clear single-situation nights (synthetic), but only 17 % of broken-input cases and 13 % of traps.

**Why it lost** (from the judges' reasons): almost always the **tip** or a **link the code had not found**.
The model chose the advice itself and defaulted to "open the window" — even in a 14.8 °C room, with no room data,
or when everything was fine — and it named causes where the code had written "no clear link" or "no baseline yet".
Our own prompt primed this: it listed "radiator, window, light, bedtime" as example tips.

### v2 — the code writes a correct draft, Nemotron rewrites it (Code_v2.gs 2.2.0)

- Nemotron gets the code's draft (meaning, links, the tip's action) and rewrites it warmer and more concrete; it may add INPUT numbers.
- New hard checks: the tip carries the code's action and nothing against it (`tip_mismatch`); when the code found no link, "why" says so (`missed_no_link`); humidity/CO₂ direction is also checked in "why"; "bright" in a dark room is rejected.
- A code gap found on the way: good rooms with better-than-usual sleep had no positive link — added.
- Replaying v1's real answers through the new checks: template flagged **0 / 26**; v1 answers in lost cases flagged **29 / 42**.

Run `20261019-1241` · [`eval-results/2026-10-19_v2_summary.csv`](eval-results/2026-10-19_v2_summary.csv)

![Judges' verdicts v1 vs v2](diagrams/eval-v1-v2_en.png)

| | Template (no AI) | Nemotron, first answer | Shown to user |
|---|---|---|---|
| Hard checks (no lies) | 100 % | **77 %** (v1: 63 %) | 100 % |
| Tip gives the code's action | 100 % | 92 % | 100 % |
| Says so when there is no link | 100 % | 100 % | 100 % |
| Invented numbers | 0 | 1 / 78 | 0 |

| Judge | Nemotron better | Template better | Tie / order-dependent |
|---|---|---|---|
| Nemotron-3-Ultra | **42 %** (v1: 27 %) | **4 %** (v1: 46 %) | 54 % |
| Qwen3.5-397B | **38 %** (v1: 35 %) | **8 %** (v1: 54 %) | 54 % |

| Criterion (1–5) | Ultra: Nemotron vs template | Qwen: Nemotron vs template |
|---|---|---|
| accuracy | 4.90 vs 4.77 | 4.96 vs 4.87 |
| explanation | **4.65 vs 4.21** | **4.83 vs 4.37** |
| actionability | 4.12 vs 3.96 | 4.50 vs 4.52 |
| clarity | 4.94 vs 4.88 | 4.88 vs 4.81 |
| honesty | 4.92 vs 4.79 | 4.92 vs 4.81 |

By group, Nemotron's share of stable verdicts: real 67 % · clear situations 64 % · broken input 56 % · traps 100 %.
Stability: same AI status in all 3 runs for 88 % of cases (v1: 69 %).

**Reading it honestly.** v2 removed what made Nemotron lose: the template now almost never wins. Ties rose to 54 % because both
versions say the same thing and differ in wording; judge self-consistency fell from 81 % to 60 % for the same reason — the closer the
pair, the more the position decides, which is why both orders are always judged. 23 of 26 cases are synthetic.

**Example — cold room (14.8 °C), awake time and deep sleep worse:**

| | tip | judges |
|---|---|---|
| template | warm the room a little before bed. | — |
| v1 | Open a window slightly before bed | 0 / 4 for Nemotron |
| v2 | Warm the room a little before bed — *"Your body felt the chill"* | 4 / 4 for Nemotron |

**Next weak spot:** for a hot room v2 sometimes says "open the window or use a fan" where the judges prefer "radiator down"
(the window had been closed all night).
