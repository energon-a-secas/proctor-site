<div align="center">

# Proctor

Run any exam from a JSON or YAML file

[![Live][badge-site]][url-site]
[![HTML5][badge-html]][url-html]
[![CSS3][badge-css]][url-css]
[![JavaScript][badge-js]][url-js]
[![Claude Code][badge-claude]][url-claude]
[![License][badge-license]](LICENSE)

[badge-site]:    https://img.shields.io/badge/live_site-0063e5?style=for-the-badge&logo=googlechrome&logoColor=white
[badge-html]:    https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white
[badge-css]:     https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white
[badge-js]:      https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black
[badge-claude]:  https://img.shields.io/badge/Claude_Code-CC785C?style=for-the-badge&logo=anthropic&logoColor=white
[badge-license]: https://img.shields.io/badge/license-MIT-404040?style=for-the-badge

[url-site]:   https://proctor.neorgon.com/
[url-html]:   #
[url-css]:    #
[url-js]:     #
[url-claude]: https://claude.ai/code

</div>

---

## Overview

Proctor turns a plain JSON or YAML file into a runnable exam. Drop in questions,
answers, and corrections, then study with instant feedback or sit a timed
simulation with a question palette, flags, and a score breakdown per domain,
subdomain, and category. The
format fits in an LLM prompt, so any model can generate a test for you -- the
spec ships at `/llms.txt` and behind the Format button.

**Live:** proctor.neorgon.com

---

## Features

- **Four question types** -- single answer, multiple answer, true/false, and typed fill-in
- **Two run modes** -- study (correction after every question) and simulator (timer, flags, submit at the end)
- **Domains and subdomains** -- the blueprint grouping an exam actually has. A domain carries a `description`: shared scenario context written **once**, shown as a fold-out panel above the question and a banner in Review, instead of being repeated at the top of every prompt
- **Filter by grouping** -- chips in the mode picker narrow what a run draws from (sit one domain, or one subdomain), and the same chips filter Review; Export PDF prints the filtered slice
- **Score breakdown** -- results and progress break down per domain, subdomain, and category, plus retake-missed-only
- **JSON, YAML, Aiken, GIFT, CSV** -- built-in parsers for all five, no dependencies, JSON is canonical; Moodle exports and spreadsheets drop straight in
- **Draw N** -- run a random slice of a big bank; questions marked `ensure: true` always make the cut
- **Weak-question practice** -- every finished run records per-question hits and misses; the mode picker offers a study run of just the questions you keep getting wrong
- **Pacing** -- set a time limit on any test at start (even one without its own), watch your s/question average against the budget while you sit it, and see per-question times (slowest flagged) on the results screen and in the CSV
- **Progress** -- score trend per test (sparkline, best/last), latest domain (or category) breakdown, and recent-run history -- all from localStorage
- **Results export** -- per-question CSV (your answer, the correct one, domain, subdomain, category, points) from the results screen
- **LLM-ready format** -- one-click prompt copy; paste the model's output straight back in
- **Share links** -- a whole test travels in the URL fragment, nothing touches a server
- **Review mode** -- every question fully rendered with the answer key and the why, paginated at your pace (steps sized to the bank -- a 96-question bank offers 5/10/20/25/50/all, a 12-question test offers 5/10/all), and walked with the arrow keys, which turn the page for you
- **One Visible menu** -- answer key, explanations, wrong options, notes, tags, and scenario are switches in a single dropdown with a badge counting what is hidden; Export PDF prints every page, but respects those switches and the filter -- an answer sheet and a blank practice sheet are the same button. Per page is the same dropdown block beside it
- **Markdown everywhere** -- prompts, options, explanations, and notes render a safe subset: fenced code blocks, inline code, bold, italic, links, lists
- **Notes and PDF** -- annotate any question with markdown notes (rendered in place, click to edit), then export the whole test (answers, corrections, notes) to PDF via the print dialog
- **Embeddable** -- one iframe snippet runs a full test inside any other site or tool (`?embed=1&mode=study#t=...`), chromeless and stateless; Review has a Copy embed code button
- **Local by design** -- tests, sessions, notes, and history live in localStorage only; embed runs write nothing at all

---

## The test format

```json
{
  "title": "Terminal Basics",
  "timeLimitMinutes": 10,
  "passingScore": 70,
  "domains": [
    {
      "name": "Filesystem",
      "description": "Shared context for these questions, written once here -- never at the top of each prompt",
      "subdomains": ["Navigation", "Creating files"]
    }
  ],
  "questions": [
    {
      "type": "single",
      "domain": "Filesystem",
      "subdomain": "Navigation",
      "category": "files",
      "prompt": "Which command lists hidden files too?",
      "options": ["ls", "ls -a", "ls -s"],
      "answer": 1,
      "explanation": "-a includes entries starting with a dot"
    }
  ]
}
```

Full field reference: [`llms.txt`](llms.txt) or the in-app Format page.

---

## Samples

Three ship with the site and load on every visit, one per parser path:

| Sample | Shape it demonstrates |
|---|---|
| Terminal Basics | JSON, four question types, domains with a shared setup |
| Console Lore | YAML subset (block scalars, nested lists) -- parsed on every page load so the parser is always exercised |
| On-Call Drill | The exam-blueprint shape: three domains, each with the scenario stated once, subdomains, `ensure` questions, fenced code in a prompt |

---

## Running locally

ES modules require an HTTP server (not `file://`):

```bash
make serve    # http://localhost:8861
```

---

## Architecture

![Architecture](docs/architecture.svg)

```
proctor-site/
├── index.html          # App shell: library, runner, results, format views
├── llms.txt            # The test-format spec, written for LLMs
├── css/style.css       # Site styles over CDN base tokens
├── data/               # Sample tests (one JSON, one YAML on purpose)
└── js/
    ├── app.js          # Entry point: restore, samples, #t= and ?src= import, embed boot
    ├── state.js        # Tests, session, history in localStorage
    ├── md.js           # Markdown subset renderer (escape-first, no deps)
    ├── formats.js      # Aiken, GIFT-subset, and CSV importers
    ├── parser.js       # JSON + YAML-subset parsing, normalization, validation
    ├── grader.js       # Per-type grading + session summary
    ├── timer.js        # Simulator countdown
    ├── render.js       # All view rendering
    └── events.js       # Session lifecycle, import pipeline, keyboard
```

---

<div align="center">
<sub>Part of <a href="https://neorgon.com/">Neorgon</a></sub>
</div>
