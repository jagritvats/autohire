# JobFlow videos: transcripts

The narration of every JobFlow video, with chapter times, as a text alternative. The videos
themselves are **attached to the GitHub release** (MP4, with an `.srt` caption file each). They
show an offline demo: a **fictional** candidate and **fictional** companies and job boards
(`JOBFLOW_DEMO_DATA=1`). Terminal scenes replay real command output; the AI-assistant chat is an
illustrative conversation built from real JobFlow tool output.

How they're made, and how to regenerate them: [`scripts/video/README.md`](../../scripts/video/README.md).

| Video | What it covers |
|---|---|
| [JobFlow — a walkthrough](#jobflow--a-walkthrough) | The whole product in about three and a half minutes: setup, sync, the Jobs feed and match cards, filters, a Job page, Search, Tailor, the apply checklist and the review gate, Applications, MCP. |
| [JobFlow — trailer](#jobflow--trailer) | A short introduction, under a minute. Also as a captioned cut and a 1:1 square cut for social media. |
| [Get started in 5 minutes](#get-started-in-5-minutes) | Terminal first: clone, install, `jobflow init --sample`, `jobflow sync`, `jobflow feed`, `jobflow show`, `jobflow serve`. |
| [Use JobFlow from Claude Code (MCP)](#use-jobflow-from-claude-code-mcp) | Adding `jobflow mcp` to Claude Code, then an illustrative conversation built from real tool output: `search_jobs`, `get_job`, `prepare_application` (a dry run), and you running `jobflow apply --fill`. |
| [Stop scrolling 500 job posts](#stop-scrolling-500-job-posts) | Vertical, about 25 s: ranked by fit to your résumé, with the honest card. |
| [It fills the form. You press submit.](#it-fills-the-form-you-press-submit) | Vertical, about 25 s: the form-filler stops at the review screen; you press submit. |
| [Your AI assistant + your job search](#your-ai-assistant--your-job-search) | Vertical, about 25 s: JobFlow from an AI assistant over MCP; your data stays on your machine. |


## JobFlow — a walkthrough

File: `jobflow-walkthrough.mp4` · 3:38. The whole product in about three and a half minutes: setup, sync, the Jobs feed and match cards, filters, a Job page, Search, Tailor, the apply checklist and the review gate, Applications, MCP.

**0:00 · What JobFlow is**

This is JobFlow, a job search engine that runs on your own computer. It finds roles on company job boards, ranks them against your résumé, and tells you honestly how well you fit. It helps you write your application from your own material, and it fills in the form. Then it stops, so you can check it and press submit.

**0:20 · Set up**

Setup takes a few minutes. Clone the repository, then run pnpm install and build. jobflow init reads your résumé — PDF, Word, LaTeX, Markdown or plain text — and asks you to confirm what it found.

**0:36 · Onboarding in the browser**

In the browser, the same setup is four short steps. Every skill and every Evidence Bank item is copied from your résumé. You fix what's wrong, and nothing is made up. Then you say where you can work, your pay floor, and the kinds of roles you want.

**0:53 · Sync, with live progress**

Next, a sync. JobFlow checks company job boards and public feeds. Here, it's a fictional demo set. The panel shows each step as it runs, the boards being fetched, the jobs found so far, and roughly how long is left. A board that doesn't answer is named, in plain words, and tried again next time.

**1:15 · Jobs and honest match cards**

Your jobs come back ranked for you. Each card has a score, why it fits, and the likely gap — a language you haven't used, or more years than you have. Pay is what the posting states, or an estimate that's labelled as one. Flags call out the catches, like a post from a staffing agency, or a remote role that's open in one country only.

**1:38 · Filters that say what they hid**

Filters only hide. Scores never change, and the page tells you how many jobs a filter hid, and why. Only two things are ever left out for you: pay stated below your floor, and a location you can't work from.

**1:52 · A Job page**

Open a job for the whole picture: how you fit, what to check before applying, and the full description.

**1:59 · Search and saved searches**

Search asks the job boards right now, with the same honest scoring, and reports what your query hid. Save a search, and it runs on every sync and becomes a tab on your Jobs page.

**2:11 · Tailoring from your own material**

Tailor drafts a résumé, a cover letter and answers for one role. They're built from your résumé, your Evidence Bank and your skills: rephrased and trimmed, never extended. Each draft says where it came from. Without a model, you get your own résumé, reformatted, and cover letters are switched off rather than faked.

**2:33 · Apply: the checklist and the review gate**

The Apply checklist makes sure you have what you need: your name, your email and a résumé file. Then open the form yourself, or pre-fill it in a browser on your machine with jobflow apply --fill. It types only what you stored, attaches your résumé, and stops at the review screen. JobFlow never submits. You read it, and you send it.

**2:56 · Applications tracker**

Once it's sent, mark it applied. Applications keeps every role from saved to offer, with a next step and a follow-up date.

**3:05 · From an AI agent, over MCP**

You can also use JobFlow from an AI assistant. jobflow mcp serves your local data over the Model Context Protocol. The assistant can search, read a job, and plan an application as a dry run. It can't fill or submit a form.

**3:21 · Open source, on your machine**

JobFlow is open source, under the AGPL. It runs on your machine, and your data stays there. Pick a style, light or dark. Use the terminal or the browser. And give it a try.


## JobFlow — trailer

File: `jobflow-trailer.mp4` · 0:46. A short introduction, under a minute. Also as a captioned cut and a 1:1 square cut for social media.

**0:00 · Ranked by you**

Job boards rank by ads and recency. JobFlow ranks by you.

**0:05 · Straight from employers**

It reads company job boards directly, and scores every role against your résumé.

**0:11 · Honest match cards**

Why it fits. The likely gap. Pay, stated or a labelled estimate.

**0:17 · Filters that report**

Filters only hide, and they tell you what they hid.

**0:21 · Grounded drafts**

Drafts come from your own résumé. Rephrased, never invented.

**0:25 · The review gate**

It pre-fills the application, then stops at the review screen. You press submit.

**0:31 · Terminal, browser, AI assistant**

Use it from the terminal, the browser, or your AI assistant.

**0:36 · Local-first**

It runs on your machine. Your data stays there.

**0:40 · Open source**

JobFlow. Open source, and local-first.


## Get started in 5 minutes

File: `jobflow-guide-get-started.mp4` · 1:33. Terminal first: clone, install, `jobflow init --sample`, `jobflow sync`, `jobflow feed`, `jobflow show`, `jobflow serve`.

**0:00 · Get started in 5 minutes**

Here's how to get JobFlow running in about five minutes, from the terminal.

**0:05 · Clone, install, build**

You need Node 20 or newer, and pnpm. Clone the repository, install the dependencies, and build. No account, no server, and no API key.

**0:18 · jobflow init**

Next, your profile. jobflow init reads your résumé and asks you to confirm what it found. To look around first, init --sample loads a fictional candidate. That's what we'll use here.

**0:32 · jobflow sync**

jobflow sync checks the job boards in your discovery preset, with live progress: the step it's on, boards checked, jobs fetched, and time left. This is demo mode, so the boards are fictional. When one doesn't answer, the summary says so, and it's tried again next sync.

**0:53 · jobflow feed**

jobflow feed is your ranked list. Each row has a score, the pay if it's known, and a line on why it fits. Caveats, like a post from a staffing agency, get a line of their own.

**1:07 · jobflow show**

jobflow show opens one job in full: how you fit, what to check, and an apply checklist with a fix for each gap.

**1:15 · jobflow serve**

When you'd rather use a browser, jobflow serve opens the web app on the same data, on your machine only.

**1:23 · Next steps**

From here, try jobflow search, tailor a résumé, and read the applying guide. Everything is in the docs folder.


## Use JobFlow from Claude Code (MCP)

File: `jobflow-guide-mcp.mp4` · 1:34. Adding `jobflow mcp` to Claude Code, then an illustrative conversation built from real tool output: `search_jobs`, `get_job`, `prepare_application` (a dry run), and you running `jobflow apply --fill`.

**0:00 · Why MCP**

JobFlow includes an MCP server, so an AI assistant like Claude Code can work with your job search, on your own data. The assistant queries JobFlow's own job data, straight from employers' boards, instead of scraping job sites.

**0:16 · Add the server**

Add it with one command. Claude Code's options go before the name. Everything after the two dashes starts the server: node, the path to jobflow in your checkout, and mcp. claude mcp list checks that it's connected.

**0:32 · search_jobs**

Now ask in plain words. The assistant calls search_jobs, which scores results against your profile. In this demo, the jobs are fictional. It also reports what the query hid, so nothing disappears silently.

**0:46 · get_job**

get_job reads one role in full: the fit, the gaps, any red flags, and pay, stated or estimated. The assistant explains it from that card, not from guesswork.

**0:59 · prepare_application (dry run)**

prepare_application is a dry run. It shows which of your details would go into which field, and what's missing. Nothing is opened, filled or sent.

**1:09 · You run the form-filler**

When you're ready, you run jobflow apply --fill yourself. It pre-fills the form in a browser on your machine, and stops at the review screen. You press submit.

**1:21 · What stays true**

The server reads your local data, reaches only public job boards, and never fills or submits a form. The full tool list is in the AI agents guide.


## Stop scrolling 500 job posts

File: `reels/jobflow-reel-ranked.mp4` · 0:24. Vertical, about 25 s: ranked by fit to your résumé, with the honest card.

Stop scrolling five hundred job posts. JobFlow ranks every role by how well it fits your résumé. Each card says why it fits, and what the gap is. Pay is what the employer stated, or clearly marked as an estimate. Filters only hide, and they tell you what they hid. Free, open source, and it runs on your machine.


## It fills the form. You press submit.

File: `reels/jobflow-reel-gate.mp4` · 0:24. Vertical, about 25 s: the form-filler stops at the review screen; you press submit.

This tool fills in your job application, and then it stops. First, a checklist: your name, your email, a résumé file. Then it types what you stored, and attaches your résumé. And it waits on the review screen. No auto-submit, ever. You read it. You press submit. JobFlow. Open source, and local-first.


## Your AI assistant + your job search

File: `reels/jobflow-reel-mcp.mp4` · 0:23. Vertical, about 25 s: JobFlow from an AI assistant over MCP; your data stays on your machine.

Your AI assistant can run your job search. Add JobFlow to Claude Code with one command. Ask for remote backend roles you'd actually get. It gets ranked jobs, with the honest gaps. Plus a dry-run apply plan. It never fills or sends a form. Your data stays on your machine. And JobFlow is open source.


---

See also: [Getting started](../getting-started.md) · [Web app tour](web-app-tour.md) · [AI agents (MCP)](ai-agents-mcp.md)
