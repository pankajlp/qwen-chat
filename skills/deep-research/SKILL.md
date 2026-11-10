---
name: deep-research
description: Research a question across many web sources and write a sourced report. Use when the user asks to research, investigate, compare options, review evidence or "find out everything about" a topic, and the answer needs more than one or two searches.
---

# Deep research

Written for Qwen Chat. You have `web_search` and `web_fetch` (and in Code mode `write_file` for saving the report).

## 1. Pin down the question
Restate what the user wants in one or two sentences: the decision or question, the scope (time period, region, audience) and what a good answer looks like. If something essential is ambiguous, ask one short question before searching; otherwise state your assumption and go.

## 2. Plan the angles
Write 3 to 6 sub-questions that together answer the main one, for example: definitions and background, the strongest evidence for, the strongest evidence against, recent developments, costs or numbers, expert disagreement. In agent mode, record them with `update_plan`.

## 3. Search wide, then deep
For each sub-question:
- Run 2 or more searches with different wording. Prefer primary sources: official sites, papers, datasets, documentation, filings, first-hand reporting.
- Open the most promising pages with `web_fetch` and read them. Do not rely on search snippets for facts.
- Keep notes as you go: claim, number, source title, URL, date.
- Follow good leads (a cited study, an official report) one hop further.
Stop a sub-question when new sources only repeat what you have.

## 4. Check before you write
- Every important claim needs a source you actually opened. Numbers need the exact source.
- Where sources disagree, say so and explain why (different dates, definitions, methods, incentives).
- Note how recent each key source is; flag anything that may be outdated.
- Separate what the evidence shows from your own judgement.
- If you could not find something, say so. Never fill gaps from memory and present it as sourced.

## 5. Write the report
- **Answer first**: 2 to 4 sentences that directly answer the question.
- **Findings**: one short section per sub-question, with inline citations like [1].
- **Where sources disagree / uncertainty**: what is unsettled and why.
- **Recommendation or next steps**, if the user is making a decision.
- **Sources**: numbered list with title, publisher or author, date and URL.
Keep it as short as the question allows. Plain language, no filler.

## Limits
Be honest about what you could not access (paywalls, pages that would not load) and about how many sources you read.
