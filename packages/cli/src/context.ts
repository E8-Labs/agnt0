import { ApiClient } from "./api/client.js";
import { AuthSession } from "./auth/session.js";
import { DefaultTokenStore, type TokenStore } from "./auth/store.js";
import { checkApiUrlSecurity, getApiUrl, getWebUrl } from "./config.js";
import { notLoggedIn } from "./errors.js";

export interface Context {
  apiUrl: string;
  webUrl: string;
  store: TokenStore;
  session: AuthSession;
  api: ApiClient;
}

export function createContext(store: TokenStore = new DefaultTokenStore()): Context {
  const apiUrl = getApiUrl();
  const warning = checkApiUrlSecurity(apiUrl);
  if (warning) console.error(warning);
  const session = new AuthSession(store, apiUrl);
  return { apiUrl, webUrl: getWebUrl(), store, session, api: new ApiClient({ baseUrl: apiUrl, tokens: session }) };
}

export async function requireLogin(ctx: Context): Promise<void> {
  if (!(await ctx.session.hasCredentials())) throw notLoggedIn();
}
