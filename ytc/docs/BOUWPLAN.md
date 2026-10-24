# YTC Agent Factory — bouwplan

**Status:** concept, ter bespreking tussen Joey en Yassine
**Datum:** 25 oktober 2026
**Hoort bij:** [`Playbooks/docs/agent-factory/PLAN.md`](https://github.com/yourtechclub/playbooks/blob/docs/agent-factory-plan/docs/agent-factory/PLAN.md) (v2). PLAN.md beschrijft **wat en waarom**. Dit document beschrijft **hoe we het bouwen**: welke code, welke configuratie, in welke volgorde, en wanneer iets af is.

---

## 0. In één alinea

Paperclip (deze repo) is de werkvloer: agents, taken, budgetten, goedkeuringen. Het kan onze playbooks **niet** zelf uitvoeren. Paperclip leest van een `TASK.md` alleen titel, tekst en een agent-slug. Alles wat onze playbooks waardevol maakt, negeert het: rollen, `blocked_by`, gates, output-contracten en "genereer per pagina/sectie". Ook kan het een playbook niet als sjabloon steeds opnieuw gebruiken. Het belangrijkste dat we dus bouwen is een **playbook-compiler**: één commando dat van een getekend project een Paperclip-project met de juiste taakboom maakt, met Jira-board en Confluence-space erbij. Daaromheen komen een Jira-sync, de agent-rollen, een geharde server en een noodstop. Al het YTC-eigen werk staat in de map `ytc/` van deze repo. De rest van de repo blijft een schone kopie van upstream Paperclip.

---

## 1. Wat ik heb gecontroleerd, en wat dat betekent voor PLAN.md

Ik heb de code van Paperclip (upstream master van 24 okt 2026) en de repos Playbooks en ytc-brand-os doorgenomen. De bevindingen hieronder staan in de code, ze zijn niet aangenomen. Waar iets nog getest moet worden, staat dat erbij.

### 1.1 Wat Paperclip wél goed regelt

| Behoefte uit PLAN.md | Hoe Paperclip het doet | Bron |
|---|---|---|
| Alleen bereikbaar via Tailscale | `paperclipai onboard --bind tailnet`, mode `authenticated` + exposure `private` | `doc/DEPLOYMENT-MODES.md`, `cli/src/index.ts:136` |
| Telemetrie uit | `PAPERCLIP_TELEMETRY_DISABLED=1` (of `DO_NOT_TRACK=1`) | `packages/shared/src/telemetry/config.ts` |
| Claude Code als werker | Adapter `claude_local`, model per agent, `ANTHROPIC_API_KEY` als secret per agent | `packages/adapters/claude-local`, `docs/adapters/claude-local.md` |
| Review- en goedkeuringsstappen | `executionPolicy.stages[]` per taak: eerst een review (agent), dan een approval (mens). "Done" wordt automatisch `in_review` | `docs/guides/execution-policy.md` |
| Plan-goedkeuring | Agent schrijft een issue-document `plan` en vraagt `request_confirmation` | `docs/guides/agent-developer/task-workflow.md` |
| Atomic checkout | `POST /api/issues/:id/checkout`: één agent wint, de rest krijgt een 409 | `doc/TASKS.md` |
| Afhankelijkheden | `blockedByIssueIds`, sub-issues via `parent` | idem |
| Budgetten | Per agent: waarschuwing op 80 %, automatische pauze op 100 % | `docs/guides/board-operator/costs-and-budgets.md` |
| Aannemen met goedkeuring | Approval-type `hire_agent`, instelling `requireBoardApprovalForNewAgents` | `packages/shared/src/constants.ts` |
| Tool-gateway "Ask first / Off" | MCP-profielen en -policies (`allow`, `block`, `require_approval`), elke call geaudit | `doc/MCP-ACCESS-GOVERNANCE.md` |
| Sandbox | CLI-engine met Bubblewrap: `filesystemScope: workspace`, `networkScope: allowlist` | `docs/adapters/claude-local.md` |
| Git-worktree per taak | `workspaceStrategy: git_worktree` met branch-sjabloon | idem |
| Back-up | `paperclipai db:backup --retention-days`, en automatische back-ups | `scripts/backup-db.sh` |
| Updates met rollback | `paperclipai update` maakt eerst een DB-back-up, `--rollback` zet terug | `doc/INSTALLING.md` |
| Telefoon | De UI is een PWA, bereikbaar via Tailscale | `ui/public/site.webmanifest` |

### 1.2 Wat Paperclip níet doet, en wat we daarom bouwen

| # | Gat | Gevolg | Oplossing (werkpakket) |
|---|---|---|---|
| G1 | Een import vereist `COMPANY.md`. Een losse `PROJECT.md` wordt geweigerd | Playbooks zijn niet direct te importeren | Eigen company-package in `ytc/company/` (WP5) |
| G2 | Van `TASK.md` leest Paperclip alleen `name`, body en `assignee`. `metadata.playbook` (rol, `blocked_by`, gate, outputs, `generate`) wordt genegeerd | De taakboom, de gates en de output-contracten verdwijnen bij een import | **Playbook-compiler** (WP6) |
| G3 | Er bestaan geen projectsjablonen. Een re-import maakt alle taken opnieuw aan | Een playbook kan niet per klant opnieuw worden gestart | De compiler maakt per klantproject via de API een nieuw project aan, idempotent (WP6) |
| G4 | Twee takensystemen: Jira (bron volgens PLAN 5.3) en Paperclip-issues | Status raakt uit sync, of iemand houdt twee borden bij | Paperclip is de werkvloer, Jira de registratie. Eenrichtings-sync plus Jira-sleutel op elke taak (WP7) |
| G5 | De generator voor pagina- en sectietickets na gate C bestaat niet (staat ook in `confluence-project-space/JIRA.md`) | Het grootste deel van het bouwwerk heeft geen goede tickets | `ytc project expand` (WP8) |
| G6 | De standaardinstellingen zijn ruim: `dangerouslySkipPermissions: true`, agents mogen agents aannemen en connecties beheren, sandbox staat uit (ACP-engine) | Zonder hardening heeft elke agent te veel macht | Hardening-profiel per rol (WP4) |
| G7 | Geen MFA en geen SSO in Paperclip | Het checklistpunt "MFA voor founders" uit PLAN 11 is in Paperclip zelf niet te halen | MFA via de Tailscale-login (Microsoft 365 met MFA). Sign-up uit, invites alleen door een founder (WP3) |
| G8 | Geen enkele "pauzeer alles"-knop en geen restore-commando | Noodstop en hersteltest uit PLAN 11 zijn niet met één handeling te doen | Eigen scripts `ytc factory stop` en `ytc factory restore` (WP3, WP11) |
| G9 | GitHub-acties lopen via de GitHub-connectie van de **verantwoordelijke mens**. Zonder connectie heeft een agent geen git-identiteit | Agent-commits zouden onder Joey's account komen | Een machine-account als eigen Paperclip-lid met eigen GitHub-connectie. Eerst testen of "dedicated agent tokens" volstaan (WP4) |
| G10 | Inkomende Teams/Slack/mail-webhooks vereisen publieke HTTPS | Dat botst met "alleen Tailscale" | Geen webhooks. De intake-agent leest de gedeelde mailbox elke 10 minuten uit via een routine (WP9) |
| G11 | Private GitHub-repos zijn waarschijnlijk niet via een URL te importeren (anonieme fetch) | Een import van `yourtechclub/playbooks` via URL faalt | Op de server klonen en de lokale map importeren (WP5) |
| G12 | Geen curated koppeling voor Pipedrive en Outlook-mail | Die moeten via de generieke remote-MCP-route | Generieke MCP met alleen-lezen-profiel (WP9) |
| G13 | Upstream brengt meerdere releases per dag uit | Een update kan de fabriek breken | Vaste versie, maandelijks updaten na een test op een tweede instance (WP3) |

### 1.3 Correcties op PLAN.md v2

Deze punten passen we aan in PLAN.md (via PR in Playbooks):

1. **Hoofdstuk 11, "MFA voor founders":** dit kan niet in Paperclip. Vervang het door "Tailscale-login via Microsoft 365 met MFA verplicht; Paperclip-sign-up uit; invites alleen door founders".
2. **Hoofdstuk 11, "Noodstop: Paperclip pause":** zo'n knop bestaat niet. Vervang het door `ytc factory stop` (zie WP11).
3. **Hoofdstuk 5.1, "Paperclip's tool-gateway":** die werkt alleen voor MCP-servers die via Paperclip zijn ingesteld. Voeg toe: "agents krijgen MCP-servers alleen via de gateway; geen eigen `.mcp.json` in de workspace".
4. **Hoofdstuk 15, fase 1, "playbook als playbook in Paperclip":** dit kan niet zonder de compiler (G2). Fase 1 hangt dus af van WP6.
5. **Bijlage A, "Of de playbooks ongewijzigd te importeren zijn":** beantwoord. Ze zijn niet ongewijzigd bruikbaar. De **inhoud** blijft wel ongewijzigd: de compiler leest ze zoals ze zijn.

---

## 2. Het doelbeeld: zo loopt een project door de fabriek

Dit is de toets voor alles hieronder. Als dit werkt voor een echt project, is de fabriek af.

```
 Getekend voorstel + kickoff-transcript
            │
            ▼
 ytc project new --client "Shokran" --key SHOK \
     --playbook website-strapi-nextjs --deal 1234 --transcript call.txt
            │
            ├─ Confluence-space   (bestaande create-space.mjs)
            ├─ Jira-project       (bestaande create-jira.mjs)
            ├─ Paperclip-project  + repos gekoppeld
            ├─ Taakboom: 1 issue per TASK.md, per fase een ouder-issue,
            │   blocked_by → blockedByIssueIds, rol → agent of mens,
            │   gate → execution policy, output-contract → checklist
            └─ projects/SHOK.json (koppelingen: Jira, Confluence, Figma, repos)
            │
            ▼
 PM-agent wordt wakker op "kickoff" → leest transcript, deal, brand-os
 → schrijft project-brief → GATE A (Marija review → founder approval)
            │
            ▼
 Sophie ontwerpt (mensentaak in Paperclip) → GATE B (klant, via founder)
            │
            ▼
 Lead-engineer-agent: development plan + figma-node-map → GATE C
            │
            ▼
 ytc project expand SHOK      ← genereert pagina-/sectie-issues (Paperclip + Jira)
            │
            ▼
 Dev-agents: checkout → worktree feature/SHOK-142-… → bouwen →
 design-match-check → PR naar development → issue "done"
            │                                   │
            │                       execution policy: review (QA-agent)
            │                                   │ changes requested → terug naar dev
            │                                   ▼
            │                       approval (mens) = PR-review + merge in GitHub
            ▼
 Jira-sync zet de status, de PR-link en de uren op het Jira-ticket
            │
            ▼
 GATE D (klant-UAT) → productie-deploy door een mens → oplevering
 Rapportage-agent: wekelijks concept → Marija → founder verstuurt
```

Alles wat in dit schema "agent" heet, draait op de kantoorserver. Alles wat "mens" heet, gebeurt in de Paperclip-UI (laptop of telefoon), in GitHub of in het gesprek met de klant.

---

## 3. Repo-indeling

Deze repo is een fork van upstream Paperclip. Om updates pijnloos te houden:

- **`master` volgt upstream.** Daar wijzigen we niets. Updaten gaat via "Sync fork" op GitHub, of `git merge upstream/master`.
- **Alles van YTC staat in `ytc/`.** Die map bestaat niet in upstream, dus er ontstaan nooit merge-conflicten.
- **Patches op Paperclip zelf** doen we alleen als het echt niet anders kan. Ze komen dan in `ytc/patches/` met een issue naar upstream. Het doel is nul patches.
- **De server installeert een vaste versie**, met `paperclipai install --version <x>`, of `--repo JoeyYTC/ytc-agent-factory --ref <sha>` als we toch een patch nodig hebben.

```
ytc/
├── README.md                    wat hier staat, hoe je begint
├── docs/
│   ├── BOUWPLAN.md              dit document
│   ├── RUNBOOK-server.md        installatie en herinstallatie van de server
│   ├── RUNBOOK-noodstop.md      noodstop, hersteltest, koude reserve
│   └── RUNBOOK-agent-lifecycle.md  aannemen, proeftijd, ontslag (ISO-bewijs)
├── company/                     agentcompanies/v1-package "Your Tech Club"
│   ├── COMPANY.md
│   ├── TEAM.md
│   ├── agents/<rol>/AGENTS.md   rolbeschrijving = instructies (PLAN 8, "vacature")
│   └── .paperclip.yaml          adapter, model, budget, rechten, routines per rol
├── access/
│   └── register.yaml            rechtenregister: agent → accounts, tokens, scopes, vervaldatum
├── cli/                         het `ytc`-commando (Node, geen extra dependencies)
│   ├── bin/ytc.mjs
│   └── src/
│       ├── paperclip.mjs        REST-client voor de Paperclip-API
│       ├── compile.mjs          playbook → taakboom (WP6)
│       ├── expand.mjs           pagina-/sectie-generator na gate C (WP8)
│       ├── jira-sync.mjs        Paperclip → Jira (WP7)
│       ├── factory.mjs          stop / start / status / restore (WP11)
│       └── access.mjs           register.yaml ↔ werkelijkheid controleren
├── projects/                    één JSON per klantproject (zelfde vorm als mission-control)
├── infra/
│   ├── bootstrap.sh             Ubuntu → klaar-voor-Paperclip (idempotent)
│   ├── nftables.conf            uitgaande allowlist
│   ├── paperclip.env.example    alle env-vars, zonder waarden
│   ├── systemd/                 timers voor jira-sync, back-up en healthcheck
│   └── restic/                  offsite back-up
└── evals/                       vaste testtaken om skill-wijzigingen te toetsen (WP12)
```

**Wat níet in deze repo staat:** playbooks, skills en merkkennis. Die blijven in `Playbooks` en `ytc-brand-os`. De server kloont ze read-only, op een vaste commit. Zo is er één bron per soort kennis (PLAN 5.3).

**Hergebruik in plaats van nieuwbouw:**

- `Playbooks/confluence-project-space/lib/playbook.mjs` leest de TASK.md-boom al in. De compiler gebruikt die rechtstreeks, geen tweede parser.
- `create-space.mjs` en `create-jira.mjs` blijven zoals ze zijn. `ytc project new` roept ze aan.
- De projectbestanden en de collector van `mission-control` ("vier signalen per pagina") worden de statusbron voor de QA- en rapportage-agents. De runner van mission-control vervalt: dat werk doet Paperclip nu.

---

## 4. Rollen: van playbook naar fabriek

De playbooks kennen meer rollen dan de pilot uit PLAN 7. We maken niet voor elke playbook-rol een eigen agent. De compiler vertaalt rollen naar het team dat er op dat moment is. Zo kunnen we later rollen afsplitsen zonder de playbooks te wijzigen.

| Playbook-rol | Pilot (fase 1) | Fase 2–3 | Model | Toelichting |
|---|---|---|---|---|
| `agent:pm` | `pm` | `pm` | Opus | Brief, tickets, status, handover. Neemt Atlas over |
| `agent:lead-engineer` | `pm` (dev-plan) + mens (PR-approval) | `lead-engineer` | Opus | De PR-goedkeuring blijft altijd bij een mens (branch protection) |
| `agent:frontend` | `developer` | `developer-1..3` | Sonnet | |
| `agent:backend` | `developer` | `developer-1..3` | Sonnet | Seeders draaien nooit tegen productie |
| `agent:devops` | **mens (Joey)** | mens | — | Forge-token en productie-secrets niet op de server (PLAN 5.1) |
| `agent:qa` | mens (review) | `qa` | Opus | Review-stap in de execution policy |
| `agent:seo` | `pm` | `content` | Sonnet | |
| `agent:content` | `pm` | `content` | Sonnet | Leest brand-os |
| `agent:account-manager` | mens | `reporting` | Sonnet | Alleen concepten |
| (geen playbook-rol) | — | `intake` | Haiku → Sonnet | `ytc-handle-client-request`, alleen lezen |
| (geen playbook-rol) | — | `crm-hygiene` | Haiku | Alleen voorstellen |
| `human:owner` | Joey / Yassine | idem | — | Board-gebruikers in Paperclip |
| `human:designer` | Sophie | idem | — | Lid in Paperclip; designtaken op haar naam |
| `human:client` | founder namens de klant | idem | — | Klantakkoord wordt door een founder vastgelegd |
| `human:security-officer` | Yassine | idem | — | Gate S en productie-deploy |
| (delivery-lead) | Marija | idem | — | Eerste reviewer op gates A en D en op rapporten |

De vertaling staat in `ytc/company/.paperclip.yaml` onder een eigen sleutel `ytc.roleMap`. Een rol afsplitsen is dan één regel wijzigen en `ytc company sync` draaien.

---

## 5. Beveiligingsmodel: vier lagen

Geen enkele laag hoeft perfect te zijn. Een fout moet door vier lagen heen om schade te doen.

| Laag | Wat het tegenhoudt | Hoe |
|---|---|---|
| 1. **GitHub** | Merge zonder mens, push naar `main`/`development` | Branch protection op alle klantrepos, ≥ 1 menselijke review, CI verplicht, secret scanning aan. Machine-accounts zijn geen admin |
| 2. **Credentials** | Te veel rechten per agent | Per rol een eigen identiteit en eigen tokens met minimale scopes (tabel hieronder). Geen productie-secrets op de server |
| 3. **Sandbox** | Bij andermans bestanden of op internet komen | Claude-adapter op `engine: cli` met Bubblewrap: `filesystemScope: workspace`, `networkScope: allowlist`. Daarnaast een nftables-allowlist op de host |
| 4. **Agent-hooks** | Gevaarlijke commando's binnen de sandbox | `ytc_guard.py` uit `ytc-execute-jira-ticket` als PreToolUse-hook: blokkeert `gh pr merge`, deploy-commando's en push naar beschermde branches. Fail-closed |

Daarbovenop: de Paperclip MCP-gateway (welke tools een rol ziet), budgetten per agent en het activity log.

### Rechtenmatrix (begin)

| Rol | GitHub | Jira / Confluence | Mail | Pipedrive | Figma | Anthropic-key |
|---|---|---|---|---|---|---|
| `pm` | lezen (Playbooks, klantrepos) | schrijven in het eigen project, Confluence-pagina's | — | lezen | lezen | eigen key, budget € X |
| `developer` | push naar `feature/*`, PR openen, alleen gekoppelde repos | ticketcomments | — | — | lezen (dev-mode) | eigen key |
| `qa` | lezen + PR-review (comment / request changes) | ticketcomments | — | — | lezen | eigen key |
| `intake` | — | tickets aanmaken (status To Do, nooit Ready for Development) | gedeelde mailbox: lezen + concepten | lezen | — | eigen key |
| `reporting` | lezen | lezen | — | — | — | eigen key |
| `crm-hygiene` | — | — | metadata lezen | lezen + notities | — | eigen key |

Deze matrix staat als data in `ytc/access/register.yaml`. `ytc access check` vergelijkt het register met de werkelijkheid: Paperclip-permissies, secrets, MCP-profielen en de vervaldatums van GitHub-tokens. Dat is meteen het ISO-bewijs voor A.5.15–A.5.18.

---

## 6. Werkpakketten

Elk werkpakket heeft een eigenaar, een opleverbaar resultaat en een acceptatietest. Een werkpakket is pas af als de test is gedaan en vastgelegd. De fasen sluiten aan op PLAN 15.

### Fase 0 — Fundament (week 1–2)

#### WP1 · Besluiten en accounts (founders)

| Deliverable | Detail |
|---|---|
| B1, B3, B5, B7 uit PLAN 18 besloten | Pilotproject (B3) bepaalt welk playbook de compiler als eerste moet kunnen |
| Anthropic API-organisatie | Workspace `factory-prod` en `factory-staging`; één key per agent; spend-limit per key; Admin-API-key voor de noodstop, alleen bij de founders |
| Actuele Anthropic-voorwaarden gecontroleerd | Voor geautomatiseerd gebruik van Claude Code via de API (PLAN bijlage A) |
| GitHub-machine-accounts | `ytc-factory-dev` (push + PR) en `ytc-factory-review` (alleen review), lid van `yourtechclub` zonder admin; fine-grained tokens per repo, looptijd 30–90 dagen |
| Atlassian | Eén service-account per rol (`pm`, `intake`, `developer`), zodat de historie laat zien wie wat deed. API-tokens per account |
| M365 | Gedeelde mailbox `aanvragen@` (of een bestaande), toegang voor `intake` alleen lezen + concepten |
| Tailscale | Tailnet met login via Microsoft 365 (MFA verplicht); ACL: alleen founders, Marija en Sophie naar de server; tag `tag:factory` voor de server |

**Acceptatie:** `access/register.yaml` bevat elk account met eigenaar, scope en vervaldatum. Er bestaat geen enkel token met org-brede of admin-rechten.

#### WP2 · Server (Joey)

| Deliverable | Detail |
|---|---|
| Hardware | Volgens PLAN 5.6: mini-pc 64/96 GB, 2× NVMe, UPS, JetKVM |
| `infra/bootstrap.sh` | Ubuntu 24.04: ZFS-mirror, LUKS met TPM-unlock, unattended-upgrades, gebruikers `paperclip` (service) en per agent geen login-shell; Node 22 LTS, pnpm, git, gh, gitleaks, python3, Playwright + Chromium, Bubblewrap; NUT voor de UPS; Tailscale met `tag:factory` |
| `infra/nftables.conf` | Inkomend: alleen `tailscale0`. Uitgaand: allowlist (api.anthropic.com, github.com + api + objects, *.atlassian.net, mcp.atlassian.com, registry.npmjs.org, api.figma.com, graph.microsoft.com, api.pipedrive.com, de back-upbestemming, het OS-updatekanaal) |
| VLAN | Server in een eigen VLAN, los van kantoornetwerk en laptops |
| Monitoring | Een healthcheck-timer op de server pingt elke 5 minuten een externe dienst (bv. healthchecks.io, een "dead man's switch"). Blijft de ping uit, dan krijgen de founders een alert. Zo is er geen open poort nodig |

**Acceptatie:** stekker eruit → server komt zelf terug en Paperclip draait weer binnen 10 minuten, zonder dat iemand op kantoor is. Een poortscan vanaf het kantoornetwerk vindt niets open.

#### WP3 · Paperclip installeren en harden (Joey)

1. Installeren met een vaste versie: `npx paperclipai install --version <stabiele versie>`. Daarna `paperclipai onboard --yes --bind tailnet --install-service`.
2. `infra/paperclip.env` (chmod 600):
   - `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`, `PAPERCLIP_BIND=tailnet`
   - `PAPERCLIP_PUBLIC_URL=https://factory.<tailnet>.ts.net`, `PAPERCLIP_ALLOWED_HOSTNAMES=…`
   - `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=true`
   - `PAPERCLIP_TELEMETRY_DISABLED=1`, geen `SENTRY_DSN`
3. Eerste admin claimen (Joey), daarna invites voor Yassine, Marija en Sophie met de juiste rollen. Company-instelling `requireBoardApprovalForNewAgents: true`.
4. Back-up: dagelijks `paperclipai db:backup --retention-days 14`, plus `secrets/master.key` en de instance-config, versleuteld met restic naar een EU-bestemming. **Zonder `master.key` is de back-up waardeloos.**
5. **Tweede instance "staging"** op dezelfde server (eigen poort, eigen data-map). Elke update gaat eerst daar naartoe, met een kopie van de productie-database.
6. Updateprocedure in `RUNBOOK-server.md`: maandelijks, eerst staging, dan `paperclipai update`, bij problemen `paperclipai update --rollback`.

**Acceptatie:** hersteltest gedaan. Een verse VPS, `bootstrap.sh`, restore van back-up plus `master.key` en een draaiende fabriek in minder dan 1 uur, met de tijd gemeten en vastgelegd (PLAN 11). Restore gaat met de hand (gunzip → psql) omdat Paperclip er geen commando voor heeft. `ytc factory restore` legt die stappen vast.

#### WP4 · Agent-runtime en hardening (Joey)

Per rol in `ytc/company/.paperclip.yaml`:

```yaml
adapter: claude_local
adapterConfig:
  engine: cli                       # vereist voor Bubblewrap
  model: claude-sonnet-5-5          # per rol, zie hoofdstuk 4
  maxTurnsPerRun: 150
  timeoutSec: 3600
  workspaceStrategy: { type: git_worktree, branchTemplate: "feature/{{issue.jiraKey}}-{{issue.slug}}" }
  sandbox:
    filesystemScope: workspace
    networkScope: allowlist
    networkAllowlist: [api.anthropic.com, github.com, api.github.com, registry.npmjs.org, api.figma.com]
env:
  ANTHROPIC_API_KEY: { secretRef: anthropic-key-developer-1 }
permissions:
  canCreateAgents: false
  tools: { manage_connections: false }
budget: { monthlyEur: 150 }
heartbeat: { enabled: false, wakeOnAssignment: true }
```

De veldnamen zijn een schets. De precieze sleutels halen we uit `docs/adapters/claude-local.md` en de spec bij het bouwen, en we testen ze in de staging-instance.

Te testen in deze stap:

- **G9, git-identiteit.** Werkt een "dedicated agent token" voor `ytc-factory-dev`, of moet het machine-account een eigen Paperclip-lid zijn met een eigen GitHub-connectie? Kies wat werkt zonder dat er ooit een founder-token in een run terechtkomt.
- **De guard-hook.** `ytc_guard.py` wordt via de managed instructies/settings in elke run geladen. Test: een agent die `gh pr merge` probeert, wordt tegengehouden.
- **Sandbox.** Een agent kan niet lezen buiten zijn worktree en geen host bereiken die niet op de allowlist staat.

**Acceptatie:** de drie tests hierboven staan als script in `ytc/evals/security/` en slagen.

#### WP5 · Company-package "Your Tech Club" (Joey)

- `COMPANY.md` (naam, missie, verwijzing naar brand-os), `TEAM.md`, `agents/pm/AGENTS.md` en `agents/developer/AGENTS.md`.
- Elke `AGENTS.md` is de "vacature" uit PLAN 8: doel, input, output, tools, grenzen, en welke bestanden uit brand-os en Playbooks verplicht gelezen worden.
- Skills: `ytc-execute-jira-ticket` en `ytc-handle-client-request` uit Playbooks, geïmporteerd van de lokale kloon (`paperclipai skills import <pad>`) op een vaste commit.
- Import: `paperclipai company import ytc/company --target existing --include company,agents,skills --collision replace`. Taken importeren we nooit via dit pad (G3).
- `ytc company sync`: kloont Playbooks en brand-os op de commit uit `ytc/company/sources.lock`, en voert de import uit. Een nieuwe commit vastzetten gaat via een PR op dit bestand. Dat is "training" (PLAN 8).

**Acceptatie:** een lege staging-instance wordt met één commando dezelfde company als productie.

#### Overig fase 0 (Yassine)

ISO-risico-analyse, leveranciersregister, AI-gebruiksbeleid, AVG-toestemming en transcriptiedienst: zoals in PLAN 15. Nieuw: `access/register.yaml` uit WP1 is het bronbestand voor het rechtenregister in Confluence.

**Exit fase 0:** WP1–WP5 geaccepteerd; security-checklist PLAN 11 ≥ 80 % (met de correcties uit 1.3).

### Fase 1 — Pilot (week 3–6)

#### WP6 · Playbook-compiler `ytc project new` (Joey + Claude Code) — **het hart**

Invoer: client, key, playbook, Pipedrive-deal, transcript, repos (optioneel), dry-run.

Stappen, in deze volgorde, en idempotent (opnieuw draaien maakt niets dubbel):

1. **Valideren.** Playbook bestaat; key vrij in Jira, Confluence en Paperclip; elke rol uit het playbook komt voor in `roleMap`.
2. **Confluence en Jira.** Roept `create-space.mjs` en `create-jira.mjs` aan. Leest de aangemaakte Jira-sleutels per taak terug (via de label `task-<slug>`).
3. **Paperclip-project.** `POST /api/companies/:id/projects`, met de repos (`PUT /api/projects/:id/repositories`) en de projectinstellingen uit `PROJECT.md` (`deploy_target`, `figma_project_url`, …) als projectdocument.
4. **Taakboom.** Leest de playbook met `lib/playbook.mjs`. Per fase één ouder-issue. Per `TASK.md`:
   - titel `SHOK-12: <name>` (de Jira-sleutel vooraan, net als de PR-titels);
   - body = de TASK.md-body, plus een kop met de rol, de gate, de verplichte inputs en de output-checklist;
   - `assignee` = agent of mens volgens `roleMap`;
   - `blocked_by` → `blockedByIssueIds`;
   - labels: `playbook:<slug>`, `task:<slug>`, `jira:<KEY-n>`, `gate:<type>`;
   - taken met `generate:` worden een placeholder-issue "wordt gegenereerd na gate C" (WP8).
5. **Gates als execution policy:**

   | Playbook-gate | Execution policy |
   |---|---|
   | `none` (agent-taak) | review door `qa` (vanaf fase 2; in de pilot: Marija of een founder) |
   | `team-approval` (C) | review `qa` → approval founder |
   | `client-approval` (A, B, D) | approval founder; de taak beschrijft dat het klantakkoord als bijlage of link wordt vastgelegd. Bij A en D eerst review door Marija |
   | `security-officer-approval` (S) | approval Yassine |
   | `change-control` | approval Yassine + mensentaak "deploy" voor Joey |

6. **Output-contracten.** `outputs.required` wordt een checklist in de body én een regel in de review-instructie van `qa`: "approved" mag alleen als elk verplicht work product als bijlage, link of work product (`/issues/:id/work-products`) aanwezig is. Paperclip dwingt dat zelf niet af. De QA-stap doet dat wel, en `ytc project check` controleert het mechanisch.
7. **Projectbestand.** `ytc/projects/SHOK.json` in het formaat van mission-control, aangevuld met de Paperclip-IDs. Dit bestand gaat via een PR de repo in.
8. **Start.** Alleen het eerste issue (kickoff/brief) gaat naar `todo`. De rest staat op `backlog` of is geblokkeerd.

**Acceptatie:**
- `--dry-run` op alle drie de playbooks geeft een volledige, foutloze boom.
- Een echte run op een testproject maakt Confluence, Jira en Paperclip aan. Een tweede run maakt niets dubbel.
- In de Paperclip-UI is de volgorde van de playbook zichtbaar, en een geblokkeerde taak wordt niet opgepakt.

#### WP7 · Jira-sync (Joey + Claude Code)

**Principe:** Paperclip is de werkvloer en Jira de registratie. Mensen werken met Jira-tickets, agents met Paperclip-issues. Het zijn steeds dezelfde taken, gekoppeld via de Jira-sleutel.

| Richting | Wat | Hoe |
|---|---|---|
| Paperclip → Jira | status (`in_progress` → In Progress, `in_review` → Review, `done` → Done), PR-links, samenvatting van de laatste agent-comment, kosten per taak als worklog-commentaar | `ytc jira-sync`, systemd-timer elke 5 minuten. Een script, geen agent: geen tokens, geen prompt-injection |
| Jira → Paperclip | tickets die **een mens** op "Ready for Development" zet en die nog geen Paperclip-issue hebben (klantverzoeken uit 9.2) | Hetzelfde script maakt het issue aan, met de juiste rol en de standaard execution policy |
| Jira → Paperclip | wijzigingen in de beschrijving van een ticket dat al loopt | Comment op het Paperclip-issue: "Jira-ticket gewijzigd, controleer de scope". Geen automatische overschrijving |

Conflictregel: Jira wint voor **wat** er gebouwd moet worden, Paperclip wint voor **de status**.

**Acceptatie:** een week lang op het pilotproject geen verschil tussen Jira en Paperclip bij een dagelijkse steekproef (KPI "> 95 % actueel" uit PLAN 13).

#### WP8 · Generator na gate C: `ytc project expand` (Joey + Claude Code)

Bouwt de generator die in `confluence-project-space/JIRA.md` beschreven staat. Hij leest het goedgekeurde development plan en de figma-node-map (Confluence-pagina's met een vaste structuur), en maakt per pagina een epic met sectie-, content-, seeder- en review-issues, in Paperclip én in Jira. Velden zoals in de tabel "What a generated page ticket should carry" in JIRA.md.

Voorwaarde: development-plan en figma-node-map hebben een machineleesbaar blok (bv. een YAML-codeblok in de Confluence-pagina). Dat vereist een kleine aanpassing aan de TASK.md's `development-plan` en `figma-node-mapping` in Playbooks. Die doen we via een PR.

**Acceptatie:** op het pilotproject maakt `expand` alle pagina-issues met per sectie een Figma-dev-link, en een tweede run maakt niets dubbel.

#### WP9 · Rollen pm en developer (founders)

- **pm:** neemt de prompts en skills van Atlas over (`atlas-pm-agent` → `Playbooks/skills`). Taken: brief, ticket-breakdown, development plan in de pilot, statusupdate per week. Krijgt via de MCP-gateway: Atlassian (projectscope), Pipedrive (alleen lezen), Figma (lezen).
- **developer:** draait `ytc-execute-jira-ticket`, aangepast voor Paperclip:
  - Readiness = het Paperclip-issue is aan hem toegewezen en niet geblokkeerd. Het Jira-ticket staat op Ready for Development (gecontroleerd door de sync).
  - Handoff = "done" melden op het issue, met het execution packet als work product. De review-stap pakt het daarna op.
  - Mission-control's resultaatschema (`done` / `blocked` / `failed` met vragen) wordt de verplichte eindcomment.
- Beide rollen beginnen in **proeftijd** (PLAN 8): project "Proeftijd" met 5–10 interne taken, alles door een mens beoordeeld.

#### WP10 · Pilotproject draaien (agents + Marija + founders)

Het gekozen pilotproject (B3) gaat volledig door de fabriek, terwijl het huidige team parallel doorwerkt. Elke week een review: KPI's, kosten, lessen. Elke les wordt een PR op een skill, playbook of `AGENTS.md`.

**Exit fase 1:** zoals in PLAN 15, plus: de compiler, de sync en de generator zijn op een echt project gebruikt zonder handmatige correcties in Paperclip.

### Fase 2 — Uitbreiden (week 7–10)

#### WP11 · Noodstop, offboarding en alerts (Joey)

- `ytc factory stop`: (1) alle agents pauzeren via de API, (2) alle routines uit (`paperclipai routines disable-all`), (3) lopende runs annuleren, (4) optioneel `--revoke`: alle Anthropic-keys van de workspace intrekken via de Admin-API. Eén commando, ook vanaf de telefoon (SSH via Tailscale) en als knop in een kleine statuspagina.
- `ytc factory start`: de omgekeerde volgorde, met per agent een bevestiging.
- `ytc agent fire <rol>`: keys en tokens intrekken, agent archiveren, register bijwerken, bewijs naar Confluence (offboarding-checklist, PLAN 11).
- Alerts naar de founders (Teams incoming webhook of push): run gefaald, budget ≥ 80 %, gate wacht langer dan 24 uur, server onbereikbaar, geweigerde tool-call.

**Acceptatie:** de noodstop is getest op productie. Alle agents stonden binnen 1 minuut stil, en de tijd is vastgelegd.

#### WP12 · Rollen qa en intake, plus evals

- **qa:** de review-stap van elke agent-taak. Toetst aan het output-contract, draait tests, Lighthouse en de design-match-check, en gebruikt de collector van mission-control (de vier signalen). Mag "changes requested" geven, nooit mergen.
- **intake:** routine elke 10 minuten op de gedeelde mailbox (alleen lezen). Draait `ytc-handle-client-request`, maakt een Jira-ticket (status To Do) en een conceptantwoord in Outlook. Kan niets versturen, niet pushen en niet bij repos (PLAN 5.1). Doorsturen vanaf de telefoon naar de gedeelde mailbox is de route "op vakantie" (PLAN 2).
- **Evals:** `ytc/evals/` bevat 10–20 afgeronde tickets van eerdere projecten (BVV, DLR) met het verwachte resultaat. Elke PR op een skill of `AGENTS.md` draait die set op de staging-instance. De PR mag pas door als het resultaat niet slechter is. Zo blijft "training" meetbaar (PLAN 5.5).

### Fase 3 — Volle fabriek (week 11–14)

#### WP13 · Rollen content, reporting en crm-hygiene

Zoals in PLAN 7. Allemaal alleen concepten en voorstellen. `reporting` gebruikt de collector van mission-control plus de kostendata van Paperclip (`paperclipai cost …`) en schrijft het wekelijkse concept in Confluence.

#### WP14 · KPI-dashboard

Geen eigen app (PLAN 2). Een wekelijkse routine maakt een Confluence-pagina met de KPI's uit PLAN 13, uit Paperclip (kosten, runs, review-uitkomsten), Jira (doorlooptijd) en GitHub (rework = PR's met "changes requested"). Die pagina is de input voor de management review in fase 4.

---

## 7. Planning en inzet

| Week | Werkpakketten | Wie | Inschatting founder-tijd |
|---|---|---|---|
| 1 | WP1, hardware bestellen, WP2 voorbereiden | Joey, Yassine | 1,5 dag |
| 2 | WP2, WP3, WP4, WP5 | Joey | 3 dagen |
| 3–4 | WP6 compiler, WP7 sync, WP9 rollen | Joey (+ Claude Code) | 4 dagen |
| 4 | proeftijd pm en developer | Marija, Joey | 1 dag |
| 5–6 | WP8 generator, WP10 pilotproject | Joey, Marija | 3 dagen + reviews |
| 7–8 | WP11 noodstop/alerts, WP12 qa/intake/evals | Joey | 3 dagen |
| 9–10 | tweede klantproject | Marija, founders | reviews |
| 11–14 | WP13, WP14, fase 4 | allen | 2 dagen + reviews |

Totaal ± 18 dagen founder-tijd verspreid over 14 weken. PLAN 16 schatte 3–5 dagen voor de opzet. Dat klopt voor de server (fase 0), maar niet voor de compiler, de sync en de generator. Die zijn het echte werk. We bouwen ze met Claude Code in deze repo, als gewone PR's met review.

---

## 8. Wanneer is de fabriek "af"? — de eindtest

De fabriek is af als dit scenario op productie lukt, zonder handwerk in Paperclip of Jira:

1. `ytc project new` met een echt (klein) project, vanuit transcript en deal.
2. Brief door `pm` → gate A goedgekeurd op de telefoon.
3. Design door Sophie → gate B.
4. Development plan → gate C → `ytc project expand` maakt de pagina-issues.
5. Developers openen PR's met design-match-bewijs; `qa` vraagt minstens één keer om wijzigingen, de developer herstelt dat zelf.
6. Een mens merget; de deploy naar staging gaat via de bestaande pipeline.
7. Jira en Confluence zijn op elk moment actueel.
8. Rapportage maakt het wekelijkse concept; Marija keurt het, een founder verstuurt het.
9. Halverwege een klantmail met een wijziging: `intake` maakt ticket en concept, een founder zet het ticket op Ready, een developer pakt het op.
10. Eén keer `ytc factory stop` en weer starten, zonder dat er werk verloren gaat.
11. Kosten per taak en per project zijn bekend.

---

## 9. Risico's van de bouw zelf

Aanvulling op het risicoregister in PLAN 17.

| # | Risico | Maatregel |
|---|---|---|
| BR1 | Paperclip-API verandert bij een update en breekt compiler of sync | Vaste versie; de CLI praat alleen via één module (`paperclip.mjs`); update eerst op staging met de eindtest |
| BR2 | De compiler wordt een tweede platform dat we moeten onderhouden (zoals TechClubAIOS) | De scope blijft: playbook → issues, sync, generator. Geen eigen UI, geen eigen database. Alles wat Paperclip kan, doet Paperclip |
| BR3 | Twee bronnen voor taken (Jira en Paperclip) lopen uit elkaar | Eén script synchroniseert, met een duidelijke conflictregel (WP7); dagelijkse steekproef in de pilot |
| BR4 | Bubblewrap-sandbox breekt builds (Playwright, pnpm-store) | In WP4 testen met een echte Next.js- en Strapi-build; extra paden via `filesystemExtraPaths` |
| BR5 | Git-identiteit (G9) lukt niet zonder een founder-token | Niet live gaan tot dit is opgelost. Desnoods een tweede, minimale patch in `ytc/patches/` |
| BR6 | Joey wordt zelf de bottleneck bij de bouw | De compiler, de sync en de generator zijn goed af te bakenen PR's; Yassine of een externe dev kan reviewen |

---

## 10. Beslissingen die nu nodig zijn

| # | Vraag | Mijn advies |
|---|---|---|
| D1 | Akkoord met "Paperclip = werkvloer, Jira = registratie, eenrichtings-sync" (WP7)? | Ja. Jira als enige werkvloer betekent dat agents via Jira wakker worden, en dan bouw je Paperclip opnieuw |
| D2 | Akkoord dat al het YTC-werk in `ytc/` staat en `master` upstream volgt? | Ja |
| D3 | Welk playbook als eerste in de compiler? | Hetzelfde als het pilotproject (B3). `website-nextjs-frontend` is het eenvoudigst (geen backend, geen seeders) |
| D4 | Mag de pilot `agent:devops`-taken (Forge, staging) overslaan en door Joey laten doen? | Ja. Staging-deploys door agents is B8, pas na fase 2 |
| D5 | Machine-accounts op GitHub en Atlassian: per rol of één gedeeld? | Per rol. Dat kost iets meer seats, maar dan laat de historie zien wie wat deed, en kun je één rol uitzetten |
| D6 | Mission-control: de runner uitfaseren en de collector houden? | Ja |

---

## 11. Eerste stappen (deze week)

1. Founders: D1–D6 en B1/B3/B5/B7 beslissen.
2. Joey: hardware bestellen, Anthropic API-organisatie aanmaken, Tailscale-tailnet met M365-login.
3. Claude Code, in deze repo: `ytc/cli` opzetten met `paperclip.mjs` en `compile.mjs --dry-run` tegen alle drie de playbooks. Dat kan al zonder server: de dry-run heeft alleen de Playbooks-repo nodig, en de API-calls testen we tegen een lokale Paperclip (`pnpm dev`).
4. PR op Playbooks: de correcties uit 1.3 in PLAN.md.
