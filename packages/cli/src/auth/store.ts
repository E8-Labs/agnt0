import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agnt0Home, debug } from "../config.js";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** ISO time the access token expires. */
  expires_at: string;
  email?: string;
}

export interface TokenStore {
  load(apiUrl: string): Promise<StoredTokens | null>;
  save(apiUrl: string, tokens: StoredTokens): Promise<void>;
  clear(apiUrl: string): Promise<void>;
}

const SERVICE = "agnt0";

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(p: string): void;
  deletePassword(): boolean | void;
}
type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry };

let keyringModule: KeyringModule | null | undefined;

/**
 * Once the keychain fails in a process we stop using it: on some Linux setups the first write fails
 * and later writes "succeed" into a non-persistent session store, which would silently lose logins.
 */
function disableKeyring(e: unknown): void {
  debug("keyring disabled for this process", e);
  keyringModule = null;
}

async function loadKeyring(): Promise<KeyringModule | null> {
  if (process.env.AGNT0_NO_KEYRING === "1") return null;
  // Secret Service needs a D-Bus session; without one (containers, SSH, CI) use the file.
  if (process.platform === "linux" && !process.env.DBUS_SESSION_BUS_ADDRESS) return null;
  if (keyringModule !== undefined) return keyringModule;
  try {
    keyringModule = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
  } catch (e) {
    debug("keyring unavailable", e);
    keyringModule = null;
  }
  return keyringModule;
}

/** Credentials file: { [apiUrl]: StoredTokens }, mode 0600. */
export class FileTokenStore implements TokenStore {
  constructor(private readonly dir = agnt0Home()) {}
  get path(): string {
    return join(this.dir, "credentials.json");
  }
  private async readAll(): Promise<Record<string, StoredTokens>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, StoredTokens>;
    } catch {
      return {};
    }
  }
  private async writeAll(all: Record<string, StoredTokens>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (Object.keys(all).length === 0) {
      await rm(this.path, { force: true });
      return;
    }
    await writeFile(this.path, JSON.stringify(all, null, 2), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
  async load(apiUrl: string): Promise<StoredTokens | null> {
    return (await this.readAll())[apiUrl] ?? null;
  }
  async save(apiUrl: string, tokens: StoredTokens): Promise<void> {
    const all = await this.readAll();
    all[apiUrl] = tokens;
    await this.writeAll(all);
  }
  async clear(apiUrl: string): Promise<void> {
    const all = await this.readAll();
    if (!(apiUrl in all)) return;
    delete all[apiUrl];
    await this.writeAll(all);
  }
}

/** OS keychain first, credentials file when no keychain is reachable (containers, CI, headless Linux). */
export class DefaultTokenStore implements TokenStore {
  private readonly file: FileTokenStore;
  constructor(dir?: string) {
    this.file = new FileTokenStore(dir);
  }
  async load(apiUrl: string): Promise<StoredTokens | null> {
    const kr = await loadKeyring();
    if (kr) {
      try {
        const v = new kr.Entry(SERVICE, apiUrl).getPassword();
        if (v) return JSON.parse(v) as StoredTokens;
      } catch (e) {
        disableKeyring(e);
      }
    }
    return this.file.load(apiUrl);
  }
  async save(apiUrl: string, tokens: StoredTokens): Promise<void> {
    const kr = await loadKeyring();
    if (kr) {
      try {
        new kr.Entry(SERVICE, apiUrl).setPassword(JSON.stringify(tokens));
        await this.file.clear(apiUrl);
        return;
      } catch (e) {
        disableKeyring(e);
      }
    }
    await this.file.save(apiUrl, tokens);
  }
  async clear(apiUrl: string): Promise<void> {
    const kr = await loadKeyring();
    if (kr) {
      try {
        new kr.Entry(SERVICE, apiUrl).deletePassword();
      } catch (e) {
        debug("keyring delete failed", e);
      }
    }
    await this.file.clear(apiUrl);
  }
}

export class MemoryTokenStore implements TokenStore {
  readonly data = new Map<string, StoredTokens>();
  async load(apiUrl: string) {
    return this.data.get(apiUrl) ?? null;
  }
  async save(apiUrl: string, t: StoredTokens) {
    this.data.set(apiUrl, t);
  }
  async clear(apiUrl: string) {
    this.data.delete(apiUrl);
  }
}
