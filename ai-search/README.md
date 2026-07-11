# Unfiltered AI Search

A self-contained, single-file web app: an **AI search engine + chat** front-end
that runs on top of a language model **you** provide. There is no built-in
content-filtering layer — how "uncensored" it is depends entirely on the model
you connect. It's neutral infrastructure, like SillyTavern / LibreChat.

> 🔞 **Adults only.** The app shows an 18+ gate on first use. Using it to create,
> request, or seek sexual content involving minors — or any other illegal
> material — is strictly prohibited, and the default system prompt refuses it.

## What it does

- **Ask/search box** with a Perplexity-style flow: optionally runs a web search
  first, feeds the results to the model, and shows an answer **with inline
  citations and a sources list**.
- **Streaming** answers, multi-turn chat history, basic Markdown rendering.
- **Bring-your-own model**, three ways:
  1. **API key** — any OpenAI-compatible endpoint (OpenRouter, OpenAI, …).
  2. **Local server** — same "API" mode pointed at `localhost` (Ollama,
     KoboldCpp, text-generation-webui). No key needed.
  3. **In-browser model** — download a HuggingFace
     [transformers.js](https://huggingface.co/models?library=transformers.js)
     model straight into the browser (runs on WebGPU/WASM, cached after first
     load).
- **Editable system prompt**, temperature, max tokens, and result count.
- Everything (keys included) is stored **only** in your browser's localStorage
  and sent **only** to the backend you configure.

## Run it

It's one file — no build step.

- **Locally:** open `ai-search/index.html` in a browser. (In-browser model mode
  and API calls need network; some browsers restrict `file://`, so hosting is
  smoother.)
- **Hosted:** drop it on GitHub Pages / any static host and open the URL.

Then tap ⚙️ and configure a backend.

## Backend setup

### A) API key (recommended for large uncensored models)
1. Backend → **API key**.
2. Base URL: `https://openrouter.ai/api/v1` (or another OpenAI-compatible host).
3. Paste your API key.
4. Model: on [OpenRouter](https://openrouter.ai/models) choose a permissive
   model (the model field has a few suggestions). You pay/authorize through your
   own account.

### B) Local server (no key, private)
1. Run a local OpenAI-compatible server:
   - **Ollama:** `ollama serve`, base URL `http://localhost:11434/v1`, model =
     whatever you `ollama pull`ed (e.g. an uncensored GGUF).
   - **KoboldCpp:** base URL `http://localhost:5001/v1`.
   - **text-generation-webui:** enable the OpenAI extension, `http://localhost:5000/v1`.
2. Leave the API key blank.
3. **CORS:** allow the browser origin. For Ollama, set
   `OLLAMA_ORIGINS=*` (or your host). Most local servers have a CORS/allow flag.

### C) In-browser HuggingFace model
1. Backend → **In-browser model**.
2. Enter a transformers.js-compatible model id, e.g.
   `onnx-community/Llama-3.2-1B-Instruct-q4f16`.
3. First run downloads & caches it. Pick **WebGPU** if supported, else **WASM**.

> Reality check: most big "uncensored" fine-tunes are **not** published as ONNX,
> so the in-browser path is limited to small models. For genuinely uncensored,
> capable output use **A** (OpenRouter) or **B** (a local uncensored GGUF).

## Web search ("search engine" mode)

The web-search toggle uses a **SearXNG** instance you point it at (Settings →
Web search). SearXNG is a self-hostable metasearch engine; this app calls its
JSON API with `safesearch=0` and cites the top results.

- The instance needs **JSON output enabled** and **CORS** allowing the browser.
- Self-hosting is recommended (many public instances disable JSON/CORS).
- Leave the field blank to use the app as pure chat (no web step).

## Notes & limits

- No server of its own — all calls go straight from your browser to your chosen
  backend, so CORS on that backend matters.
- Streaming uses Server-Sent Events for API mode and a token streamer for the
  in-browser model.
- This is a front-end only; it neither hosts nor ships any model or content.
