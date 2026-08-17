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
            "archived:false review-requested:@me status:success"
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
    document.getElementById("order").textContent =
        getOrder() === "desc" ? "Newest first" : "Oldest first";
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

function setStatus(text, kind) {
    const status = document.getElementById("status");
    status.textContent = text;
    status.className = kind || "";
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

function renderAll(data) {
    for (const section of SECTIONS) {
        renderSection(section, data[section.key]);
    }
    renderSummary(data);
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

function readCache() {
    try {
        const cache = JSON.parse(
            localStorage.getItem(CACHE_KEY) || "null");
        const current = JSON.stringify(effectiveQueries());
        if (cache && cache.ts && cache.data &&
            cache.order === getOrder() &&
            JSON.stringify(cache.queries) === current) {
            return cache;
        }
    } catch (err) {}
    return null;
}

function writeCache(data) {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
        ts: Date.now(),
        data: data,
        queries: effectiveQueries(),
        order: getOrder()
    }));
}

function showTokenPrompt(refocus) {
    const existing = document.getElementById("token-section");
    if (existing) {
        if (refocus) {
            const openInput = document.getElementById("token-input");
            if (openInput) openInput.focus();
        }
        return;
    }
    const grid = document.querySelector(".act");
    const input = el("input", {
        id: "token-input",
        type: "password",
        placeholder: "ghp_… or github_pat_…"
    });
    const save = el("button", { class: "save", text: "Save token" });
    const link = el("a", {
        href: "https://github.com/settings/tokens/new" +
            "?scopes=repo&description=Land%20homepage",
        text: "Create one on GitHub"
    });
    const intro = el("p", {
        text: "Listing your pull requests needs a GitHub personal " +
            "access token (classic, repo scope). It is stored only " +
            "in this browser's localStorage. "
    });
    intro.appendChild(link);
    intro.appendChild(document.createTextNode("."));
    const row = el("div", { class: "row" }, [save]);
    if (getToken()) {
        const cancel = el("button", {
            class: "cancel",
            type: "button",
            text: "Cancel"
        });
        cancel.addEventListener("click", () => section.remove());
        row.appendChild(cancel);
    }
    const box = el("div", { class: "token-box" }, [intro, input, row]);
    const section = el("section", { id: "token-section" }, [
        el("h2", { text: "GitHub token" }),
        box
    ]);
    save.addEventListener("click", () => {
        const value = input.value.trim();
        if (!value) return;
        localStorage.setItem(TOKEN_KEY, value);
        section.remove();
        loadPRs(true);
    });
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") save.click();
        if (e.key === "Escape") section.remove();
    });
    grid.prepend(section);
    if (refocus) input.focus();
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
        text: "Reset to default"
    });
    const cancel = el("button", { class: "plain", text: "Cancel" });
    const editor = el("div", { class: "filter-editor" }, [
        input,
        el("div", { class: "row" }, [save, reset, cancel])
    ]);
    function apply(value) {
        const overrides = getFilterOverrides();
        const trimmed = value.trim();
        if (!trimmed || trimmed === section.defaultQuery) {
            delete overrides[section.key];
        } else {
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
        showTokenPrompt(false);
        for (const section of SECTIONS) {
            renderMessage(document.getElementById(section.list),
                "empty", "Waiting for token.");
        }
        return;
    }
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
        const results = await Promise.all(
            SECTIONS.map(section => searchPRs(getQuery(section))));
        const data = {};
        SECTIONS.forEach((section, i) => { data[section.key] = results[i]; });
        renderAll(data);
        hasData = true;
        writeCache(data);
        setStatus("synced " + fmtTime(Date.now()));
    } catch (err) {
        if (err.message === "unauthorized") {
            localStorage.removeItem(TOKEN_KEY);
            showTokenPrompt(true);
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
        setStatus("failed", kind);
        for (const section of SECTIONS) {
            renderMessage(document.getElementById(section.list),
                "error", err.message);
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

function updateJiraButtons(connected, reauth) {
    const connect = document.getElementById("jira-connect");
    connect.hidden = connected && !reauth;
    connect.textContent = reauth ? "Reconnect Jira" : "Connect Jira";
    document.getElementById("jira-disconnect").hidden = !connected;
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
    updateJiraButtons(true, false);
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
            lane.appendChild(el("span", {
                class: "lane-label",
                text: group.status
            }));
        }
        for (const ticket of group.tickets) {
            lane.appendChild(el("a", {
                href: conn.siteUrl + "/browse/" + ticket.key,
                title: ticket.summary
            }, [
                el("span", { class: "jira-key", text: ticket.key }),
                el("span", { class: "jira-title", text: ticket.summary })
            ]));
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
    updateJiraButtons(true, reauth);
    document.getElementById("jira-list").replaceChildren(
        el("li", { class: "jira-error", text: "Jira: " + message }));
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
            fields: "summary,status"
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
                    ? status.statusCategory.key : ""
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

function showJiraPrompt() {
    const existing = document.getElementById("jira-section");
    if (existing) {
        existing.querySelector("input").focus();
        return;
    }
    const grid = document.querySelector(".act");
    const stored = getJira();
    const intro = el("p", {
        text: "Showing assigned tickets needs your Jira site, the " +
            "email you log in with, and an "
    });
    intro.appendChild(el("a", {
        href: "https://id.atlassian.com/manage-profile/security/" +
            "api-tokens",
        text: "Atlassian API token"
    }));
    intro.appendChild(document.createTextNode(
        ". They are stored only in this browser's localStorage."));
    const siteInput = el("input", {
        placeholder: "https://yoursite.atlassian.net",
        spellcheck: "false",
        value: stored ? stored.siteUrl : ""
    });
    const emailInput = el("input", {
        type: "email",
        placeholder: "you@example.com",
        spellcheck: "false",
        value: stored ? stored.email : ""
    });
    const tokenInput = el("input", {
        type: "password",
        placeholder: "API token"
    });
    const save = el("button", { class: "save", text: "Connect" });
    const cancel = el("button", {
        class: "cancel",
        type: "button",
        text: "Cancel"
    });
    const error = el("p", { class: "error" });
    const box = el("div", { class: "token-box" }, [
        intro, siteInput, emailInput, tokenInput,
        el("div", { class: "row" }, [save, cancel]),
        error
    ]);
    const section = el("section", { id: "jira-section" }, [
        el("h2", { text: "Jira" }),
        box
    ]);
    cancel.addEventListener("click", () => section.remove());
    save.addEventListener("click", async () => {
        const siteUrl = normalizeSiteUrl(siteInput.value);
        const email = emailInput.value.trim();
        const apiToken = tokenInput.value.trim();
        if (!siteUrl || !email || !apiToken) return;
        error.textContent = "";
        save.disabled = true;
        try {
            await requestJiraPermission(siteUrl);
            await connectJira(siteUrl, email, apiToken);
            localStorage.removeItem(JIRA_CACHE_KEY);
            jiraHasData = false;
            section.remove();
            loadJira(true);
        } catch (err) {
            error.textContent = err.message;
        } finally {
            save.disabled = false;
        }
    });
    for (const field of [siteInput, emailInput, tokenInput]) {
        field.addEventListener("keydown", e => {
            if (e.key === "Enter") save.click();
            if (e.key === "Escape") section.remove();
        });
    }
    grid.prepend(section);
    (stored ? tokenInput : siteInput).focus();
}

let jiraHasData = false;
let jiraInFlight = false;

async function loadJira(force) {
    const conn = getJira();
    if (!conn) {
        updateJiraButtons(false, false);
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
    } catch (err) {
        if (err.message === "jira-reauth") {
            renderJiraError("token rejected", true);
        } else if (!jiraHasData) {
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
        const undo = el("button", { text: "Undo" });
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
        editing ? "Done" : "Edit";
    renderBookmarks();
});

document.getElementById("order").addEventListener("click", () => {
    localStorage.setItem(ORDER_KEY,
        getOrder() === "desc" ? "asc" : "desc");
    updateOrderButton();
    loadPRs(false);
});

document.getElementById("refresh")
    .addEventListener("click", () => {
        loadPRs(true);
        loadJira(true);
    });

document.getElementById("change-token")
    .addEventListener("click", () => showTokenPrompt(true));

document.getElementById("jira-connect")
    .addEventListener("click", () => showJiraPrompt());

document.getElementById("jira-disconnect")
    .addEventListener("click", () => {
        localStorage.removeItem(JIRA_KEY);
        localStorage.removeItem(JIRA_CACHE_KEY);
        jiraHasData = false;
        loadJira(false);
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
