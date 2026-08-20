import { Hono, type Context, type Handler } from "hono";

import {
  scoutAskHandler as defaultScoutAskHandler,
  type ScoutAskHandler,
} from "../../core/broker/ask.ts";
import type { ScoutAskReceipt } from "../../core/broker/ask-types.ts";
import { resolveScoutSenderId } from "../../core/broker/sender.ts";
import {
  buildScoutAskCommand,
  parseAskApiBody,
  askApiFailure,
  askReceiptStatus,
  type AskApiError,
  type AskApiErrorResponse,
  type AskApiResult,
} from "./ask-contract.ts";

type AskRouteDependencies = {
  resolveSenderId: (
    senderId: string | null | undefined,
    currentDirectory: string,
  ) => Promise<string>;
  scoutAskHandler: ScoutAskHandler;
};

export type AskRouteOptions = {
  currentDirectory: string;
  dependencies?: Partial<AskRouteDependencies>;
};

const defaultAskRouteDependencies: AskRouteDependencies = {
  resolveSenderId: (senderId, currentDirectory) =>
    resolveScoutSenderId(senderId?.trim() || "operator", currentDirectory),
  scoutAskHandler: defaultScoutAskHandler,
};

async function readJson(c: Context): Promise<AskApiResult<unknown>> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return askApiFailure("invalid_json", "invalid json");
  }
}

function renderAskApiError(c: Context, result: {
  status: 400;
  error: AskApiError;
}) {
  return c.json(
    {
      ok: false,
      error: result.error,
    } satisfies AskApiErrorResponse,
    result.status,
  );
}

function renderAskReceipt(c: Context, receipt: ScoutAskReceipt) {
  return c.json(receipt, askReceiptStatus(receipt));
}

function createAskHttpHandler(
  options: AskRouteOptions,
  deps: AskRouteDependencies,
): Handler {
  return async (c) => {
    const json = await readJson(c);
    if (!json.ok) {
      return renderAskApiError(c, json);
    }

    const payload = parseAskApiBody(json.value);
    if (!payload.ok) {
      return renderAskApiError(c, payload);
    }

    const senderId = await deps.resolveSenderId(
      payload.value.senderId,
      options.currentDirectory,
    );
    const command = buildScoutAskCommand({
      payload: payload.value,
      senderId,
      currentDirectory: options.currentDirectory,
    });
    const receipt = await deps.scoutAskHandler(command);

    return renderAskReceipt(c, receipt);
  };
}

export function createAskRoutes(options: AskRouteOptions): Hono {
  const deps: AskRouteDependencies = {
    ...defaultAskRouteDependencies,
    ...options.dependencies,
  };

  const routes = new Hono();
  routes.post("/ask", createAskHttpHandler(options, deps));
  return routes;
}
