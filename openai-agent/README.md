# OpenAI Agent Loop as Workflow Tasks

A customer support agent built on the OpenAI Responses API with the plain `openai` package. The agent loop is written by hand: each conversation turn is a task, and every model call and tool call runs as its own subtask, so each step is retried and shows up in the Dashboard on its own.

## What you'll learn

- Calling the OpenAI Responses API with function tools from a workflow task
- Running tools as subtasks with `ctx.run`, three levels deep
- Looping model, then tools, then model, until the model answers, with a round limit
- Returning permanent API errors as results so Render doesn't retry them
- Configuring the model and API key with environment variables

## Workflow structure

```
multiTurnConversation (root)
  └── agentTurn                 (one per user message)
        ├── callLlmWithTools    (Responses API call)
        └── executeTool         (one per requested tool call)
              ├── getOrderStatus
              ├── processRefund
              └── searchKnowledgeBase
```

## Prerequisites

- Node.js 22+ (required by `openai` 7)
- The [Render CLI](https://render.com/docs/cli)
- An [OpenAI API key](https://platform.openai.com/api-keys)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and set OPENAI_API_KEY. OPENAI_MODEL defaults to gpt-6.2-sol.
```

## Run locally

Build, then start the local task server. It loads `.env` when it starts:

```bash
npm run build
render workflows dev -- npm start
```

In another terminal, start a conversation:

```bash
render workflows tasks runs start multiTurnConversation --local \
  --input='["What is the status of order ORD-001?", "ORD-002 is taking too long, please refund it."]'
```

## Deploy to Render

Create a new **Workflow** service on Render:

- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`
- **Environment variables:**
  - `OPENAI_API_KEY`: your OpenAI API key
  - `OPENAI_MODEL` (optional): any model that supports function tools in the Responses API. Defaults to `gpt-6.2-sol`.
