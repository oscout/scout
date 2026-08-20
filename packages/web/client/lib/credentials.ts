import { api } from "./api.ts";
import { HudVault } from "./hud-vault.ts";

const OPENSCOUT_VAULT_SERVICE = "dev.openscout.credentials";
const OPENAI_KEY = "openai_api_key";

const vault = new HudVault({ service: OPENSCOUT_VAULT_SERVICE });

export type ClientCredentialState = {
  configured: boolean;
  preview: string | null;
};

export type ServerCredentialState = {
  openai: {
    configured: boolean;
    source: "env" | "local-config" | "local-store" | "missing";
    preview: string | null;
  };
};

export async function getOpenAIApiKey(): Promise<string | null> {
  const value = await vault.get(OPENAI_KEY);
  const trimmed = value?.trim();
  return trimmed && trimmed.startsWith("sk-") ? trimmed : null;
}

export async function setOpenAIApiKey(value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed.startsWith("sk-")) {
    throw new Error("OpenAI API keys should start with sk-.");
  }
  await vault.set(OPENAI_KEY, trimmed);
}

export async function deleteOpenAIApiKey(): Promise<void> {
  await vault.delete(OPENAI_KEY);
}

export async function saveOpenAIKeyToServer(value: string): Promise<ServerCredentialState> {
  return api<ServerCredentialState>("/api/scoutbot/credentials/openai", {
    method: "POST",
    body: JSON.stringify({ apiKey: value.trim() }),
  });
}

export async function deleteOpenAIKeyFromServer(): Promise<ServerCredentialState> {
  return api<ServerCredentialState>("/api/scoutbot/credentials/openai", { method: "DELETE" });
}

export async function getServerCredentialState(): Promise<ServerCredentialState> {
  return api<ServerCredentialState>("/api/scoutbot/credentials");
}

export async function ensureOpenAIKeyOnServer(): Promise<ServerCredentialState | null> {
  const server = await getServerCredentialState();
  if (server.openai.configured) return server;
  const apiKey = await getOpenAIApiKey();
  return apiKey ? saveOpenAIKeyToServer(apiKey) : null;
}

export async function getClientCredentialState(): Promise<ClientCredentialState> {
  const key = await getOpenAIApiKey();
  return {
    configured: Boolean(key),
    preview: key ? previewSecret(key) : null,
  };
}

function previewSecret(value: string): string {
  if (value.length <= 10) return "configured";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}
