# Render Workflows TypeScript Examples

Example projects demonstrating [Render Workflows](https://render.com/docs/workflows) using the [`@renderinc/sdk`](https://www.npmjs.com/package/@renderinc/sdk) TypeScript SDK.

## Examples

| Example | Description |
|---------|-------------|
| [hello-world](./hello-world) | Simplest workflow — learn tasks, task chaining, and orchestration |
| [etl-job](./etl-job) | Extract, transform, load pipeline with retry handling |
| [data-pipeline](./data-pipeline) | Multi-source data pipeline with enrichment and segmentation |
| [file-processing](./file-processing) | File ingestion with validation, parsing, and transformation |
| [openai-agent](./openai-agent) | AI-powered workflow using OpenAI for text analysis |
| [file-analyzer](./file-analyzer) | Two-service architecture: API gateway + workflow service for CSV analysis |

## Getting started

Each example is a standalone Node.js project. To run any example:

```bash
cd <example>
npm install
npm run build
npm start
```

## Prerequisites

- Node.js 18+
- A [Render](https://render.com) account (for deployment)

## Deploying to Render

Each example can be deployed as a Render Workflow service. See the individual example READMEs for specific deployment instructions.

## Learn more

- [Render Workflows documentation](https://render.com/docs/workflows)
- [TypeScript SDK documentation](https://render.com/docs/workflows-sdk-typescript)
- [`@renderinc/sdk` on npm](https://www.npmjs.com/package/@renderinc/sdk)
