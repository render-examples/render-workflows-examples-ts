import "dotenv/config";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";

const retry = {
  maxRetries: 3,
  waitDurationMs: 2000,
  backoffScaling: 2.0,
};

// Retries belong on the tasks that call outside systems: the OpenAI API and the
// tool lookups. Tasks that only orchestrate subtasks don't retry. Retrying one
// re-runs every subtask below it, which multiplies attempts and repeats side
// effects, such as a refund that already went through.
const noRetry = {
  maxRetries: 0,
  waitDurationMs: 1000,
  backoffScaling: 1.5,
};

// Read the model from the environment so a retired model is a config change,
// not a code change.
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-6.2-sol";

function createOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable not set. " +
      "Please set it in your Render environment variables.",
    );
  }
  // Render retries failed task runs, so turn off the client's own retries
  // to keep one retry policy in charge.
  return new OpenAI({ apiKey, maxRetries: 0 });
}

// ---- Tool Functions ----

const getOrderStatus = task(
  { name: "getOrderStatus", retry },
  function getOrderStatus(_ctx: TaskContext, orderId: string) {
    console.log(`[TOOL] Looking up order status for: ${orderId}`);

    const mockOrders: { [key: string]: { status: string; tracking: string | null; eta: string } } = {
      "ORD-001": { status: "shipped", tracking: "1Z999AA1234567890", eta: "2024-10-15" },
      "ORD-002": { status: "processing", tracking: null, eta: "2024-10-12" },
      "ORD-003": { status: "delivered", tracking: "1Z999AA9876543210", eta: "2024-10-08" },
    };

    if (orderId in mockOrders) {
      const order = mockOrders[orderId];
      console.log(`[TOOL] Order ${orderId} found: ${order.status}`);
      return { success: true, order_id: orderId, ...order };
    }

    console.warn(`[TOOL] Order ${orderId} not found`);
    return { success: false, order_id: orderId, error: "Order not found" };
  },
);

// A refund isn't idempotent: retrying after a failure partway through could
// refund the order twice. Leaving retry unset doesn't guarantee that, since
// the documented default is 3 retries, so turn retries off explicitly.
const processRefund = task(
  { name: "processRefund", retry: noRetry },
  function processRefund(_ctx: TaskContext, orderId: string, reason: string) {
    console.log(`[TOOL] Processing refund for order: ${orderId}`);
    console.log(`[TOOL] Refund reason: ${reason}`);

    const refundId = `REF-${orderId}-${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}`;

    const result = {
      success: true,
      refund_id: refundId,
      order_id: orderId,
      reason,
      amount: 99.99,
      processed_at: new Date().toISOString(),
    };

    console.log(`[TOOL] Refund processed: ${refundId}`);
    return result;
  },
);

const searchKnowledgeBase = task(
  { name: "searchKnowledgeBase", retry },
  function searchKnowledgeBase(_ctx: TaskContext, query: string) {
    console.log(`[TOOL] Searching knowledge base: ${query}`);

    const knowledge: { [key: string]: { title: string; content: string } } = {
      shipping: {
        title: "Shipping Policy",
        content:
          "We offer free shipping on orders over $50. Standard shipping takes 3-5 business days. Express shipping is available for $15 and takes 1-2 business days.",
      },
      returns: {
        title: "Return Policy",
        content:
          "We accept returns within 30 days of purchase. Items must be unused and in original packaging. Refunds are processed within 5-7 business days.",
      },
      warranty: {
        title: "Warranty Information",
        content:
          "All products come with a 1-year manufacturer warranty. Extended warranties are available for purchase.",
      },
    };

    const queryLower = query.toLowerCase();
    const matches = Object.entries(knowledge)
      .filter(
        ([key, article]) =>
          queryLower.includes(key) ||
          queryLower.split(" ").some((word) => article.content.toLowerCase().includes(word)),
      )
      .map(([, article]) => article);

    console.log(`[TOOL] Found ${matches.length} knowledge base articles`);
    return { success: true, query, results: matches, count: matches.length };
  },
);

// ---- Agent Tasks ----

// Tool definitions in the Responses API format. strict: true makes the model's
// arguments always match the schema, which requires every property to be
// listed in "required" and additionalProperties to be false.
const tools: FunctionTool[] = [
  {
    type: "function",
    name: "get_order_status",
    description: "Look up the status of a customer order by order ID",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "The order ID (e.g., ORD-001)" },
      },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "process_refund",
    description: "Process a refund for an order",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "The order ID to refund" },
        reason: { type: "string", description: "Reason for the refund" },
      },
      required: ["order_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_knowledge_base",
    description: "Search the knowledge base for help articles and information",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const SYSTEM_PROMPT =
  "You are a helpful customer support agent. You can look up order " +
  "status, process refunds, and search the knowledge base for information. " +
  "Be polite, professional, and helpful. Use tools when necessary to " +
  "assist the customer.";

// Earlier turns are kept as plain user/assistant messages.
type HistoryMessage = { role: "user" | "assistant"; content: string };

// Upper bound on model -> tools -> model rounds in one turn, so a model that
// keeps requesting tools can't loop forever.
const MAX_TOOL_ROUNDS = 5;

// OpenAI errors that mean the request itself is wrong: unknown model, bad key,
// invalid input. A retry can't fix them, so callLlmWithTools returns them as a
// result instead of throwing. Rate limits (429), server errors (5xx) and
// network errors still throw, so Render retries them.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

const callLlmWithTools = task(
  { name: "callLlmWithTools", retry },
  async function callLlmWithTools(
    _ctx: TaskContext,
    inputItems: ResponseInputItem[],
    toolDefs: FunctionTool[],
    model: string = DEFAULT_MODEL,
  ) {
    console.log(`[AGENT] Calling ${model} with ${toolDefs.length} tools available`);

    let client: OpenAI;
    try {
      client = createOpenAIClient();
    } catch (error) {
      // A missing API key is a setup problem. A retry can't fix it, so report
      // it as a result like the permanent API errors below.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[AGENT] Not retrying: ${message}`);
      return { error: { status: null, message } };
    }

    let response;
    try {
      response = await client.responses.create({
        model,
        instructions: SYSTEM_PROMPT,
        input: inputItems,
        tools: toolDefs,
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError && PERMANENT_ERROR_STATUSES.has(error.status ?? 0)) {
        console.error(`[AGENT] OpenAI error ${error.status}, not retrying: ${error.message}`);
        return { error: { status: error.status, message: error.message } };
      }
      throw error;
    }

    const toolCalls = response.output
      .filter((item): item is ResponseFunctionToolCall => item.type === "function_call")
      .map((item) => ({ call_id: item.call_id, name: item.name, arguments: item.arguments }));

    if (toolCalls.length) {
      console.log(`[AGENT] Model requested ${toolCalls.length} tool calls`);
    }

    return {
      output_text: response.output_text,
      tool_calls: toolCalls,
      // The model's output items go back into the next call's input so the
      // model can see which tool calls it made.
      output_items: response.output as ResponseInputItem[],
    };
  },
);

const executeTool = task(
  { name: "executeTool", retry: noRetry },
  async function executeTool(ctx: TaskContext, toolName: string, args: { [key: string]: string }) {
    console.log(`[AGENT] Executing tool: ${toolName}`);

    try {
      switch (toolName) {
        case "get_order_status":
          return await ctx.run(getOrderStatus, args.order_id);
        case "process_refund":
          return await ctx.run(processRefund, args.order_id, args.reason);
        case "search_knowledge_base":
          return await ctx.run(searchKnowledgeBase, args.query);
        default:
          console.error(`[AGENT] Unknown tool: ${toolName}`);
          return { error: `Unknown tool: ${toolName}` };
      }
    } catch (error) {
      console.error(`[AGENT] Tool execution failed: ${error}`);
      return { error: String(error) };
    }
  },
);


const agentTurn = task(
  { name: "agentTurn", retry: noRetry },
  async function agentTurn(
    ctx: TaskContext,
    userMessage: string,
    conversationHistory: HistoryMessage[] = [],
  ) {
    console.log("[AGENT TURN] Starting agent turn");

    if (typeof userMessage !== "string") {
      return {
        success: false,
        error: `user_message must be a string, got ${typeof userMessage}`,
        response: "I'm sorry, there was an error processing your message. Please try again.",
      };
    }

    // The model can ask for tools several times in one turn, for example to
    // look up an order and then refund it. Each round runs the requested tools
    // and sends their results back, until the model answers in text or the
    // turn reaches MAX_TOOL_ROUNDS.

    // Within this turn, inputItems also collects tool calls and their outputs.
    let inputItems: ResponseInputItem[] = [
      ...conversationHistory,
      { role: "user", content: userMessage },
    ];
    const toolResults: { tool: string; result: unknown }[] = [];
    let reply: string | null = null;

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      const llmResponse = await ctx.run(callLlmWithTools, inputItems, tools);

      if ("error" in llmResponse) {
        return {
          response: null,
          error: llmResponse.error,
          conversation_history: conversationHistory,
          tool_calls: toolResults,
        };
      }

      if (!llmResponse.tool_calls.length) {
        reply = llmResponse.output_text;
        break;
      }

      console.log(
        `[AGENT TURN] Round ${round}: executing ${llmResponse.tool_calls.length} tool calls`,
      );

      // Send the model's own output back, followed by one function_call_output
      // per call.
      inputItems = [...inputItems, ...llmResponse.output_items];
      for (const call of llmResponse.tool_calls) {
        const result = await ctx.run(executeTool, call.name, JSON.parse(call.arguments));
        toolResults.push({ tool: call.name, result });
        inputItems.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }
    }

    if (reply === null) {
      console.warn(`[AGENT TURN] Stopped after ${MAX_TOOL_ROUNDS} tool rounds`);
      reply = "Sorry, I couldn't finish that request. Please try again or contact support.";
    }

    console.log("[AGENT TURN] Agent turn complete");

    return {
      response: reply,
      conversation_history: [
        ...conversationHistory,
        { role: "user" as const, content: userMessage },
        { role: "assistant" as const, content: reply },
      ],
      tool_calls: toolResults,
    };
  },
);

// Root task: multi-turn conversation
task(
  { name: "multiTurnConversation", retry: noRetry, timeoutSeconds: 300 },
  async function multiTurnConversation(ctx: TaskContext, ...messages: string[]) {
    console.log("=".repeat(80));
    console.log(`[CONVERSATION] Starting multi-turn conversation with ${messages.length} messages`);
    console.log("=".repeat(80));

    let conversationHistory: HistoryMessage[] = [];
    const responses: {
      turn: number;
      user: string;
      assistant: string | null;
      tool_calls: unknown[];
      error?: unknown;
    }[] = [];

    for (let i = 0; i < messages.length; i++) {
      console.log(`[CONVERSATION] Turn ${i + 1}/${messages.length}`);

      const turnResult = await ctx.run(agentTurn, messages[i], conversationHistory);

      const turn = {
        turn: i + 1,
        user: messages[i],
        assistant: turnResult.response,
        tool_calls: turnResult.tool_calls ?? [],
      };

      // A permanent error would repeat on every later turn, so stop here.
      if ("error" in turnResult) {
        responses.push({ ...turn, error: turnResult.error });
        console.error(`[CONVERSATION] Stopping after turn ${i + 1}: ${JSON.stringify(turnResult.error)}`);
        break;
      }

      responses.push(turn);
      conversationHistory = turnResult.conversation_history ?? [];
    }

    console.log("=".repeat(80));
    console.log("[CONVERSATION] Multi-turn conversation complete");
    console.log("=".repeat(80));

    return {
      turns: responses,
      total_turns: responses.length,
      conversation_history: conversationHistory,
    };
  },
);
