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

/**
 * The project's backend decision, made once and then honoured by every step.
 *
 * Without this, each step re-derives the stack from the brief and they can disagree — one ticket
 * writing Prisma while the next writes Drizzle. Every field is optional because this has to describe
 * any backend a user brings (Neon, Supabase, AWS, Rails, …), not a fixed menu; what matters is that
 * the commands are stated once so no role has to guess them.
 */
export const ProjectStack = z.object({
  /** One line for the dashboard, e.g. "Postgres on Neon with Drizzle". */
  summary: z.string().max(400).optional(),
  db: z.string().max(60).optional(),
  /** Who hosts the database: neon, supabase, rds, local… */
  provider: z.string().max(60).optional(),
  orm: z.string().max(60).optional(),
  auth: z.string().max(60).optional(),
  storage: z.string().max(60).optional(),
  hosting: z.string().max(60).optional(),
  /** Exactly how this project runs migrations, so no step invents its own command. */
  migrate_command: z.string().max(200).optional(),
  test_command: z.string().max(200).optional(),
  /**
   * `disposable` means the database the agents touch can be recreated and is safe to migrate
   * against; `shared` means it holds data someone would miss. Steps are told which, because a
   * migration is the most destructive thing an agent can do to a project.
   */
  dev_database: z.enum(["disposable", "shared"]).optional(),
});
export type ProjectStack = z.infer<typeof ProjectStack>;

export const ProjectSettings = z.object({
  default_runner: Runner.default("claude"),
  runner_by_role: z.record(Role, Runner).default({}),
  approval_policy: z.enum(["ask_risky", "ask_all", "auto"]).default("ask_risky"),
  /** Absent until the Architect (or the user) has decided. */
  stack: ProjectStack.optional(),
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
  /**
   * Roles the planner may schedule. `architect` is here so the backend decision can be a ticket of
   * its own, made once before the work that depends on it; the others the planner never assigns —
   * a review is created by the engine for every ticket, and the release ticket is added by the
   * engine once the rest are done.
   */
  role: z.enum(["architect", "frontend_developer", "backend_developer", "test_engineer", "docs_writer"]),
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

/**
 * A skill as it reaches one step. Never a GitHub link to clone at run time: the registry has already
 * pinned, checked and packaged it, so the CLI only has to verify a checksum.
 */
export const StepSkillInline = z.object({
  id: z.string(),
  /** Directory and skill name, lowercase and dash-separated, e.g. `agnt0-frontend-rules`. */
  slug: z.string(),
  version: z.string(),
  /** The whole SKILL.md, frontmatter included, for a skill that is instructions and nothing else. */
  inline: z.string(),
  /** Always false: an inline skill costs nothing to resend, and ours are deleted after the step. */
  cache: z.literal(false),
});
export type StepSkillInline = z.infer<typeof StepSkillInline>;

export const StepSkillBundle = z.object({
  id: z.string(),
  slug: z.string(),
  version: z.string(),
  /** Hex sha256 of the bundle. The CLI verifies it before unpacking and refuses the skill on mismatch. */
  sha256: z.string(),
  /** Short-lived signed download link. */
  url: z.string(),
  /**
   * Whether the CLI may keep the unpacked bundle between steps. True for open-source skills, whose
   * data files are large and whose contents are public; false for ours, which are deleted after the step.
   */
  cache: z.boolean(),
});
export type StepSkillBundle = z.infer<typeof StepSkillBundle>;

/** Inline first: it is the shape with a required `inline`, so the union never mistakes one for the other. */
export const StepSkill = z.union([StepSkillInline, StepSkillBundle]);
export type StepSkill = z.infer<typeof StepSkill>;

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
  output_schema: z.enum(["plan", "review", "audit"]).nullable(),
  compression: Compression,
  allowed_tools: z.array(z.string()),
  scope: z.array(z.string()),
  /** Relative to the repo root, e.g. .agnt0/wt/tkt_41. Null = run in the repo root (plan steps). */
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  /**
   * Local ref a new worktree branch is cut from, e.g. `agnt0/tkt_40` for a ticket that depends on
   * tkt_40. Null, absent or unknown locally means branch from HEAD. Only used when the branch is
   * created; an existing branch is left where it is.
   *
   * Optional so an older server (which never sends it) still validates.
   */
  base_branch: z.string().nullable().optional(),
  /**
   * The skills the server matched to this step — a few at most, so matching stays sharp even on a
   * project that holds dozens. Instruction-only skills ride inline; anything with files comes as a
   * checksummed bundle. Defaulted so an older server (which never sends it) still validates.
   */
  skills: z.array(StepSkill).max(12).default([]),
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
  z.object({
    type: z.literal("step.completed"),
    step_id: z.string(),
    outcome: z.string(),
    credits_charged: z.number(),
    /** Tokens the step reported (input + output + cache reads), for the live agent tiles. */
    tokens: z.number().optional(),
    at: z.string(),
  }),
  z.object({ type: z.literal("ticket.updated"), ticket: Ticket }),
  z.object({ type: z.literal("usage.updated"), usage: UsageSnapshot }),
  z.object({ type: z.literal("limit.reached"), limit: LimitReached }),
  z.object({ type: z.literal("cli.heartbeat"), state: z.enum(["idle", "running", "paused"]), at: z.string() }),
  z.object({ type: z.literal("onboarding.updated"), onboarding: OnboardingState }),
  // M1/M2 additions
  z.object({ type: z.literal("notification.created"), notification: z.lazy(() => Notification) }),
  z.object({ type: z.literal("checkpoint.created"), checkpoint: z.lazy(() => Checkpoint) }),
  z.object({ type: z.literal("checkpoint.restore_requested"), checkpoint: z.lazy(() => Checkpoint), requested_at: z.string() }),
  z.object({ type: z.literal("preview.status"), preview: z.lazy(() => PreviewStatus) }),
  z.object({ type: z.literal("qa.finding"), qa_run_id: z.string(), finding: z.lazy(() => QaFinding) }),
  z.object({ type: z.literal("qa.completed"), qa_run: z.lazy(() => QaRun) }),
  z.object({ type: z.literal("audit.progress"), audit_id: z.string(), stage: z.string(), at: z.string() }),
  z.object({ type: z.literal("audit.completed"), audit: z.lazy(() => AuditRun) }),
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
  agents: (id: string) => `/v1/projects/${id}/agents`,
  guideMessages: "/v1/guide/messages",
  guideHistory: "/v1/guide/sessions/current",
  realtime: (id: string) => `/v1/rt/projects/${id}`,
  // added by api
  rtTicket: "/v1/rt/ticket",
  ticketDecision: (projectId: string, ticketId: string) => `/v1/projects/${projectId}/tickets/${ticketId}/decision`,
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

/**
 * What one agent has done on a project. Everything here is measured from steps the agent actually
 * ran; anything we cannot measure yet is absent rather than zero, so the dashboard never shows a
 * confident 0 for something that was simply never recorded.
 */
export const AgentStats = z.object({
  role: Role,
  steps: z.number().int(),
  /** Tickets this agent worked, however many steps that took. */
  tickets: z.number().int(),
  /**
   * Share of this agent's finished tickets that a reviewer approved without sending them back,
   * 0-1. Absent until it has finished one, since a rate over no tickets is meaningless.
   */
  first_pass_rate: z.number().min(0).max(1).optional(),
  /** Wall-clock seconds per step, averaged over the steps that ended. */
  avg_step_seconds: z.number().optional(),
  credits: z.number().int(),
  tokens: z.number().int(),
  /** What those tokens would cost at list API prices, in USD. An estimate, from placeholder prices. */
  api_price_usd: z.number().optional(),
  /** Share of the plan's weekly allowance this agent used, 0-1. */
  plan_share: z.number().min(0).max(1).optional(),
  /** Which models it ran on, most-used first. */
  model_mix: z.array(z.object({ model: z.string(), steps: z.number().int() })),
  last_active_at: z.string().nullable(),
});
export type AgentStats = z.infer<typeof AgentStats>;

export const AgentsResponse = z.object({
  agents: z.array(AgentStats),
  /**
   * Things the page would show but cannot measure yet, each with the reason, so the UI can say so
   * instead of rendering a misleading zero. e.g. `tokens_saved` until compression ships.
   */
  unavailable: z.array(z.object({ metric: z.string(), reason: z.string() })).default([]),
});
export type AgentsResponse = z.infer<typeof AgentsResponse>;

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

// added by api — PATCH /v1/projects/{id} (responds with Project). Omitted fields are left unchanged;
// `settings` keys are merged into the current settings; `brief: null` clears the brief.
export const ProjectPatch = z.object({
  name: z.string().min(1).max(80).optional(),
  brief: z.string().max(20000).nullable().optional(),
  settings: z
    .object({
      default_runner: Runner.optional(),
      runner_by_role: z.record(Role, Runner).optional(),
      approval_policy: z.enum(["ask_risky", "ask_all", "auto"]).optional(),
      stack: ProjectStack.optional(),
    })
    .optional(),
});
export type ProjectPatch = z.infer<typeof ProjectPatch>;

// added by api — POST /v1/rt/ticket: a single-use, user-bound ticket for opening a realtime socket from the
// browser (wss://<api>/v1/rt/...?ticket=...). Web session tokens are not accepted on the socket; CLI access
// tokens still are (?token=).
export const RtTicketResponse = z.object({ ticket: z.string(), expires_in_s: z.number().int() });
export type RtTicketResponse = z.infer<typeof RtTicketResponse>;

// added by api — POST /v1/projects/{id}/tickets/{ticketId}/decision for tickets in `approval`
// (approve → ready, reject → blocked). Responds with Ticket; 409 when the ticket is not awaiting a decision.
export const TicketDecisionRequest = z.object({ decision: z.enum(["approve", "reject"]) });
export type TicketDecisionRequest = z.infer<typeof TicketDecisionRequest>;


/* ------------------------------------------------------------------ */
/* M1/M2 contracts — checkpoints, notifications, env, preview, QA, audit */
/* ------------------------------------------------------------------ */

// ---- Checkpoints. The CLI makes the git ref; the server keeps the record. Restore is executed by the CLI.
export const Checkpoint = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  git_sha: z.string(),
  git_ref: z.string(),
  created_by: z.enum(["agent", "user"]),
  step_id: z.string().nullable(),
  created_at: z.string(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;
export const CreateCheckpointRequest = z.object({
  name: z.string().min(1).max(120),
  git_sha: z.string().regex(/^[0-9a-f]{7,64}$/),
  git_ref: z.string().max(200),
  created_by: z.enum(["agent", "user"]),
  step_id: z.string().nullable().optional(),
});
export const CheckpointList = z.object({ checkpoints: z.array(Checkpoint) });
/** POST /v1/checkpoints/{id}/restore — records the request and pushes checkpoint.restore_requested to the CLI. */
export const RestoreResponse = z.object({ checkpoint: Checkpoint, requested_at: z.string(), cli_command: z.string() });

// ---- Notifications
export const NotificationType = z.enum(["approval", "limit", "step_failed", "ticket_blocked", "project_done", "audit_done", "qa_findings", "plan_ready"]);
export const Notification = z.object({
  id: z.string(),
  type: NotificationType,
  title: z.string(),
  body: z.string(),
  project_id: z.string().nullable(),
  ticket_id: z.string().nullable(),
  read_at: z.string().nullable(),
  created_at: z.string(),
});
export type Notification = z.infer<typeof Notification>;
export const NotificationList = z.object({ notifications: z.array(Notification), unread: z.number().int() });

// ---- Env and secrets. Values only ever leave the server in EnvPullResponse (CLI token, logged).
export const EnvName = z.enum(["dev", "preview", "prod"]);
export type EnvName = z.infer<typeof EnvName>;
export const EnvKey = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
export const EnvVarMeta = z.object({
  key: z.string(),
  environment: EnvName,
  updated_at: z.string(),
  last_accessed_at: z.string().nullable(),
  preview: z.string().describe("Masked, e.g. sk_••••3f9a"),
});
export const EnvKeysResponse = z.object({ vars: z.array(EnvVarMeta) });
/** PUT /v1/projects/{id}/env (web). value null deletes the key. */
export const EnvPutRequest = z.object({
  environment: EnvName,
  vars: z.array(z.object({ key: EnvKey, value: z.string().max(16384).nullable() })).min(1).max(200),
});
/** GET /v1/projects/{id}/env?environment=dev (CLI token only). */
export const EnvPullResponse = z.object({ environment: EnvName, vars: z.record(z.string()) });

// ---- Preview (the CLI serves it locally; the server only learns its status)
export const PreviewStatus = z.object({
  project_id: z.string(),
  state: z.enum(["starting", "running", "stopped", "error"]),
  local_url: z.string().nullable(),
  framework: z.string().nullable(),
  devices: z.array(z.enum(["mobile", "tablet", "desktop"])),
  message: z.string().nullable(),
  at: z.string(),
});
export type PreviewStatus = z.infer<typeof PreviewStatus>;
export const PreviewStatusRequest = PreviewStatus.omit({ project_id: true, at: true });

// ---- Blobs (local disk driver in dev, R2 later). PUT/GET with a short-lived signed URL from the API.
export const SignedUpload = z.object({ key: z.string(), put_url: z.string(), get_url: z.string(), expires_in_s: z.number().int() });

// ---- QA
export const QaDevice = z.enum(["mobile", "tablet", "desktop"]);
export const QaFinding = z.object({
  id: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  device: QaDevice,
  title: z.string().max(200),
  url: z.string().max(2000),
  repro_steps: z.array(z.string().max(500)).max(20),
  screenshot_url: z.string().nullable(),
  ticket_id: z.string().nullable(),
});
export type QaFinding = z.infer<typeof QaFinding>;
export const QaRun = z.object({
  id: z.string(),
  project_id: z.string(),
  build_sha: z.string().nullable(),
  devices: z.array(QaDevice),
  status: z.enum(["running", "passed", "failed", "error"]),
  findings_count: z.number().int(),
  screenshots: z.array(z.object({ device: QaDevice, url: z.string(), page: z.string() })),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type QaRun = z.infer<typeof QaRun>;
/** POST /v1/projects/{id}/qa-runs → QaRunCreated (charged as a QA step). */
export const QaRunCreateRequest = z.object({
  build_sha: z.string().nullable(),
  devices: z.array(QaDevice).min(1),
  base_url: z.string().max(500),
  pages: z.array(z.string().max(500)).max(50),
});
export const QaRunCreated = z.object({ qa_run: QaRun, uploads: z.array(SignedUpload).max(200) });
/** POST /v1/qa-runs/{id}/complete */
export const QaRunCompleteRequest = z.object({
  status: z.enum(["passed", "failed", "error"]),
  screenshots: z.array(z.object({ device: QaDevice, key: z.string(), page: z.string() })).max(200),
  findings: z
    .array(z.object({
      severity: z.enum(["low", "medium", "high"]),
      device: QaDevice,
      title: z.string().max(200),
      url: z.string().max(2000),
      repro_steps: z.array(z.string().max(500)).max(20),
      screenshot_key: z.string().nullable(),
    }))
    .max(100),
});
export const QaRunList = z.object({ qa_runs: z.array(QaRun) });
export const QaRunDetail = z.object({ qa_run: QaRun, findings: z.array(QaFinding) });

// ---- Code Auditor. Runs as orchestrator steps (kind "audit", role code_auditor, output_schema "audit").
export const AuditFindingKind = z.enum(["dead_code", "unwired_call", "orphan_handler", "duplicate", "contradiction", "parallel_run", "broken_build", "failing_test"]);
export const AuditOutput = z.object({
  summary: z.string().max(4000),
  score: z.object({ overall: z.number().min(0).max(100), areas: z.record(z.number().min(0).max(100)) }),
  findings: z
    .array(z.object({
      kind: AuditFindingKind,
      severity: z.enum(["low", "medium", "high"]),
      title: z.string().max(200),
      file: z.string().max(500).nullable(),
      line: z.number().int().nullable(),
      evidence: z.string().max(4000),
      confirmed_by_run: z.boolean(),
    }))
    .max(200),
});
export type AuditOutput = z.infer<typeof AuditOutput>;
export const AuditFinding = AuditOutput.shape.findings.element.extend({
  id: z.string(),
  status: z.enum(["open", "ticketed", "dismissed"]),
  ticket_id: z.string().nullable(),
});
export type AuditFinding = z.infer<typeof AuditFinding>;
export const AuditRun = z.object({
  id: z.string(),
  project_id: z.string(),
  trigger: z.enum(["link", "import", "manual", "pre_ship"]),
  mode: z.enum(["full", "static"]),
  status: z.enum(["queued", "running", "completed", "failed", "skipped"]),
  score: z.number().nullable(),
  areas: z.record(z.number()).nullable(),
  summary: z.string().nullable(),
  estimate_credits: z.number().int(),
  credits_used: z.number().int(),
  commit_sha: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type AuditRun = z.infer<typeof AuditRun>;
/** POST /v1/projects/{id}/audits — queues an audit; the next steps/next leases its step. */
export const AuditStartRequest = z.object({ mode: z.enum(["full", "static"]).default("full"), trigger: z.enum(["link", "import", "manual", "pre_ship"]).default("manual") });
export const AuditList = z.object({ audits: z.array(AuditRun) });
export const AuditDetail = z.object({ audit: AuditRun, findings: z.array(AuditFinding) });
export const AuditFindingTicketRequest = z.object({ finding_ids: z.array(z.string()).min(1).max(50) });
export const AuditFindingTicketResponse = z.object({ tickets: z.array(Ticket) });
export const AuditFindingDismissRequest = z.object({ finding_ids: z.array(z.string()).min(1).max(50) });


/* ---------------------------------------------------- share links (M3) */

/**
 * A temporary public link to the user's running preview. The tunnel runs on their machine; this is
 * the record of it, so the dashboard can show what is live and revoke it.
 */
export const ShareLink = z.object({
  id: z.string(),
  project_id: z.string(),
  url: z.string(),
  kind: z.enum(["tunnel", "deploy"]),
  label: z.string().nullable(),
  /** active | expired | revoked | closed — derived, so a caller never has to compare clocks. */
  status: z.enum(["active", "expired", "revoked", "closed"]),
  expires_at: z.string(),
  created_at: z.string(),
});
export type ShareLink = z.infer<typeof ShareLink>;

export const ShareLinkList = z.object({ links: z.array(ShareLink) });
export type ShareLinkList = z.infer<typeof ShareLinkList>;

export const ShareLinkCreateRequest = z.object({
  url: z.string().url().max(2000),
  kind: z.enum(["tunnel", "deploy"]).default("tunnel"),
  label: z.string().max(120).optional(),
  /** How long the link should live. Defaults to 24 hours; the server caps it at 7 days. */
  ttl_hours: z.number().int().min(1).max(168).optional(),
});
export type ShareLinkCreateRequest = z.infer<typeof ShareLinkCreateRequest>;


/* --------------------------------------------------------- canvas (M3) */

/**
 * A screen on the Canvas: a real route of the user's app, captured as an image.
 * The Canvas shows what actually runs, so there is no wireframe document format — a screen is a
 * screenshot plus where it came from.
 */
export const CanvasScreen = z.object({
  id: z.string(),
  project_id: z.string(),
  ticket_id: z.string().nullable(),
  route: z.string(),
  label: z.string(),
  device: z.enum(["mobile", "tablet", "desktop"]),
  /** Short-lived signed URL for the image, or null while a capture is pending. */
  screenshot_url: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  version: z.number().int(),
  /** How many comments on this screen are still open. */
  open_comments: z.number().int(),
  captured_at: z.string().nullable(),
  created_at: z.string(),
});
export type CanvasScreen = z.infer<typeof CanvasScreen>;

export const CanvasComment = z.object({
  id: z.string(),
  screen_id: z.string(),
  author: z.string(),
  body: z.string(),
  status: z.enum(["open", "resolved"]),
  /** Position as a fraction of the screen's width and height, or null for the screen as a whole. */
  x: z.number().min(0).max(1).nullable(),
  y: z.number().min(0).max(1).nullable(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type CanvasComment = z.infer<typeof CanvasComment>;

export const CanvasScreenList = z.object({ screens: z.array(CanvasScreen) });
export type CanvasScreenList = z.infer<typeof CanvasScreenList>;
export const CanvasCommentList = z.object({ comments: z.array(CanvasComment) });
export type CanvasCommentList = z.infer<typeof CanvasCommentList>;

export const CanvasScreenCreateRequest = z.object({
  route: z.string().max(400),
  label: z.string().min(1).max(140),
  device: z.enum(["mobile", "tablet", "desktop"]).default("desktop"),
  ticket_id: z.string().optional(),
  /** Blob key of an already-uploaded screenshot, as `agnt0 qa` uploads them. */
  screenshot_key: z.string().max(400).optional(),
  width: z.number().int().positive().max(10_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
  qa_run_id: z.string().optional(),
});
export type CanvasScreenCreateRequest = z.infer<typeof CanvasScreenCreateRequest>;

export const CanvasCommentCreateRequest = z.object({
  body: z.string().min(1).max(4000),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
});
export type CanvasCommentCreateRequest = z.infer<typeof CanvasCommentCreateRequest>;

export const CanvasCommentPatch = z.object({ status: z.enum(["open", "resolved"]) });
export type CanvasCommentPatch = z.infer<typeof CanvasCommentPatch>;

/**
 * An inspiration item. We never rehost someone's design work: the item is a link to the source with
 * its own preview image, and opening it takes the user to the original site.
 */
export const InspoItem = z.object({
  id: z.string(),
  project_id: z.string(),
  kind: z.enum(["visual", "component_library"]),
  source: z.enum(["dribbble", "awwwards", "mobbin", "pinterest", "library", "url"]),
  url: z.string(),
  title: z.string(),
  thumbnail_url: z.string().nullable(),
  tags: z.array(z.string()),
  status: z.enum(["suggested", "liked", "removed"]),
  added_by: z.string(),
  created_at: z.string(),
});
export type InspoItem = z.infer<typeof InspoItem>;

export const InspoList = z.object({ items: z.array(InspoItem) });
export type InspoList = z.infer<typeof InspoList>;

export const InspoCreateRequest = z.object({
  url: z.string().url().max(2000),
  title: z.string().max(200).optional(),
  kind: z.enum(["visual", "component_library"]).default("visual"),
  thumbnail_url: z.string().url().max(2000).optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
});
export type InspoCreateRequest = z.infer<typeof InspoCreateRequest>;

export const InspoPatch = z.object({ status: z.enum(["suggested", "liked", "removed"]) });
export type InspoPatch = z.infer<typeof InspoPatch>;

/* --------------------------------------------------------- skills (M3) */

/**
 * How a skill reaches an agent. `core` is ours and locked to the role, `added` is the user's pick from
 * the library, `project` is matched by the server from the stack and the ticket.
 */
export const SkillTier = z.enum(["core", "added", "project"]);
export type SkillTier = z.infer<typeof SkillTier>;

/** A library entry: one skill at its latest approved version. */
export const SkillSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  /** `agnt0` is our own text, `curated` is reviewed open source, `private` is the user's own import. */
  source: z.enum(["agnt0", "curated", "private"]),
  version: z.string(),
  /** Verified means the registry's checks passed at this version: license, scripts, both runners. */
  verified: z.boolean(),
  runners: z.array(Runner),
  /** Roles that always carry this skill. The user cannot remove it from them. */
  core_roles: z.array(Role),
  /** Roles the server may match it to when a ticket fits. */
  match_roles: z.array(Role),
  /** Tools it needs on the user's machine, e.g. `python3`. `agnt0 doctor` checks these. */
  needs_tools: z.array(z.string()),
  /** 0 for an instruction-only skill that rides inline. */
  bytes: z.number().int(),
  origin_url: z.string().nullable(),
  license: z.string().nullable(),
  updated_at: z.string(),
});
export type SkillSummary = z.infer<typeof SkillSummary>;

export const SkillList = z.object({ skills: z.array(SkillSummary) });
export type SkillList = z.infer<typeof SkillList>;

/** Why a role carries a skill, so the card can say "Frontend Developer (auto)" and mean it. */
export const SkillUse = z.object({
  role: Role,
  reason: z.enum(["core", "pinned", "matched", "added"]),
});

export const ProjectSkill = z.object({
  skill: SkillSummary,
  tier: SkillTier,
  used_by: z.array(SkillUse),
  /** Null for core and server-matched skills, which nobody added by hand. */
  added_at: z.string().nullable(),
  /** How many steps on this project have loaded it. */
  loads: z.number().int(),
});
export type ProjectSkill = z.infer<typeof ProjectSkill>;

export const ProjectSkillList = z.object({
  skills: z.array(ProjectSkill),
  /** Added skills only — core and matched ones do not count against the limit. */
  added_count: z.number().int(),
  added_limit: z.number().int(),
});
export type ProjectSkillList = z.infer<typeof ProjectSkillList>;

export const ProjectSkillAddRequest = z.object({ skill_id: z.string() });
export type ProjectSkillAddRequest = z.infer<typeof ProjectSkillAddRequest>;

/** `auto` clears an override and puts the skill back under normal matching. */
export const AgentSkillOverrideRequest = z.object({
  skill_id: z.string(),
  mode: z.enum(["pin", "exclude", "auto"]),
});
export type AgentSkillOverrideRequest = z.infer<typeof AgentSkillOverrideRequest>;

export const m2routes = {
  checkpoints: (projectId: string) => `/v1/projects/${projectId}/checkpoints`,
  checkpointRestore: (checkpointId: string) => `/v1/checkpoints/${checkpointId}/restore`,
  notifications: "/v1/notifications",
  notificationRead: (id: string) => `/v1/notifications/${id}/read`,
  notificationsReadAll: "/v1/notifications/read-all",
  envKeys: (projectId: string) => `/v1/projects/${projectId}/env/keys`,
  env: (projectId: string) => `/v1/projects/${projectId}/env`,
  preview: (projectId: string) => `/v1/projects/${projectId}/preview`,
  blob: (key: string) => `/v1/blobs/${key}`,
  qaRuns: (projectId: string) => `/v1/projects/${projectId}/qa-runs`,
  qaRun: (runId: string) => `/v1/qa-runs/${runId}`,
  qaRunComplete: (runId: string) => `/v1/qa-runs/${runId}/complete`,
  audits: (projectId: string) => `/v1/projects/${projectId}/audits`,
  audit: (auditId: string) => `/v1/audits/${auditId}`,
  auditFindingsTicket: (auditId: string) => `/v1/audits/${auditId}/findings/ticket`,
  auditFindingsDismiss: (auditId: string) => `/v1/audits/${auditId}/findings/dismiss`,
  shareLinks: (projectId: string) => `/v1/projects/${projectId}/share-links`,
  shareLink: (id: string) => `/v1/share-links/${id}`,
  canvasScreens: (projectId: string) => `/v1/projects/${projectId}/canvas/screens`,
  canvasScreen: (screenId: string) => `/v1/canvas/screens/${screenId}`,
  canvasComments: (screenId: string) => `/v1/canvas/screens/${screenId}/comments`,
  canvasComment: (commentId: string) => `/v1/canvas/comments/${commentId}`,
  inspo: (projectId: string) => `/v1/projects/${projectId}/inspo`,
  inspoItem: (id: string) => `/v1/inspo/${id}`,
  skills: "/v1/skills",
  projectSkills: (projectId: string) => `/v1/projects/${projectId}/skills`,
  projectSkill: (projectId: string, skillId: string) => `/v1/projects/${projectId}/skills/${skillId}`,
  agentSkills: (projectId: string, role: string) => `/v1/projects/${projectId}/agents/${role}/skills`,
  /** Signed, short-lived; the CLI only ever gets this URL from a step. */
  skillBundle: (skillId: string, version: string) => `/v1/skill-bundles/${skillId}/${version}`,
} as const;

// added by api — type aliases for the M1/M2 response schemas above (types only; no wire change).
export type CheckpointList = z.infer<typeof CheckpointList>;
export type RestoreResponse = z.infer<typeof RestoreResponse>;
export type NotificationList = z.infer<typeof NotificationList>;
export type EnvVarMeta = z.infer<typeof EnvVarMeta>;
export type EnvKeysResponse = z.infer<typeof EnvKeysResponse>;
export type EnvPullResponse = z.infer<typeof EnvPullResponse>;
export type SignedUpload = z.infer<typeof SignedUpload>;
export type QaRunCreated = z.infer<typeof QaRunCreated>;
export type QaRunList = z.infer<typeof QaRunList>;
export type QaRunDetail = z.infer<typeof QaRunDetail>;
export type AuditList = z.infer<typeof AuditList>;
export type AuditDetail = z.infer<typeof AuditDetail>;
export type AuditFindingTicketResponse = z.infer<typeof AuditFindingTicketResponse>;

// added by api — POST /v1/audits/{id}/skip (no body) → AuditRun with status "skipped"; 409 when the audit
// is no longer queued/running. Lets a linked project's Planner start without waiting for the audit.
export const m2routesApi = {
  auditSkip: (auditId: string) => `/v1/audits/${auditId}/skip`,
} as const;
