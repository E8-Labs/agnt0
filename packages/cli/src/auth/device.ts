import { DevicePending, DeviceStartResponse, routes, TokenResponse } from "@agnt0/protocol";
import { hostname, platform, release } from "node:os";
import { ApiClient, realSleep } from "../api/client.js";
import { ApiHttpError, CliError } from "../errors.js";

export interface DeviceLoginDeps {
  api: ApiClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called once the code is known, to print it and open the browser. */
  onCode: (start: DeviceStartResponse) => void | Promise<void>;
  deviceName?: string;
  os?: string;
}

export function describeOs(): string {
  return `${platform()} ${release()}`.slice(0, 60);
}

/** RFC 8628-style device flow against the Agent Zero API. */
export async function deviceLogin(deps: DeviceLoginDeps): Promise<TokenResponse> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const start = await deps.api.post(routes.deviceStart, {
    auth: false,
    body: {
      client: "agnt0-cli",
      device_name: (deps.deviceName ?? hostname()).slice(0, 120),
      os: (deps.os ?? describeOs()).slice(0, 60),
    },
    schema: DeviceStartResponse,
  });
  await deps.onCode(start);

  let interval = Math.max(1, start.interval_s);
  const deadline = now() + start.expires_in_s * 1000;

  while (now() < deadline) {
    await sleep(interval * 1000);
    try {
      return await deps.api.post(routes.token, {
        auth: false,
        body: { grant_type: "device_code", device_code: start.device_code },
        schema: TokenResponse,
      });
    } catch (e) {
      if (!(e instanceof ApiHttpError)) throw e;
      const pending = DevicePending.safeParse(e.rawBody);
      if (!pending.success) throw e;
      switch (pending.data.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          interval += 5;
          continue;
        case "access_denied":
          throw new CliError("Login was denied in the browser.", "Run `agnt0 login` to try again.");
        case "expired_token":
          throw new CliError("The login code expired before it was approved.", "Run `agnt0 login` to get a new code.");
      }
    }
  }
  throw new CliError("The login code expired before it was approved.", "Run `agnt0 login` to get a new code.");
}
