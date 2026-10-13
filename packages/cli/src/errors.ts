import { ApiError } from "@agnt0/protocol";
import pc from "picocolors";
import { isDebug } from "./config.js";

/** An error meant for the user: printed without a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** A non-2xx response from the Agent Zero API. */
export class ApiHttpError extends Error {
  public readonly body: ApiError | undefined;
  constructor(
    public readonly status: number,
    public readonly rawBody: unknown,
    public readonly path: string,
  ) {
    const parsed = ApiError.safeParse(rawBody);
    super(parsed.success ? parsed.data.message : `HTTP ${status} from ${path}`);
    this.name = "ApiHttpError";
    this.body = parsed.success ? parsed.data : undefined;
  }
  get code(): string | undefined {
    return this.body?.error;
  }
}

export function notLoggedIn(): CliError {
  return new CliError("You're not logged in.", "Run `agnt0 login` first.");
}

export function describeError(err: unknown): { message: string; hint?: string } {
  if (err instanceof CliError) return { message: err.message, hint: err.hint };
  if (err instanceof ApiHttpError) {
    const b = err.body;
    switch (b?.error) {
      case "unauthorized":
      case "token_expired":
        return { message: "Your Agent Zero session has expired.", hint: "Run `agnt0 login` again." };
      case "plan_required":
        return { message: "This needs an active Agent Zero plan.", hint: `Pick a plan: ${b.upgrade_url ?? "agnt0 upgrade"}` };
      case "credits_exhausted":
        return { message: "Your extra credits are used up.", hint: "Run `agnt0 credits buy` or `agnt0 upgrade`." };
      case "limit_reached":
        return { message: b.message, hint: "Run `agnt0 usage` to see when it resets, or `agnt0 credits use`." };
      case "forbidden":
        return { message: "This project belongs to a different account.", hint: "Check `agnt0 status`, or link this repo again with `agnt0 link`." };
      case "not_found":
        return { message: b.message || "Not found." };
      case "protocol_outdated":
        return { message: "This version of agnt0 is too old for the Agent Zero API.", hint: "Update it: npm i -g agnt0@latest" };
      case "stale_sha":
        return { message: "Your local repo is behind what Agent Zero expects.", hint: "Pull or merge the latest changes, then run again." };
      case "rate_limited":
        return { message: "Too many requests right now.", hint: "Wait a moment and try again." };
      default:
        if (err.status >= 500) return { message: `The Agent Zero API had a problem (HTTP ${err.status}).`, hint: "Try again in a minute." };
        return { message: err.message };
    }
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

export function printError(err: unknown): number {
  const { message, hint } = describeError(err);
  console.error(`${pc.red("✗")} ${message}`);
  if (hint) console.error(`  ${pc.dim(hint)}`);
  if (isDebug() && err instanceof Error && err.stack) console.error(pc.dim(err.stack));
  return err instanceof CliError ? err.exitCode : 1;
}
