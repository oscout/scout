import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

export type ScoutbotCredentialSource = "local-store";

export type ScoutbotCredentialProviderState = {
  configured: boolean;
  source: ScoutbotCredentialSource | "missing";
  preview: string | null;
};

export type ScoutbotCredentialState = {
  openai: ScoutbotCredentialProviderState;
};

export type ScoutbotCredentialStore = {
  getState: () => ScoutbotCredentialState;
  getOpenAIKey: () => string | null;
  setOpenAIKey: (value: string) => ScoutbotCredentialState;
  deleteOpenAIKey: () => ScoutbotCredentialState;
};

type StoredCredentials = {
  version: 1;
  openai?: EncryptedSecret;
};

type EncryptedSecret = {
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

const OPENAI_KEY_AAD = "openscout:scoutbot:openai:v1";

export function createScoutbotCredentialStore(input: {
  filePath?: string;
  keyPath?: string;
} = {}): ScoutbotCredentialStore {
  const paths = resolveOpenScoutSupportPaths();
  const filePath = input.filePath ?? join(paths.controlHome, "scoutbot-credentials.json");
  const keyPath = input.keyPath ?? join(paths.controlHome, "scoutbot-credentials.key");

  const getOpenAIKey = (): string | null => {
    const stored = readStore(filePath).openai;
    if (!stored) return null;
    try {
      return decryptSecret(stored, readOrCreateKey(keyPath), OPENAI_KEY_AAD);
    } catch {
      return null;
    }
  };

  const getState = (): ScoutbotCredentialState => {
    const key = getOpenAIKey();
    return {
      openai: {
        configured: Boolean(key),
        source: key ? "local-store" : "missing",
        preview: key ? previewSecret(key) : null,
      },
    };
  };

  return {
    getState,
    getOpenAIKey,
    setOpenAIKey: (value: string) => {
      const key = normalizeOpenAIKey(value);
      const store = readStore(filePath);
      store.openai = encryptSecret(key, readOrCreateKey(keyPath), OPENAI_KEY_AAD);
      writeStore(filePath, store);
      return getState();
    },
    deleteOpenAIKey: () => {
      const store = readStore(filePath);
      if (store.openai) {
        delete store.openai;
        writeStore(filePath, store);
      }
      return getState();
    },
  };
}

export function normalizeOpenAIKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("sk-")) {
    throw new Error("OpenAI API keys should start with sk-.");
  }
  return trimmed;
}

export function previewSecret(value: string): string {
  if (value.length <= 10) return "configured";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

function readStore(filePath: string): StoredCredentials {
  if (!existsSync(filePath)) return { version: 1 };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoredCredentials>;
    return {
      version: 1,
      ...(parsed.openai ? { openai: parsed.openai } : {}),
    };
  } catch {
    return { version: 1 };
  }
}

function writeStore(filePath: string, store: StoredCredentials): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, filePath);
}

function readOrCreateKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    try {
      const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64url");
      if (key.length === 32) return key;
    } catch {
      // Regenerate below; existing encrypted credentials will become unreadable.
    }
  }

  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  const tmp = `${keyPath}.tmp`;
  writeFileSync(tmp, `${key.toString("base64url")}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, keyPath);
  return key;
}

function encryptSecret(value: string, key: Buffer, aad: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptSecret(secret: EncryptedSecret, key: Buffer, aad: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
