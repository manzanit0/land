"use strict";

const API = "https://api.github.com";
const TOKEN_KEY = "land.gh_token";
const BOOKMARKS_KEY = "land.bookmarks";
const CACHE_KEY = "land.cache";
const FILTERS_KEY = "land.filters";
const ORDER_KEY = "land.order";
const REPO_CACHE_KEY = "land.repo_archived";
const CACHE_TTL_MS = 90 * 1000;
const REPO_TTL_MS = 24 * 60 * 60 * 1000;
const FORCE_MIN_MS = 5 * 1000;
const REFRESH_MS = 5 * 60 * 1000;
const MAX_ROWS = 8;
const SEARCH_PAGE = 30;
const UNDO_MS = 6000;
const JIRA_KEY = "land.jira";
const JIRA_CACHE_KEY = "land.jira_cache";
const JIRA_MAX = 6;
const JIRA_JQL = "assignee = currentUser() AND " +
    "statusCategory != Done AND status != \"To Do\" " +
    "ORDER BY updated DESC";

const ext = globalThis.browser || globalThis.chrome;

const DEFAULT_BOOKMARKS = [];

const SECTIONS = [
    {
        key: "ready",
        list: "ready-list",
        count: "ready-count",
        short: "ready to land",
        empty: "All clear — nothing to land.",
        defaultQuery:
            "is:pr is:open draft:false author:@me " +
            "archived:false review:approved"
    },
    {
        key: "review",
        list: "review-list",
        count: "review-count",
        short: "on you",
        empty: "Nothing on your desk.",
        defaultQuery:
            "is:pr is:open -author:app/dependabot draft:false " +
            "archived:false review-requested:@me"
    },
    {
        key: "flight",
        list: "flight-list",
        count: "flight-count",
        short: "in flight",
        empty: "No drafts, no failing checks.",
        defaultQuery:
            "is:pr is:open author:@me archived:false " +
            "(status:failure OR draft:true)"
    },
    {
        key: "pending",
        list: "pending-list",
        count: "pending-count",
        short: "stuck on others",
        empty: "Nothing waiting on others.",
        defaultQuery:
            "is:pr is:open draft:false author:@me " +
            "archived:false review:required"
    }
];

// Search results don't say why a PR matched, so PRs of yours that were
// sent back with requested changes are fetched through their own query
// and merged into "On you" carrying a flag that becomes their tag.
const CHANGES_QUERY =
    "is:pr is:open author:@me archived:false draft:false " +
    "review:changes_requested";

let hasData = false;
let inFlight = false;
let lastForce = 0;
let undoEntries = [];
let editing = false;

function getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
}

function getFilterOverrides() {
    try {
        const stored = JSON.parse(
            localStorage.getItem(FILTERS_KEY) || "null");
        if (stored && typeof stored === "object") return stored;
    } catch (err) {}
    return {};
}

function saveFilterOverrides(overrides) {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(overrides));
}

function getQuery(section) {
    return getFilterOverrides()[section.key] || section.defaultQuery;
}

function getOrder() {
    return localStorage.getItem(ORDER_KEY) === "asc" ? "asc" : "desc";
}

function updateOrderButton() {
    const button = document.getElementById("order");
    const desc = getOrder() === "desc";
    button.textContent = desc
        ? "sort: newest first" : "sort: oldest first";
    button.title = desc
        ? "Switch to oldest first" : "Switch to newest first";
}

function effectiveQueries() {
    const queries = {};
    for (const section of SECTIONS) {
        queries[section.key] = getQuery(section);
    }
    return queries;
}

function updateFilterButtons() {
    const overrides = getFilterOverrides();
    for (const section of SECTIONS) {
        const button = document.getElementById(section.key + "-filter");
        const custom = Boolean(overrides[section.key]);
        button.textContent = custom ? "filtered" : "filter";
        button.classList.toggle("custom", custom);
    }
}

let ghStatus = { text: "", kind: "" };
let jiraStatus = { text: "", kind: "" };

function renderStatus() {
    const status = document.getElementById("status");
    const parts = [];
    for (const part of [ghStatus, jiraStatus]) {
        if (!part.text) continue;
        if (parts.length > 0) {
            parts.push(document.createTextNode(" · "));
        }
        parts.push(el("span", { class: part.kind, text: part.text }));
    }
    status.replaceChildren(...parts);
}

function setStatus(text, kind) {
    ghStatus = { text: text, kind: kind || "" };
    renderStatus();
}

function setJiraStatus(text, kind) {
    jiraStatus = { text: text || "", kind: kind || "" };
    renderStatus();
}

function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });
}

function relativeTime(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
}

function ageClass(iso) {
    const days = (Date.now() - new Date(iso).getTime()) / 86400000;
    if (days < 2) return "";
    if (days < 7) return "age-warn";
    return "age-old";
}

function fullRepoFromUrl(repositoryUrl) {
    return repositoryUrl.replace(API + "/repos/", "");
}

function repoFromUrl(repositoryUrl) {
    const full = fullRepoFromUrl(repositoryUrl);
    return full.slice(full.indexOf("/") + 1);
}

function searchUrl(query) {
    return "https://github.com/search?type=pullrequests&q=" +
        encodeURIComponent(query + " sort:updated-" + getOrder());
}

function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (k === "text") node.textContent = v;
        else node.setAttribute(k, v);
    }
    for (const child of children || []) node.appendChild(child);
    return node;
}

function renderMessage(list, cls, text) {
    list.replaceChildren(el("li", { class: cls, text: text }));
}

function renderSummary(data) {
    const summary = document.getElementById("summary");
    summary.replaceChildren(...SECTIONS.map(section => {
        const total = data[section.key].total;
        const part = el("span", { class: "part" });
        part.appendChild(el("span", {
            class: "n" + (total > 0 ? " " + section.key : ""),
            text: String(total)
        }));
        part.appendChild(
            document.createTextNode(" " + section.short));
        return part;
    }));
}

function renderSection(section, result) {
    const list = document.getElementById(section.list);
    const total = result.total;
    const count = document.getElementById(section.count);
    count.textContent = total;
    count.classList.toggle("active", total > 0);
    if (total === 0) {
        renderMessage(list, "empty", section.empty);
        return;
    }
    let items = result.items.slice(0, MAX_ROWS);
    if (section.key === "flight") {
        items = [...items].sort(
            (a, b) => (a.draft ? 1 : 0) - (b.draft ? 1 : 0));
    }
    const rows = items.map(pr => {
        const sub = el("span", { class: "pr-sub" });
        sub.appendChild(document.createTextNode(
            repoFromUrl(pr.repository_url) + " #" +
            pr.number + " · "));
        sub.appendChild(el("span", {
            class: ageClass(pr.updated_at),
            text: relativeTime(pr.updated_at)
        }));
        if (section.key === "flight") {
            sub.appendChild(document.createTextNode(" · "));
            sub.appendChild(el("span", {
                class: pr.draft ? "t-draft" : "t-checks",
                text: pr.draft ? "draft" : "failing"
            }));
        }
        if (section.key === "review" && pr.changesRequested) {
            sub.appendChild(document.createTextNode(" · "));
            sub.appendChild(el("span", {
                class: "t-changes",
                text: "changes requested"
            }));
        }
        const link = el("a", { href: pr.html_url }, [
            el("div", { class: "pr-text" }, [
                el("span", { class: "pr-title", text: pr.title }),
                sub
            ])
        ]);
        return el("li", { class: "pr" }, [link]);
    });
    if (total > MAX_ROWS) {
        rows.push(el("li", { class: "more" }, [
            el("a", {
                href: searchUrl(getQuery(section)),
                text: "and " + (total - MAX_ROWS) + " more on GitHub →"
            })
        ]));
    }
    list.replaceChildren(...rows);
}

let lastRendered = "";
let pendingData = null;
let hoveredList = null;

function dataFingerprint(data) {
    return JSON.stringify(SECTIONS.map(section => {
        const result = data[section.key];
        return [result.total, result.items.map(pr => [
            pr.html_url, pr.title, pr.updated_at,
            Boolean(pr.draft), Boolean(pr.changesRequested)
        ])];
    }));
}

function renderAll(data) {
    for (const section of SECTIONS) {
        renderSection(section, data[section.key]);
    }
    renderSummary(data);
    lastRendered = dataFingerprint(data);
    pendingData = null;
}

// A background sync must not move rows the user is aiming at, so a
// re-render is skipped while the pointer rests on a list and applied
// once it leaves. Unchanged data never re-renders at all.
function scheduleRender(data) {
    if (dataFingerprint(data) === lastRendered) return;
    if (hoveredList) {
        pendingData = data;
        return;
    }
    renderAll(data);
}

function ghHeaders() {
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + getToken(),
        "X-GitHub-Api-Version": "2022-11-28"
    };
}

function readRepoCache() {
    try {
        const stored = JSON.parse(
            localStorage.getItem(REPO_CACHE_KEY) || "null");
        if (stored && typeof stored === "object") return stored;
    } catch (err) {}
    return {};
}

async function fetchArchived(fullName) {
    const res = await fetch(API + "/repos/" + fullName, {
        headers: ghHeaders()
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data.archived);
}

// The archived:false search qualifier cannot be trusted: GitHub only
// reindexes a PR when it is touched, so PRs that were open when their
// repository got archived keep a stale "not archived" flag in the
// search index and still show up. Archived repos are therefore
// filtered out client-side by checking each repo via the REST API,
// with results cached for a day since archived status rarely changes.
async function archivedRepos(fullNames) {
    const cache = readRepoCache();
    const now = Date.now();
    const missing = fullNames.filter(name => {
        const entry = cache[name];
        return !entry || now - entry.ts > REPO_TTL_MS;
    });
    const checked = await Promise.all(
        missing.map(name => fetchArchived(name).catch(() => false)));
    missing.forEach((name, i) => {
        cache[name] = { archived: checked[i], ts: now };
    });
    if (missing.length > 0) {
        localStorage.setItem(REPO_CACHE_KEY, JSON.stringify(cache));
    }
    return new Set(fullNames.filter(name => cache[name].archived));
}

async function searchPRs(query) {
    const url = API + "/search/issues?advanced_search=true&per_page=" +
        SEARCH_PAGE + "&sort=updated&order=" + getOrder() +
        "&q=" + encodeURIComponent(query);
    const res = await fetch(url, { headers: ghHeaders() });
    if (res.status === 401) throw new Error("unauthorized");
    const limited = res.status === 429 || (res.status === 403 &&
        res.headers.get("x-ratelimit-remaining") === "0");
    if (limited) throw new Error("GitHub rate limit hit");
    if (!res.ok) throw new Error("GitHub error " + res.status);
    const data = await res.json();
    const items = data.items || [];
    const names = [...new Set(
        items.map(pr => fullRepoFromUrl(pr.repository_url)))];
    const archived = await archivedRepos(names);
    const kept = items.filter(
        pr => !archived.has(fullRepoFromUrl(pr.repository_url)));
    const total = (data.total_count || 0) - (items.length - kept.length);
    return { items: kept, total: total };
}

function mergeReview(base, changes) {
    const flagged = changes.items.map(pr =>
        Object.assign({}, pr, { changesRequested: true }));
    const items = [...base.items, ...flagged].sort((a, b) => {
        const diff = new Date(a.updated_at) - new Date(b.updated_at);
        return getOrder() === "asc" ? diff : -diff;
    });
    return { items: items, total: base.total + changes.total };
}

// The cache keeps one entry per sort order so toggling the order
// renders instantly from the last sync instead of refetching.
function readCache() {
    try {
        const stored = JSON.parse(
            localStorage.getItem(CACHE_KEY) || "null");
        const cache = stored && stored[getOrder()];
        const current = JSON.stringify(effectiveQueries());
        if (cache && cache.ts && cache.data &&
            JSON.stringify(cache.queries) === current) {
            return cache;
        }
    } catch (err) {}
    return null;
}

function writeCache(data) {
    const stored = {};
    try {
        const parsed = JSON.parse(
            localStorage.getItem(CACHE_KEY) || "null");
        if (parsed && typeof parsed === "object") {
            if (parsed.asc) stored.asc = parsed.asc;
            if (parsed.desc) stored.desc = parsed.desc;
        }
    } catch (err) {}
    stored[getOrder()] = {
        ts: Date.now(),
        data: data,
        queries: effectiveQueries()
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(stored));
}

let connExpanded = null;

function connHost(url) {
    try {
        return new URL(url).host;
    } catch (err) {
        return url;
    }
}

function connServices() {
    const jira = getJira();
    return [
        {
            key: "github",
            name: "GitHub",
            state: getToken()
                ? "token ···" + getToken().slice(-4) : "",
            form: buildGithubForm,
            disconnect: () => {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(CACHE_KEY);
                hasData = false;
                loadPRs(false);
            }
        },
        {
            key: "jira",
            name: "Jira",
            state: jira
                ? jira.email + " · " + connHost(jira.siteUrl) : "",
            form: buildJiraForm,
            disconnect: () => {
                localStorage.removeItem(JIRA_KEY);
                localStorage.removeItem(JIRA_CACHE_KEY);
                jiraHasData = false;
                loadJira(false);
            }
        }
    ];
}

function connForm(children, saveFn, done) {
    const save = el("button", { class: "save", text: "Save" });
    const cancel = el("button", {
        class: "cancel",
        type: "button",
        text: "cancel"
    });
    const error = el("p", { class: "error" });
    const node = el("div", { class: "conn-form" }, [
        ...children,
        el("div", { class: "row" }, [save, cancel]),
        error
    ]);
    save.addEventListener("click", async () => {
        error.textContent = "";
        save.disabled = true;
        try {
            await saveFn();
            done();
        } catch (err) {
            error.textContent = err.message;
        } finally {
            save.disabled = false;
        }
    });
    cancel.addEventListener("click", () => done());
    node.addEventListener("keydown", e => {
        if (e.key === "Enter" &&
            e.target instanceof HTMLInputElement) save.click();
        if (e.key === "Escape") done();
    });
    return node;
}

async function verifyGithubToken(token) {
    const res = await fetch(API + "/user", {
        headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + token,
            "X-GitHub-Api-Version": "2022-11-28"
        }
    });
    if (res.status === 401) {
        throw new Error("GitHub rejected the token");
    }
    if (!res.ok) throw new Error("GitHub error " + res.status);
}

function buildGithubForm(done) {
    const intro = el("p", {
        text: "Personal access token (classic, repo scope), stored " +
            "only in this browser's localStorage. "
    });
    intro.appendChild(el("a", {
        href: "https://github.com/settings/tokens/new" +
            "?scopes=repo&description=Land%20homepage",
        text: "Create one on GitHub"
    }));
    intro.appendChild(document.createTextNode("."));
    const input = el("input", {
        type: "password",
        placeholder: "ghp_… or github_pat_…"
    });
    return connForm([intro, input], async () => {
        const value = input.value.trim();
        if (!value) throw new Error("a token is required");
        await verifyGithubToken(value);
        localStorage.setItem(TOKEN_KEY, value);
        loadPRs(true);
    }, done);
}

function buildJiraForm(done) {
    const stored = getJira();
    const intro = el("p", {
        text: "Site, login email, and an "
    });
    intro.appendChild(el("a", {
        href: "https://id.atlassian.com/manage-profile/security/" +
            "api-tokens",
        text: "Atlassian API token"
    }));
    intro.appendChild(document.createTextNode(
        ", stored only in this browser's localStorage."));
    const site = el("input", {
        placeholder: "https://yoursite.atlassian.net",
        spellcheck: "false",
        value: stored ? stored.siteUrl : ""
    });
    const email = el("input", {
        type: "email",
        placeholder: "you@example.com",
        spellcheck: "false",
        value: stored ? stored.email : ""
    });
    const token = el("input", {
        type: "password",
        placeholder: "API token"
    });
    return connForm([intro, site, email, token], async () => {
        const siteUrl = normalizeSiteUrl(site.value);
        const emailValue = email.value.trim();
        const tokenValue = token.value.trim();
        if (!siteUrl || !emailValue || !tokenValue) {
            throw new Error("all three fields are required");
        }
        await requestJiraPermission(siteUrl);
        await connectJira(siteUrl, emailValue, tokenValue);
        localStorage.removeItem(JIRA_CACHE_KEY);
        jiraHasData = false;
        loadJira(true);
    }, done);
}

function showWelcome() {
    if (document.getElementById("welcome")) return;
    const intro = el("p", {
        text: "Every new tab becomes a pull-request triage board: " +
            "what is ready to land, what needs your review, what is " +
            "in flight, and what is stuck on others."
    });
    const form = buildGithubForm(() => {});
    form.querySelector(".save").textContent = "Connect GitHub";
    form.querySelector(".cancel").remove();
    const note = el("p", {
        class: "welcome-note",
        text: "Optional: connect Jira from Connections (top right) " +
            "to see your assigned tickets as a small board at the " +
            "bottom."
    });
    const section = el("section", { id: "welcome" }, [
        el("h2", { text: "Welcome to land." }),
        el("div", { class: "welcome-box" }, [intro, form, note])
    ]);
    document.querySelector("main").prepend(section);
}

// The welcome card and the Connections panel both carry the GitHub
// form, so only one of them may be on screen: the panel supersedes
// the card while open, and the card returns when it closes.
function refreshWelcome() {
    const wanted = document.body.classList.contains("onboarding") &&
        !document.getElementById("connections-section");
    const existing = document.getElementById("welcome");
    if (wanted && !existing) showWelcome();
    if (!wanted && existing) existing.remove();
}

function setOnboarding(on) {
    document.body.classList.toggle("onboarding", on);
    refreshWelcome();
}

function focusConnForm() {
    const list = document.getElementById("conn-list");
    if (!list) return;
    const input = list.querySelector(".conn-form input");
    if (input) input.focus();
}

function renderConnRows() {
    const list = document.getElementById("conn-list");
    if (!list) return;
    const rows = connServices().map(service => {
        const row = el("div", { class: "conn-row" });
        row.appendChild(el("span", {
            class: "conn-name",
            text: service.name
        }));
        row.appendChild(el("span", {
            class: "conn-state",
            text: service.state || "not connected"
        }));
        const actions = el("div", { class: "conn-actions" });
        const primary = el("button", {
            text: service.state ? "update" : "connect"
        });
        primary.addEventListener("click", () => {
            connExpanded =
                connExpanded === service.key ? null : service.key;
            renderConnRows();
            focusConnForm();
        });
        actions.appendChild(primary);
        if (service.state) {
            const off = el("button", { text: "disconnect" });
            off.addEventListener("click", () => {
                service.disconnect();
                connExpanded = null;
                renderConnRows();
            });
            actions.appendChild(off);
        }
        row.appendChild(actions);
        if (connExpanded === service.key) {
            row.appendChild(service.form(() => {
                connExpanded = null;
                renderConnRows();
            }));
        }
        return row;
    });
    list.replaceChildren(...rows);
}

function showConnections(expandKey, refocus) {
    const existing = document.getElementById("connections-section");
    if (existing) {
        if (expandKey && connExpanded !== expandKey) {
            connExpanded = expandKey;
            renderConnRows();
        }
        if (refocus) focusConnForm();
        return;
    }
    connExpanded = expandKey || null;
    const close = el("button", { class: "filter-btn", text: "close" });
    const heading = el("h2", {});
    heading.appendChild(document.createTextNode("Connections"));
    heading.appendChild(close);
    const section = el("section", { id: "connections-section" }, [
        heading,
        el("div", { class: "conn-list", id: "conn-list" })
    ]);
    close.addEventListener("click", () => {
        section.remove();
        refreshWelcome();
    });
    document.querySelector(".act").prepend(section);
    renderConnRows();
    refreshWelcome();
    if (refocus) focusConnForm();
}

function toggleFilterEditor(section) {
    const listEl = document.getElementById(section.list);
    const parent = listEl.parentElement;
    const open = parent.querySelector(".filter-editor");
    if (open) {
        open.remove();
        return;
    }
    const input = el("input", {
        value: getQuery(section),
        spellcheck: "false",
        "aria-label": "Search filter for " + section.short
    });
    const save = el("button", { class: "save", text: "Save" });
    const reset = el("button", {
        class: "plain",
        text: "reset to default"
    });
    const cancel = el("button", { class: "plain", text: "cancel" });
    const docs = el("a", {
        href: "https://docs.github.com/en/search-github/" +
            "searching-on-github/" +
            "searching-issues-and-pull-requests",
        text: "syntax reference"
    });
    const error = el("p", { class: "error" });
    const editor = el("div", { class: "filter-editor" }, [
        input,
        el("div", { class: "row" }, [save, reset, cancel, docs]),
        error
    ]);
    async function apply(value) {
        const overrides = getFilterOverrides();
        const trimmed = value.trim();
        if (!trimmed || trimmed === section.defaultQuery) {
            delete overrides[section.key];
        } else {
            error.textContent = "";
            save.disabled = true;
            try {
                await searchPRs(trimmed);
            } catch (err) {
                error.textContent = err.message.includes("422")
                    ? "GitHub rejected this filter — check the syntax"
                    : err.message;
                return;
            } finally {
                save.disabled = false;
            }
            overrides[section.key] = trimmed;
        }
        saveFilterOverrides(overrides);
        editor.remove();
        updateFilterButtons();
        loadPRs(false);
    }
    save.addEventListener("click", () => apply(input.value));
    reset.addEventListener("click",
        () => apply(section.defaultQuery));
    cancel.addEventListener("click", () => editor.remove());
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") apply(input.value);
        if (e.key === "Escape") editor.remove();
    });
    parent.insertBefore(editor, listEl);
    input.focus();
}

async function loadPRs(force) {
    if (!getToken()) {
        setOnboarding(true);
        document.getElementById("summary").replaceChildren();
        setStatus("");
        lastRendered = "";
        for (const section of SECTIONS) {
            renderMessage(document.getElementById(section.list),
                "empty", "Waiting for token.");
        }
        return;
    }
    setOnboarding(false);
    if (inFlight) return;
    const now = Date.now();
    if (force && now - lastForce < FORCE_MIN_MS) return;
    const cache = readCache();
    if (cache && !hasData) {
        renderAll(cache.data);
        hasData = true;
        setStatus("synced " + fmtTime(cache.ts));
    }
    if (!force && cache && now - cache.ts < CACHE_TTL_MS) {
        return;
    }
    if (force) lastForce = now;
    inFlight = true;
    setStatus("syncing…");
    try {
        const results = await Promise.all([
            ...SECTIONS.map(section => searchPRs(getQuery(section))),
            searchPRs(CHANGES_QUERY)
        ]);
        const data = {};
        SECTIONS.forEach((section, i) => { data[section.key] = results[i]; });
        data.review = mergeReview(data.review, results[SECTIONS.length]);
        scheduleRender(data);
        hasData = true;
        writeCache(data);
        setStatus("synced " + fmtTime(Date.now()));
    } catch (err) {
        if (err.message === "unauthorized") {
            localStorage.removeItem(TOKEN_KEY);
            showConnections("github", true);
            setStatus("token rejected", "error");
            return;
        }
        const kind = err.message.includes("rate limit")
            ? "warn" : "error";
        if (hasData) {
            const shown = cache ? " — showing " + fmtTime(cache.ts) +
                " data" : "";
            setStatus(err.message + shown, kind);
            return;
        }
        setStatus(err.message, kind);
        lastRendered = "";
        for (const section of SECTIONS) {
            renderMessage(document.getElementById(section.list),
                "empty", "unavailable");
        }
    } finally {
        inFlight = false;
    }
}

function getJira() {
    try {
        const conn = JSON.parse(localStorage.getItem(JIRA_KEY) || "null");
        if (conn && conn.siteUrl && conn.email && conn.apiToken) {
            return conn;
        }
    } catch (err) {}
    return null;
}

function saveJira(conn) {
    localStorage.setItem(JIRA_KEY, JSON.stringify(conn));
}

function readJiraCache() {
    try {
        const cache = JSON.parse(
            localStorage.getItem(JIRA_CACHE_KEY) || "null");
        if (cache && cache.ts && cache.data) return cache;
    } catch (err) {}
    return null;
}

function writeJiraCache(data) {
    localStorage.setItem(JIRA_CACHE_KEY, JSON.stringify({
        ts: Date.now(),
        data: data
    }));
}

function setJiraVisible(visible) {
    document.querySelector(".jira").hidden = !visible;
}

function groupJiraByStatus(issues) {
    const order = { new: 0, indeterminate: 1, done: 2 };
    const groups = [];
    const byStatus = new Map();
    for (const ticket of issues) {
        let group = byStatus.get(ticket.status);
        if (!group) {
            group = {
                status: ticket.status,
                category: ticket.category,
                tickets: []
            };
            byStatus.set(ticket.status, group);
            groups.push(group);
        }
        group.tickets.push(ticket);
    }
    return groups.sort((a, b) =>
        (order[a.category] ?? 3) - (order[b.category] ?? 3));
}

function renderJiraTickets(conn, data) {
    setJiraVisible(true);
    const list = document.getElementById("jira-list");
    if (data.issues.length === 0) {
        list.replaceChildren(el("li", {
            class: "jira-note",
            text: "No Jira tickets assigned."
        }));
        return;
    }
    const items = [];
    for (const group of groupJiraByStatus(data.issues)) {
        const lane = el("li", {});
        if (group.status) {
            const label = el("span", { class: "lane-label" });
            label.appendChild(el("span", {
                class: "lane-count",
                text: String(group.tickets.length)
            }));
            label.appendChild(
                document.createTextNode(" " + group.status));
            lane.appendChild(label);
        }
        for (const ticket of group.tickets) {
            const children = [
                el("span", { class: "jira-key", text: ticket.key }),
                el("span", { class: "jira-title", text: ticket.summary })
            ];
            if (ticket.updated) {
                children.push(el("span", {
                    class: ("jira-age " +
                        ageClass(ticket.updated)).trim(),
                    text: relativeTime(ticket.updated)
                }));
            }
            lane.appendChild(el("a", {
                href: conn.siteUrl + "/browse/" + ticket.key,
                title: ticket.summary
            }, children));
        }
        items.push(lane);
    }
    if (data.more) {
        items.push(el("li", { class: "jira-more" }, [
            el("a", {
                class: "more-link",
                href: conn.siteUrl + "/issues/?jql=" +
                    encodeURIComponent(JIRA_JQL),
                text: "more →"
            })
        ]));
    }
    list.replaceChildren(...items);
}

function renderJiraError(message, reauth) {
    setJiraVisible(true);
    const item = el("li", {
        class: "jira-error",
        text: "Jira: " + message
    });
    if (reauth) {
        const fix = el("button", { text: "reconnect" });
        fix.addEventListener("click",
            () => showConnections("jira", true));
        item.appendChild(fix);
    }
    document.getElementById("jira-list").replaceChildren(item);
}

function jiraHeaders(conn) {
    return {
        "Accept": "application/json",
        "Authorization": "Basic " +
            btoa(conn.email + ":" + conn.apiToken)
    };
}

async function fetchJiraIssues(conn) {
    const url = conn.siteUrl + "/rest/api/3/search/jql?" +
        new URLSearchParams({
            jql: JIRA_JQL,
            maxResults: String(JIRA_MAX),
            fields: "summary,status,updated"
        });
    const res = await fetch(url, { headers: jiraHeaders(conn) });
    if (res.status === 401 || res.status === 403) {
        throw new Error("jira-reauth");
    }
    if (!res.ok) throw new Error("Jira error " + res.status);
    const data = await res.json();
    return {
        issues: (data.issues || []).map(issue => {
            const status = issue.fields && issue.fields.status;
            return {
                key: issue.key,
                summary: issue.fields && issue.fields.summary || "",
                status: status ? status.name : "",
                category: status && status.statusCategory
                    ? status.statusCategory.key : "",
                updated: issue.fields && issue.fields.updated || ""
            };
        }),
        more: data.isLast === false
    };
}

// Jira's REST API sends no CORS headers, so the page needs a host
// permission for the site to fetch it. Chrome grants the wildcard
// at install; Firefox MV3 treats host permissions as optional, so
// the specific site is requested here, inside the click handler's
// user gesture.
// Unlike GitHub, Atlassian's API sends no CORS headers, so the
// fetch only works from an extension page holding a host permission
// for the site. On a plain page (file:// included) there is nothing
// to request and the fetch is guaranteed to be blocked.
async function requestJiraPermission(siteUrl) {
    if (!ext || !ext.permissions) {
        throw new Error("Atlassian blocks cross-origin requests: " +
            "Jira needs land loaded as an extension, not a file:// " +
            "or http(s) page");
    }
    const perm = { origins: [siteUrl + "/*"] };
    let granted = false;
    let failure = "";
    try {
        granted = await ext.permissions.request(perm);
    } catch (err) {
        failure = err.message;
    }
    if (granted) return;
    const has = await ext.permissions.contains(perm)
        .catch(() => false);
    if (has) return;
    if (failure) {
        throw new Error("host permission unavailable (" + failure +
            ") — reload the add-on so the new manifest applies, " +
            "then retry");
    }
    throw new Error("site permission declined");
}

async function connectJira(siteUrl, email, apiToken) {
    const conn = { siteUrl: siteUrl, email: email, apiToken: apiToken };
    const res = await fetch(siteUrl + "/rest/api/3/myself", {
        headers: jiraHeaders(conn)
    });
    if (res.status === 401 || res.status === 403) {
        throw new Error("Jira rejected the credentials");
    }
    if (!res.ok) throw new Error("Jira error " + res.status);
    saveJira(conn);
}

function normalizeSiteUrl(value) {
    let url = value.trim().replace(/\/+$/, "");
    if (url && !/^https:\/\//.test(url)) url = "https://" + url;
    return url;
}

let jiraHasData = false;
let jiraInFlight = false;

async function loadJira(force) {
    const conn = getJira();
    if (!conn) {
        setJiraVisible(false);
        setJiraStatus("");
        document.getElementById("jira-list").replaceChildren();
        return;
    }
    const cache = readJiraCache();
    if (cache && !jiraHasData) {
        renderJiraTickets(conn, cache.data);
        jiraHasData = true;
    }
    if (!force && cache && Date.now() - cache.ts < CACHE_TTL_MS) return;
    if (jiraInFlight) return;
    jiraInFlight = true;
    try {
        const data = await fetchJiraIssues(conn);
        renderJiraTickets(conn, data);
        jiraHasData = true;
        writeJiraCache(data);
        setJiraStatus("");
    } catch (err) {
        if (err.message === "jira-reauth") {
            setJiraStatus("");
            renderJiraError("token rejected", true);
        } else if (jiraHasData && cache) {
            setJiraStatus("jira — showing " + fmtTime(cache.ts) +
                " data", "warn");
        } else {
            setJiraStatus("");
            renderJiraError(err.message, false);
        }
    } finally {
        jiraInFlight = false;
    }
}

function getBookmarks() {
    try {
        const stored = JSON.parse(
            localStorage.getItem(BOOKMARKS_KEY) || "null");
        if (Array.isArray(stored)) return stored;
    } catch (err) {}
    return DEFAULT_BOOKMARKS.slice();
}

function saveBookmarks(bookmarks) {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
}

function removeBookmark(index) {
    const bookmarks = getBookmarks();
    const entry = { bm: bookmarks[index], index: index };
    bookmarks.splice(index, 1);
    saveBookmarks(bookmarks);
    entry.timer = setTimeout(() => {
        undoEntries = undoEntries.filter(e => e !== entry);
        renderBookmarks();
    }, UNDO_MS);
    undoEntries.push(entry);
    renderBookmarks();
}

function undoRemove(entry) {
    clearTimeout(entry.timer);
    undoEntries = undoEntries.filter(e => e !== entry);
    const bookmarks = getBookmarks();
    const at = Math.min(entry.index, bookmarks.length);
    bookmarks.splice(at, 0, entry.bm);
    saveBookmarks(bookmarks);
    renderBookmarks();
}

function renderBookmarks() {
    const bookmarks = getBookmarks();
    const list = document.getElementById("bookmark-list");
    const items = bookmarks.map((bm, i) => {
        const item = el("li", {}, [
            el("a", { href: bm.url, title: bm.url, text: bm.title })
        ]);
        if (editing) {
            const remove = el("button", {
                class: "bm-remove",
                "aria-label": "Remove " + bm.title,
                title: "Remove " + bm.title,
                text: "✕"
            });
            remove.addEventListener("click", () => removeBookmark(i));
            item.appendChild(remove);
        }
        return item;
    });
    items.push(...undoEntries.map(entry => {
        const undo = el("button", { text: "undo" });
        undo.addEventListener("click", () => undoRemove(entry));
        const note = el("li", { class: "undo-note" });
        note.appendChild(document.createTextNode(
            "Removed “" + entry.bm.title + "”"));
        note.appendChild(undo);
        return note;
    }));
    if (items.length === 0) {
        items.push(el("li", {
            class: "none",
            text: editing
                ? "Add your first bookmark below."
                : "No bookmarks yet."
        }));
    }
    list.replaceChildren(...items);
}

document.getElementById("bookmark-form")
    .addEventListener("submit", e => {
        e.preventDefault();
        const title = document.getElementById("bm-title").value.trim();
        const url = document.getElementById("bm-url").value.trim();
        if (!title || !url) return;
        const bookmarks = getBookmarks();
        bookmarks.push({ title: title, url: url });
        saveBookmarks(bookmarks);
        e.target.reset();
        renderBookmarks();
    });

for (const section of SECTIONS) {
    document.getElementById(section.key + "-filter")
        .addEventListener("click", () => toggleFilterEditor(section));
}

document.getElementById("bm-edit").addEventListener("click", () => {
    editing = !editing;
    document.getElementById("bookmark-form").hidden = !editing;
    document.getElementById("bm-edit").textContent =
        editing ? "done" : "edit";
    renderBookmarks();
});

document.getElementById("order").addEventListener("click", () => {
    localStorage.setItem(ORDER_KEY,
        getOrder() === "desc" ? "asc" : "desc");
    updateOrderButton();
    hasData = false;
    loadPRs(false);
});

for (const section of SECTIONS) {
    const listEl = document.getElementById(section.list);
    listEl.addEventListener("pointerenter", () => {
        hoveredList = listEl;
    });
    listEl.addEventListener("pointerleave", () => {
        hoveredList = null;
        if (pendingData) renderAll(pendingData);
    });
}

document.getElementById("refresh")
    .addEventListener("click", () => {
        loadPRs(true);
        loadJira(true);
    });

document.getElementById("connections").addEventListener("click", () => {
    const existing = document.getElementById("connections-section");
    if (existing) {
        existing.remove();
        refreshWelcome();
        return;
    }
    showConnections(null, false);
});

document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        loadPRs(false);
        loadJira(false);
    }
});

document.addEventListener("keydown", e => {
    const target = e.target;
    const typing = target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "r") {
        loadPRs(true);
        loadJira(true);
    }
});

renderBookmarks();
updateFilterButtons();
updateOrderButton();
loadPRs(false);
loadJira(false);
setInterval(() => {
    loadPRs(false);
    loadJira(false);
}, REFRESH_MS);
