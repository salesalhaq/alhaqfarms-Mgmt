import "server-only";

import { getServerEnvironment } from "@/lib/supabase/server-environment";

export interface FbrCredentials {
  username: string;
  password: string;
  apiKey: string;
}

interface EncryptedCredentials {
  [key: string]: string | number;
  version: 1;
  iv: string;
  ciphertext: string;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(): Promise<CryptoKey> {
  const configured = (await getServerEnvironment()).FBR_CONFIG_ENCRYPTION_KEY?.trim() || "";
  if (!/^[0-9a-f]{64}$/i.test(configured)) {
    throw new Error("FBR cloud credential encryption is not configured. Set FBR_CONFIG_ENCRYPTION_KEY to a 32-byte hexadecimal secret.");
  }
  const raw = Uint8Array.from(configured.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16));
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptFbrCredentials(credentials: FbrCredentials): Promise<EncryptedCredentials> {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext),
  );
  return { version: 1, iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
}

export async function decryptFbrCredentials(value: unknown): Promise<FbrCredentials> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { username: "", password: "", apiKey: "" };
  }
  const envelope = value as Partial<EncryptedCredentials>;
  if (envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("Stored FBR credentials have an unsupported encrypted format.");
  }
  const key = await encryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(decodeBase64(envelope.iv)) },
    key,
    toArrayBuffer(decodeBase64(envelope.ciphertext)),
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored FBR credentials have an invalid format.");
  }
  const record = parsed as Record<string, unknown>;
  return {
    username: typeof record.username === "string" ? record.username : "",
    password: typeof record.password === "string" ? record.password : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
  };
}
