/**
 * @agnt0/protocol — the wire contract between the agnt0 CLI, the web app and the cloud API.
 *
 * Rules:
 *  - Every request and response body that crosses the network has a zod schema here.
 *  - Field names are snake_case on the wire.
 *  - Bump PROTOCOL_VERSION on any breaking change; the API rejects older CLIs with 426.
 *  - Nothing secret lives here: no prompts, no routing rules, no pricing logic.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_HEADER = "x-agnt0-protocol";
export const CLI_VERSION_HEADER = "x-agnt0-cli";

/* ------------------------------------------------------------------ */
/* Shared enums                                                        */
/* ------------------------------------------------------------------ */

export const Plan = z.enum(["none", "starter", "pro", "max"]);
export type Plan = z.infer<typeof Plan>;

export const SubscriptionStatus = z.enum(["none", "active", "past_due", "canceled", "lapsed"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const Runner = z.enum(["claude", "codex"]);
export type Runner = z.infer<typeof Runner>;

export const ModelTier = z.enum(["opus", "sonnet", "haiku"]);
export type ModelTier = z.infer<typeof ModelTier>;

/** The 14 visible agents plus the two hidden helpers. */
export const Role = z.enum([
  "product_strategist",
  "planner",
  "architect",
  "product_designer",
  "frontend_developer",
  "backend_developer",
  "debugger",
  "code_reviewer",
  "security_reviewer",
  "code_auditor",
  "test_engineer",
  "qa_tester",
  "release_manager",
  "docs_writer",
  "verifier",
  "explore",
]);
export type Role = z.infer<typeof Role>;

export const ROLE_LABELS: Record<Role, string> = {
  product_strategist: "Product Strategist",
  planner: "Planner",
  architect: "Architect",
  product_designer: "Product Designer",
  frontend_developer: "Frontend Developer",
  backend_developer: "Backend Developer",
  debugger: "Debugger",
  code_reviewer: "Code Reviewer",
  security_reviewer: "Security Reviewer",
  code_auditor: "Code Auditor",
  test_engineer: "Test Engineer",
  qa_tester: "QA Tester",
  release_manager: "Release Manager",
  docs_writer: "Docs Writer",
  verifier: "Verifier",
  explore: "Explore",
};

export const Phase = z.enum(["define", "wireframe", "design", "prototype", "qa", "ship_ready"]);
export type Phase = z.infer<typeof Phase>;

export const TicketStatus = z.enum(["backlog", "ready", "in_progress", "in_review", "approval", "done", "blocked"]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const StepKind = z.enum(["plan", "build", "review", "verify", "fix", "audit"]);
export type StepKind = z.infer<typeof StepKind>;

export const StepStatus = z.enum(["leased", "running", "succeeded", "failed", "expired", "cancelled"]);
export type StepStatus = z.infer<typeof StepStatus>;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export const ErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "token_expired",
  "plan_required",
  "credits_exhausted",
  "limit_reached",
  "forbidden",
  "not_found",
  "stale_sha",
  "protocol_outdated",
  "rate_limited",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: ErrorCode,
  message: z.string(),
  upgrade_url: z.string().optional(),
  retry_after_s: z.number().optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export const LimitKind = z.enum(["session", "week", "hosted_ai"]);
export type LimitKind = z.infer<typeof LimitKind>;

/** Body of `402 limit_reached`. The CLI prints it; the web chat turns it into the limit popover. */
export const LimitReached = ApiError.extend({
  error: z.literal("limit_reached"),
  limit: LimitKind,
  used: z.number(),
  allowance: z.number(),
  resets_at: z.string(),
  options: z.array(z.enum(["wait", "extra_credits", "upgrade"])),
  buy_url: z.string(),
  upgrade_url: z.string(),
});
export type LimitReached = z.infer<typeof LimitReached>;

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export const SignupRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(80),
});
export const LoginRequest = z.object({ email: z.string().email(), password: z.string().min(1) });
export const WebSessionResponse = z.object({ token: z.string(), expires_at: z.string() });
export type WebSessionResponse = z.infer<typeof WebSessionResponse>;

/** POST /v1/oauth/device */
export const DeviceStartRequest = z.object({
  client: z.literal("agnt0-cli"),
  device_name: z.string().max(120),
  os: z.string().max(60),
});
export const DeviceStartResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  interval_s: z.number().int(),
  expires_in_s: z.number().int(),
});
export type DeviceStartResponse = z.infer<typeof DeviceStartResponse>;

/** POST /v1/oauth/device/approve (web, signed in) */
export const DeviceApproveRequest = z.object({ user_code: z.string(), approve: z.boolean() });

/** POST /v1/oauth/token */
export const TokenRequest = z.discriminatedUnion("grant_type", [
  z.object({ grant_type: z.literal("device_code"), device_code: z.string() }),
  z.object({ grant_type: z.literal("refresh_token"), refresh_token: z.string() }),
]);
export const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in_s: z.number().int(),
  token_type: z.literal("Bearer"),
});
export type TokenResponse = z.infer<typeof TokenResponse>;
/** While the user has not approved yet the token endpoint returns 400 with one of these. */
export const DevicePending = z.object({ error: z.enum(["authorization_pending", "slow_down", "access_denied", "expired_token"]) });

export const RevokeRequest = z.object({ refresh_token: z.string() });

/* ------------------------------------------------------------------ */
/* Account and usage                                                   */
/* ------------------------------------------------------------------ */

export const UsageWindow = z.object({
  kind: z.enum(["session", "week"]),
  used: z.number(),
  allowance: z.number(),
  started_at: z.string().nullable(),
  resets_at: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsageSnapshot = z.object({
  plan: Plan,
  subscription_status: SubscriptionStatus,
  session: UsageWindow,
  week: UsageWindow,
  hosted_ai: z.object({ used: z.number(), cap: z.number() }),
  onboarding_allowance_left: z.number(),
  wallet: z.object({
    balance: z.number(),
    keep_working: z.boolean(),
    auto_reload_pack: z.enum(["none", "pack_10", "pack_25", "pack_50"]),
    monthly_spend_cap_usd: z.number(),
    spent_this_month_usd: z.number(),
  }),
  max_parallel_agents: z.number().int(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

export const UsageSettingsPatch = z.object({
  keep_working: z.boolean().optional(),
  auto_reload_pack: z.enum(["none", "pack_10", "pack_25", "pack_50"]).optional(),
  monthly_spend_cap_usd: z.number().min(0).max(1000).optional(),
});

export const Me = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  usage: UsageSnapshot,
  cli_sessions: z.array(
    z.object({ id: z.string(), device_name: z.string(), os: z.string(), last_seen_at: z.string().nullable() }),
  ),
});
export type Me = z.infer<typeof Me>;

/* ------------------------------------------------------------------ */
/* Onboarding signals                                                  */
/* ------------------------------------------------------------------ */

export const OnboardingStepId = z.enum(["node_git", "runner", "cli_install", "login", "doctor", "github", "chrome_extension"]);
export type OnboardingStepId = z.infer<typeof OnboardingStepId>;

export const OnboardingStep = z.object({
  step: OnboardingStepId,
  status: z.enum(["todo", "done", "skipped"]),
  proved_by: z.string().nullable(),
  proved_at: z.string().nullable(),
});
export const OnboardingState = z.object({ steps: z.array(OnboardingStep), handoff_ready: z.boolean() });
export type OnboardingState = z.infer<typeof OnboardingState>;

/** POST /v1/doctor-reports — the CLI uploads every `agnt0 doctor` result; it proves onboarding steps. */
export const DoctorCheck = z.object({
  id: z.enum(["node", "git", "package_manager", "claude", "claude_login", "codex", "codex_login", "ports"]),
  ok: z.boolean(),
  detail: z.string(),
  version: z.string().optional(),
});
export const DoctorReport = z.object({
  cli_version: z.string(),
  os: z.string(),
  checks: z.array(DoctorCheck),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

/** POST /v1/cli/heartbeat */
export const Heartbeat = z.object({
  project_id: z.string().nullable(),
  cli_version: z.string(),
  runner: Runner.nullable(),
  state: z.enum(["idle", "running", "paused"]),
});

/* ------------------------------------------------------------------ */
/* Projects and tickets                                                */
/* ------------------------------------------------------------------ */

export const ProjectSettings = z.object({
  default_runner: Runner.default("claude"),
  runner_by_role: z.record(Role, Runner).default({}),
  approval_policy: z.enum(["ask_risky", "ask_all", "auto"]).default("ask_risky"),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  phase: Phase,
  brief: z.string().nullable(),
  repo_sha: z.string().nullable(),
  settings: ProjectSettings,
  created_at: z.string(),
});
export type Project = z.infer<typeof Project>;

/** POST /v1/projects — `agnt0 init` (mode new) or `agnt0 link` (mode existing). */
export const CreateProjectRequest = z.object({
  name: z.string().min(1).max(80),
  mode: z.enum(["new", "existing"]),
  brief: z.string().max(20000).optional(),
  repo_sha: z.string().optional(),
});

export const Ticket = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: z.array(z.string()),
  status: TicketStatus,
  role: Role,
  priority: z.number().int(),
  depends_on: z.array(z.string()),
  parallel_ok: z.boolean(),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Ticket = z.infer<typeof Ticket>;

export const TicketPatch = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: TicketStatus.optional(),
  priority: z.number().int().optional(),
});

/** What the Planner step must output (validated by the server before tickets are created). */
export const PlannedTicket = z.object({
  key: z.string().describe("Planner-local key used by depends_on, e.g. T1"),
  title: z.string().min(3).max(140),
  description: z.string().max(4000),
  acceptance_criteria: z.array(z.string()).min(1).max(12),
  role: z.enum(["frontend_developer", "backend_developer", "test_engineer", "docs_writer"]),
  priority: z.number().int().min(1).max(5),
  depends_on: z.array(z.string()).default([]),
  parallel_ok: z.boolean().default(true),
});
export const PlanOutput = z.object({ tickets: z.array(PlannedTicket).min(1).max(40) });
export type PlanOutput = z.infer<typeof PlanOutput>;

/** What a review step must output. */
export const ReviewOutput = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  findings: z.array(z.object({ severity: z.enum(["low", "medium", "high"]), file: z.string().optional(), note: z.string() })),
  acceptance: z.array(z.object({ criterion: z.string(), met: z.boolean() })),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/* ------------------------------------------------------------------ */
/* Steps — the orchestrator hands out exactly one at a time            */
/* ------------------------------------------------------------------ */

export const Compression = z.object({
  read: z.array(z.enum(["logs", "json", "test", "csv"])),
  write: z.enum(["full", "terse"]),
});

export const Step = z.object({
  step_id: z.string(),
  project_id: z.string(),
  ticket_id: z.string().nullable(),
  kind: StepKind,
  role: Role,
  runner: Runner,
  model: ModelTier,
  /** Server-authored instructions. Held in CLI memory only; never written to disk. */
  prompt: z.string(),
  /** If set the runner must finish by printing one JSON object matching this schema name. */
  output_schema: z.enum(["plan", "review"]).nullable(),
  compression: Compression,
  allowed_tools: z.array(z.string()),
  scope: z.array(z.string()),
  /** Relative to the repo root, e.g. .agnt0/wt/tkt_41. Null = run in the repo root (plan steps). */
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  approval: z.object({ requires_approval: z.array(z.string()) }),
  checkpoint_before: z.boolean(),
  lease_expires_at: z.string(),
  max_turns: z.number().int(),
});
export type Step = z.infer<typeof Step>;

/** POST /v1/projects/{id}/steps/next */
export const StepNextRequest = z.object({
  runner_available: z.array(Runner),
  repo_sha: z.string().nullable(),
  max_parallel: z.number().int().min(1).max(8).default(1),
});
export const StepNextResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("step"), step: Step }),
  z.object({
    kind: z.literal("idle"),
    reason: z.enum(["no_ready_tickets", "waiting_approval", "phase_complete", "needs_brief", "all_done"]),
    message: z.string(),
  }),
]);
export type StepNextResponse = z.infer<typeof StepNextResponse>;

export const EventType = z.enum(["tool_call", "file_diff", "log", "browse", "message"]);
export const StepEvent = z.object({
  type: EventType,
  summary: z.string().max(2000),
  at: z.string(),
  data: z.record(z.unknown()).optional(),
});
export type StepEvent = z.infer<typeof StepEvent>;

/** POST /v1/steps/{id}/events */
export const StepEventsRequest = z.object({ events: z.array(StepEvent).max(200) });

export const TokenUsage = z.object({
  runner: Runner,
  model: z.string(),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_read_tokens: z.number().int().min(0),
  cache_write_tokens: z.number().int().min(0).default(0),
  raw_tool_tokens: z.number().int().min(0).default(0),
  sent_tool_tokens: z.number().int().min(0).default(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** POST /v1/steps/{id}/complete */
export const StepCompleteRequest = z.object({
  outcome: z.enum(["succeeded", "failed"]),
  summary: z.string().max(8000),
  /** Parsed JSON the runner printed when output_schema was set. */
  output: z.unknown().optional(),
  diff: z
    .object({ files_changed: z.number().int(), lines_added: z.number().int(), lines_removed: z.number().int(), head_sha: z.string().nullable() })
    .optional(),
  usage: TokenUsage,
  duration_ms: z.number().int(),
  error: z.string().optional(),
});
export type StepCompleteRequest = z.infer<typeof StepCompleteRequest>;

export const StepCompleteResponse = z.object({
  credits_charged: z.number(),
  next: z.enum(["continue", "pause_limit", "idle"]),
  usage: UsageSnapshot,
});
export type StepCompleteResponse = z.infer<typeof StepCompleteResponse>;

/* ------------------------------------------------------------------ */
/* Guide (web agent)                                                   */
/* ------------------------------------------------------------------ */

/** POST /v1/guide/messages — response is text/event-stream of GuideStreamEvent lines. */
export const GuideMessageRequest = z.object({
  session_id: z.string().nullable(),
  content: z.string().min(1).max(8000),
  project_id: z.string().nullable().optional(),
});
export const GuideStreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), session_id: z.string(), phase: z.enum(["discovery", "setup", "after_handoff"]) }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("action"), action: z.enum(["show_setup_checklist", "show_install_command", "create_project", "handoff"]), data: z.record(z.unknown()).optional() }),
  z.object({ type: z.literal("done"), message_id: z.string(), credits_charged: z.number(), usage: UsageSnapshot }),
  z.object({ type: z.literal("limit"), limit: LimitReached }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type GuideStreamEvent = z.infer<typeof GuideStreamEvent>;

export const GuideMessage = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  credits_charged: z.number(),
  created_at: z.string(),
});
export type GuideMessage = z.infer<typeof GuideMessage>;

/* ------------------------------------------------------------------ */
/* Realtime — wss://<api>/v1/rt/projects/{id}?token=...                */
/* ------------------------------------------------------------------ */

export const RealtimeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("step.started"), step_id: z.string(), ticket_id: z.string().nullable(), role: Role, at: z.string() }),
  z.object({ type: z.literal("step.event"), step_id: z.string(), event: StepEvent }),
  z.object({ type: z.literal("step.completed"), step_id: z.string(), outcome: z.string(), credits_charged: z.number(), at: z.string() }),
  z.object({ type: z.literal("ticket.updated"), ticket: Ticket }),
  z.object({ type: z.literal("usage.updated"), usage: UsageSnapshot }),
  z.object({ type: z.literal("limit.reached"), limit: LimitReached }),
  z.object({ type: z.literal("cli.heartbeat"), state: z.enum(["idle", "running", "paused"]), at: z.string() }),
  z.object({ type: z.literal("onboarding.updated"), onboarding: OnboardingState }),
]);
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

/* ------------------------------------------------------------------ */
/* Route table — one place both sides read paths from                  */
/* ------------------------------------------------------------------ */

export const routes = {
  signup: "/v1/auth/signup",
  login: "/v1/auth/login",
  logoutWeb: "/v1/auth/logout",
  deviceStart: "/v1/oauth/device",
  deviceApprove: "/v1/oauth/device/approve",
  token: "/v1/oauth/token",
  revoke: "/v1/oauth/revoke",
  me: "/v1/me",
  usage: "/v1/usage",
  usageSettings: "/v1/usage/settings",
  devActivatePlan: "/v1/billing/dev-activate",
  checkout: "/v1/billing/checkout",
  creditsCheckout: "/v1/credits/checkout",
  stripeWebhook: "/v1/webhooks/stripe",
  onboarding: "/v1/onboarding",
  doctorReports: "/v1/doctor-reports",
  heartbeat: "/v1/cli/heartbeat",
  projects: "/v1/projects",
  project: (id: string) => `/v1/projects/${id}`,
  tickets: (id: string) => `/v1/projects/${id}/tickets`,
  ticket: (projectId: string, ticketId: string) => `/v1/projects/${projectId}/tickets/${ticketId}`,
  stepsNext: (id: string) => `/v1/projects/${id}/steps/next`,
  stepEvents: (stepId: string) => `/v1/steps/${stepId}/events`,
  stepComplete: (stepId: string) => `/v1/steps/${stepId}/complete`,
  activity: (id: string) => `/v1/projects/${id}/activity`,
  guideMessages: "/v1/guide/messages",
  guideHistory: "/v1/guide/sessions/current",
  realtime: (id: string) => `/v1/rt/projects/${id}`,
} as const;

/* ------------------------------------------------------------------ */
// added by api — additive response/request schemas for routes above whose shapes were not yet defined
/* ------------------------------------------------------------------ */

/** Generic acknowledgement: logoutWeb, revoke, heartbeat, stripeWebhook. */
export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** Response of POST /v1/oauth/device/approve. */
export const DeviceApproveResponse = z.object({
  ok: z.literal(true),
  status: z.enum(["approved", "denied"]),
  device_name: z.string(),
  os: z.string(),
});
export type DeviceApproveResponse = z.infer<typeof DeviceApproveResponse>;

export const PaidPlan = z.enum(["starter", "pro", "max"]);
export type PaidPlan = z.infer<typeof PaidPlan>;
export const CreditPack = z.enum(["pack_10", "pack_25", "pack_50"]);
export type CreditPack = z.infer<typeof CreditPack>;

/** POST /v1/billing/dev-activate (local dev only) — responds with UsageSnapshot. */
export const DevActivateRequest = z.object({ plan: PaidPlan });
/** POST /v1/billing/checkout */
export const CheckoutRequest = z.object({ plan: PaidPlan });
/** POST /v1/credits/checkout */
export const CreditsCheckoutRequest = z.object({ pack: CreditPack });
/** Response of both checkout routes: redirect the browser to `url`. */
export const CheckoutResponse = z.object({ url: z.string() });
export type CheckoutResponse = z.infer<typeof CheckoutResponse>;

/** GET /v1/projects */
export const ProjectList = z.object({ projects: z.array(Project) });
export type ProjectList = z.infer<typeof ProjectList>;

/** GET /v1/projects/{id}/tickets (PATCH .../tickets/{ticketId} responds with Ticket). */
export const TicketList = z.object({ tickets: z.array(Ticket) });
export type TicketList = z.infer<typeof TicketList>;

/** Response of POST /v1/steps/{id}/events */
export const StepEventsResponse = z.object({ accepted: z.number().int() });

/** GET /v1/projects/{id}/activity — newest first. */
export const ActivityStep = z.object({
  id: z.string(),
  ticket_id: z.string().nullable(),
  kind: StepKind,
  role: Role,
  model: ModelTier,
  status: StepStatus,
  summary: z.string().nullable(),
  credits_charged: z.number(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
});
export const ActivityEvent = z.object({
  id: z.string(),
  step_id: z.string(),
  type: EventType,
  summary: z.string(),
  at: z.string(),
  data: z.record(z.unknown()).optional(),
});
export const ActivityResponse = z.object({ steps: z.array(ActivityStep), events: z.array(ActivityEvent) });
export type ActivityResponse = z.infer<typeof ActivityResponse>;

/** GET /v1/guide/sessions/current */
export const GuideSession = z.object({
  id: z.string(),
  phase: z.enum(["discovery", "setup", "after_handoff"]),
  project_id: z.string().nullable(),
  created_at: z.string(),
});
export type GuideSession = z.infer<typeof GuideSession>;
export const GuideHistoryResponse = z.object({ session: GuideSession.nullable(), messages: z.array(GuideMessage) });
export type GuideHistoryResponse = z.infer<typeof GuideHistoryResponse>;

/** Realtime user channel (counterpart of routes.realtime): wss://<api>/v1/rt/me?token=... carries
 *  usage.updated, limit.reached, onboarding.updated and cli.heartbeat for the signed-in user. */
export const realtimeMe = "/v1/rt/me";
