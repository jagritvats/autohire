# LLM providers

A model is **optional**. Without one (the default `echo` provider), JobFlow still discovers,
ranks, explains matches with rule-based notes, parses résumés, builds résumé variants from
your own text and pre-fills forms. A model adds:

- richer match write-ups for your top cards (why it fits, the likely gap, red flags);
- tailored résumé rewrites (LaTeX / Markdown) grounded in your material;
- cover letters and answers to application questions (these refuse without a model);
- optional assisted résumé extraction (filtered so nothing absent from your file survives).

## Choosing a provider

```bash
pnpm jobflow config set llm.provider anthropic    # anthropic | openai | grok
pnpm jobflow config set llm.key --stdin           # paste the key, then Ctrl-D
pnpm jobflow config set llm.model claude-opus-5-5 # optional: override the strong model
pnpm jobflow doctor                               # sends a 1-token test
```

Or in the web app: Settings → Writing model (it shows the model in use, and has a "Test connection" button). The key is stored in
your own database (encrypted at rest when `JOBFLOW_SECRET_KEY` is set), is never shown back
in the UI, and is redacted from error messages and logs.

Environment variables work too and act as the default for everyone on the machine:
`LLM_PROVIDER`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY`, `LLM_MODEL_STRONG`,
`LLM_MODEL_CHEAP`. An OpenAI-compatible gateway can be used with `llm.baseUrl`.

| Provider | Default strong / cheap model |
|---|---|
| `anthropic` | `claude-opus-5-5` / `claude-haiku-5-5` |
| `openai` | `gpt-5` / `gpt-5-mini` |
| `grok` | the provider's current defaults (see `packages/llm/src/factory.ts`) |

## Cost control

- Match write-ups run only for your top N cards (`JOBFLOW_RERANK_TOP`, default 15) and are
  cached per posting — a model only sees new or changed top cards.
- Drafts are cached by a hash of everything they depend on; they regenerate only when your
  résumé, evidence, the posting or the model changes (or you force it).
- Embeddings for ranking use the operator-level provider for the whole corpus so vectors stay
  comparable; with `echo`, a local hashing embedder is used.

## Honesty

Every generation path uses the same system prompt (`HONEST_VOICE`) plus your candidate block
and Evidence Bank: rephrase, reorder and trim your own claims, never extend them; no
name-dropping technologies you haven't listed; no tryhard framing.
