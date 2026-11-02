/*
 * alert-console-card — the Alerts view for the Alert2 fork.
 *
 * Every alert, what is firing now, and what happened. Built from the same design system
 * as health-monitor-card (ha-health-monitor repo) so the two views read as one product:
 * the same four type roles, the same tokens, tiles, sticky header, multi-select filters,
 * chips, keyed rows and detail panels. When changing anything visual, change it there too.
 *
 * Design rules (inherited from the Health card — keep them):
 *
 *  - One hue per CATEGORY, used everywhere that category appears. TWO priorities only:
 *    high red, low yellow (Alert2's "medium" counts as high). A firing alert is the
 *    Health card's "unavailable" red whatever its priority; an acknowledged one is a
 *    pale rose - it fired, and it is handled. Green is OK, grey is snoozed/notified.
 *    Selection is white and one weight up, never a hue.
 *
 *  - Four type roles and nothing else (top of STYLES). A new element gets type by joining
 *    a role, never by inventing a font-size.
 *
 *  - Touch first: every hit target is at least --tap high, sized for a wall tablet.
 *
 *  - No explanatory prose. Labels carry their own meaning.
 *
 *  - One scrollbar. Nothing inside the card scrolls except the filter popover.
 *
 * Data:
 *  - alert2.* states (one read per tick; there are few alerts);
 *  - the fork's per-alert timeline, websocket "alert2/hm/timeline";
 *  - the recorder, for the firing chart and each alert's firing/OK history, which is
 *    drawn by state-history-card (our fork) like the Health card's availability.
 *
 * Config:
 *   type: custom:alert-console-card
 *   title: Alerts            # optional
 *   hours: 24                # optional: 6 | 24 | 72 | 168
 *   page_size: 50            # optional
 *   grid_options: {columns: full}   # required inside a sections-view grid
 */

const VERSION = "1.0.0";

/* The Health card's palette, renamed for what it means here. Same hex values, so a red
   alert and a red "offline" are the same red on the same dashboard. */
const COL = {
  ok: "#3FB950",          // OK / resolved
  firing: "#F85149",      // firing — the Health card's "unavailable" red
  high: "#F85149",        // high priority — the same red
  low: "#EFC53F",         // low priority — yellow
  snoozed: "#F9A8A3",     // snoozed: half way from the firing red to white
  quiet: "#8B949E",       // pending, snoozed, notified — deliberately colourless
  grid: "rgba(255,255,255,.07)",
  axis: "rgba(255,255,255,.45)",
};

/* Two priorities. Alert2 also knows "medium"; it reads as high here, so nothing set
   outside this card can quietly drop to the lower one. */
const PRIO = {
  high: { label: "High", tone: COL.high, rank: 0 },
  low: { label: "Low", tone: COL.low, rank: 1 },
};
const PRIO_IDS = ["high", "low"];
const prioKey = (p) => (p === "high" || p === "medium" ? "high" : "low");
const prioOf = (p) => PRIO[prioKey(p)];

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const IOS = "cubic-bezier(0.32, 0.72, 0, 1)";
const IOS_SOFT = "cubic-bezier(0.34, 1.26, 0.64, 1)";
const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const RANGES = [
  { id: "24h", label: "24h", hours: 24 },
  { id: "3d", label: "3d", hours: 72 },
  { id: "7d", label: "7d", hours: 168 },
];
const DAY = 86400e3;
/* Timeline entries per page (the Health card's). */
const TL_PAGE = 10;
// lines of an alert's message per page (one item - a device, a condition's part - per line)
const MSG_PAGE = 10;

/* Active = anything not OK: firing or acknowledged.
   All = every alert. History = everything that happened, newest first. */
const VIEWS = [
  { id: "active", label: "Active" },
  { id: "all", label: "All Alerts" },
  { id: "history", label: "History" },
];

/* Below 700px only the `narrow` columns stay, at their `wn` width, so a phone row is
   never wider than the screen (the page must not scroll sideways). */
const COLUMNS = {
  active: [
    { id: "name", label: "Alert", w: "minmax(220px,3fr)", narrow: true, wn: "minmax(0,1fr)" },
    { id: "category", label: "Category", w: "minmax(110px,1fr)" },
    { id: "priority", label: "Priority", w: "110px", align: "right" },
    { id: "status", label: "Status", w: "150px", align: "right", narrow: true, wn: "auto" },
    { id: "since", label: "Since", w: "120px", align: "right" },
  ],
  all: [
    { id: "name", label: "Alert", w: "minmax(220px,3fr)", narrow: true, wn: "minmax(0,1fr)" },
    { id: "category", label: "Category", w: "minmax(110px,1fr)" },
    { id: "priority", label: "Priority", w: "110px", align: "right" },
    { id: "status", label: "Status", w: "150px", align: "right", narrow: true, wn: "auto" },
    { id: "lastFired", label: "Last fired", w: "120px", align: "right" },
  ],
  history: [
    { id: "when", label: "When", w: "190px", narrow: true, wn: "auto" },
    { id: "name", label: "Alert", w: "minmax(260px,3fr)", narrow: true, wn: "minmax(0,1fr)" },
    { id: "event", label: "Event", w: "190px", narrow: true, wn: "auto" },
    { id: "detail", label: "Detail", w: "minmax(140px,2fr)" },
  ],
};

/* Three statuses and nothing in between: Firing, Snoozed, OK. One name per state, used
   by the tile, the chip, the filter and the history band alike.
   - An alert is ACTIVE while its condition holds, or - an EVENT alert, one that fires at a
     moment and has no "still on" (an error, a door opened) - for a day after it fires.
   - CLEAR makes an active alert OK until it fires again. Only where the rule allows it
     (`allow_clear`; unset: yes for an event alert, no for a condition alert, which turns
     OK by itself once its condition is false). Clear is Alert2's ack.
   - SNOOZE pauses notifications and shows the alert as Snoozed; when the snooze ends, an
     alert that is still active is Firing again.
   - A rule with a "for" delay whose condition is true but whose delay has not run out is
     still OK; its timeline shows "Detected". */
/* A snooze in effect is the alert's status whether it fires or not: Snooze is offered on every
   rule (a flood of alerts is often known in advance), and what was snoozed is found - in the
   status filter, the Snoozed tile, Active - as Snoozed until the snooze ends. */
function statusOf(r) {
  if (r.snoozeUntil) return { text: "Snoozed", tone: COL.snoozed };
  if (!r.firing) return { text: "OK", tone: COL.ok };
  return { text: "Firing", tone: COL.firing };
}
const STATUS_TONE = { Firing: COL.firing, Snoozed: COL.snoozed, OK: COL.ok };
const allowClearOf = (a, isCond) => (typeof a.allow_clear === "boolean" ? a.allow_clear : !isCond);
/* How long an event alert stays Firing after it fires: its rule's "Stays firing" (the fork's
   `stays_firing_mins`; 0 = until cleared), a day where unset. */
function stayMsOf(a) {
  const m = Number(a?.stays_firing_mins);
  if (a?.stays_firing_mins == null || !Number.isFinite(m)) return DAY;
  return m > 0 ? m * 60e3 : Infinity;
}

/* An alert's recorder history (compressed rows: s, a, lu) → [[time ms, status], ...], the
   status changes only, by the same rules as statusOf(). A restart's brief "unavailable"
   is not a status: the alert keeps the one it had. Two changes are recorded by no row -
   an event alert's day running out and a snooze ending - so those moments are added. */
function statusPoints(rows, isCond, endMs, restarts = []) {
  const live = [];
  for (const r of rows) {
    if (r.s == null || r.s === "unavailable" || r.s === "unknown") continue;
    const a = r.a || {};
    const nc = Date.parse(a.notification_control);     // NaN for "enabled" / "disabled"
    live.push({
      t: (r.lu ?? r.lc) * 1000,
      on: r.s === "on",
      fired: a.last_fired_time ? Date.parse(a.last_fired_time) : null,
      snooze: Number.isFinite(nc) ? nc : null,
      cleared: allowClearOf(a, isCond) && !!a.is_acked,
      stay: stayMsOf(a),
    });
  }
  const moments = [];
  live.forEach((r, i) => {
    const next = i + 1 < live.length ? live[i + 1].t : endMs;
    moments.push([r.t, i]);
    for (const x of [!isCond && r.fired != null ? r.fired + r.stay : null, r.snooze]) {
      if (x != null && x > r.t && x < next) moments.push([x, i]);
    }
  });
  moments.sort((a, b) => a[0] - b[0]);
  const pts = [];
  for (const [t, i] of moments) {
    const r = live[i];
    const active = isCond ? r.on : r.fired != null && t - r.fired < r.stay;
    // a snooze in effect wins, firing or not - as statusOf
    const st = r.snooze != null && r.snooze > t ? "Snoozed" : !active || r.cleared ? "OK" : "Firing";
    if (!pts.length || pts[pts.length - 1][1] !== st) pts.push([t, st]);
  }
  // Home Assistant down: "Restarting" from its stop to its start, then the status it had (an
  // alert keeps its state through a restart)
  for (const r of restarts) {
    const s = Date.parse(r.stopped), e = Date.parse(r.started);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || !pts.length || s < pts[0][0] || s > endMs) continue;
    const held = [...pts].reverse().find((p) => p[0] <= s && p[1] !== "Restarting")?.[1];
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i][0] > s && pts[i][0] < e) pts.splice(i, 1);
    pts.push([s, "Restarting"]);
    if (held && e < endMs && !pts.some((p) => p[0] === e)) pts.push([e, held]);
    pts.sort((a, b) => a[0] - b[0]);
  }
  return pts.filter((p, i) => i === 0 || p[1] !== pts[i - 1][1]);
}

/* Timeline vocabulary: what the fork records (hm_timeline.py) → what the reader sees. */
function eventOf(e, row) {
  switch (e.kind) {
    case "detected": return { text: "Detected", tone: COL.quiet };
    case "detect_cleared": return { text: "Cleared early", tone: COL.quiet };
    case "on": return { text: "Activated", tone: COL.firing };
    case "fire": return { text: "Activated", tone: COL.firing };   // an event alert firing
    case "off": return { text: "Resolved", tone: COL.ok };
    // Alert2's ack is the Clear button, where the rule allows clearing; elsewhere an ack
    // (from Alert2's own dialog) changes nothing here.
    case "ack": return row?.allowClear ? { text: "Cleared", tone: COL.ok } : { text: "Acknowledged", tone: COL.quiet };
    case "unack": return { text: row?.allowClear ? "Reopened" : "Unacknowledged", tone: COL.quiet };
    case "notified": return { text: "Notified", tone: COL.quiet };
    // the rule's life: its timeline and history start over at an edit
    case "created": return { text: "Alert rule created", tone: COL.quiet };
    case "edited": return { text: "Alert rule edited", tone: COL.quiet };
    case "deleted": return { text: "Alert rule deleted", tone: COL.quiet };
    // Home Assistant was restarted (from the fork's restart log, shown in every timeline)
    case "restart": return { text: "Home Assistant restarted", tone: COL.quiet };
    // while firing, an item of what it says came or went (a second device offline, one back)
    case "changed":
      if (e.added?.length && !e.removed?.length) return { text: "Added", tone: COL.firing };
      if (e.removed?.length && !e.added?.length) return { text: "Removed", tone: COL.ok };
      return { text: "Changed", tone: COL.quiet };
    case "notification_control":
      if (e.enabled === false) return { text: "Notifications off", tone: COL.quiet };
      // End Snooze is a snooze that ends at once (see _action)
      if (e.snooze_until) {
        return Date.parse(e.snooze_until) > Date.parse(e.t) + 5000 ? { text: "Snoozed", tone: COL.snoozed }
                                                                  : { text: "Snooze ended", tone: COL.quiet };
      }
      return { text: "Notifications on", tone: COL.quiet };
    case "action": return e.ok === false ? { text: "Action failed", tone: COL.high }
                                         : { text: "Action ran", tone: COL.ok };
    default: return { text: e.kind, tone: COL.quiet };
  }
}

/* The Event filter lists an alert's life in order, not the alphabet. */
const EVENT_ORDER = ["Alert rule created", "Alert rule edited", "Alert rule deleted", "Home Assistant restarted", "Detected", "Cleared early", "Activated", "Added", "Removed", "Changed", "Notified", "Snoozed", "Snooze ended",
  "Cleared", "Acknowledged", "Reopened", "Unacknowledged", "Resolved", "Notifications off",
  "Notifications on", "Action ran", "Action failed"];

/* What a Resolved was about. Alert2 says nothing when an alert turns off, so it is what the
   alert last said - its Activated message, with the items that came and went since - by name,
   without values (the 9% a battery read then is not why it resolved). An item's name is the
   fork's (hm_timeline.item_key): before " · ", without a closing "(...)" or a trailing value. */
const ITEM_PAREN = /\s*\([^()]*\)\s*$/;
const ITEM_VALUE = /\s+[-+]?\d+(?:[.,]\d+)?\s*(?:%|[^\s\d]{1,6})?\s*$/;
const itemName = (line) => line.split(" · ", 1)[0].replace(ITEM_PAREN, "").replace(ITEM_VALUE, "").trim() || line.trim();
function markResolved(entries) {
  let items = new Map();
  for (const e of [...entries].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))) {
    const set = (l) => { const n = itemName(l); items.set(n.toLowerCase(), n); };
    if ((e.kind === "on" || e.kind === "fire") && e.message) {
      items = new Map();
      unescapeHtml(e.message).split("\n").map((l) => l.trim()).filter(Boolean).forEach(set);
    } else if (e.kind === "changed") {
      (e.added || []).forEach(set);
      for (const l of e.removed || []) items.delete(itemName(l).toLowerCase());
    } else if (e.kind === "off") {
      e.about = [...items.values()];
      items = new Map();
    }
  }
  return entries;
}

function eventDetail(e) {
  const parts = [];
  // one line here: a message's items run on with " · " (the event's popup shows them a line each)
  if (e.message) parts.push(unescapeHtml(e.message).split("\n").map((l) => l.trim()).filter(Boolean).join(" · "));
  if (e.about?.length) parts.push(e.about.join(" · "));
  // an item that came or went; both at once are told apart by + and −
  const both = e.added?.length && e.removed?.length;
  if (e.added?.length) parts.push(e.added.map((x) => (both ? `+ ${x}` : x)).join(" · "));
  if (e.removed?.length) parts.push(e.removed.map((x) => (both ? `− ${x}` : x)).join(" · "));
  if (e.user) parts.push(`by ${e.user}`);
  if (e.notifiers?.length) parts.push(notifiedText(e));
  // a snooze ended early (End Snooze) has no "until" worth saying
  if (e.snooze_until && Date.parse(e.snooze_until) > Date.parse(e.t) + 5000) {
    parts.push(`until ${fmtDT(Date.parse(e.snooze_until))}`);
  }
  if (e.delay_secs) parts.push(`waiting ${fmtDur(e.delay_secs * 1000)}`);
  if (e.kind === "restart" && e.stopped) parts.push(`down ${fmtDur(Date.parse(e.t) - Date.parse(e.stopped))}`);
  if (e.error) parts.push(e.error);
  return parts.join(" · ");
}

class AlertConsoleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._view = "active";
    this._range = "24h";
    this._sort = { col: "status", dir: "asc" };
    this._prios = new Set();
    this._cats = new Set();
    this._statuses = new Set();
    this._events = new Set();
    this._q = "";
    this._open = null;
    this._page = 0;
    this._series = new Set([0, 1]);
    this._built = false;
    this._sig = "";
    this._timeline = {};          // entity_id -> entries, from the fork
    this._overview = null;
    this._onDocPress = (e) => {
      const path = e.composedPath?.() || [];
      this.shadowRoot?.querySelectorAll(".ms.open").forEach((m) => {
        if (!path.includes(m)) m.classList.remove("open");
      });
    };
    this._onDocKey = (e) => { if (e.key === "Escape") this._closeMenus(); };
    this._mq = typeof matchMedia === "function" ? matchMedia("(max-width: 700px)") : null;
    this._onMq = () => { if (this._phone) return; this._el && (this._el.thead._sig = ""); this._sig = ""; this._paintTable(); };
  }

  /* A new rule, in the editor - also for a card this one sits in (page-switcher-card's
     New alert, when `embedded` hides this card's own header). */
  newAlert() { this._editor?.open(); }

  setConfig(config) {
    this._config = { title: "Alerts", hours: 24, page_size: 50, ...(config || {}) };
    // layout: phone - the iPhone design (AlertPhoneView), drawn from this card's data and actions
    this._phone = this._config.layout === "phone";
    this._pageSize = Math.max(10, Number(this._config.page_size) || 50);
    const r = RANGES.find((x) => x.hours === Number(this._config.hours));
    this._range = r ? r.id : "24h";
    this._built = false;
    this.shadowRoot.innerHTML = "";
  }

  getCardSize() { return 14; }
  static getStubConfig() { return { type: "custom:alert-console-card" }; }

  connectedCallback() {
    document.addEventListener("pointerdown", this._onDocPress, true);
    document.addEventListener("keydown", this._onDocKey, true);
    this._mq?.addEventListener?.("change", this._onMq);
    this._trackHaHeader();
    this._observe();
    // back on screen (HA keeps a left view's cards): follow the timeline again, and catch up
    if (this._hass && this._built) { this._followTimeline(); this._loadTimeline(); }
  }
  disconnectedCallback() {
    this._unfollowTimeline();
    clearTimeout(this._expT);
    document.removeEventListener("pointerdown", this._onDocPress, true);
    document.removeEventListener("keydown", this._onDocKey, true);
    this._mq?.removeEventListener?.("change", this._onMq);
    this._hdrRo?.disconnect(); this._hdrRo = null; this._hdr = null;
    this._ro?.disconnect(); this._ro = null;
    this._headRo?.disconnect(); this._headRo = null;
    this._labRo?.disconnect(); this._labRo = null;
    if (this._snzEl?.dlg.open) this._snzEl.dlg.close();
    if (this._editor?.dlg.open) { this._editor.unsubscribe(); this._editor.dlg.close(); }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    setLocale(hass);
    if (this._hdr && !this._hdr.isConnected) this._trackHaHeader();
    this._data = this._read(hass);
    if (this._shc?.isConnected) this._shc.hass = this._histHass(hass);
    if (!this._built) this._build();
    this._followTimeline();
    // an alert added or gone: ask again which ones were made here (and so can be edited)
    const idsSig = this._data.rows.map((r) => r.id).sort().join("|");
    if (idsSig !== this._idsSig) { this._idsSig = idsSig; this._loadUiIds(); }

    /* Something about an alert changed (fired, cleared, acked, snoozed): the timeline
       has new entries and the chart a new bar, so re-read both. Cheap — there are a
       handful of alerts and the recorder query is one call. */
    // (its priority too: an edit that only changes it moves its bars to the other colour)
    const stateSig = this._data.rows.map((r) =>
      `${r.id}:${r.state}:${r.cleared}:${r.nc}:${r.lastFired}:${r.pending}:${r.priority}`).join("|");
    const changed = stateSig !== this._stateSig;
    this._stateSig = stateSig;

    this._paint();
    this._scheduleExpiry();
    if (first || changed) {
      this._loadTimeline();
      this._loadOverview();
      if (this._open) this._refreshDetail();
    }
  }

  /* An event alert turns OK when its "Stays firing" runs out - a moment no state change
     marks - so the card wakes for it. */
  _scheduleExpiry() {
    clearTimeout(this._expT);
    const now = Date.now();
    const next = Math.min(...(this._data?.rows || [])
      .filter((r) => r.firing && Number.isFinite(r.firingUntil) && r.firingUntil > now).map((r) => r.firingUntil));
    if (!Number.isFinite(next)) return;
    this._expT = setTimeout(() => {
      if (!this._hass || !this.isConnected) return;
      this._data = this._read(this._hass);
      this._sig = "";
      this._paint();
      if (this._open) this._refreshDetail(true);
      this._scheduleExpiry();
    }, Math.min(next - now + 500, 2 ** 31 - 1));
  }

  // ------------------------------------------------------------------ data

  /* The alerts made in this card - kept by Alert2's UI store, so editable here - by entity
     id, with Alert2's uiId for loading and saving them. YAML alerts (the system ones) are
     not among them, and get no Edit button. */
  async _loadUiIds() {
    const seq = (this._uiSeq = (this._uiSeq || 0) + 1);
    let res;
    try { res = await this._hass.callApi("POST", "alert2/manageAlert", { search: { str: "" } }); } catch { return; }
    if (seq !== this._uiSeq) return;
    this._uiIds = new Map((res?.results || []).filter((r) => !r.failedToLoad).map((r) => [r.id, r.uiId]));
    // an open alert gains (or loses) its Edit button in place, its message left alone
    const eid = this._openAlertId();
    const row = eid && this._data.byId[eid];
    const bar = row && this._el?.tbody.querySelector(".detail:not(.closing) .btnrow");
    if (bar) bar.outerHTML = this._btnRowHtml(row);
  }

  _read(hass) {
    const now = Date.now();
    const rows = [];
    for (const [id, st] of Object.entries(hass.states)) {
      if (!id.startsWith("alert2.")) continue;
      const a = st.attributes || {};
      const isCond = "last_on_time" in a;
      const nc = a.notification_control || "enabled";
      let snoozeUntil = null;
      if (nc !== "enabled" && nc !== "disabled") {
        const t = Date.parse(nc);
        if (Number.isFinite(t) && t > now) snoozeUntil = t;
      }
      const lastFired = a.last_fired_time ? Date.parse(a.last_fired_time) : null;
      // Active: the condition holds, or an event alert fired in the last day. Cleared: an
      // ack where the rule allows clearing (Alert2's ack lasts until the next fire).
      // `firing` is "not OK" - Firing or Snoozed (statusOf).
      const allowClear = allowClearOf(a, isCond);
      const stay = stayMsOf(a);
      const active = isCond ? st.state === "on" : !!(lastFired && now - lastFired < stay);
      const cleared = allowClear && !!a.is_acked;
      const firing = active && !cleared;
      const sinceIso = isCond ? (st.state === "on" ? a.last_on_time : a.last_off_time) : a.last_fired_time;
      // when it last turned OK: a clear, at the clear (Alert2 forgets an ack when it fires again,
      // so an ack is always this firing's); an event alert, when its time as Firing ran out
      const lastAck = a.last_ack_time ? Date.parse(a.last_ack_time) : null;
      const okSince = firing ? null : cleared && lastAck ? lastAck
        : !isCond && lastFired && Number.isFinite(stay) ? lastFired + stay
        : sinceIso ? Date.parse(sinceIso) : null;
      rows.push({
        id,
        name: a.friendly_name || id,
        state: st.state,
        isCond,
        // The fork's `category`; else the domain - except Alert2's own built-in alerts, whose
        // domain "alert2" says who made them, not what they are about. They are about the system.
        category: a.category || (a.domain === "alert2" ? "system" : (a.domain || "—")),
        description: a.description || "",
        priority: prioKey(a.priority),
        allowClear,
        cleared,
        nc,
        snoozeUntil,
        notificationsOff: nc === "disabled",
        firing,
        pending: isCond && st.state === "off" && !!a.cond_true_time,
        since: sinceIso ? Date.parse(sinceIso) : null,
        okSince,
        lastFired,
        lastOn: a.last_on_time ? Date.parse(a.last_on_time) : null,
        message: a.last_fired_message ? unescapeHtml(a.last_fired_message) : "",
        link: a.link || null,
        linkMobile: a.link_mobile || null,
        // the dashboards that show its banner while it fires (url_paths)
        overlay: Array.isArray(a.overlay) ? a.overlay : [],
        hasDisplayMsg: !!a.has_display_msg,
        // an event alert: when its time as Firing runs out (no state change marks that moment)
        firingUntil: !isCond && lastFired ? lastFired + stay : null,
      });
    }
    return { rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])) };
  }

  /* History rows: every timeline entry of every alert, newest first. */
  _historyRows() {
    const out = [];
    for (const [eid, entries] of Object.entries(this._timeline || {})) {
      const row = this._data.byId[eid];
      // a deleted rule: the name it had (its life entries carry it)
      const was = [...entries].reverse().find((e) => e.name)?.name;
      entries.forEach((e, i) => {
        const t = Date.parse(e.t);
        const ev = eventOf(e, row);
        out.push({
          id: `${eid}|${e.t}|${e.kind}|${i}`,
          eid, t, e, ev,
          name: row ? row.name : was || eid,
          category: row ? row.category : "—",
          priority: row ? row.priority : "low",
          detail: eventDetail(e),
        });
      });
    }
    // Home Assistant's restarts, once each
    for (const r of this._restarts || []) {
      const e = { t: r.started, kind: "restart", stopped: r.stopped };
      out.push({ id: `restart|${r.started}|restart|0`, eid: null, t: Date.parse(r.started), e, ev: eventOf(e),
                 name: "Home Assistant", category: "system", priority: "low", detail: eventDetail(e) });
    }
    return out;
  }

  /* The tab's rows before any filter. */
  _baseRows() {
    if (this._view === "history") return this._historyRows();
    if (this._view === "active") return this._data.rows.filter((r) => statusOf(r).text !== "OK");
    return this._data.rows;
  }

  _visible() {
    const q = this._q.toLowerCase();
    const { col, dir } = this._sort;

    if (this._view === "history") {
      let out = this._baseRows();
      if (this._prios.size) out = out.filter((r) => this._prios.has(prioOf(r.priority).label));
      if (this._cats.size) out = out.filter((r) => this._cats.has(r.category));
      if (this._events.size) out = out.filter((r) => this._events.has(r.ev.text));
      if (q) out = out.filter((r) =>
        r.name.toLowerCase().includes(q) || r.eid.includes(q) || r.detail.toLowerCase().includes(q));
      const key = (r) => {
        switch (col) {
          case "name": return r.name.toLowerCase();
          case "event": return r.ev.text;
          case "detail": return r.detail.toLowerCase();
          default: return -r.t;   // when: newest first
        }
      };
      return sortBy(out, key, dir, (r) => -r.t);
    }

    let out = this._baseRows();
    if (this._prios.size) out = out.filter((r) => this._prios.has(prioOf(r.priority).label));
    if (this._cats.size) out = out.filter((r) => this._cats.has(r.category));
    if (this._statuses.size) out = out.filter((r) => this._statuses.has(statusOf(r).text));
    // A bar picked in the chart: exactly the alerts behind it.
    if (this._pinned) out = out.filter((r) => this._pinned.rows.has(r.id));
    if (q) out = out.filter((r) =>
      r.name.toLowerCase().includes(q) || r.id.includes(q) || r.message.toLowerCase().includes(q));
    // Unacknowledged firing first, then by priority, then the rest.
    const sev = (r) => {
      const s = statusOf(r).text;
      const base = s === "Firing" ? 0 : s === "Snoozed" ? 10 : 30;
      return base + prioOf(r.priority).rank;
    };
    const key = (r) => {
      switch (col) {
        case "status": return sev(r);
        case "priority": return prioOf(r.priority).rank;
        case "category": return r.category;
        case "since": return r.since ? -r.since : Infinity;
        case "lastFired": return r.lastFired ? -r.lastFired : Infinity;
        default: return r.name.toLowerCase();
      }
    };
    return sortBy(out, key, dir, (r) => r.name);
  }

  // --------------------------------------------------------------- history

  async _ws(msg) { try { return await this._hass.callWS(msg); } catch { return null; } }

  _window() {
    const hours = RANGES.find((r) => r.id === this._range).hours;
    const end = new Date();
    return { start: new Date(end.getTime() - hours * 3600e3), end, hours };
  }

  async _loadTimeline() {
    const res = await this._ws({ type: "alert2/hm/timeline" });
    this._timeline = res?.alerts || {};
    Object.values(this._timeline).forEach(markResolved);
    this._restarts = res?.restarts || [];
    this._tlLoaded = true;
    this._paint();
    // the open alert's timeline too: it was drawn before this read came back
    this._paintOpenTimeline();
  }

  /* The fork pushes each timeline entry once it is recorded (alert2/hm/timeline/subscribe).
     A snooze changes no on/off state, and every entry lands a moment after the state change
     it belongs to (the fork looks up who did it first) - re-reading the log on a state change
     alone missed it until the page was reloaded. */
  _followTimeline() {
    if (this._tlSub || this._tlSubFailed || !this._hass?.connection || !this.isConnected) return;
    this._tlSub = this._hass.connection.subscribeMessage((m) => this._onTimeline(m), { type: "alert2/hm/timeline/subscribe" })
      // a fork without the command: the state-change re-read is all there is
      .catch(() => { this._tlSub = null; this._tlSubFailed = true; return null; });
  }

  _unfollowTimeline() {
    const sub = this._tlSub;
    this._tlSub = null;
    sub?.then((unsub) => unsub?.()).catch(() => {});
  }

  /* {entity_id, entry}: one new entry. {entity_id, entries}: the alert's whole log (filled in
     when it was created, emptied when its rule was deleted). */
  _onTimeline(m) {
    // a restart logged: every timeline and history band shows it
    if (Array.isArray(m?.restarts)) {
      this._restarts = m.restarts;
      this._paint();
      if (this._open) this._refreshDetail(true);
      return;
    }
    const eid = m?.entity_id;
    if (!eid) return;
    if (Array.isArray(m.entries)) {
      if (m.entries.length) this._timeline[eid] = m.entries;
      else delete this._timeline[eid];
    } else if (m.entry) {
      const log = (this._timeline[eid] ||= []);
      // a full re-read may have brought it already
      if (log.some((x) => x.t === m.entry.t && x.kind === m.entry.kind)) return;
      log.push(m.entry);
    } else return;
    if (this._timeline[eid]) markResolved(this._timeline[eid]);
    this._paint();
    // a whole new log (an edit started it over): its history band starts over too
    if (m.entries && this._openAlertId() === eid) { this._refreshDetail(true); return; }
    this._paintOpenTimeline(eid, !!m.entry);
  }

  /* The open alert's timeline, redrawn in place - nothing else in its panel touched. A new
     entry (`fresh`) slides in at the top when the first page is showing. */
  _paintOpenTimeline(eid = null, fresh = false) {
    const id = this._openAlertId();
    if (!id || (eid && eid !== id)) return;
    const detail = this._el?.tbody.querySelector(".detail:not(.closing)");
    const host = detail?.querySelector(".dtl");
    if (!host) return;
    const h = detail.offsetHeight;
    host.innerHTML = this._timelineHtml(id, this._data.byId[id] || null);
    if (fresh && !reduceMotion() && !(this._tlPage?.[id] > 0)) {
      host.querySelector(".log li")?.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }],
        { duration: 380, easing: IOS });
    }
    this._resizeDetail(detail, h);
  }

  async _loadOverview() {
    const { start, end } = this._window();
    const ids = this._data.rows.map((r) => r.id);
    // From the first (clock-aligned) slot's start, so that bar is drawn from whole data.
    const from = new Date(Math.min(start.getTime(), this._slotsFor(start, end)[0].a));
    // with their attributes: whether a firing alert was cleared is one of them (a few
    // alerts with a few changes a day - the rows stay small)
    const res = ids.length ? await this._ws({
      type: "history/history_during_period",
      start_time: from.toISOString(), end_time: end.toISOString(),
      entity_ids: ids, minimal_response: false, no_attributes: false,
      significant_changes_only: false,
    }) : {};
    this._overview = { res: res || {}, start, end, from };
    this._drawOverview();
  }

  // ----------------------------------------------------------------- build

  /* The phone layout: AlertPhoneView draws it; this card keeps the data, the chart model,
     the actions - and the rule editor, whose dialogs (and their help pop-ups) live here. */
  _buildPhone() {
    this.shadowRoot.innerHTML = `<style>${STYLES}:host{display:block}</style>
      <alert-phone-view></alert-phone-view>
      <dialog class="idlg" id="idlg" aria-label="About this alert"><div class="iscrim"></div><div class="ipop"></div></dialog>
      <dialog class="red" id="red" aria-label="New alert">
        <div class="red-scrim"></div>
        <div class="red-wrap"><div class="red-sheet" tabindex="-1"></div></div>
      </dialog>`;
    this._built = true;
    // the editor and the help pop-up: a drag in them never scrolls the page behind (holdPage)
    this.shadowRoot.querySelectorAll("dialog").forEach(holdPage);
    this._wireInfo();
    this._editor = new RuleEditor(this, this.shadowRoot.getElementById("red"));
    this._phView = this.shadowRoot.querySelector("alert-phone-view");
    this._phView.card = this;
  }

  _build() {
    if (this._phone) { this._buildPhone(); return; }
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card class="${this._config.embedded ? "embedded" : ""}">
        <header class="top">
          <span class="h1 t-title">${escapeHtml(this._config.title)}</span>
          <button class="newbtn" id="newAlert" title="New alert">
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>New alert</span></button>
        </header>
        <dialog class="idlg" id="idlg" aria-label="About this alert">
          <div class="iscrim"></div><div class="ipop"></div>
        </dialog>
        <dialog class="snz" id="snz" aria-label="Snooze">
          <div class="snzscrim" id="snzScrim"></div>
          <div class="snzpanel" id="snzPanel" tabindex="-1">
            <div class="sgrp" id="snzMenu">
              <div class="shead"><div class="stitle">Snooze notifications for:</div></div>
              <div id="snzRows"></div>
              <button class="srow scustom" id="snzCustom"><span>Custom</span><span class="sval"></span>
                <svg class="schev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
            </div>
            <div class="sgrp scust" id="snzCust" hidden>
                <input class="stext" id="snzText" type="text" autocomplete="off" spellcheck="false"
                       enterkeyhint="done" placeholder="Type a length: 90m, 3h, 2d, 1w" aria-label="Snooze length">
                <div class="scal" id="snzCal"></div>
                <div class="stime"><span>Time</span><button class="tchip" id="snzTimeChip" aria-expanded="false"><span class="tcin"></span></button></div>
                <div class="sdrum" id="snzDrum" hidden></div>
                <div class="sprev" id="snzPreview"></div>
                <button class="sgo" id="snzGo" disabled>Snooze</button>
            </div>
            <button class="sgrp scancel" id="snzCancel">Cancel</button>
          </div>
        </dialog>
        <dialog class="red" id="red" aria-label="New alert">
          <div class="red-scrim"></div>
          <div class="red-wrap"><div class="red-sheet" tabindex="-1"></div></div>
        </dialog>

        <section class="status">
          <div class="ptitle"><span class="phead">Current status</span></div>
          <div class="tiles" id="tiles">
            ${STATS.map((s) => `
              <button class="tile" data-stat="${s.id}">
                <span class="tval num">
                  <span class="tbig" id="t_${s.id}">0</span>
                  <span class="tden" id="d_${s.id}"></span>
                </span>
                <span class="tlab" id="s_${s.id}"></span>
              </button>`).join("")}
          </div>
        </section>

        <section class="panel">
          <div class="ptitle">
            <span class="phead">Firing over time</span>
            <span class="legend" id="legend">
              ${PRIO_IDS.map((p, k) => `<button class="lg on" data-s="${k}"><i style="--c:${PRIO[p].tone}"></i>${PRIO[p].label}</button>`).join("")}
            </span>
            <span class="cfold" id="cfold"></span>
            <div class="ranges" id="ranges">
              ${RANGES.map((r) => `<button class="rg${r.id === this._range ? " on" : ""}" data-r="${r.id}">${r.label}</button>`).join("")}
            </div>
          </div>
          <div class="chartwrap" id="overview">
            <div class="chartsvg" id="chartsvg"></div>
            <div class="ctip" id="ctip" hidden></div>
          </div>
        </section>

        <div class="stickyhead" id="stickyhead">
          <nav class="views" id="views">
            ${VIEWS.map((v) => `<button class="vw${v.id === this._view ? " on" : ""}" data-v="${v.id}">${v.label}</button>`).join("")}
          </nav>
          <div class="filters">
            <label class="search">
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
              <input id="q" type="search" placeholder="Search alerts…" autocomplete="off">
            </label>
            <div class="ms" id="msSp">
              <button class="msbtn"><span class="mslabel"></span>
                <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
              <div class="mspanel"></div>
            </div>
            <div class="ms" id="msCat">
              <button class="msbtn"><span class="mslabel"></span>
                <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
              <div class="mspanel"></div>
            </div>
            <button class="pin" id="pin" hidden></button>
            <button class="clear" id="clear">Reset</button>
          </div>
        </div>

        <div class="tablewrap">
          <div class="thead" id="thead"></div>
          <div class="tbody" id="tbody"></div>
        </div>
        <div class="pager" id="pager">
          <button class="pg" id="pgPrev" aria-label="Previous page">
            <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
          <span class="pgtext" id="pgText"></span>
          <button class="pg" id="pgNext" aria-label="Next page">
            <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
        </div>
        <div class="tfoot" id="tfoot"></div>
      </ha-card>`;

    const $ = (id) => this.shadowRoot.getElementById(id);
    this._el = {
      ranges: $("ranges"), legend: $("legend"), overview: $("overview"), views: $("views"),
      chartsvg: $("chartsvg"), ctip: $("ctip"), pin: $("pin"), cfold: $("cfold"),
      q: $("q"), msSp: $("msSp"), msCat: $("msCat"), clear: $("clear"),
      thead: $("thead"), tbody: $("tbody"), tfoot: $("tfoot"),
      pager: $("pager"), pgPrev: $("pgPrev"), pgNext: $("pgNext"), pgText: $("pgText"),
    };
    this._wireSnooze();
    this._wireInfo();
    this._editor = new RuleEditor(this, $("red"));
    $("newAlert").addEventListener("click", () => this.newAlert());
    for (const s of STATS) {
      this._el[`t_${s.id}`] = $(`t_${s.id}`);
      this._el[`d_${s.id}`] = $(`d_${s.id}`);
      this._el[`s_${s.id}`] = $(`s_${s.id}`);
    }

    /* A tile lands on exactly what it counts - its tab, status and priority, in the
       filter menu for all to see - with every other filter cleared. At zero too: three
       tiles share the Active tab, so an unfiltered tab would show the other tiles' rows. */
    $("tiles").addEventListener("click", (e) => {
      const t = e.target.closest(".tile");
      if (!t) return;
      this._clearFilters();
      const s = STATS.find((x) => x.id === t.dataset.stat);
      this._setView(s.view);
      for (const x of s.statuses || []) this._statuses.add(x);
      for (const x of s.prios || []) this._prios.add(x);
      this._paintFilters();
      this._paintTable();
      this._scrollToTable();
    });

    this._el.legend.addEventListener("click", (e) => {
      const b = e.target.closest(".lg");
      if (!b) return;
      const k = Number(b.dataset.s);
      if (this._series.has(k) && this._series.size === 1) return;
      this._series.has(k) ? this._series.delete(k) : this._series.add(k);
      b.classList.toggle("on", this._series.has(k));
      this._drawOverview();
    });

    this._el.ranges.addEventListener("click", (e) => {
      const b = e.target.closest(".rg"); if (!b) return;
      this._range = b.dataset.r;
      this.shadowRoot.querySelectorAll(".rg").forEach((x) => x.classList.toggle("on", x === b));
      this._loadOverview();
      if (this._open) this._refreshDetail(true);
    });

    this._el.views.addEventListener("click", (e) => {
      const b = e.target.closest(".vw"); if (!b) return;
      this._pinned = null;     // a chart pick belongs to the tab it opened
      this._setView(b.dataset.v);
      this._paint();
    });

    // The chart: hover or a sideways finger drag names the alerts behind each bar;
    // a tap (pointer up within 10px of where it went down) shows them in the table.
    const chart = this._el.overview;
    chart.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" || this._press) this._hoverChart(e);
    });
    chart.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") this._hideTip(); });
    chart.addEventListener("pointerdown", (e) => {
      this._press = { x: e.clientX, y: e.clientY };
      this._hoverChart(e);
    });
    chart.addEventListener("pointerup", (e) => {
      const p = this._press;
      this._press = null;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 10) this._pickChart(e);
      else if (e.pointerType !== "mouse") this._hideTip();
    });
    chart.addEventListener("pointercancel", () => { this._press = null; this._hideTip(); });
    this._el.pin.addEventListener("click", () => {
      this._pinned = null; this._sig = ""; this._paintFilters(); this._paintTable();
    });

    this._el.q.addEventListener("input", () => {
      this._q = this._el.q.value.trim(); this._sig = ""; this._paintTable();
    });

    for (const [host, which] of [[this._el.msSp, "sp"], [this._el.msCat, "cat"]]) {
      host.querySelector(".msbtn").addEventListener("click", (e) => {
        e.stopPropagation();
        const open = host.classList.contains("open");
        this._closeMenus();
        if (!open) host.classList.add("open");
      });
      host.querySelector(".mspanel").addEventListener("click", (e) => {
        e.stopPropagation();
        const opt = e.target.closest(".msopt");
        const act = e.target.closest(".msact");
        if (act) {
          for (const g of this._menu(which).groups) {
            const set = this._setOf(g.key);
            if (act.dataset.a === "none") set.clear();
            else for (const x of g.values) set.add(x.v);
          }
        } else if (opt) {
          const set = this._setOf(opt.dataset.g);
          const v = opt.dataset.v;
          set.has(v) ? set.delete(v) : set.add(v);
        } else return;
        // In place, never innerHTML: re-rendering detaches the element under the finger.
        this._syncMenu(host, which);
        this._sig = "";
        this._paintTable();
      });
    }

    this._el.pgPrev.addEventListener("click", () => this._goPage(this._page - 1));
    this._el.pgNext.addEventListener("click", () => this._goPage(this._page + 1));

    this._el.clear.addEventListener("click", () => {
      this._clearFilters();
      this._closeMenus(); this._paintFilters(); this._paintTable();
    });

    this._el.tbody.addEventListener("keydown", (e) => {
      const ev = (e.key === "Enter" || e.key === " ") && e.target.closest?.("[data-evk]");
      if (ev) { e.preventDefault(); this._showEvent(ev); }
    });
    this._el.tbody.addEventListener("click", (e) => {
      const tlb = e.target.closest("[data-tl]");
      if (tlb) { e.stopPropagation(); this._pageTimeline(tlb); return; }
      const mpb = e.target.closest("[data-mp]");
      if (mpb) { e.stopPropagation(); this._pageMsg(mpb); return; }
      const goa = e.target.closest("[data-goalert]");
      if (goa) { e.stopPropagation(); this._showAlert(goa.dataset.goalert); return; }
      const info = e.target.closest("[data-info]");
      if (info) { e.stopPropagation(); this._toggleInfo(info); return; }
      const ev = e.target.closest("[data-evk]");
      if (ev) { e.stopPropagation(); this._showEvent(ev); return; }
      const act = e.target.closest("[data-act]");
      if (act) { e.stopPropagation(); this._action(act.dataset.act, act.dataset.eid, act.dataset.arg, act); return; }
      const nav = e.target.closest("[data-nav]");
      if (nav) { e.stopPropagation(); this._navigate(nav.dataset.nav); return; }
      const tag = e.target.closest(".tag[data-f]");
      if (tag) { e.stopPropagation(); this._toggleFilter(tag.dataset.f, tag.dataset.v); return; }
      if (e.target.closest(".detail")) return;
      const tr = e.target.closest(".tr");
      if (tr) this._toggle(tr.dataset.id);
    });

    this._built = true;
    this._observe();
  }

  /* Size watchers: the chart, the sticky filter bar and the filter labels. Dropped while
     the card is off screen (HA keeps a left view's cards), so set up again on return. */
  _observe() {
    if (!this._built || !this.isConnected || this._phone) return;
    this._ro?.disconnect();
    this._ro = new ResizeObserver(() => this._drawOverview());
    this._ro.observe(this._el.overview);

    const head = this.shadowRoot.getElementById("stickyhead");
    this._headRo?.disconnect();
    this._headRo = new ResizeObserver(() => {
      this.shadowRoot.host.style.setProperty("--sticky-h", `${head.offsetHeight}px`);
    });
    this._headRo.observe(head);

    this._labRo?.disconnect();
    this._labRo = new ResizeObserver((es) => es.forEach((x) => fitPills(x.target)));
    for (const host of [this._el.msSp, this._el.msCat]) this._labRo.observe(host.querySelector(".mslabel"));
  }

  /* After the rule editor adds an alert: All Alerts, unfiltered, with the new one open. */
  _showAlert(eid) {
    if (this._phone) { this._phView?.showAlert(eid); return; }
    this._clearFilters();
    this._setView("all");
    this._paint();
    requestAnimationFrame(() => {
      const tr = this._el.tbody.querySelector(`.tr[data-id="${CSS.escape(eid)}"]`);
      if (!tr) return;
      if (this._open !== eid) this._toggle(eid);
      tr.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
    });
  }

  /* After the editor saves a change: the alert stays where it was, open, showing the change.
     (Unless the change moved it out of what the filters show: then as a new one.) */
  _showEdited(eid) {
    if (this._phone) { this._paint(); this._phView?.showAlert(eid); return; }
    this._paint();
    requestAnimationFrame(() => {
      const tr = this._el.tbody.querySelector(`.tr[data-id="${CSS.escape(eid)}"]`);
      if (!tr) { this._showAlert(eid); return; }
      if (this._openAlertId() !== eid) this._toggle(eid);
      else this._refreshDetail(true);
    });
  }

  /* After the editor deletes an alert: its row has left (or is leaving) the table. */
  _afterDelete(eid) {
    if (this._phone) { this._phView?.afterDelete(eid); return; }
    if (this._openAlertId() === eid) { this._open = null; this._shc = null; }
    this._sig = "";
    this._paint();
  }

  _clearFilters() {
    this._q = ""; if (this._el) this._el.q.value = "";
    this._prios.clear(); this._cats.clear(); this._statuses.clear(); this._events.clear();
    this._pinned = null;
    this._sig = "";
  }

  _setOf(key) {
    return { prio: this._prios, cat: this._cats, status: this._statuses, event: this._events }[key];
  }

  /* A filter menu, for the tab on show: its sections, each with its values, their colour
     and how many of the tab's rows have each. "sp" is Status (Event in History) and
     Priority; "cat" is Category. */
  _menu(which) {
    const base = this._baseRows();
    const hist = this._view === "history";
    const count = (fn) => {
      const n = {};
      for (const r of base) { const k = fn(r); n[k] = (n[k] || 0) + 1; }
      return n;
    };
    if (which === "cat") {
      const n = count((r) => r.category);
      const cats = [...new Set(this._data.rows.map((r) => r.category))].sort((a, b) => a.localeCompare(b));
      return { empty: "All categories", groups: [{ key: "cat", values: cats.map((v) => ({ v, n: n[v] || 0 })) }] };
    }
    let first;
    if (hist) {
      const n = count((r) => r.ev.text);
      const tone = {};
      for (const r of base) tone[r.ev.text] = r.ev.tone;
      const rank = (v) => (EVENT_ORDER.indexOf(v) + 1) || 99;
      first = { key: "event", title: "Event", values: Object.keys(n)
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
        .map((v) => ({ v, tone: tone[v], n: n[v] })) };
    } else {
      const n = count((r) => statusOf(r).text);
      const names = this._view === "active" ? ["Firing", "Snoozed"] : ["Firing", "Snoozed", "OK"];
      first = { key: "status", title: "Status", values: names.map((v) => ({ v, tone: STATUS_TONE[v], n: n[v] || 0 })) };
    }
    const n = count((r) => prioOf(r.priority).label);
    return {
      empty: hist ? "All events & priorities" : "All statuses & priorities",
      groups: [first, { key: "prio", title: "Priority",
        values: PRIO_IDS.map((p) => ({ v: PRIO[p].label, tone: PRIO[p].tone, n: n[PRIO[p].label] || 0 })) }],
    };
  }

  /* Paint a filter menu: its options (rebuilt only when they change - re-rendering an open
     menu detaches the element under the finger; otherwise ticks and counts in place) and
     its button, which names what is picked. */
  _syncMenu(host, which) {
    const spec = this._menu(which);
    const panel = host.querySelector(".mspanel");
    const shape = spec.groups.map((g) => g.key + ":" + g.values.map((x) => x.v).join("|")).join("::");
    if (panel._shape !== shape) {
      panel._shape = shape;
      panel.innerHTML =
        `<div class="msacts">
           <button class="msact" data-a="all">Select all</button>
           <button class="msact" data-a="none">Clear</button>
         </div>` +
        spec.groups.map((g) => (g.title ? `<div class="msgh t-label">${g.title}</div>` : "") +
          g.values.map((x) => `<button class="msopt" data-g="${g.key}" data-v="${escapeHtml(x.v)}">
              <span class="box"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></span>
              ${x.tone ? `<span class="msdot" style="--c:${x.tone}"></span>` : ""}
              <span class="msname">${escapeHtml(x.v)}</span>
              <span class="mscount"></span></button>`).join("")).join("");
    }
    const opts = panel.querySelectorAll(".msopt");
    let i = 0;
    for (const g of spec.groups) {
      const set = this._setOf(g.key);
      for (const x of g.values) {
        const o = opts[i++];
        o.classList.toggle("on", set.has(x.v));
        const c = o.querySelector(".mscount");
        if (c.textContent !== String(x.n)) c.textContent = x.n;
      }
    }
    paintPicked(host, spec, (k) => this._setOf(k));
  }

  _toggleFilter(which, value) {
    const set = this._setOf(which);
    if (!set) return;
    set.has(value) ? set.delete(value) : set.add(value);
    this._sig = "";
    this._paintFilters();
    this._paintTable();
  }

  _scrollToTable() {
    const thead = this.shadowRoot.querySelector(".thead");
    const body = this.shadowRoot.querySelector(".tbody");
    if (!thead || !body) return;
    const scroller = document.scrollingElement || document.documentElement;
    const pinnedTo = (parseFloat(getComputedStyle(thead).top) || 0) + thead.offsetHeight;
    const top = scroller.scrollTop + body.getBoundingClientRect().top - pinnedTo - 12;
    scroller.scrollTo({ top: Math.max(0, top), behavior: reduceMotion() ? "auto" : "smooth" });
  }

  /* Pin line under HA's own toolbar, MEASURED (kiosk-mode hides the toolbar but leaves
     --header-height at 56px). Same as the Health card. */
  _trackHaHeader() {
    if (this._phone) return;
    let hdr = null;
    for (let n = this, i = 0; n && i < 40; i++) {
      const host = n.getRootNode()?.host;
      if (!host) break;
      if (host.localName === "hui-root") { hdr = host.shadowRoot?.querySelector(".header"); break; }
      n = host;
    }
    this._hdrRo?.disconnect();
    this._hdr = hdr;
    if (!hdr) { this.style.removeProperty("--hm-top"); return; }
    const measure = () => {
      const r = hdr.getBoundingClientRect();
      const shown = r.height > 0 && getComputedStyle(hdr).display !== "none";
      this.style.setProperty("--hm-top", `${shown ? Math.max(0, Math.round(r.bottom)) : 0}px`);
    };
    this._hdrRo = new ResizeObserver(measure);
    this._hdrRo.observe(hdr, { box: "border-box" });
    measure();
  }

  _goPage(n) {
    const total = Math.max(1, Math.ceil(this._matching / this._pageSize));
    const next = Math.min(Math.max(0, n), total - 1);
    if (next === this._page) return;
    this._page = next;
    this._open = null;
    this._sig = "";
    this._paintTable();
    this._scrollToTable();
  }

  _setView(view) {
    // Status words belong to the alert tabs, event words to History: never carry them across.
    if (view !== this._view) { this._statuses.clear(); this._events.clear(); }
    this._view = view;
    this.shadowRoot.querySelectorAll(".vw").forEach((x) => x.classList.toggle("on", x.dataset.v === view));
    this._sort = view === "history" ? { col: "when", dir: "asc" } : { col: "status", dir: "asc" };
    this._el.q.placeholder = view === "history" ? "Search history…" : "Search alerts…";
    this._open = null;
    this._sig = "";
  }

  _closeMenus() {
    this.shadowRoot?.querySelectorAll(".ms.open").forEach((m) => m.classList.remove("open"));
  }

  /* (i) next to an alert's name: its entity id and description, beside the icon, without
     opening the row. A modal <dialog> like the snooze sheet: the page dims and stays
     still; a tap outside, the icon again, or Escape closes it. */
  _wireInfo() {
    const dlg = this.shadowRoot.getElementById("idlg");
    this._info = { dlg, pop: dlg.querySelector(".ipop"), scrim: dlg.querySelector(".iscrim"), btn: null };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); this._hideInfo(); });
    this._info.scrim.addEventListener("click", () => this._hideInfo());
    // a long event message scrolls inside the popup, never the page behind
    containScroll(dlg, [this._info.pop]);
  }

  _toggleInfo(btn) {
    if (this._info.dlg.open) { this._hideInfo(); return; }
    const eid = btn.dataset.info;
    const row = this._data.byId[eid];
    this._popAt(btn, `<div class="ipk">Entity</div><div class="ipid">${escapeHtml(eid)}</div>` +
      (row?.description ? `<div class="ipk">Description</div><div class="ipd">${escapeHtml(row.description)}</div>` : ""));
  }

  /* A timeline row's whole event - what the row cuts to one line - in the same popup. */
  _showEvent(li) {
    if (this._info.dlg.open) { this._hideInfo(); return; }
    const eid = li.dataset.ev;
    const e = this._entriesOf(eid).find((x) => `${x.t}|${x.kind}` === li.dataset.evk);
    if (!e) return;
    const row = this._data.byId[eid];
    this._popAt(li, this._eventHtml(e, row, eid), true);
  }

  /* An event, whole: what happened and when, then each field it has. */
  _eventHtml(e, row, eid, name = null) {
    const ev = eventOf(e, row);
    const field = (k, v, cls = "ipd") => v ? `<div class="ipk">${k}</div><div class="${cls}">${escapeHtml(v)}</div>` : "";
    const until = e.snooze_until && Date.parse(e.snooze_until) > Date.parse(e.t) + 5000 ? fmtDT(Date.parse(e.snooze_until)) : "";
    return `<div class="ipev"><span class="logdot" style="--c:${ev.tone}"></span><b>${escapeHtml(ev.text)}</b>
        <span class="ipwhen">${escapeHtml(fmtDT(Date.parse(e.t)))}</span></div>` +
      field("Alert", name || row?.name || e.name || eid) +
      // Detected / Cleared early: what made the condition true (the alert never said it)
      field(e.kind === "detected" || e.kind === "detect_cleared" ? "What" : "Message",
            e.message ? unescapeHtml(e.message) : "", "ipd ipmsg") +
      field("About", e.about?.length ? e.about.join("\n") : "", "ipd ipmsg") +
      field("Added", e.added?.length ? e.added.join("\n") : "", "ipd ipmsg") +
      field("Removed", e.removed?.length ? e.removed.join("\n") : "", "ipd ipmsg") +
      field("By", e.user) +
      field("Notified", e.notifiers?.length ? notifiedText(e) : "") +
      field("Snoozed until", until) +
      field("Waiting", e.delay_secs ? fmtDur(e.delay_secs * 1000) : "") +
      field("Error", e.error, "ipd ipmsg") +
      field("Down for", e.kind === "restart" && e.stopped ? fmtDur(Date.parse(e.t) - Date.parse(e.stopped)) : "");
  }

  /* The History tab's expanded row: the event, whole - not the alert's status - and the way
     to the alert itself. */
  _historyDetailHtml(r) {
    const row = r.eid ? this._data.byId[r.eid] : null;
    const go = row
      ? `<button class="navbtn primary" data-goalert="${escapeHtml(r.eid)}">Open alert</button>`
      : r.eid ? `<span class="muted">This alert rule no longer exists.</span>` : "";
    return `<div class="hevent">${this._eventHtml(r.e, row, r.eid, r.eid ? r.name : "")}</div>
      ${go ? `<div class="hbtnrow">${go}</div>` : ""}`;
  }

  /* The popup, beside what opened it (ringed while it is open): under it, or above it when
     the screen ends first. `wide`: an event's popup takes the full width it may have, so a
     long message wraps in lines worth reading. */
  _popAt(btn, html, wide = false) {
    const { dlg, pop, scrim } = this._info;
    pop.innerHTML = html;
    pop.classList.toggle("wide", wide === true);
    pop.classList.toggle("xwide", wide === "x");
    pop.scrollTop = 0;
    this._info.btn = btn;
    btn.classList.add("on");
    dlg.showModal();
    const b = btn.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.max(8, Math.min(b.left - 12, innerWidth - w - 8));
    // under the icon, or above it when the screen ends first
    let top = b.bottom + 6, above = false;
    if (top + h > innerHeight - 8) {
      if (b.top - 6 - h >= 8) { top = b.top - 6 - h; above = true; } else top = Math.max(8, innerHeight - 8 - h);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    if (reduceMotion()) return;
    pop.style.transformOrigin = `${Math.max(0, Math.min(w, b.left + b.width / 2 - left))}px ${above ? h : 0}px`;
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
    pop.animate([{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: IOS_SOFT });
  }

  async _hideInfo() {
    const i = this._info;
    if (!i?.dlg.open || i.closing) return;
    i.closing = true;
    i.btn?.classList.remove("on");
    if (!reduceMotion()) {
      i.scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "forwards" });
      await i.pop.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.94)" }],
        { duration: 160, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
      i.pop.getAnimations().forEach((a) => a.cancel());
      i.scrim.getAnimations().forEach((a) => a.cancel());
    }
    i.dlg.close();
    i.closing = false;
  }

  // ----------------------------------------------------------------- snooze

  /* The snooze sheet, iOS style: a popover beside the Snooze button on a wide screen, an
     action sheet from the bottom on a phone. Ready-made lengths snooze at one tap;
     Custom opens a field to type a length ("90m", "3h", "2d", "1w") and a calendar with
     a time for an exact moment. It is a modal <dialog>, so it sits above everything -
     the sticky header, HA's toolbar - whatever the dashboard's layout. */
  _wireSnooze() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const el = this._snzEl = {
      dlg: $("snz"), panel: $("snzPanel"), scrim: $("snzScrim"), rows: $("snzRows"),
      menu: $("snzMenu"),
      customBtn: $("snzCustom"), cust: $("snzCust"), text: $("snzText"), cal: $("snzCal"),
      chip: $("snzTimeChip"), drum: $("snzDrum"), preview: $("snzPreview"), go: $("snzGo"),
      cancel: $("snzCancel"),
    };
    // Custom: the picker the phone's sheet has too; the popover makes room for its drum
    this._picker = new SnoozePicker(el, {
      go: (t) => this._snoozeDone(() => this._action("snooze", this._snz.eid, String(t))),
      value: (v) => swapText(el.customBtn.querySelector(".sval"), el.cust.hidden ? "" : v),
      drum: (open, h) => { if (!this._narrow()) this._placeSnooze(false, h); },
      scroller: () => (this._narrow() ? el.panel : el.cust),
    });
    containScroll(el.dlg, [el.cust, el.panel]);
    el.dlg.addEventListener("cancel", (e) => { e.preventDefault(); this._closeSnooze(); });
    el.scrim.addEventListener("click", () => this._closeSnooze());
    el.cancel.addEventListener("click", () => this._closeSnooze());
    el.rows.addEventListener("click", (e) => {
      const r = e.target.closest(".srow");
      if (!r) return;
      if (r.dataset.end) this._snoozeDone(() => this._action("enable", this._snz.eid));
      else this._snoozeDone(() => this._action("snooze", this._snz.eid, r.dataset.t));
    });
    el.customBtn.addEventListener("click", () => this._toggleCustom());
  }

  _openSnooze(eid, anchor) {
    const el = this._snzEl;
    const row = this._data.byId[eid];
    if (!el || !row || el.dlg.open) return;
    const now = Date.now();
    this._snz = { eid, anchor };
    el.rows.innerHTML =
      (row.snoozeUntil ? `<button class="srow end" data-end="1"><span>End Snooze</span>
          <span class="sval">until ${escapeHtml(fmtUntil(row.snoozeUntil))}</span></button>` : "") +
      snoozePresets(now).map((p) => `<button class="srow" data-t="${p.t}">
          <span>${p.label}</span><span class="sval">${escapeHtml(fmtUntil(p.t))}</span></button>`).join("");
    el.cust.hidden = true;
    el.cust.style.height = "";
    el.customBtn.classList.remove("open");
    this._picker.reset();
    el.dlg.showModal();
    el.panel.focus({ preventScroll: true });
    this._placeSnooze(true);
  }

  _narrow() { return !!this._mq?.matches; }

  /* Wide: beside the button, below it or above when there is no room, the panel growing
     out of the button; Custom opens to the right of the list. Narrow: an action sheet
     along the bottom, Custom under the list. `extra`: height about to be added by an
     opening animation, not laid out yet. Moves after opening glide. */
  _placeSnooze(opening, extra = 0) {
    const el = this._snzEl;
    const p = el.panel;
    const narrow = this._narrow();
    el.dlg.classList.toggle("narrow", narrow);
    let origin = "50% 100%";
    if (!narrow) {
      const b = this._snz.anchor?.isConnected ? this._snz.anchor.getBoundingClientRect()
                                              : { left: innerWidth / 2 - 190, top: innerHeight / 3, bottom: innerHeight / 3, width: 0 };
      // the list goes by the button; Custom, beside it, moves up only as far as it must
      const w = p.offsetWidth, h = el.menu.offsetHeight;
      const left = Math.max(8, Math.min(b.left, innerWidth - w - 8));
      let top = b.bottom + 8, above = false;
      if (top + h > innerHeight - 8) {
        if (b.top - 8 - h >= 8) { top = b.top - 8 - h; above = true; }
        else top = Math.max(8, innerHeight - 8 - h);
      }
      if (!el.cust.hidden) {
        const ch = Math.min(el.cust.scrollHeight + extra, innerHeight - 16);
        el.cust.style.top = `${Math.max(8, Math.min(top, innerHeight - 8 - ch)) - top}px`;
      } else el.cust.style.top = "";
      if (!opening && !reduceMotion()) {
        p.style.transition = `top 360ms ${IOS}, left 360ms ${IOS}`;
        clearTimeout(this._snzMove);
        this._snzMove = setTimeout(() => { p.style.transition = ""; }, 400);
      }
      p.style.left = `${left}px`;
      p.style.top = `${top}px`;
      origin = `${Math.max(0, Math.min(w, b.left + b.width / 2 - left))}px ${above ? h : 0}px`;
    } else {
      p.style.left = p.style.top = el.cust.style.top = "";
    }
    if (!opening || reduceMotion()) return;
    p.style.transformOrigin = origin;
    el.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: "ease-out" });
    if (narrow) {
      p.animate([{ transform: "translateY(110%)" }, { transform: "none" }], { duration: 520, easing: IOS });
    } else {
      p.animate([{ opacity: 0, transform: "scale(.86)" }, { opacity: 1, transform: "none" }],
        { duration: 440, easing: IOS_SOFT });
    }
  }

  async _closeSnooze() {
    const el = this._snzEl;
    if (!el?.dlg.open || this._snzClosing) return;
    this._snzClosing = true;
    if (!reduceMotion()) {
      const out = this._narrow()
        ? [{ transform: "none" }, { transform: "translateY(110%)" }]
        : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.9)" }];
      el.scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease-in", fill: "forwards" });
      await el.panel.animate(out, { duration: this._narrow() ? 300 : 200, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
      el.panel.getAnimations().forEach((a) => a.cancel());
      el.scrim.getAnimations().forEach((a) => a.cancel());
    }
    el.dlg.close();
    this._snzClosing = false;
  }

  /* Close the sheet and run the snooze call; the row's state follows from HA. */
  _snoozeDone(fn) {
    fn();
    this._closeSnooze();
  }

  /* Custom: to the right of the list on a wide screen (it would not fit under it), sliding
     out from behind it; under the list on a phone, opening downwards. */
  _toggleCustom() {
    const el = this._snzEl;
    const open = el.cust.hidden;
    const narrow = this._narrow();
    el.customBtn.classList.toggle("open", open);
    if (open) {
      el.cust.hidden = false;
      this._placeSnooze(false);
      if (reduceMotion()) return;
      if (narrow) {
        el.cust.animate([{ height: "0px", opacity: 0 }, { height: `${el.cust.offsetHeight}px`, opacity: 1 }],
          { duration: 420, easing: IOS });
        const p = el.panel;
        setTimeout(() => p.scrollTo({ top: p.scrollTop + el.cust.getBoundingClientRect().top - p.getBoundingClientRect().top - 60,
                                      behavior: "smooth" }), 80);
      } else {
        el.cust.animate([{ opacity: 0, transform: "translateX(-24px) scale(.96)" }, { opacity: 1, transform: "none" }],
          { duration: 460, easing: IOS_SOFT });
      }
      return;
    }
    const finish = () => { el.cust.hidden = true; this._placeSnooze(false); };
    if (reduceMotion()) { finish(); return; }
    const a = narrow
      ? el.cust.animate([{ height: `${el.cust.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
          { duration: 300, easing: IOS })
      : el.cust.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-24px) scale(.96)" }],
          { duration: 200, easing: "cubic-bezier(.4,0,1,1)" });
    a.onfinish = finish;
  }

  _columns() {
    const narrow = this._mq?.matches;
    return COLUMNS[this._view].filter((c) => !narrow || c.narrow);
  }

  // ----------------------------------------------------------------- paint

  _paint() {
    if (this._phone) { this._phView?.update(); return; }
    const rows = this._data.rows;
    for (const s of STATS) {
      const { n, total } = s.calc(rows);
      const big = this._el[`t_${s.id}`];
      const den = this._el[`d_${s.id}`];
      const lab = this._el[`s_${s.id}`];
      const tile = big.closest(".tile");
      // Coloured only while there is something to see; the rules tile never is.
      const hot = n > 0 && !!s.tone;
      big.textContent = n;
      den.textContent = total !== null ? `/ ${total}` : "";
      lab.textContent = s.label;
      big.style.color = hot ? s.tone : "";
      lab.style.color = hot ? s.tone : "";
      tile.style.setProperty("--tc", s.tone || "#fff");
      tile.classList.toggle("hot", hot);
      const key = `${n}/${total}`;
      if (big._k !== key) {
        big._k = key;
        if (!reduceMotion()) big.animate(
          [{ transform: "translateY(-4px) scale(.94)", opacity: 0 }, { transform: "none", opacity: 1 }],
          { duration: 320, easing: IOS_SOFT });
      }
    }
    this._paintFilters();
    this._paintTable();
  }

  _paintFilters() {
    // The chart pick, as a red chip (a stretch of time is shown); tapping it lets go.
    const pin = this._el.pin;
    if (this._pinned) {
      const html = `<span class="pindot" style="--c:${this._pinned.tone}"></span>
        <span class="pinlab">${escapeHtml(this._pinned.label)}</span>
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
      if (pin._html !== html) { pin._html = html; pin.innerHTML = html; }
      pin.style.setProperty("--c", this._pinned.tone);
      pin.hidden = false;
    } else if (!pin.hidden) {
      pin.hidden = true; pin._html = "";
    }
    this._syncMenu(this._el.msSp, "sp");
    this._syncMenu(this._el.msCat, "cat");
  }

  _paintTable() {
    if (!this._el) return;
    this._el.clear.classList.toggle("on", !!(this._q || this._prios.size || this._cats.size ||
      this._statuses.size || this._events.size || this._pinned));
    const cols = this._columns();
    const all = this._visible();
    const narrow = !!this._mq?.matches;
    const grid = cols.map((c) => (narrow && c.wn) || c.w).join(" ") + (narrow ? " 26px" : " 74px");

    const scope = this._view + this._sort.col + this._sort.dir + (this._pinned ? this._pinned.label : "") +
      [...this._prios].sort() +
      [...this._cats].sort() + [...this._statuses].sort() + [...this._events].sort() + this._q;
    if (scope !== this._scope) { this._scope = scope; this._page = 0; }

    this._matching = all.length;
    const pages = Math.max(1, Math.ceil(all.length / this._pageSize));
    if (this._page > pages - 1) this._page = pages - 1;
    const from = this._page * this._pageSize;
    const rows = all.slice(from, from + this._pageSize);

    const headSig = this._view + JSON.stringify(this._sort) + cols.length;
    if (this._el.thead._sig !== headSig) {
      this._el.thead._sig = headSig;
      this._el.thead.style.gridTemplateColumns = grid;
      this._el.thead.innerHTML = cols.map((c) => {
        const on = this._sort.col === c.id;
        return `<button class="th t-label${on ? " on" : ""}${c.align === "right" ? " r" : ""}" data-c="${c.id}">
                  <span>${c.label}</span><span class="ar">${on ? (this._sort.dir === "asc" ? "▲" : "▼") : ""}</span></button>`;
      }).join("") + `<span></span>`;
      this._el.thead.querySelectorAll(".th").forEach((b) => b.addEventListener("click", () => {
        const c = b.dataset.c;
        this._sort = this._sort.col === c
          ? { col: c, dir: this._sort.dir === "asc" ? "desc" : "asc" } : { col: c, dir: "asc" };
        this._paintTable();
      }));
    }

    // everything a row shows - an edit that only renames or re-files an alert repaints it too
    const sig = scope + this._page + cols.length + "|" + rows.map((r) =>
      this._view === "history" ? `${r.id}${r.name}${r.category}${r.priority}`
        : `${r.id}${statusOf(r).text}${r.message}${r.since}${r.lastFired}${r.nc}${r.priority}${r.name}${r.category}${r.description}`).join("|");
    if (sig === this._sig) return;
    this._sig = sig;

    this._reconcile(rows, cols, grid);

    this._el.pager.style.display = pages > 1 ? "" : "none";
    this._el.pgPrev.disabled = this._page === 0;
    this._el.pgNext.disabled = this._page >= pages - 1;
    this._el.pgText.textContent = `${this._page + 1} of ${pages}`;
    const what = this._view === "history" ? "events" : "alerts";
    const total = this._data.rows.length;
    this._el.tfoot.textContent = all.length
      ? `Showing ${from + 1}–${from + rows.length} of ${all.length} ${what} · ${total} alerts defined`
      : `${total} alerts defined`;
  }

  /* What an empty table shows - the phone's empty states: all clear (a green tick), or
     nothing that matches (a quiet filter sign) with what was asked for. */
  _emptyState() {
    const filtered = this._q || this._cats.size || this._pinned || this._statuses.size || this._prios.size;
    const n = this._data.rows.length;
    if (filtered) return { icon: PH_ICON.filter, title: "No Matches", body: `${this._emptyMsg()}.`, tone: COL.quiet };
    if (this._view === "history") return { icon: PH_ICON.check, title: "No History", body: "Nothing has happened in the last 10 days.", tone: COL.quiet };
    if (this._view === "active") {
      return { icon: PH_ICON.check, title: "No Active Alerts", tone: COL.ok,
               body: `Everything is OK. ${n} ${n === 1 ? "rule is" : "rules are"} watching.` };
    }
    return { icon: PH_ICON.filter, title: "No Alert Rules", body: "Make one with New alert.", tone: COL.quiet };
  }

  /* What an empty table says. A tile's own filters (one status, at most one priority) get
     a sentence of their own: "No high priority alerts are firing". */
  _emptyMsg() {
    if (this._view === "history") return "No history matches these filters";
    const st = [...this._statuses], pr = [...this._prios];
    const plain = !this._q && !this._cats.size && !this._pinned;
    if (plain && !st.length && !pr.length) return this._view === "active" ? "Nothing is firing" : "No alerts defined";
    if (plain && st.length === 1 && pr.length <= 1) {
      return `No ${pr.length ? `${pr[0].toLowerCase()} priority ` : ""}alerts are ${st[0] === "OK" ? "OK" : st[0].toLowerCase()}`;
    }
    return "No alerts match these filters";
  }

  /* Keyed reconcile with FLIP — the Health card's, unchanged: rows are reused, patched
     only when their markup differs, and moved instead of rebuilt, so the list never
     blanks. */
  _reconcile(rows, cols, grid) {
    const body = this._el.tbody;
    if (!rows.length) {
      const e = this._emptyState();
      const msg = `${e.title}|${e.body}`;
      if (body._empty !== msg) {
        body.innerHTML = `<div class="nil"><span class="nilic" style="--c:${e.tone}">${e.icon}</span>
          <div class="nilt">${escapeHtml(e.title)}</div><div class="nilb">${escapeHtml(e.body)}</div></div>`;
        body._empty = msg;
        if (!reduceMotion()) body.firstElementChild.animate(
          [{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }],
          { duration: 320, easing: IOS });
      }
      return;
    }
    if (body._empty) { body.innerHTML = ""; body._empty = false; }

    const near = (top) => top > -320 && top < window.innerHeight + 320;
    const existing = new Map();
    for (const el of body.children) if (el.dataset.rowid) existing.set(el.dataset.rowid, el);
    const before = new Map();
    for (const [id, el] of existing) before.set(id, el.getBoundingClientRect().top);
    const wanted = new Set(rows.map((r) => r.id));
    const entering = [];

    for (const r of rows) {
      let w = existing.get(r.id);
      if (!w) { w = this._makeRow(r); entering.push(w); }
      this._fillRow(w, r, cols, grid);
      body.appendChild(w);
    }

    const leaving = [...existing].filter(([id]) => !wanted.has(id)).map(([, el]) => el);
    for (const el of leaving) {
      const top = el.getBoundingClientRect().top;
      el.remove();
      if (!near(top) || leaving.length > 30 || reduceMotion()) continue;
      el.style.position = "absolute";
      el.style.pointerEvents = "none";
      el.style.width = `${body.clientWidth}px`;
      el.style.top = `${top - body.getBoundingClientRect().top}px`;
      body.appendChild(el);
      el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-6px) scale(.985)" }],
        { duration: 220, easing: IOS }).onfinish = () => el.remove();
    }

    let flipped = 0;
    for (const [id, el] of existing) {
      if (!wanted.has(id)) continue;
      const dy = before.get(id) - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1 || !near(el.getBoundingClientRect().top) || flipped > 60 || reduceMotion()) continue;
      flipped++;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 420, easing: IOS });
    }

    let staged = 0;
    for (const el of entering) {
      if (reduceMotion()) break;
      if (!near(el.getBoundingClientRect().top)) continue;
      el.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
        { duration: 380, easing: IOS, delay: Math.min(staged++, 14) * 22, fill: "backwards" });
    }
  }

  _makeRow(r) {
    const w = document.createElement("div");
    w.className = "trwrap";
    w.dataset.rowid = r.id;
    const tr = document.createElement("div");
    tr.className = "tr";
    tr.dataset.id = r.id;
    w.appendChild(tr);
    return w;
  }

  _fillRow(w, r, cols, grid) {
    const tr = w.firstElementChild;
    const hist = this._view === "history";
    const st = hist ? r.ev : statusOf(r);
    const pr = prioOf(r.priority);
    const cell = (c) => {
      switch (c.id) {
        case "name": {
          // Name, then (i) for the entity id and description; under it what the alert is
          // for. A bell with a slash marks an alert whose notifications are switched off.
          const eid = hist ? r.eid : r.id;
          const info = !eid ? "" : `<button class="info" data-info="${escapeHtml(eid)}" title="About this alert"
                          aria-label="About this alert"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/>
                          <path d="M12 11v5.5M12 7.6v.01"/></svg></button>`;
          const quiet = !hist && r.notificationsOff
            ? `<span class="quiet" title="Notifications off"><svg viewBox="0 0 24 24">
                 <path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H6M10 21h4M4 3l16 18"/></svg></span>` : "";
          const sub = !hist && r.description ? `<i>${escapeHtml(r.description)}</i>` : "";
          return `<span class="nm"><span class="dot" style="--c:${st.tone}"></span>
                    <span class="nmt"><span class="nml"><b>${escapeHtml(r.name)}</b>${info}${quiet}</span>${sub}</span></span>`;
        }
        case "category":
          return `<button class="tag${this._cats.has(r.category) ? " on" : ""}" data-f="cat" data-v="${escapeHtml(r.category)}"
                    title="Filter by ${escapeHtml(r.category)}">${escapeHtml(r.category)}</button>`;
        case "priority":
          return `<button class="tag stt${this._prios.has(pr.label) ? " on" : ""}" data-f="prio" data-v="${pr.label}"
                    style="--c:${pr.tone}" title="Filter by ${pr.label} priority">${pr.label}</button>`;
        case "status":
          return `<button class="tag stt${this._statuses.has(st.text) ? " on" : ""}" data-f="status"
                    data-v="${escapeHtml(st.text)}" style="--c:${st.tone}" title="Filter by ${escapeHtml(st.text)}">${escapeHtml(st.text)}</button>`;
        case "event":
          return `<button class="tag stt${this._events.has(st.text) ? " on" : ""}" data-f="event"
                    data-v="${escapeHtml(st.text)}" style="--c:${st.tone}" title="Filter by ${escapeHtml(st.text)}">${escapeHtml(st.text)}</button>`;
        case "since": return `<span class="muted">${r.since ? ago(r.since) : "—"}</span>`;
        case "lastFired": return `<span class="muted">${r.lastFired ? ago(r.lastFired) : "never"}</span>`;
        case "when": return `<span class="muted num">${fmtDT(r.t)}</span>`;
        case "detail": return `<span class="muted clip">${escapeHtml(r.detail || "—")}</span>`;
        default: return "";
      }
    };
    const open = this._open === r.id;
    const html =
      cols.map((c) => `<span class="td${c.align === "right" ? " r" : ""}">${cell(c)}</span>`).join("") +
      `<span class="td acts">
         <span class="chev${open ? " up" : ""}"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></span>
       </span>`;
    if (tr.style.gridTemplateColumns !== grid) tr.style.gridTemplateColumns = grid;
    if (tr._html !== html) {
      const swapping = tr._html !== undefined && tr._cols !== cols.length;
      tr._html = html;
      tr.innerHTML = html;
      if (swapping && !reduceMotion()) tr.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: IOS });
    }
    tr._cols = cols.length;
    tr.classList.toggle("open", open);
  }

  // ---------------------------------------------------------------- detail

  _toggle(id) {
    const body = this._el.tbody;
    const wasOpen = this._open === id;
    body.querySelectorAll(".detail:not(.closing)").forEach((d) => this._collapseDetail(d));
    body.querySelector(".tr.open")?.classList.remove("open");
    body.querySelector(".chev.up")?.classList.remove("up");
    this._open = wasOpen ? null : id;
    this._shc = null;
    if (!this._open) return;

    const tr = body.querySelector(`.tr[data-id="${CSS.escape(id)}"]`);
    if (!tr) return;
    tr.classList.add("open");
    tr.querySelector(".chev")?.classList.add("up");
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.innerHTML = `<div class="detailBody">
        <div class="dtop"></div>
        <div class="dhist"></div>
        <div class="dtl"></div>
      </div>`;
    tr.parentElement.appendChild(detail);
    this._fillDetail(detail, true);
    this._expandDetail(detail);
  }

  /* The open row's alert: History rows open the alert their event belongs to. */
  _openAlertId() {
    if (!this._open) return null;
    return this._open.includes("|") ? this._open.split("|")[0] : this._open;
  }

  _refreshDetail(remountHistory = false) {
    const detail = this._el?.tbody.querySelector(".detail:not(.closing)");
    if (detail) this._fillDetail(detail, remountHistory);
  }

  async _fillDetail(detail, mountHistory) {
    if (this._view === "history" && this._open?.includes("|")) {
      const r = this._historyRows().find((x) => x.id === this._open);
      const body = detail.querySelector(".detailBody");
      const from = detail.offsetHeight;
      body.innerHTML = r ? this._historyDetailHtml(r) : `<div class="loading">This event is no longer recorded.</div>`;
      this._resizeDetail(detail, from);
      return;
    }
    const eid = this._openAlertId();
    const row = this._data.byId[eid];
    const top = detail.querySelector(".dtop");
    const from = detail.offsetHeight;
    if (!row) {
      top.innerHTML = `<div class="loading">This alert no longer exists.</div>`;
      detail.querySelector(".dhist").innerHTML = "";
      detail.querySelector(".dtl").innerHTML = this._timelineHtml(eid, null);
      return;
    }
    top.innerHTML = this._detailTopHtml(row, row.message);
    detail.querySelector(".dtl").innerHTML = this._timelineHtml(eid, row);
    if (mountHistory) this._mountHistory(detail.querySelector(".dhist"), row);
    this._resizeDetail(detail, from);

    // The live message, for an alert whose display_msg tracks the current situation.
    if (row.hasDisplayMsg) {
      const res = await this._ws({
        type: "call_service", domain: "alert2", service: "get_display_msg",
        service_data: {}, target: { entity_id: eid }, return_response: true,
      });
      const msg = res?.response?.[eid] ?? res?.response;
      const text = typeof msg === "string" ? msg : (msg && typeof msg === "object" ? Object.values(msg)[0] : null);
      if (typeof text === "string" && detail.isConnected && !detail.classList.contains("closing") &&
          this._openAlertId() === eid) {
        const h = detail.offsetHeight;
        top.innerHTML = this._detailTopHtml(row, unescapeHtml(text));
        this._resizeDetail(detail, h);
      }
    }
  }

  /* The expanded alert: what it says now, and the same buttons in the same order on every
     alert - Snooze, Edit, then the one action that ends the alarm. Status, priority and
     category are already in the row above. The entity id and the description live in the
     row's (i) popup, not here. */
  _detailTopHtml(row, message) {
    const st = statusOf(row);
    return `
      ${message ? this._msgHtml(row.id, message, st.tone) : ""}
      ${this._btnRowHtml(row)}`;
  }

  /* What the alert says now, a line per item - the editor's rules put each device, each
     condition's part, on a line of its own - ten to a page with ‹ › under them, as the
     timeline. The page shown is kept per alert, so a live update does not throw it back. */
  _msgHtml(eid, message, tone) {
    const lines = String(message).split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return "";
    (this._msgText ||= {})[eid] = message;
    const pages = Math.ceil(lines.length / MSG_PAGE);
    const p = Math.max(0, Math.min(pages - 1, this._msgPage?.[eid] || 0));
    const shown = lines.slice(p * MSG_PAGE, (p + 1) * MSG_PAGE).map((l) => `<div class="msgline">${escapeHtml(l)}</div>`).join("");
    const pager = pages > 1 ? `<div class="tlpager msgpager">
        <button class="pg" data-mp="-1" data-eid="${escapeHtml(eid)}" aria-label="Previous"${p === 0 ? " disabled" : ""}>
          <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <span class="pgtext">${p + 1} / ${pages}</span>
        <button class="pg" data-mp="1" data-eid="${escapeHtml(eid)}" aria-label="Next"${p === pages - 1 ? " disabled" : ""}>
          <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></div>` : "";
    return `<div class="msg" style="--c:${tone}"><div class="msglines">${shown}</div>${pager}</div>`;
  }

  /* ‹ ›: the lines leave the way the reader is going and the next ten come in. */
  _pageMsg(btn) {
    const dir = Number(btn.dataset.mp);
    const eid = btn.dataset.eid;
    (this._msgPage ||= {})[eid] = (this._msgPage[eid] || 0) + dir;
    const host = btn.closest(".msg");
    const detail = btn.closest(".detail");
    const tone = host?.style.getPropertyValue("--c");
    const list = host?.querySelector(".msglines");
    const paint = () => {
      const tmp = document.createElement("div");
      tmp.innerHTML = this._msgHtml(eid, this._msgText?.[eid] || "", tone);
      if (tmp.firstElementChild) host.replaceWith(tmp.firstElementChild);
      return tmp.firstElementChild;
    };
    if (!list || reduceMotion()) { paint(); return; }
    list.getAnimations().forEach((a) => a.cancel());
    const out = list.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-dir * 56}px)`, opacity: 0 }],
      { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    out.onfinish = () => {
      if (!host.isConnected) return;
      const h = detail?.offsetHeight;
      const fresh = paint();
      fresh?.querySelector(".msglines")?.animate([{ transform: `translateX(${dir * 56}px)`, opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 320, easing: IOS });
      if (detail) this._resizeDetail(detail, h);
    };
  }

  _btnRowHtml(row) {
    const btn = (act, label, arg = "", cls = "") =>
      `<button class="navbtn${cls}" data-act="${act}" data-eid="${escapeHtml(row.id)}" data-arg="${arg}">${label}</button>`;
    const buttons = [];
    // Snooze opens the snooze sheet; while snoozed it says until when, and the sheet ends it.
    // The control white, as New alert: the button most often wanted.
    // While snoozed it is the highlight - white, as the chosen tab - as the state the alert is in.
    if (row.notificationsOff) buttons.push(btn("enable", "Notifications on", "", " primary"));
    else if (row.snoozeUntil) buttons.push(btn("snoozeMenu", `Snoozed until ${fmtUntil(row.snoozeUntil)}`, "", " snoozed"));
    else buttons.push(btn("snoozeMenu", "Snooze", "", " primary"));
    // Edit, for an alert made in this card (a YAML one is edited in its file)
    if (this._uiIds?.has(row.id)) buttons.push(btn("edit", "Edit", "", " primary"));
    // Clear, where the rule allows it: back to OK until the alert fires again.
    if (row.firing && row.allowClear) buttons.push(btn("ack", "Clear", "", " ok"));
    const note = row.notificationsOff ? "Notifications are off" : "";
    return `<div class="btnrow">${buttons.join("")}${note ? `<span class="muted bnote">${escapeHtml(note)}</span>` : ""}
        ${this._linkFor(row) ? `<button class="navbtn primary golink" data-nav="${escapeHtml(this._linkFor(row))}">Open link</button>` : ""}</div>`;
  }

  /* The timeline TL_PAGE entries at a time, newest first, with ‹ › under it - the
     Health card's. The page shown is kept per alert, so an update to the alert does not
     throw the reader back to the first page. */
  _timelineHtml(eid, row) {
    const entries = [...this._entriesOf(eid)].reverse();
    if (!entries.length) return `<div class="dhead sm">Timeline</div><div class="loading">Nothing recorded yet.</div>`;
    const pages = Math.ceil(entries.length / TL_PAGE);
    const p = Math.max(0, Math.min(pages - 1, this._tlPage?.[eid] || 0));
    // each row opens the whole event: a long message is cut to one line here
    const items = entries.slice(p * TL_PAGE, (p + 1) * TL_PAGE).map((e) => {
      const ev = eventOf(e, row);
      const detail = eventDetail(e);
      return `<li class="lgi" role="button" tabindex="0" data-ev="${escapeHtml(eid)}" data-evk="${escapeHtml(`${e.t}|${e.kind}`)}"
          aria-label="${escapeHtml(`${ev.text}, ${fmtDT(Date.parse(e.t))}: details`)}"><span class="logdot" style="--c:${ev.tone}"></span>
        <span class="lgt">${fmtDT(Date.parse(e.t))}</span>
        <span class="lgm"><b>${escapeHtml(ev.text)}</b>${detail ? ` <span class="muted">· ${escapeHtml(detail)}</span>` : ""}</span>
        <span class="lgchev">${ICON_CHEV_R}</span></li>`;
    }).join("");
    const pager = pages > 1 ? `<div class="tlpager">
        <button class="pg" data-tl="-1" data-eid="${escapeHtml(eid)}" aria-label="Newer"${p === 0 ? " disabled" : ""}>
          <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <span class="pgtext">${p + 1} / ${pages}</span>
        <button class="pg" data-tl="1" data-eid="${escapeHtml(eid)}" aria-label="Older"${p === pages - 1 ? " disabled" : ""}>
          <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></div>` : "";
    return `<div class="dhead sm">Timeline</div><div class="tl"><ul class="log">${items}</ul>${pager}</div>`;
  }

  /* Paging: the page leaves the way the reader is going - older slides out to the left -
     fading, and the next comes in from the other side. */
  _pageTimeline(btn) {
    const dir = Number(btn.dataset.tl);
    const eid = btn.dataset.eid;
    (this._tlPage ||= {})[eid] = (this._tlPage[eid] || 0) + dir;
    const host = btn.closest(".dtl");
    const detail = btn.closest(".detail");
    const list = host?.querySelector(".log");
    const paint = () => { host.innerHTML = this._timelineHtml(eid, this._data.byId[eid] || null); };
    if (!list || reduceMotion()) { paint(); return; }
    list.getAnimations().forEach((a) => a.cancel());
    const out = list.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-dir * 56}px)`, opacity: 0 }],
      { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    out.onfinish = () => {
      if (!host.isConnected) return;
      const h = detail?.offsetHeight;
      paint();
      host.querySelector(".log")?.animate([{ transform: `translateX(${dir * 56}px)`, opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 320, easing: IOS });
      if (detail) this._resizeDetail(detail, h);
    };
  }

  /* The alert's status over the chosen range - Firing, Snoozed, OK, in the status
     colours - drawn by state-history-card like the Health card's availability. The same
     band for every alert: the recorder keeps an alert's state and attributes, and
     statusPoints() turns them into the three statuses (an event alert has no on/off
     state of its own). The card is handed a view of hass in which the alert's entity
     IS that status, and whose history call returns the status series. */
  async _mountHistory(host, row) {
    this._shc = null;
    this._hist = null;
    if (!host) return;
    const { hours } = this._window();
    const range = RANGES.find((r) => r.id === this._range);
    host.innerHTML = `<div class="dhead sm">Firing history <span class="dsub">${range.label}</span></div>
      <div class="shc" style="min-height:${SHC_ROW_H + SHC_ROW_GAP + 30}px"></div>`;
    const slot = host.querySelector(".shc");
    if (!(await whenDefined("state-history-card", 5000))) {
      slot.innerHTML = `<div class="loading">state-history-card is not loaded as a dashboard resource.</div>`;
      slot.style.minHeight = "";
      return;
    }
    const end = Date.now();
    const pts = await this._statusPoints(row.id, row.isCond, end - hours * 3600e3, end);
    if (!slot.isConnected || slot.closest(".detail")?.classList.contains("closing") ||
        this._openAlertId() !== row.id) return;
    this._hist = { eid: row.id, isCond: row.isCond, pts };
    const el = document.createElement("state-history-card");
    el.setConfig({
      type: "custom:state-history-card",
      hours_to_show: hours,
      refresh_interval: 300,
      legend: "off",
      timestamps: "on",
      labels: "off",
      label_width: BAND_LABEL_W,
      state_colors: { Firing: COL.firing, Snoozed: COL.snoozed, OK: COL.ok, Restarting: COL.quiet },
      default_color: COL.quiet,
      entities: [{ entity: row.id, name: "Status" }],
    });
    el.hass = this._histHass(this._hass);
    slot.replaceChildren(el);
    this._shc = el;
  }

  /* An alert's timeline: from its rule's last edit (an edit starts it over; what came before
     stays in the History tab), with Home Assistant's restarts since then in it. */
  _entriesOf(eid) {
    const edited = this._editedAt(eid);
    const own = (this._timeline[eid] || []).filter((e) => Date.parse(e.t) >= edited);
    if (!own.length) return [];
    const from = Date.parse(own[0].t) || 0;
    const restarts = (this._restarts || []).filter((r) => Date.parse(r.started) >= from)
      .map((r) => ({ t: r.started, kind: "restart", stopped: r.stopped }));
    return [...own, ...restarts].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  }

  /* When the alert's rule was last edited (its timeline starts there), or 0. */
  _editedAt(eid) {
    const t = (this._timeline[eid] || []).filter((e) => e.kind === "edited").map((e) => Date.parse(e.t)).filter(Number.isFinite);
    return t.length ? Math.max(...t) : 0;
  }

  /* An alert's statuses over a window - from its rule's last edit at the earliest: an
     edited rule's history starts over, as its timeline does. */
  async _statusPoints(eid, isCond, startMs, endMs) {
    startMs = Math.max(startMs, this._editedAt(eid));
    if (startMs >= endMs) return [];
    const res = await this._ws({
      type: "history/history_during_period",
      start_time: new Date(startMs).toISOString(), end_time: new Date(endMs).toISOString(),
      entity_ids: [eid], include_start_time_state: true, significant_changes_only: false,
      minimal_response: false, no_attributes: false,
    });
    return statusPoints(res?.[eid] || [], isCond, endMs, this._restarts || []);
  }

  /* hass as state-history-card should see it: the open alert's entity carries its status,
     and asking for its history returns the status series. Everything else is untouched. */
  _histHass(hass) {
    const h = this._hist;
    const row = h && this._data?.byId[h.eid];
    if (!row) return hass;
    const now = statusOf(row).text;
    const last = h.pts[h.pts.length - 1];
    const iso = new Date(last && last[1] === now ? last[0] : Date.now()).toISOString();
    const synth = { entity_id: h.eid, state: now, attributes: {}, last_changed: iso, last_updated: iso };
    const states = new Proxy(hass.states, { get: (t, k) => (k === h.eid ? synth : t[k]) });
    const callApi = async (method, path, ...rest) => {
      if (method !== "GET" || !path.startsWith("history/period/")) return hass.callApi(method, path, ...rest);
      const [head, query = ""] = path.slice("history/period/".length).split("?");
      const startMs = Date.parse(decodeURIComponent(head));
      const endMs = Date.parse(new URLSearchParams(query).get("end_time") || "") || Date.now();
      h.pts = await this._statusPoints(h.eid, h.isCond, startMs, endMs);
      return [h.pts.map(([t, state]) => {
        const at = new Date(t).toISOString();
        return { entity_id: h.eid, state, last_changed: at, last_updated: at };
      })];
    };
    return { ...hass, states, callApi };
  }

  async _action(act, eid, arg, el) {
    const call = (service, data = {}) =>
      this._hass.callService("alert2", service, { entity_id: eid, ...data });
    switch (act) {
      case "ack": return call("ack");
      case "unack": return call("unack");
      case "snoozeMenu": this._openSnooze(eid, el); return null;
      /* Snooze only pauses notifications. Alert2 also acks on every notification change
         unless told not to, and only a snooze can be told - so turning notifications back
         on is a snooze that ends now, which Alert2 at once turns into "enabled".
         arg: when the snooze ends, in ms. */
      case "snooze":
        return call("notification_control",
          { enable: true, snooze_until: new Date(Number(arg)).toISOString(), ack_at_snooze_start: false });
      case "disable": return call("notification_control", { enable: false });
      case "enable":
        return call("notification_control",
          { enable: true, snooze_until: new Date().toISOString(), ack_at_snooze_start: false });
      case "edit": this._editor.edit(eid, this._uiIds?.get(eid)); return null;
      default: return null;
    }
  }

  /* An alert's link: an address inside Home Assistant (a popup hash included) is
     navigated in the app; anything else opens in a new tab. */
  /* The two dashboards the editor's links come from: the card's options, or found by name. */
  _dashboards() {
    const dash = Object.values(this._hass?.panels || {}).filter((x) => x.component_name === "lovelace").map((x) => x.url_path);
    return {
      desktop: this._config.desktop_dashboard || dash.find((d) => /tablet|desktop/.test(d)) || null,
      mobile: this._config.mobile_dashboard || dash.find((d) => /mobile|phone/.test(d)) || null,
    };
  }

  /* An alert's link for where it is being looked at: the mobile one on the mobile dashboard
     or a phone-sized screen, the desktop one anywhere else - each the other's stand-in. */
  _linkFor(row) {
    const m = this._dashboards().mobile;
    const mobile = (m && location.pathname.startsWith(`/${m}/`)) || this._narrow();
    return mobile ? row.linkMobile || row.link : row.link || row.linkMobile;
  }

  /* Every view and pop-up of the two dashboards, read from their own configuration, for the
     editor's link pickers. Cached for a minute: one read per dashboard per editing session. */
  _linkTargets() {
    const now = Date.now();
    if (this._linkCache && now - this._linkCache.t < 60e3) return this._linkCache.p;
    const read = async (dash) => {
      if (!dash) return null;
      const cfg = await this._hass.callWS({ type: "lovelace/config", url_path: dash }).catch(() => null);
      return cfg ? { dash, title: this._hass.panels?.[dash]?.title || dash, items: linkItems(dash, cfg) } : null;
    };
    const ds = this._dashboards();
    const p = Promise.all([read(ds.desktop), read(ds.mobile)]).then(([desktop, mobile]) => ({ desktop, mobile }));
    this._linkCache = { t: now, p };
    return p;
  }

  _navigate(link) {
    if (/^https?:\/\//i.test(link)) { window.open(link, "_blank", "noopener"); return; }
    const url = link.startsWith("/") ? link : `/${link}`;
    history.pushState(null, "", url);
    this.dispatchEvent(new CustomEvent("location-changed", { bubbles: true, composed: true }));
    if (url.includes("#")) window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  _expandDetail(detail) {
    if (reduceMotion()) return;
    const to = detail.scrollHeight;
    detail.style.overflow = "hidden";
    detail._anim?.cancel();
    detail._anim = detail.animate([{ height: "0px", opacity: 0 }, { height: `${to}px`, opacity: 1 }],
      { duration: 420, easing: IOS });
    detail._anim.onfinish = () => { detail.style.height = "auto"; detail.style.overflow = ""; };
  }

  /* A closing panel is marked so nothing treats it as the open one (a late refresh
     drawing into it, or resizing it, cancelled its close and left it behind). */
  _collapseDetail(detail) {
    detail.classList.add("closing");
    if (reduceMotion()) { detail.remove(); return; }
    const from = detail.offsetHeight;
    detail.style.overflow = "hidden";
    detail._anim?.cancel();
    detail._anim = detail.animate([{ height: `${from}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
      { duration: 300, easing: IOS });
    detail._anim.onfinish = () => detail.remove();
  }

  _resizeDetail(detail, from) {
    if (reduceMotion() || !from || detail.classList.contains("closing")) return;
    detail.style.overflow = "hidden";
    const to = detail.scrollHeight;
    if (Math.abs(to - from) < 2) { detail.style.overflow = ""; return; }
    detail._anim?.cancel();
    detail._anim = detail.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 380, easing: IOS });
    detail._anim.onfinish = () => { detail.style.height = "auto"; detail.style.overflow = ""; };
  }

  // ---------------------------------------------------------------- chart

  /* Grouped bars per priority, each anchored at zero — the Health card's chart, with its
     interaction: clock-aligned, equal, touch-sized slots; a tooltip naming the alerts
     behind every bar on hover or a finger drag; a tap shows exactly those alerts in the
     table. A bar is the number of alerts of that priority that were firing at any moment
     of its slot (a condition alert) or fired in it (an event alert). */
  _drawOverview() {
    if (this._phone) {
      if (!this._overview) return;
      const { start, end } = this._overview;
      const slots = this._slotsFor(start, end);
      if (slots[0].a < this._overview.from.getTime() && !this._refetching) {
        this._refetching = true;
        this._loadOverview().finally(() => { this._refetching = false; });
      }
      this._chart = { slots, series: this._overviewSeries(slots, slots[0].a, end.getTime()) };
      this._phView?.chartChanged();
      return;
    }
    const host = this._el?.chartsvg;
    if (!host || !this._overview) return;
    const { start, end } = this._overview;
    const W = this._el.overview.clientWidth || 700;
    const H = 190;
    const P = { l: 32, r: 32, t: 10, b: 30 };
    const plotW = W - P.l - P.r;
    const t1 = end.getTime();
    const slots = this._slotsFor(start, end);
    // Whole slots on the axis so every bar is the same width; refetch if a narrower card
    // moved the first slot before the data we have.
    if (slots[0].a < this._overview.from.getTime() && !this._refetching) {
      this._refetching = true;
      this._loadOverview().finally(() => { this._refetching = false; });
    }
    const t0 = slots[0].a, tEnd = slots[slots.length - 1].b, span = tEnd - t0;
    const xt = (t) => P.l + ((t - t0) / span) * plotW;

    const series = this._overviewSeries(slots, t0, t1);
    this._chart = { slots, series, P, W, H, xt, t0, t1 };
    this._drawBars(slots, series, start, t1, W, H, P, xt);
    const fired = new Set();
    series.forEach((s) => s.per.forEach((p) => p.ids.forEach((_, id) => fired.add(id))));
    this._foldChart(fired.size);
  }

  /* Nothing fired in the range: the chart folds to its title row, which says so where the
     legend was - as the phone's chart folds to its count. Folding or unfolding (another
     range) eases the panel to its new height. */
  _foldChart(n) {
    const panel = this._el.overview.closest(".panel");
    const folded = !n;
    if (folded) this._el.cfold.innerHTML = `<b>0</b>alerts fired in ${PH_RANGE_WORDS[this._range] || this._range}`;
    if (panel.classList.contains("folded") === folded) return;
    const h0 = panel.offsetHeight;
    panel.classList.toggle("folded", folded);
    const h1 = panel.offsetHeight;
    if (h0 && h1 !== h0 && !reduceMotion()) {
      panel.animate([{ height: `${h0}px`, overflow: "hidden" }, { height: `${h1}px`, overflow: "hidden" }], { duration: 320, easing: IOS });
      (folded ? this._el.cfold : this._el.legend).animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: IOS });
    }
  }

  /* Per slot and priority, the alerts firing in it: per[i] = { v, ids: Map(alert id -> times it
     fired in the slot; 1 for a condition alert) }. The tablet's chart and the phone's alike. */
  _overviewSeries(slots, t0, t1) {
    const { res } = this._overview;
    const per = PRIO_IDS.map(() => slots.map(() => new Map()));
    for (const r of this._data.rows) {
      const hist = res[r.id] || [];
      const k = PRIO_IDS.indexOf(r.priority);
      if (r.isCond) {
        /* Firing as the list and the tiles count it: on, and not cleared (an ack where the
           rule allows clearing). A restart's brief "unavailable" keeps the status it had. */
        const live = hist.filter((h) => !["unavailable", "unknown"].includes(String(h.s ?? h.state)));
        live.forEach((h, i) => {
          const at = h.a || h.attributes || {};
          if (String(h.s ?? h.state) !== "on" || (allowClearOf(at, true) && at.is_acked)) return;
          const a = (h.lu ?? h.last_updated ?? 0) * 1000;
          const nx = live[i + 1];
          const b = nx ? (nx.lu ?? nx.last_updated ?? 0) * 1000 : t1;
          slots.forEach((sl, j) => { if (b > sl.a && a < sl.b) per[k][j].set(r.id, 1); });
        });
      } else {
        /* An event alert is Firing from the moment it fires until its "Stays firing" runs out
           or someone clears it - so it counts in every slot of that span, as the list counts
           it, one still Firing from before the window too (not only where it fired). Its state
           IS the time it last fired, so each DISTINCT value is one fire: the recorder also
           writes a row when only an attribute changes (acked, notified …) - the row that turns
           it acked is when it was cleared. */
        const fires = [];
        for (const h of hist) {
          const t = Date.parse(h.s ?? h.state);
          if (!Number.isFinite(t)) continue;
          const at = h.a || h.attributes || {};
          let f = fires[fires.length - 1];
          if (!f || f.t !== t) { f = { t, stay: stayMsOf(at), cleared: null }; fires.push(f); }
          if (f.cleared == null && allowClearOf(at, false) && at.is_acked) f.cleared = Math.max(t, (h.lu ?? h.last_updated ?? 0) * 1000);
        }
        fires.forEach((f, i) => {
          const until = Math.min(f.t + f.stay, f.cleared ?? Infinity, fires[i + 1]?.t ?? Infinity, t1);
          slots.forEach((sl, j) => {
            // a fire in the slot counts as many times as it fired there; still firing, once
            if (f.t >= sl.a && f.t < sl.b) per[k][j].set(r.id, (per[k][j].get(r.id) || 0) + 1);
            else if (f.t < sl.a && until > sl.a && !per[k][j].has(r.id)) per[k][j].set(r.id, 1);
          });
        });
      }
    }
    return PRIO_IDS.map((p, k) => ({
      color: PRIO[p].tone, name: PRIO[p].label,
      per: per[k].map((m) => ({ v: m.size, ids: m })),
    }));
  }

  _drawBars(slots, series, start, t1, W, H, P, xt) {
    const host = this._el.chartsvg;

    // A priority with nothing in the window takes no room in the slots.
    const shown = series.map((s, k) => ({ ...s, k }))
      .filter((s) => this._series.has(s.k) && s.per.some((p) => p.v > 0));
    const max = Math.max(1, ...shown.flatMap((s) => s.per.map((p) => p.v)));
    const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
    const base = H - P.b;
    const n = shown.length || 1;

    const grid = niceTicks(max).map((v) =>
      `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="${COL.grid}"/>
       <text x="${P.l - 8}" y="${y(v) + 5}" class="ax" text-anchor="end">${v}</text>`).join("");

    // The status band's own marks for the CHOSEN range (axisMarks, for its track
    // width), placed on this chart's whole-slot axis.
    const marks = axisMarks(start.getTime(), t1, bandTrackWidth(W)).map(({ t, label }) =>
      `<line x1="${xt(t)}" x2="${xt(t)}" y1="${P.t}" y2="${H - P.b}" stroke="${COL.grid}"/>
       <text x="${xt(t)}" y="${H - 9}" class="ax" text-anchor="middle">${label}</text>`);

    const bars = [];
    this._chart.geo = slots.map((sl, i) => {
      const x0 = xt(sl.a), x1 = xt(sl.b), w = x1 - x0;
      const pad = Math.max(3, w * 0.18);
      const inner = Math.min(3, w * 0.04);
      const bw = Math.max(3, (w - pad - inner * (n - 1)) / n);
      const gx = x0 + (w - (bw * n + inner * (n - 1))) / 2;
      const cells = [];
      shown.forEach((s, j) => {
        const v = s.per[i].v;
        const bx = gx + j * (bw + inner);
        cells.push({ k: s.k, x: bx, w: bw, v });
        if (!v) return;
        const h = Math.max(3, (v / max) * (H - P.t - P.b));
        bars.push(`<rect class="cbar" x="${bx.toFixed(1)}" y="${(base - h).toFixed(1)}" ` +
          `width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, bw / 3).toFixed(1)}" ` +
          `fill="${s.color}" style="--d:${i * 12}ms"/>`);
      });
      // nothing at all in the slot: a short white stub at zero, a bar wide, in the middle - an
      // empty slot reads as a zero, not as a gap
      if (!cells.some((c) => c.v)) {
        const zx = gx + (bw * n + inner * (n - 1) - bw) / 2;
        bars.push(`<rect class="cbar" x="${zx.toFixed(1)}" y="${(base - 3).toFixed(1)}" width="${bw.toFixed(1)}" ` +
          `height="3" rx="1.5" fill="#fff" style="--d:${i * 12}ms"/>`);
      }
      return { x0, x1, cells };
    });
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      <rect class="hband" id="hband" x="0" y="${P.t}" width="0" height="${H - P.t - P.b}" rx="6"/>
      ${grid}${marks.join("")}${bars.join("")}</svg>`;
    this._hoverSlot = -1;
    if (!this._el.ctip.hidden) this._hideTip();
  }

  _slotsFor(start, end) {
    // the phone: about twelve slots, as narrow bars as a finger can still pick
    if (this._phone) return slotGrid(start.getTime(), end.getTime(), 12);
    const plotW = (this._el?.overview?.clientWidth || 700) - 64;
    return slotGrid(start.getTime(), end.getTime(), Math.max(6, Math.min(30, Math.floor(plotW / 48))));
  }

  _slotAt(e) {
    const c = this._chart;
    if (!c) return -1;
    const r = this._el.overview.getBoundingClientRect();
    const x = (e.clientX - r.left) * (c.W / r.width);
    if (x < c.P.l || x > c.W - c.P.r) return -1;
    return c.geo.findIndex((g) => x >= g.x0 && x < g.x1);
  }

  _hoverChart(e) {
    const i = this._slotAt(e);
    if (i < 0) { if (e.pointerType === "mouse") this._hideTip(); return; }
    if (i === this._hoverSlot) return;
    this._hoverSlot = i;
    const c = this._chart;
    const g = c.geo[i];
    const band = this.shadowRoot.getElementById("hband");
    if (band) { band.setAttribute("x", g.x0.toFixed(1)); band.setAttribute("width", (g.x1 - g.x0).toFixed(1)); }
    const tip = this._el.ctip;
    tip.innerHTML = this._tipHtml(i);
    tip.hidden = false;
    const wrap = this._el.overview.getBoundingClientRect();
    const scale = wrap.width / c.W;
    const tw = tip.offsetWidth;
    const right = g.x1 * scale + 12;
    const left = g.x0 * scale - 12 - tw;
    const x = right + tw <= wrap.width ? right : Math.max(0, left);
    tip.style.transform = `translate(${Math.round(x)}px, 0)`;
  }

  _hideTip() {
    this._hoverSlot = -1;
    if (this._el?.ctip) this._el.ctip.hidden = true;
    const band = this.shadowRoot?.getElementById("hband");
    if (band) band.setAttribute("width", "0");
  }

  _tipHtml(i) {
    const c = this._chart;
    const sl = c.slots[i];
    const parts = c.series
      .map((s, k) => ({ s, k, p: s.per[i] }))
      .filter(({ k, p }) => this._series.has(k) && p.v > 0)
      .map((x) => ({ ...x, names: [...x.p.ids]
        .map(([id]) => this._data.byId[id]?.name || id)
        .sort((a, b) => a.localeCompare(b)) }));
    // At most TIP_NAMES names in the whole tooltip, shared out evenly between priorities.
    const room = shareOut(parts.map((x) => x.names.length), TIP_NAMES);
    const secs = parts.map(({ s, p, names }, j) => {
      const list = names.slice(0, room[j]).map((nm) => `<li>${escapeHtml(nm)}</li>`).join("") +
        (names.length > room[j] ? `<li class="tmore">and ${names.length - room[j]} more</li>` : "");
      return `<div class="tsec" style="--c:${s.color}">
          <div class="thd"><i></i>${s.name}<b>${p.v}</b></div>
          ${list ? `<ul>${list}</ul>` : ""}</div>`;
    }).join("");
    return `<div class="twhen">${escapeHtml(fmtSlot(sl.a, sl.b))}</div>` +
      (secs || `<div class="tnone">Nothing firing</div>`);
  }

  /* A tap or click on a bar: All Alerts, showing every alert that fired in its slot - both
     priorities (those the legend shows). The chip is red whatever they are: it only warns
     that the table shows a stretch of time. */
  _pickChart(e) {
    const i = this._slotAt(e);
    if (i < 0) return;
    const c = this._chart;
    const rows = new Set(c.series.filter((s, k) => this._series.has(k)).flatMap((s) => [...s.per[i].ids.keys()]));
    if (!rows.size) return;
    const sl = c.slots[i];
    this._clearFilters();
    this._setView("all");
    this._pinned = { rows, tone: COL.firing, label: fmtSlot(sl.a, sl.b) };
    this._hideTip();
    this._paintFilters();
    this._paintTable();
    this._scrollToTable();
  }
}

/* ---- the rule editor -----------------------------------------------------------
   "New alert": the Simple Schedule card's event editor, rebuilt in this card - one
   square sheet on the card's own background with the priority's colour along its top
   (where the event editor carries the calendar's), labelled rows in banded groups,
   pickers that open inline under their row, folds for what is optional, and Cancel /
   Add at the foot, pinned so they never scroll away.

   A rule is a list of CONDITIONS, all of which must hold, each one a sentence of chips:
   "[Garage Door] [is] [Open]". The form compiles to an Alert2 config (compileRule) and
   is itself kept in the config's `rule` field, so the builder can open the rule again.
   What the rule says right now is shown as it is built: the condition and message are
   rendered live by Home Assistant (render_template). */

/* The Health monitor's checks, built in: one per tab of the Health view, asked by STATUS,
   worded and coloured exactly as the Health view words and colours them. `scope` is the
   summary attribute that says which entities the tab is about - its devices (an entity with
   a device), its helpers (one without), or whatever has a battery. No Signal Health: a
   Bluetooth sensor's signal moves with whichever proxy hears it, so it is no alert. */
const H_STATUS = {
  Unavailable: { list: "offline_entities", tone: "#F85149" },
  "Not updating": { list: "stale_entities", tone: "#8B949E" },
  "Low battery": { list: "low_battery_entities", tone: "#DB6D28" },
  "Weak signal": { list: "poor_signal_entities", tone: "#EFC53F" },
  Failed: { list: "failed_entities", tone: "#F85149" },
  OK: { tone: "#3FB950" },
};
const HEALTH = {
  dev: { statuses: ["Unavailable", "Not updating", "OK"], scope: "device_ids", inScope: true, all: "All devices are OK" },
  bat: { statuses: ["Low battery", "Unavailable", "OK"], scope: "battery_levels", inScope: true, all: "All batteries are OK" },
  hlp: { statuses: ["Failed", "Unavailable", "Not updating", "OK"], scope: "device_ids", inScope: false, all: "All helpers are OK" },
};
/* Time and calendar: reminders, and anything that should only count at certain times. */
/* The list a condition is picked from, as iOS Settings rows: an icon tile, a name, a line
   under it. The Health monitor leads, in a white tile with the Health heart; one row each for
   "Health monitor" and "Time or calendar" - the condition's own row then chooses which. */
const KIND_ROWS = [
  { id: "health", label: "Health monitor", sub: "Built in: devices, batteries and helpers", icon: "heart", lead: true },
  { id: "time", label: "Time or calendar", sub: "A time of day, or a calendar event such as garbage collection", icon: "clock" },
  { id: "state", label: "An entity is in a state", sub: "A door is open, a switch is off", icon: "toggle" },
  { id: "numeric", label: "A value is above or below a number", sub: "A temperature above 26", icon: "gauge" },
  { id: "template", label: "A template is true", sub: "Jinja, for anything else", icon: "braces" },
];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];   // Python's weekday() order
const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return [h || 0, m || 0]; };
const pad2 = (n) => String(n).padStart(2, "0");
const fmtHM = (s) => { const [h, m] = hm(s); return fmtTime(new Date(2000, 0, 1, h, m).getTime()); };

/* A state's usual values by domain, so "is" offers a list rather than a blank. */
const DOMAIN_STATES = {
  binary_sensor: ["on", "off"], input_boolean: ["on", "off"], switch: ["on", "off"],
  light: ["on", "off"], fan: ["on", "off"], automation: ["on", "off"], script: ["on", "off"],
  siren: ["on", "off"], remote: ["on", "off"], humidifier: ["on", "off"],
  cover: ["open", "closed", "opening", "closing"], valve: ["open", "closed", "opening", "closing"],
  lock: ["locked", "unlocked", "jammed", "open"], person: ["home", "not_home"],
  device_tracker: ["home", "not_home"], sun: ["above_horizon", "below_horizon"],
  media_player: ["off", "on", "idle", "playing", "paused"],
  vacuum: ["cleaning", "docked", "returning", "idle", "error"],
  alarm_control_panel: ["disarmed", "armed_home", "armed_away", "armed_night", "arming", "pending", "triggered"],
};

const slugify = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
// a value inside a Jinja expression
const jstr = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
// plain text in a template, with nothing in it that Jinja could read as a tag
const jtext = (s) => String(s).replace(/[{}]/g, (c) => `{{ '${c}' }}`);
const isNum = (v) => v !== "" && v != null && Number.isFinite(Number(v));

/* The Health monitor's groups, by the summary sensor each one keeps. */
function healthGroups(hass) {
  return Object.keys(hass?.states || {})
    .map((id) => /^sensor\.entity_availability_([a-z0-9_]+)_group_summary$/.exec(id)?.[1])
    .filter(Boolean).sort();
}

/* An event alert's triggers - "when something happens" - picked from a list like the
   conditions'. Kept in the same list as the conditions (form `conds`, each with `trig`), so
   every picker, drum and animation of a condition row works for a trigger row too. */
const TRIGGER_ROWS = [
  { id: "hev", label: "Health monitor", sub: "A device goes offline, a battery runs low, a job fails", icon: "heart", lead: true },
  { id: "tstate", label: "An entity changes", sub: "A door opens, a button is pressed, a camera sees a person", icon: "toggle" },
  { id: "tat", label: "A time of day", sub: "Every evening at 8 PM, on the days you pick", icon: "clock" },
  { id: "tcal", label: "A calendar event starts", sub: "Garbage collection, the evening before", icon: "calendar" },
  { id: "tnum", label: "A value crosses a number", sub: "The freezer rises above -10", icon: "gauge" },
  { id: "tyaml", label: "A trigger in YAML", sub: "Home Assistant's own trigger, for anything else", icon: "braces" },
];
const TRIG_KINDS = TRIGGER_ROWS.map((k) => k.id);

/* The (i) beside "Fires" - the user's own words, one panel per kind: side by side on a
   tablet, one above the other on a phone. */
const FIRES_INFO = `<div class="ipcols">
  <section class="ipsec">
    <div class="iph">While true</div>
    <div class="iptag">A situation</div>
    <div class="ipd">The alert mirrors something that is the case right now, so it turns OK by itself when
      that stops. It answers "is something wrong right now?"</div>
    <div class="ipneed">You need it when</div>
    <ul class="iplist">
      <li>It must last a while first: "garage door open for 10 minutes", which you can only say with For.</li>
      <li>It should clean up after itself: "devices offline" goes away when they come back.</li>
    </ul>
  </section>
  <section class="ipsec">
    <div class="iph">When it happens</div>
    <div class="iptag">A moment</div>
    <div class="ipd">It fires the instant something happens, every time, and doesn't care whether the thing
      is still going on. It stays until you clear it, or until "Stays firing" runs out.</div>
    <div class="ipneed">You need it when</div>
    <ul class="iplist">
      <li>There's no lasting state to watch: a doorbell ring or a button press has no "is" to stay true,
        or it sorted itself out before you looked.</li>
      <li>You want every occurrence on its own: "this device went offline", each time, with its name.</li>
    </ul>
  </section>
</div>`;
/* The (i) beside a numeric condition's Margin - one panel, as the Fires panels. */
const MARGIN_INFO = `<div class="ipcols one">
  <section class="ipsec">
    <div class="iph">Margin</div>
    <div class="iptag">When it turns OK again</div>
    <div class="ipd">Without a margin, a value that wobbles around its limit makes the alert fire, turn OK and
      fire again, over and over. With one, the alert still fires at the limit, but turns OK only once the
      value is back by the margin: "above -10" with a margin of 2 turns OK at -12.</div>
    <div class="ipneed">You need it when</div>
    <ul class="iplist">
      <li>The value wobbles near the limit: a freezer, humidity, CO2, or a battery that bounces between 19
        and 21 %.</li>
      <li>OK should mean properly back to normal, not a hair under the limit.</li>
    </ul>
  </section>
</div>`;
/* The (i) beside Actions. */
const ACTIONS_INFO = `<div class="ipcols one">
  <section class="ipsec">
    <div class="iph">Actions</div>
    <div class="iptag">What it does when it fires</div>
    <div class="ipd">Each time the alert fires, it runs the scripts you pick here, all at once. A script is told
      which alert fired ({{ alert }}) and what it says ({{ message }}), so it can announce it. Snoozing the
      alert does not stop them.</div>
    <div class="ipneed">You need it when</div>
    <ul class="iplist">
      <li>Something should happen without you: close the water valve on a leak, or turn the porch light on
        when the garage door is left open.</li>
      <li>You want to see or hear it: flash a lamp red, or say "garbage tomorrow" on the speakers.</li>
    </ul>
  </section>
</div>`;
const NOTIFY_INFO = `<div class="ipcols one">
  <section class="ipsec">
    <div class="iph">Notify</div>
    <div class="iptag">Who hears about it when it fires</div>
    <div class="ipd">A push goes to each user you pick: every phone or tablet signed in to the Home Assistant app as
      them, a new one too (Everyone: every device with the app). Tapping it opens the alert, and its buttons clear or
      snooze it without opening anything. A banner drops in across the top of each dashboard you pick - on every
      page, or (Show on: Home page, at the top of that list) on its Home page alone. Both go away by themselves once the
      alert is OK again, cleared or snoozed.</div>
    <div class="ipneed">You need it when</div>
    <ul class="iplist">
      <li>Someone should know even when nobody is looking at a screen: a water leak, or the garage door left
        open at night.</li>
      <li>Whoever walks past the wall tablet should see it: the garbage goes out tomorrow.</li>
    </ul>
  </section>
</div>`;
/* What the Health monitor announces on the bus, by part of Health: what it is called here,
   the event, and what the message says. */
const HEV = {
  dev: { noun: "device", whats: [["offline", "goes offline"], ["recovered", "comes back online"], ["stale", "stops updating"]] },
  bat: { noun: "battery", whats: [["low", "runs low"]] },
  hlp: { noun: "helper", whats: [["failed", "fails"], ["offline", "goes offline"], ["recovered", "comes back online"]] },
};
const HEV_EVENT = {
  offline: "entity_availability_offline", recovered: "entity_availability_recovered",
  stale: "entity_availability_stale", low: "entity_availability_low_battery", failed: "entity_availability_job_failed",
};
const HEV_SAYS = { offline: "went offline", recovered: "is back online", stale: "stopped updating", low: "battery low", failed: "failed" };
const hevWhat = (c) => (HEV[c.part]?.whats.find(([k]) => k === c.what) || HEV[c.part]?.whats[0] || [])[1] || "";

function newCond(kind, hass, conds = []) {
  const group = healthGroups(hass)[0] || "home_devices";
  switch (kind) {
    case "state": return { kind, entity: "", op: "is", value: "" };
    case "numeric": return { kind, entity: "", op: "above", value: "" };
    case "template": return { kind, template: "" };
    case "time": return { kind, from: "18:00", to: "21:00", days: [0, 1, 2, 3, 4, 5, 6] };
    case "calendar": return { kind, entity: "", mins: 1440 };
    // triggers
    case "hev": return { kind, trig: true, part: "dev", what: "offline", group };
    case "tstate": return { kind, trig: true, entity: "", value: "" };
    case "tat": return { kind, trig: true, at: "20:00", days: [0, 1, 2, 3, 4, 5, 6] };
    case "tcal": return { kind, trig: true, entity: "", mins: 0 };
    case "tnum": return { kind, trig: true, entity: "", op: "above", value: "" };
    case "tyaml": return { kind, trig: true, template: "" };
    default: {
      // the same Health condition twice says nothing new: start on a status not used yet
      const used = new Set(conds.filter((c) => c.kind === kind).map((c) => c.status));
      return { kind, group, status: HEALTH[kind].statuses.find((x) => !used.has(x)) || HEALTH[kind].statuses[0] };
    }
  }
}

const nameOf = (hass, eid) => hass?.states?.[eid]?.attributes?.friendly_name || eid;
function stateLabel(hass, eid, v) {
  const st = hass?.states?.[eid];
  try { if (st && hass.formatEntityState) return hass.formatEntityState(st, v); } catch { /* raw it is */ }
  return v;
}

/* "1 day 6 h", "45 min"; zero says what it means where it is used. */
function fmtMins(m, zero = "Immediately") {
  if (!m) return zero;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  return [d && `${d} day${d > 1 ? "s" : ""}`, h && `${h} h`, mi && `${mi} min`].filter(Boolean).join(" ");
}

/* A template condition joins the others as an EXPRESSION; one written with {% %} can only
   stand alone. */
function templateExpr(t) {
  const s = String(t || "").trim();
  if (!s) return null;
  const m = /^\{\{([\s\S]*)\}\}$/.exec(s);
  if (m && !/\{\{|\}\}|\{%|%\}/.test(m[1])) return { expr: m[1].trim() };
  if (!/\{[{%#]/.test(s)) return { expr: s };
  return { raw: s };
}

const summaryOf = (c) => `'sensor.entity_availability_${/^[a-z0-9_]+$/.test(c.group || "") ? c.group : "home_devices"}_group_summary'`;

/* What a Health status is called on screen, as the Health card calls it: Not updating says
   the window it is judged over, its group's staleness threshold - "Not Updating (24h)". The
   value in the rule and the address (not_updating) stays as it is. */
function statusWord(status, hass, group) {
  if (status !== "Not updating") return status;
  const m = Math.round(Number(hass?.states?.[summaryOf({ group }).slice(1, -1)]?.attributes?.staleness_minutes) || 0);
  return m ? `Not Updating (${m % 60 ? `${m}m` : `${m / 60}h`})` : "Not Updating";
}

/* One condition as a Jinja boolean expression ({expr}), a whole template ({raw}), or
   null while it is not finished. `mins`: a Health "Unavailable" counted per device - each
   device must have been offline that long, by its own offline-since time. */
function condExpr(c, mins = 0) {
  const h = HEALTH[c.kind];
  if (h) {
    const sum = summaryOf(c);
    const scope = `state_attr(${sum}, '${h.scope}') or {}`;
    const sel = h.inScope ? "select" : "reject";
    if (c.status === "OK") {
      const lists = h.statuses.filter((x) => x !== "OK").map((x) => `(state_attr(${sum}, '${H_STATUS[x].list}') or [])`);
      return { expr: `((${lists.join(" + ")}) | ${sel}('in', ${scope}) | list | count == 0)` };
    }
    const st = H_STATUS[c.status];
    if (!st?.list) return null;
    if (c.status === "Unavailable" && mins > 0) {
      return { expr: `((state_attr(${sum}, 'offline_since') or {}).items() | selectattr(0, 'in', state_attr(${sum}, 'offline_entities') or []) | ${sel}attr(0, 'in', ${scope}) | map(attribute=1) | map('as_datetime') | select('lt', now() - timedelta(minutes=${mins})) | list | count > 0)` };
    }
    if (c.status === "Not updating" && mins > 0) {
      // marked Not updating once its device was last heard longer ago than the group's
      // staleness time: in that status for `mins` once it is older than both together
      return { expr: `((state_attr(${sum}, 'stale_since') or {}).items() | selectattr(0, 'in', state_attr(${sum}, 'stale_entities') or []) | ${sel}attr(0, 'in', ${scope}) | map(attribute=1) | map('as_datetime') | select('lt', now() - timedelta(minutes=${mins} + ((state_attr(${sum}, 'staleness_minutes') or 0) | float(0)))) | list | count > 0)` };
    }
    return { expr: `((state_attr(${sum}, '${st.list}') or []) | ${sel}('in', ${scope}) | list | count > 0)` };
  }
  switch (c.kind) {
    case "state":
      return c.entity && c.value !== "" ? { expr: `${c.op === "not" ? "not " : ""}is_state(${jstr(c.entity)}, ${jstr(c.value)})` } : null;
    case "numeric":
      return c.entity && isNum(c.value)
        ? { expr: `(has_value(${jstr(c.entity)}) and states(${jstr(c.entity)}) | float(0) ${c.op === "below" ? "<" : ">"} ${Number(c.value)})` }
        : null;
    case "time": {
      // a window on the chosen days; one that ends before it starts runs past midnight;
      // the same start and end is the whole day
      const days = [...new Set(c.days || [])].filter((d) => d >= 0 && d <= 6).sort();
      if (!days.length) return null;
      const from = `${pad2(hm(c.from)[0])}:${pad2(hm(c.from)[1])}`, to = `${pad2(hm(c.to)[0])}:${pad2(hm(c.to)[1])}`;
      const window = from === to ? "" : from < to
        ? `(today_at('${from}') <= now() < today_at('${to}'))`
        : `(now() >= today_at('${from}') or now() < today_at('${to}'))`;
      const onDays = days.length === 7 ? "" : `now().weekday() in [${days.join(", ")}]`;
      const parts = [onDays, window].filter(Boolean);
      return { expr: parts.length ? `(${parts.join(" and ")})` : "true" };
    }
    case "calendar":
      // an event in progress, or the next one starting within the time set
      return c.entity ? { expr: `(is_state(${jstr(c.entity)}, 'on') or (state_attr(${jstr(c.entity)}, 'start_time') is not none and 0 <= as_timestamp(state_attr(${jstr(c.entity)}, 'start_time'), 0) - as_timestamp(now()) <= ${Math.max(0, Number(c.mins) || 0) * 60}))` } : null;
    default:
      return templateExpr(c.template);
  }
}

/* What a condition says when it holds: the part of the alert's message it owns. A Health
   condition names what is in that status, in the Health monitor's own names. */
function condMsg(c, hass, mins = 0) {
  const h = HEALTH[c.kind];
  if (h) {
    if (c.status === "OK") return jtext(h.all);
    const st = H_STATUS[c.status];
    if (!st?.list) return "";
    const name = "names.get(eid, state_attr(eid, 'friendly_name') or eid)";
    let pre = "", when = "", item = `${name} ~ ' ${c.status.toLowerCase()}'`;
    if (c.status === "Unavailable") {
      pre = "{% set since = state_attr(S, 'offline_since') or {} %}";
      if (mins > 0) when = ` and (not since.get(eid) or as_datetime(since.get(eid)) < now() - timedelta(minutes=${mins}))`;
      item = `${name} ~ (' (offline since ' ~ (as_timestamp(since.get(eid)) | timestamp_custom('%a, %b %-d, %-I:%M %p')) ~ ')' if since.get(eid) else ' unavailable')`;
    } else if (c.status === "Not updating") {
      pre = "{% set seen = state_attr(S, 'stale_since') or {} %}{% set stale = (state_attr(S, 'staleness_minutes') or 0) | float(0) %}";
      if (mins > 0) when = ` and (not seen.get(eid) or as_datetime(seen.get(eid)) < now() - timedelta(minutes=${mins} + stale))`;
      item = `${name} ~ (' (no update since ' ~ (as_timestamp(seen.get(eid)) | timestamp_custom('%a, %b %-d, %-I:%M %p')) ~ ')' if seen.get(eid) else ' not updating')`;
    } else if (c.status === "Low battery") {
      pre = "{% set lv = state_attr(S, 'battery_levels') or {} %}";
      item = `${name} ~ ' ' ~ lv.get(eid) ~ '%'`;
    } else if (c.status === "Weak signal") {
      pre = "{% set lv = state_attr(S, 'signal_levels') or {} %}{% set un = state_attr(S, 'signal_units') or {} %}";
      item = `${name} ~ ' ' ~ lv.get(eid) ~ ' ' ~ (un.get(eid) or 'dBm')`;
    }
    return `{% set S = ${summaryOf(c)} %}{% set names = state_attr(S, 'display_names') or {} %}{% set scope = state_attr(S, '${h.scope}') or {} %}{% set ns = namespace(n=[]) %}${pre}{% for eid in state_attr(S, '${st.list}') or [] if eid ${h.inScope ? "in" : "not in"} scope${when} %}{% set ns.n = ns.n + [${item}] %}{% endfor %}{{ ns.n | unique | join('\\n') }}`;
  }
  switch (c.kind) {
    case "state":
      return c.op === "not"
        ? `${jtext(nameOf(hass, c.entity))} is {{ states(${jstr(c.entity)}) }}`
        : `${jtext(nameOf(hass, c.entity))} is ${jtext(stateLabel(hass, c.entity, c.value))}`;
    case "numeric": {
      const unit = hass?.states?.[c.entity]?.attributes?.unit_of_measurement;
      return `${jtext(nameOf(hass, c.entity))} is {{ states(${jstr(c.entity)}) }}${unit ? jtext(` ${unit}`) : ""}`;
    }
    case "calendar": {
      // "Bio · Tomorrow, 4:00 AM" - the card's own date format; "happening now" while it runs
      if (!c.entity) return "";
      const E = jstr(c.entity);
      const clock = LOCALE.hour12 === false ? "%H:%M" : "%-I:%M %p";
      // nothing at all while the calendar has no event (still loading, or none coming): a
      // made-up date would read as an item
      return `{% set st = state_attr(${E}, 'start_time') %}{% if st %}{% set ts = as_timestamp(st, 0) %}{% set d = ts | timestamp_custom('%Y-%m-%d') %}{{ state_attr(${E}, 'message') or ${jstr(nameOf(hass, c.entity))} }} · {{ 'happening now' if is_state(${E}, 'on') else ('Today' if d == now().strftime('%Y-%m-%d') else 'Tomorrow' if d == (now() + timedelta(days=1)).strftime('%Y-%m-%d') else ts | timestamp_custom('%a, %b %-d')) ~ ('' if state_attr(${E}, 'all_day') else ', ' ~ (ts | timestamp_custom('${clock}'))) }}{% endif %}`;
    }
    default:
      return "";
  }
}

/* "For" counted per device: when every condition is a Health "Unavailable", each device
   must have been offline that long by its OWN offline-since time - which outlives a
   restart, where Alert2's delay (delay_on_secs) starts again from nothing. Otherwise the
   delay it is. */
const plainConds = (f) => f.conds.filter((c) => !c.trig);
// the statuses whose start the Health monitor keeps per device: offline_since (across restarts),
// and for Not updating when the whole device was last heard (stale_since) plus the group's
// staleness time
const PER_DEVICE_FOR = new Set(["Unavailable", "Not updating"]);
const forPerDevice = (f) => { const cs = plainConds(f); return cs.length > 0 && cs.every((c) => HEALTH[c.kind] && PER_DEVICE_FOR.has(c.status)); };

// "Each device, from when it went offline (or stopped updating)"
function perDeviceHint(f) {
  const st = new Set(plainConds(f).map((c) => c.status));
  const from = [st.has("Unavailable") && "went offline", st.has("Not updating") && "stopped updating"].filter(Boolean).join(" or ");
  return `Each device, from when it ${from}`;
}

const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth"];

/* A new rule's id, never typed: alert2.rule_<id>. Its name and category can then change
   freely - the entity id, and with it the history, stays. */
function newRuleKey(hass) {
  for (;;) {
    const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
    if (!hass?.states?.[`alert2.rule_${name}`]) return { domain: "rule", name };
  }
}

/* The scripts a rule runs when it fires -> Alert2's actions_on (JSON text, as the rule API
   takes structured fields). Each script is told the alert's name and what it said; several
   run side by side, so one failing does not hold up the rest (and the failure still reaches
   the timeline). An event alert queues them: every fire runs them, in turn. */
function actionsOn(f, title, event) {
  const scripts = (f.actions || []).filter((x) => /^script\.[a-z0-9_]+$/.test(x));
  if (!scripts.length) return null;
  const call = (eid) => ({ action: eid, data: { alert: jtext(title || "Alert"), message: "{{ alert_message }}" } });
  return JSON.stringify({ mode: event ? "queued" : "single",
                          actions: scripts.length === 1 ? [call(scripts[0])] : [{ parallel: scripts.map(call) }] });
}

/* The form -> an Alert2 config, plus what is still missing. `condition` and `message`
   are there as soon as the conditions are complete, for the live preview. `key`: the
   rule's domain and name - its entity id. */
function compileRule(f, hass, key) {
  if (f.type === "event") return compileEvent(f, hass, key);
  if (f.type === "builtin") return compileBuiltin(f, hass, key);
  const errors = [];
  const title = f.title.trim();
  if (!title) errors.push("Give the alert a name.");
  // the rows that are conditions (their places in the form, for the "holds now" dots)
  const holdIdx = f.conds.map((c, i) => (c.trig ? -1 : i)).filter((i) => i >= 0);
  const conds = holdIdx.map((i) => f.conds[i]);
  if (!conds.length) errors.push("Add a condition: what should the alert watch?");
  const perDevice = forPerDevice(f);
  const mins = perDevice ? f.forMins : 0;
  const exprs = conds.map((c) => condExpr(c, mins));
  exprs.forEach((e, i) => {
    if (!e) errors.push(`Finish the ${ORDINAL[i] || `#${i + 1}`} condition.`);
  });
  const raw = exprs.find((e) => e?.raw);
  if (raw && conds.length > 1) errors.push("A template written with {% %} can only be the one condition.");
  const complete = conds.length && exprs.every(Boolean) && !(raw && conds.length > 1);
  const any = f.match === "any";
  /* A margin: the numeric condition that has one becomes Alert2's threshold, which fires past
     the number and turns OK only once the value is back by the margin (hysteresis). Alert2
     keeps one threshold per alert, joined to the other conditions with And. */
  const margined = conds.filter((c) => c.kind === "numeric" && String(c.margin ?? "").trim() !== "");
  if (margined.some((c) => !(isNum(c.margin) && Number(c.margin) >= 0))) errors.push("A margin is a number, 0 or more.");
  const withMargin = margined.filter((c) => Number(c.margin) > 0);
  if (withMargin.length > 1) errors.push("Only one condition can have a margin.");
  if (withMargin.length && any && conds.length > 1) errors.push("A margin needs And between the conditions: switch Or to And, or remove the margin.");
  const thr = withMargin.length === 1 && !(any && conds.length > 1) ? withMargin[0] : null;
  const condition = !complete ? "" : raw ? raw.raw : `{{ ${exprs.map((e) => `(${e.expr})`).join(any ? " or " : " and ")} }}`;
  // each condition's part, joined at render time: a part whose condition does not hold
  // (with Any) says nothing, and two conditions naming the same thing name it once
  const parts = conds.map((c) => condMsg(c, hass, mins)).filter(Boolean);
  const auto = parts.length < 2 ? parts.join("") :
    parts.map((x, i) => `{% set part${i} %}${x}{% endset %}`).join("") +
    `{{ [${parts.map((_, i) => `part${i}`).join(", ")}] | map('trim') | reject('eq', '') | unique | join('\\n') }}`;
  // which conditions hold right now, for the editor (one boolean per condition)
  const holds = complete && !raw && conds.length > 1 ? `{{ [${exprs.map((e) => `(${e.expr})`).join(", ")}] | tojson }}` : "";
  const message = (f.message || "").trim() || auto || jtext(title || "Alert");
  const { domain, name } = key;
  const cfg = {
    domain, name, friendly_name: title, category: slugify(f.category) || "general",
    priority: f.priority, condition, message, display_msg: message,
    allow_clear: f.clearable ? "true" : "false",
    rule: JSON.stringify({ v: 1, conds, match: any ? "any" : "all", for_mins: f.forMins,
                           message: (f.message || "").trim() || null, actions: f.actions || [] }),
  };
  const acts = actionsOn(f, title, false);
  if (acts) cfg.actions_on = acts;
  if (f.forMins > 0 && !perDevice) cfg.delay_on_secs = String(f.forMins * 60);
  if (thr && complete && isNum(thr.value)) {
    // the margined value as the threshold; the rest stays the condition, with the value having
    // one (unavailable is not 0) - the preview keeps judging the whole rule plainly, as a
    // saved or edited rule starts out
    const E = jstr(thr.entity);
    const rest = exprs.filter((_, k) => conds[k] !== thr).map((e) => `(${e.expr})`);
    cfg.condition = `{{ ${[`has_value(${E})`, ...rest].join(" and ")} }}`;
    // as text, as every value the rule API takes (Alert2 reads "2" as the number)
    cfg.threshold = { value: `{{ states(${E}) | float(0) }}`, hysteresis: String(Number(thr.margin)),
                      [thr.op === "below" ? "minimum" : "maximum"]: String(Number(thr.value)) };
  }
  if (f.description.trim()) cfg.description = f.description.trim();
  Object.assign(cfg, notifyCfg(f, title));
  const entityId = `alert2.${slugify(`${domain}_${name}`)}`;
  const rows = healthRowsTpl(f, mins);
  if (f.linkDesktop.trim()) cfg.link = expandOnly(f.linkDesktop.trim(), entityId, rows);
  if (f.linkMobile.trim()) cfg.link_mobile = expandOnly(f.linkMobile.trim(), entityId, rows);
  return { cfg, errors, condition, message, auto, holds, holdIdx, entityId };
}

/* One trigger -> Alert2's trigger (Home Assistant's syntax, with an id), the filter it needs
   at the moment it fires (a Jinja expression on `trigger`), what the message says about it
   (Jinja, on `trigger`), and the same in plain words for the editor. null while unfinished. */
function trigSpec(c, id, hass) {
  switch (c.kind) {
    case "hev": {
      const S = summaryOf(c);
      const entry = hass?.states?.[S.slice(1, -1)]?.attributes?.entry_id;
      const trigger = { trigger: "event", event_type: HEV_EVENT[c.what] || HEV_EVENT.offline, id };
      if (entry) trigger.event_data = { entry_id: entry };   // this Health group's own events
      const e = "trigger.event.data.entity_id";
      // devices are what has a device; helpers are what has none (a job is always a helper)
      const filter = c.part === "dev" ? `${e} in (state_attr(${S}, 'device_ids') or {})`
        : c.part === "hlp" && c.what !== "failed" ? `${e} not in (state_attr(${S}, 'device_ids') or {})` : "";
      const name = `{% set e = ${e} %}{% set n = (state_attr(${S}, 'display_names') or {}).get(e, state_attr(e, 'friendly_name') or e) %}{{ n }}`;
      const tail = c.what === "low"
        ? ` battery low{% set lv = (state_attr(${S}, 'battery_levels') or {}).get(e) %}{% if lv is not none %} ({{ lv }}%){% endif %}`
        : c.what === "failed" ? ` failed{% if trigger.event.data.error %}: {{ trigger.event.data.error }}{% endif %}`
        : ` ${HEV_SAYS[c.what]}`;
      return { trigger, filter, msg: name + tail, sample: `‹${HEV[c.part].noun}› ${HEV_SAYS[c.what]}` };
    }
    case "tstate": {
      if (!c.entity || c.value === "") return null;
      const ev = c.entity.startsWith("event.");
      // never on Home Assistant starting up or an entity dropping out and back. An event entity
      // is "unknown" until its first event - after every restart, for some (UniFi Protect's
      // doorbell) - so from "unknown" it is a real event: the first ring after a restart.
      const trigger = { trigger: "state", entity_id: c.entity, id, not_from: ev ? ["unavailable"] : ["unavailable", "unknown"] };
      if (ev || c.value === "*") trigger.not_to = ["unavailable", "unknown"];   // any change of state, not of attributes
      else trigger.to = c.value;
      const filter = ev && c.value !== "*" ? `trigger.to_state.attributes.event_type == ${jstr(c.value)}` : "";
      const nm = nameOf(hass, c.entity);
      if (ev) {
        return { trigger, filter, msg: `{{ trigger.to_state.name }}{% if trigger.to_state.attributes.event_type %} · {{ trigger.to_state.attributes.event_type | replace('_', ' ') }}{% endif %}`,
                 sample: `${nm} · ${c.value === "*" ? "‹the event›" : c.value.replace(/_/g, " ")}` };
      }
      return c.value === "*"
        ? { trigger, filter, msg: "{{ trigger.to_state.name }} changed to {{ trigger.to_state.state }}", sample: `${nm} changed to ‹its new state›` }
        : { trigger, filter, msg: `{{ trigger.to_state.name }} changed to ${jtext(stateLabel(hass, c.entity, c.value))}`,
            sample: `${nm} changed to ${stateLabel(hass, c.entity, c.value)}` };
    }
    case "tat": {
      const days = [...new Set(c.days || [])].filter((d) => d >= 0 && d <= 6).sort();
      if (!days.length) return null;
      const [h, m] = hm(c.at);
      return { trigger: { trigger: "time", at: `${pad2(h)}:${pad2(m)}:00`, id },
               filter: days.length === 7 ? "" : `now().weekday() in [${days.join(", ")}]`, msg: "", sample: "" };
    }
    case "tcal": {
      if (!c.entity) return null;
      // "Only events called" with no title yet: not finished
      if (c.event?.match === "title" && !evFiltered(c.event)) return null;
      const mins = Math.max(0, Number(c.mins) || 0);
      const off = `${mins ? "-" : ""}${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}:00`;
      const clock = LOCALE.hour12 === false ? "%H:%M" : "%-I:%M %p";
      // "Bio · Tomorrow, 4:00 AM" - the card's own date format
      const msg = `{% set ce = trigger.calendar_event %}{% set ts = as_timestamp(ce.start, 0) %}{% set d = ts | timestamp_custom('%Y-%m-%d') %}{{ ce.summary }} · {{ ('Today' if d == now().strftime('%Y-%m-%d') else 'Tomorrow' if d == (now() + timedelta(days=1)).strftime('%Y-%m-%d') else ts | timestamp_custom('%a, %b %-d')) ~ ('' if ce.all_day else ', ' ~ (ts | timestamp_custom('${clock}'))) }}`;
      // a reminder made on one event (the Simple Schedule card's Alert section, through the
      // fork's hm_reminders) lets only that event through; one by title, every event so called
      const named = c.event?.match === "title" ? c.event.title.trim() : c.event?.summary;
      return { trigger: { trigger: "calendar", event: "start", entity_id: c.entity, offset: off, id },
               filter: evFiltered(c.event) ? calEventFilter(c.event) : "", msg,
               sample: named ? `${named} · ‹when it starts›` : "‹the event› · ‹when it starts›" };
    }
    case "tnum": {
      if (!c.entity || !isNum(c.value)) return null;
      const unit = hass?.states?.[c.entity]?.attributes?.unit_of_measurement;
      return { trigger: { trigger: "numeric_state", entity_id: c.entity, [c.op === "below" ? "below" : "above"]: Number(c.value), id },
               filter: "", msg: `{{ trigger.to_state.name }} is {{ trigger.to_state.state }}${unit ? jtext(` ${unit}`) : ""}`,
               sample: `${nameOf(hass, c.entity)} is ‹its value›${unit ? ` ${unit}` : ""}` };
    }
    case "tyaml":
      return c.template.trim() ? { raw: c.template, filter: "", msg: "", sample: "" } : null;
    default:
      return null;
  }
}

/* A calendar trigger's event filter: one event (its uid), one occurrence of a series (uid and
   recurrence_id), every occurrence (the uid) - or every event with a title, trimmed and in any
   case ("PrB" == " prb"). The fork's hm_reminders.event_filter writes the very same expression -
   change both together. */
const titleKey = (s) => String(s ?? "").trim().toLowerCase();
// whether a calendar trigger's event filter is complete enough to let anything through
const evFiltered = (ev) => !!ev && (ev.match === "title" ? !!titleKey(ev.title) : !!ev.uid);
function calEventFilter(ev) {
  if (ev.match === "title") {
    return `(trigger.calendar_event.summary | default('', true) | trim | lower) == ${jstr(titleKey(ev.title))}`;
  }
  const uid = `trigger.calendar_event.uid == ${jstr(ev.uid)}`;
  return ev.match === "event" && ev.recurrence_id
    ? `${uid} and trigger.calendar_event.recurrence_id == ${jstr(ev.recurrence_id)}` : uid;
}

/* For the editor's preview: a stand-in for the event a trigger waits for, made from what
   Home Assistant knows now (Jinja that sets `trigger`), and - where it can be known - when it
   would fire next (a Jinja timestamp). The calendar's next event; the entity as it is; a device
   that is offline now (or any device of that part of Health). */
function trigSample(c, hass) {
  switch (c.kind) {
    case "hev": {
      const S = summaryOf(c);
      const list = { offline: "offline_entities", recovered: "offline_entities", stale: "stale_entities",
                     low: "low_battery_entities", failed: "failed_entities" }[c.what] || "offline_entities";
      const fall = { low: "battery_levels", failed: "job_runs" }[c.what] || (c.part === "hlp" ? "display_names" : "device_ids");
      const scope = c.part === "dev" && c.what !== "low" ? ` | select('in', state_attr(${S}, 'device_ids') or {})`
        : c.part === "hlp" && c.what !== "failed" ? ` | reject('in', state_attr(${S}, 'device_ids') or {})` : "";
      return { prelude: `{% set e = (((state_attr(${S}, '${list}') or [])${scope} | list) + ((state_attr(${S}, '${fall}') or {})${scope} | list)) | first %}` +
        `{% set trigger = {'id': 't0', 'event': {'data': {'entity_id': e, 'error': ((state_attr(${S}, 'job_runs') or {}).get(e) or {}).get('error')}}} %}`,
        at: "none", ok: "e is defined and e is not none" };
    }
    case "tstate":
    case "tnum": {
      const E = jstr(c.entity);
      const st = c.kind === "tstate" && c.value !== "*" && !c.entity.startsWith("event.") ? jstr(c.value) : `states(${E})`;
      return { prelude: `{% set trigger = {'id': 't0', 'to_state': {'name': state_attr(${E}, 'friendly_name') or ${E}, 'state': ${st}, 'attributes': (states[${E}].attributes if states[${E}] else {})}} %}`,
               at: "none", ok: "true" };
    }
    case "tcal": {
      const E = jstr(c.entity);
      return { prelude: `{% set trigger = {'id': 't0', 'calendar_event': {'summary': state_attr(${E}, 'message'), 'start': state_attr(${E}, 'start_time'), 'end': state_attr(${E}, 'end_time'), 'all_day': state_attr(${E}, 'all_day')}} %}`,
               at: `(as_timestamp(state_attr(${E}, 'start_time')) - ${Math.max(0, Number(c.mins) || 0) * 60}) if state_attr(${E}, 'start_time') else none`,
               ok: `state_attr(${E}, 'start_time') is not none` };
    }
    default:
      return { prelude: "{% set trigger = {'id': 't0'} %}", at: "none", ok: "true" };
  }
}

/* A time of day's next firing, on its days, in ms. */
function nextAt(c) {
  const [h, m] = hm(c.at);
  const days = new Set(c.days || []);
  for (let k = 0; k < 8; k++) {
    const d = new Date();
    d.setDate(d.getDate() + k);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > Date.now() && days.has((d.getDay() + 6) % 7)) return d.getTime();
  }
  return null;
}

/* "When it happens": an Alert2 event alert. It fires each time a trigger does and its
   filter and the "Only if" conditions hold at that moment; it has no on and off of its own.
   Any trigger fires it (their order is only their order). */
function compileEvent(f, hass, key) {
  const errors = [];
  const title = f.title.trim();
  if (!title) errors.push("Give the alert a name.");
  const trigs = f.conds.filter((c) => c.trig);
  const holdIdx = f.conds.map((c, i) => (c.trig ? -1 : i)).filter((i) => i >= 0);
  const conds = holdIdx.map((i) => f.conds[i]);
  if (!trigs.length) errors.push("Add a trigger: what should the alert wait for?");
  const built = trigs.map((c, n) => trigSpec(c, `t${n}`, hass));
  built.forEach((b, n) => { if (!b) errors.push(`Finish the ${ORDINAL[n] || `#${n + 1}`} trigger.`); });
  const yaml = built.some((b) => b?.raw);
  if (yaml && trigs.length > 1) errors.push("A trigger written in YAML can only be the one trigger.");
  const exprs = conds.map((c) => condExpr(c, 0));
  exprs.forEach((e, n) => { if (!e) errors.push(`Finish the ${ORDINAL[n] || `#${n + 1}`} condition.`); });
  const raw = exprs.find((e) => e?.raw);
  const filtered = built.some((b) => b?.filter);
  if (raw && (conds.length > 1 || filtered)) errors.push("A template written with {% %} can only be the one condition.");
  const stay = Math.max(0, Number(f.stayMins ?? 1440) || 0);
  if (!stay && !f.clearable) errors.push("Stays firing until cleared needs Can be cleared on - or a time after which it turns OK.");
  const ready = !errors.length || (errors.length === 1 && !title);
  const any = f.match === "any";
  const onlyIf = !conds.length || !exprs.every(Boolean) ? "" : raw ? "" : exprs.map((e) => `(${e.expr})`).join(any ? " or " : " and ");
  // each trigger's own filter, told apart by the trigger's id
  const filters = filtered ? built.map((b, n) => `(trigger.id == 't${n}'${b?.filter ? ` and (${b.filter})` : ""})`).join(" or ") : "";
  const condition = raw ? raw.raw : [filters, onlyIf].filter(Boolean).map((x) => `(${x})`).join(" and ");
  // the message: what happened, by trigger; a trigger with nothing to say (a time of day)
  // says the alert's name
  const name = jtext(title || "Alert");
  const auto = built.length === 1 ? built[0]?.msg || name
    : built.map((b, n) => `{% ${n ? "elif" : "if"} trigger.id == 't${n}' %}${b?.msg || name}`).join("") + `{% else %}${name}{% endif %}`;
  const message = (f.message || "").trim() || auto;
  const sample = (f.message || "").trim() ? "" : built.map((b) => b?.sample || title).filter(Boolean)[0] || title;
  const { domain, name: rname } = key;
  const cfg = {
    domain, name: rname, friendly_name: title, category: slugify(f.category) || "general",
    priority: f.priority, message,
    trigger: yaml ? built[0].raw : JSON.stringify(built.map((b) => b?.trigger)),
    allow_clear: f.clearable ? "true" : "false",
    stays_firing_mins: String(stay),
    rule: JSON.stringify({ v: 1, type: "event", conds: f.conds, match: any ? "any" : "all", stay_mins: stay,
                           message: (f.message || "").trim() || null, actions: f.actions || [] }),
  };
  const acts = actionsOn(f, title, true);
  if (acts) cfg.actions_on = acts;
  if (condition) cfg.condition = raw ? condition : `{{ ${condition} }}`;
  if (f.description.trim()) cfg.description = f.description.trim();
  Object.assign(cfg, notifyCfg(f, title));
  // "only what this alert is about" is for a rule that holds while true: an event alert has
  // no rows to name
  const noOnly = (l) => l.replace(/&hm_alert=this(?=[&#]|$)/, "");
  if (f.linkDesktop.trim()) cfg.link = noOnly(f.linkDesktop.trim());
  if (f.linkMobile.trim()) cfg.link_mobile = noOnly(f.linkMobile.trim());
  // the editor's preview: whether the "Only if" conditions would let it through now, and what
  // it would say for the first trigger's stand-in event - and when that one fires next
  const preview = raw ? raw.raw : onlyIf ? `{{ ${onlyIf} }}` : "";
  const first = trigs[0];
  const calSample = first?.kind === "tcal" && built[0] ? { entity: first.entity, mins: Math.max(0, Number(first.mins) || 0),
    ev: evFiltered(first.event) ? { uid: first.event.uid || null, recurrence_id: first.event.recurrence_id || null,
                                    match: first.event.match, title: first.event.title || null } : null } : null;
  const sm = first && built[0] && !calSample ? trigSample(first, hass) : null;
  const sampleTpl = sm ? `${sm.prelude}{% set ok = ${sm.ok} %}{% set m %}${message}{% endset %}{{ {'ok': ok, 'msg': (m | trim) if ok else '', 'at': ${sm.at}} | tojson }}` : "";
  const sampleAt = first?.kind === "tat" && built[0] ? nextAt(first) : null;
  const sampleOf = first ? { kind: first.kind, mins: Number(first.mins) || 0, entity: first.entity || "" } : null;
  const holds = !raw && conds.length > 1 && onlyIf ? `{{ [${exprs.map((e) => `(${e.expr})`).join(", ")}] | tojson }}` : "";
  return { cfg, errors, event: true, ready: ready && built.length > 0 && built.every(Boolean), preview, sample, sampleTpl, sampleAt, sampleOf, calSample,
           condition: cfg.condition || "", message, auto, holds, holdIdx, entityId: `alert2.${slugify(`${domain}_${rname}`)}` };
}

const truthy = (v) => v === true || ["true", "on", "yes", "1"].includes(String(v).trim().toLowerCase());

/* Notify -> Alert2: who gets a push (`notifier`, a list) and the fork's banner dashboards
   (`overlay`). A push is titled with the alert's name and says only its message - the name is
   not said again in front of it (annotate_messages). */
function notifyCfg(f, title) {
  const cfg = {};
  if (f.notify?.length) {
    cfg.notifier = JSON.stringify(f.notify);
    cfg.title = jtext(title || "Alert");
    cfg.annotate_messages = "false";
  }
  if (f.banner?.length) cfg.overlay = JSON.stringify(f.bannerMain ? f.banner.map((d) => `${d}/${BANNER_MAIN}`) : f.banner);
  return cfg;
}
/* Where a banner shows: a whole dashboard ("tablet-dashboard": every page, a pop-up open over
   one too) or its main page alone ("tablet-dashboard/home": that page, not a pop-up open over
   it) - the rule's "Home page only". A dashboard's home page is its Home view, /<dashboard>/home. */
const BANNER_MAIN = "home";
function bannerForm(v) {
  const list = listOf(v);
  return { banner: [...new Set(list.map((x) => x.split("/")[0]))],
           bannerMain: list.length > 0 && list.every((x) => x.endsWith(`/${BANNER_MAIN}`)) };
}
// whether this page shows a banner an alert has on those dashboards or pages (its `overlay`)
function bannerHere(overlay) {
  const path = location.pathname.replace(/\/$/, "");
  const dash = path.split("/")[1] || "";
  return overlay.some((o) => (o.includes("/") ? path === `/${o}` && !location.hash : o === dash));
}
// who was told: each phone by its device's name (the fork records them), else the notifiers
function notifiedText(e) {
  return (e.names?.length ? e.names : e.notifiers || []).join(", ");
}
// a list as a rule keeps it: a list, JSON or YAML text ("[a, b]", "- a"), or one name
function listOf(v) {
  if (Array.isArray(v)) return v.map(String);
  const t = String(v ?? "").trim();
  if (!t || t === "null") return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j.map(String);
    if (typeof j === "string") return [j];
  } catch { /* YAML, then */ }
  return t.replace(/^\[|\]$/g, "").split(/[,\n]/).map((x) => x.replace(/^[\s-]*['"]?|['"]?\s*$/g, "")).filter(Boolean);
}
// a rule pushes to users (the fork's "user:<id>": each device signed in to the app as them);
// Everyone is every device with the app
const EVERYONE = "user:*";
// the dashboards a banner can show on: all of them but the map and the hidden built-in one
function bannerDashboards(hass) {
  return Object.values(hass?.panels || {})
    .filter((p) => p.component_name === "lovelace" && p.url_path !== "map" && !(p.url_path === "lovelace" && p.show_in_sidebar === false))
    .map((p) => ({ id: p.url_path, name: p.title || p.url_path, icon: p.icon || "mdi:view-dashboard" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* A rule as Alert2 keeps it -> the editor's form. Made here, it carries the form it was
   made from (`rule`, JSON text, or YAML structure when read from its file). One without it
   - or with a condition kind this editor no longer knows - opens as what it is: its
   condition as a template, its message as its own. */
const COND_KINDS = ["state", "numeric", "template", "time", "calendar"];
function formFromCfg(cfg) {
  let rule = cfg.rule;
  if (typeof rule === "string") { try { rule = JSON.parse(rule); } catch { rule = null; } }
  const ok = !!rule && Array.isArray(rule.conds) && rule.conds.length > 0 &&
    rule.conds.every((c) => c && (HEALTH[c.kind] || COND_KINDS.includes(c.kind) || (c.trig && TRIG_KINDS.includes(c.kind))));
  // an event alert: its triggers (and "Only if" conditions) from its form, or - without
  // one - its trigger as YAML and its condition as a template
  if (cfg.trigger) {
    const raw = typeof cfg.trigger === "string" ? cfg.trigger : JSON.stringify(cfg.trigger);
    const conds = ok ? JSON.parse(JSON.stringify(rule.conds))
      : [{ kind: "tyaml", trig: true, template: raw }, ...(cfg.condition ? [{ kind: "template", template: String(cfg.condition) }] : [])];
    return {
      type: "event",
      title: String(cfg.friendly_name || cfg.name || ""),
      priority: prioKey(cfg.priority),
      category: (cfg.category || cfg.domain) && (cfg.category || cfg.domain) !== "general" ? String(cfg.category || cfg.domain) : "",
      clearable: cfg.allow_clear === undefined ? true : truthy(cfg.allow_clear),
      conds, match: ok && rule.match === "any" ? "any" : "all", forMins: 0,
      stayMins: ok && rule.stay_mins != null ? Number(rule.stay_mins)
        : cfg.stays_firing_mins != null ? Number(cfg.stays_firing_mins) : 1440,
      message: ok ? String(rule.message || "") : String(cfg.message || ""),
      description: String(cfg.description || ""),
      linkDesktop: collapseOnly(cfg.link),
      linkMobile: collapseOnly(cfg.link_mobile),
      actions: ok && Array.isArray(rule.actions) ? rule.actions.slice() : [],
      notify: listOf(cfg.notifier),
      ...bannerForm(cfg.overlay),
    };
  }
  return {
    type: "state",
    title: String(cfg.friendly_name || cfg.name || ""),
    priority: prioKey(cfg.priority),
    // a rule from before `category` was its own field: its domain was its category
    category: (cfg.category || cfg.domain) && (cfg.category || cfg.domain) !== "general" ? String(cfg.category || cfg.domain) : "",
    clearable: truthy(cfg.allow_clear),
    conds: ok ? JSON.parse(JSON.stringify(rule.conds)) : [{ kind: "template", template: String(cfg.condition || "") }],
    match: ok && rule.match === "any" ? "any" : "all",
    forMins: ok ? Math.max(0, Number(rule.for_mins) || 0) : Math.round((Number(cfg.delay_on_secs) || 0) / 60),
    message: ok ? String(rule.message || "") : String(cfg.message || ""),
    description: String(cfg.description || ""),
    linkDesktop: collapseOnly(cfg.link),
    linkMobile: collapseOnly(cfg.link_mobile),
    actions: ok && Array.isArray(rule.actions) ? rule.actions.slice() : [],
    notify: listOf(cfg.notifier),
    ...bannerForm(cfg.overlay),
  };
}
/* Alert2's own alerts - made by Alert2, not by a rule. Their settings live in the rule store
   too (the fork applies a change at once), but only some can change: what sets one off is
   Alert2's, and it says what was reported. */
const BUILTIN = {
  global_exception: "Home Assistant has an uncaught error",
  error: "A rule or the alerting has a problem",
  warning: "The alerting has a warning",
};
const isBuiltinCfg = (cfg) => cfg?.domain === "alert2" && Object.hasOwn(BUILTIN, String(cfg?.name));
function formFromBuiltin(cfg) {
  return {
    type: "builtin", builtin: String(cfg.name),
    title: String(cfg.friendly_name || cfg.name || ""),
    priority: prioKey(cfg.priority),
    // filed under "system" unless one was chosen, as the cards show it
    category: cfg.category ? String(cfg.category) : "system",
    clearable: cfg.allow_clear === undefined ? true : truthy(cfg.allow_clear),
    conds: [], match: "all", forMins: 0,
    stayMins: cfg.stays_firing_mins != null ? Number(cfg.stays_firing_mins) : 1440,
    message: "", description: String(cfg.description || ""),
    linkDesktop: collapseOnly(cfg.link), linkMobile: collapseOnly(cfg.link_mobile),
    actions: [], notify: listOf(cfg.notifier), ...bannerForm(cfg.overlay),
  };
}
function compileBuiltin(f, hass, key) {
  const errors = [];
  const title = f.title.trim();
  if (!title) errors.push("Give the alert a name.");
  const stay = Math.max(0, Number(f.stayMins) || 0);
  if (!stay && !f.clearable) errors.push("Stays firing until cleared needs Can be cleared on - or a time after which it turns OK.");
  const { domain, name } = key;
  const cfg = { domain, name, friendly_name: title, priority: f.priority,
                allow_clear: f.clearable ? "true" : "false", stays_firing_mins: String(stay) };
  // "system" is what the cards call it without one; "general" is a choice like any other
  const cat = f.category || "general";
  if (cat !== "system") cfg.category = slugify(cat);
  if (f.description.trim()) cfg.description = f.description.trim();
  Object.assign(cfg, notifyCfg(f, title));
  // no rows of its own: "only what this alert is about" does not apply
  const noOnly = (l) => l.replace(/&hm_alert=this(?=[&#]|$)/, "");
  if (f.linkDesktop.trim()) cfg.link = noOnly(f.linkDesktop.trim());
  if (f.linkMobile.trim()) cfg.link_mobile = noOnly(f.linkMobile.trim());
  return { cfg, errors, builtin: true, condition: "", message: "", entityId: `alert2.${slugify(`${domain}_${name}`)}` };
}
// the fields the editor writes but leaves out when empty or not of this kind of alert -
// so an emptied one, or one of the other kind (a trigger on an alert turned to "While
// true"), is removed
const OPTIONAL_CFG = ["description", "link", "link_mobile", "delay_on_secs", "condition", "trigger", "display_msg", "stays_firing_mins", "threshold", "actions_on",
  "notifier", "overlay", "title", "annotate_messages"];
const ICON_CHEV_R = `<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`;
const ICON = {
  x: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
  chev: `<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
  tick: `<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>`,
  pop: `<svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M8 4h8"/></svg>`,
  heart: `<svg viewBox="0 0 24 24"><path style="fill:#ff2d55;stroke:none" d="M12 20.5s-7.8-4.6-9.4-9.6C1.6 7.6 3.6 4.5 7 4.5c2.1 0 3.8 1.2 5 3 1.2-1.8 2.9-3 5-3 3.4 0 5.4 3.1 4.4 6.4C19.8 15.9 12 20.5 12 20.5z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>`,
  toggle: `<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="2.6"/></svg>`,
  gauge: `<svg viewBox="0 0 24 24"><path d="M4.5 16a8 8 0 1 1 15 0"/><path d="M12 15l3.5-5"/></svg>`,
  braces: `<svg viewBox="0 0 24 24"><path d="M9 4.5c-2 0-2.5 1-2.5 3v2c0 1.2-.8 2.5-2 2.5 1.2 0 2 1.3 2 2.5v2c0 2 .5 3 2.5 3M15 4.5c2 0 2.5 1 2.5 3v2c0 1.2.8 2.5 2 2.5-1.2 0-2 1.3-2 2.5v2c0 2-.5 3-2.5 3"/></svg>`,
};
const ENTITY_ROWS = 60;
const CLEAR_HINT = { on: "Allowed to reset to OK", off: "OK only once condition expires" };
// what the duration chips are sized for: the longest a duration can read on the drums
const DUR_WIDEST = "30 days 23 h 59 min";
const TIME_WIDEST = "12:59 PM";

class RuleEditor {
  constructor(card, dlg) {
    this.card = card;
    this.dlg = dlg;
    this.scrim = dlg.querySelector(".red-scrim");
    this.sheet = dlg.querySelector(".red-sheet");
    this._unsubs = [];
    this._pseq = 0;
    containScroll(dlg, () => [...this.sheet.querySelectorAll(".ed-list, .ed-opts, .ed-tarea"), this.sheet]);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); this.back(); });
    this.scrim.addEventListener("click", () => this.back());
    this.sheet.addEventListener("click", (e) => this.onClick(e));
    this.sheet.addEventListener("input", (e) => this.onInput(e));
    this.sheet.addEventListener("keydown", (e) => this.onKey(e));
  }

  get hass() { return this.card._hass; }

  /* `init` (Edit): the rule's uiId, its stored config and its form. */
  open(init = null) {
    if (this.dlg.open) return;
    this.editing = init;
    this.key = init ? { domain: init.cfg.domain, name: init.cfg.name } : newRuleKey(this.hass);
    this.f = init?.form || { type: "state", title: "", priority: "high", category: "", clearable: false, conds: [], match: "all",
                             forMins: 0, stayMins: 1440, message: "", description: "", linkDesktop: "", linkMobile: "", actions: [],
                             notify: [], banner: [], bannerMain: false };
    this.f.type ||= "state";
    this.f.actions ||= [];
    this.f.notify ||= [];
    this.f.banner ||= [];
    this.f.bannerMain = !!this.f.bannerMain;
    if (this.f.stayMins == null) this.f.stayMins = 1440;
    this.ui = { picker: null, adding: !this.f.conds.length, addingT: false, folds: {}, busy: false, catTouched: !!init,
                clearTouched: !!init, enter: new Set(init ? [] : ["add"]) };
    this.res = null;
    this._pkey = null;
    this.links = init?.links || null;
    this.pushUsers = null;
    this.render();
    // a phone: the whole width, as a sheet from the bottom
    this.narrow = this.card._narrow();
    this.dlg.classList.toggle("narrow", this.narrow);
    this.dlg.showModal();
    this.sheet.scrollTop = 0;
    // only now laid out: before the dialog shows, every segment measures 0
    this.placeThumbs(this.sheet);
    if (!reduceMotion()) {
      this.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease" });
      if (this.narrow) {
        this.sheet.animate([{ transform: "translateY(100%)" }, { transform: "none" }], { duration: 440, easing: IOS });
      } else {
        this.sheet.animate([{ opacity: 0, transform: "scale(.9) translateY(10px)" }, { opacity: 1, transform: "none" }],
          { duration: 460, easing: "cubic-bezier(.24,1.12,.4,1)" });
      }
    }
    // not on a touch screen, where focusing would throw the keyboard over the form
    if (matchMedia("(pointer: fine)").matches) this.sheet.querySelector(".ed-title").focus({ preventScroll: true });
    this.preview();
  }

  /* Edit: the rule as Alert2 keeps it, into the same sheet. */
  async edit(eid, uiId) {
    if (this.dlg.open || this._loading || uiId == null) return;
    this._loading = true;
    // the dashboards too, so the link chips open with their names, not their addresses
    const [cfg, links] = await Promise.all([
      this.hass.callApi("POST", "alert2/manageAlert", { load: { uiId } })
        .catch((err) => ({ error: err?.body?.message || err?.message || String(err) })),
      this.card._linkTargets().catch(() => null),
    ]);
    this._loading = false;
    if (!cfg || cfg.error) {
      this.card.dispatchEvent(new CustomEvent("hass-notification", { bubbles: true, composed: true,
        detail: { message: `Could not open the alert: ${cfg?.error || "not found"}` } }));
      return;
    }
    this.open({ uiId, eid, cfg, links, form: isBuiltinCfg(cfg) ? formFromBuiltin(cfg) : formFromCfg(cfg) });
  }

  /* One layer at a time, outermost first: an open picker closes before the sheet does. */
  back() {
    if (this.ui?.picker) return this.setPicker(null);
    if (this.ui?.addingT && this.f.conds.some((c) => c.trig)) { this.ui.addingT = false; return this.paintWhen(); }
    if (this.ui?.adding && (this.f.type === "event" || plainConds(this.f).length)) { this.ui.adding = false; return this.paintWhen(); }
    return this.close();
  }

  async close() {
    if (!this.dlg.open || this._closing) return;
    this._closing = true;
    this.unsubscribe();
    clearTimeout(this._pt);
    if (!reduceMotion()) {
      this.scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: this.narrow ? 280 : 200, easing: "ease-in", fill: "forwards" });
      await this.sheet.animate(this.narrow
        ? [{ transform: "none" }, { transform: "translateY(105%)" }]
        : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.96) translateY(8px)" }],
        { duration: this.narrow ? 300 : 190, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
      this.sheet.getAnimations().forEach((a) => a.cancel());
      this.scrim.getAnimations().forEach((a) => a.cancel());
    }
    this.dlg.close();
    this._closing = false;
  }

  // ------------------------------------------------------------------ render

  render() {
    const f = this.f;
    this.sheet.style.setProperty("--accent", PRIO[f.priority].tone);
    this.sheet.innerHTML = `
      <div class="ed-title-row">
        <input class="ed-title" placeholder="New alert" aria-label="Name" autocomplete="off" spellcheck="false"
          value="${escapeHtml(f.title)}">
      </div>
      <div class="ed-group" id="edBasics"></div>
      <div class="ed-group" id="edWhen"></div>
      <div class="ed-group" id="edThen"></div>
      <div class="ed-group" id="edNotify"></div>
      <div class="ed-group" id="edLinks"></div>
      ${this.foldHtml("msg", "Message & details", `${f.type === "builtin" ? `
        <div class="ed-row ed-msgauto ed-off"><span class="ed-lbl">Says</span><span class="ed-said">What was reported</span></div>
        <div class="ed-row notes ed-off"><span class="ed-lbl">Your own</span>
          <textarea class="ed-tarea" rows="2" disabled placeholder="Built in: it says what was reported."></textarea></div>` : `
        <div class="ed-row ed-msgauto"><span class="ed-lbl">Says</span><span class="ed-said" id="edSaid"></span></div>
        <div class="ed-row notes"><span class="ed-lbl">Your own</span>
          <textarea class="ed-tarea" id="edMsg" rows="2" placeholder="Leave empty to use the one above. A template is fine.">${escapeHtml(f.message)}</textarea></div>`}
        <div class="ed-row notes"><span class="ed-lbl">About</span>
          <textarea class="ed-tarea" id="edDesc" rows="3" placeholder="What this alert is for, in plain words. Shown under its name.">${escapeHtml(f.description)}</textarea></div>`)}
      <div class="ed-error" id="edErr" hidden></div>
      <div class="ed-actions">
        ${this.editing && f.type !== "builtin" ? `<button class="ed-btn danger" data-act="delete">Delete</button>` : ""}
        <span class="ed-spacer"></span>
        <button class="ed-btn" data-act="cancel">Cancel</button>
        <button class="ed-btn primary" data-act="save">${this.editing ? "Save" : "Add"}</button>
      </div>`;
    this.paintBasics();
    this.paintWhen();
    this.paintThen();
    this.paintNotify();
    this.paintLinks();
    this.paintFolds();
  }

  foldHtml(id, label, body) {
    return `<div class="ed-group ed-foldg" data-foldg="${id}">
        <button class="ed-row ed-disclose" data-fold="${id}" aria-expanded="false">
          <span class="ed-lbl">${label}</span><span class="ed-sub" id="edSub_${id}"></span>
          <span class="ed-chev">${ICON.chev}</span></button>
        <div class="ed-fold"><div class="ed-fold-in">${body}</div></div>
      </div>`;
  }

  paintFolds() {
    const f = this.f;
    for (const g of this.sheet.querySelectorAll("[data-foldg]")) {
      const id = g.dataset.foldg;
      const open = !!this.ui.folds[id];
      g.querySelector(".ed-fold").classList.toggle("open", open);
      g.querySelector(".ed-chev").classList.toggle("open", open);
      g.querySelector(".ed-disclose").setAttribute("aria-expanded", String(open));
    }
    swapText(this.sheet.querySelector("#edSub_msg"),
      [f.message.trim() ? "Your Own Set" : "Automatic", f.description.trim() && "About Set"].filter(Boolean).join(", "));
  }

  paintBasics() {
    const f = this.f;
    const cats = this.categories();
    const catOpen = this.ui.picker === "cat";
    const box = this.sheet.querySelector("#edBasics");
    box.innerHTML = `
      <div class="ed-row"><span class="ed-lbl">Priority</span>
        <span class="ed-vals"><span class="ed-seg ed-sw" data-sw="prio" role="radiogroup" aria-label="Priority"
            style="--thumb:${PRIO[f.priority].tone}"><span class="ed-thumb"></span>
          ${PRIO_IDS.map((p) => `<button class="ed-seg-btn${f.priority === p ? " on" : ""}" data-prio="${p}"
              role="radio" aria-checked="${f.priority === p}">${PRIO[p].label}</button>`).join("")}
        </span></span></div>
      <button class="ed-row ed-pickrow" data-pick="cat" aria-expanded="${catOpen}"><span class="ed-lbl">Category</span>
        <span class="ed-vals"><span class="ed-chip sel">${escapeHtml(f.category || "general")}</span></span></button>
      ${catOpen ? `<div class="ed-picker${this.takeEnter("cat") ? " enter" : ""}" data-picker="cat">
          <div class="ed-opts">
            ${cats.map((c) => `<button class="ed-chip${c === (f.category || "general") ? " on" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")}
          </div>
          <div class="ed-row"><span class="ed-lbl">New</span><span class="ed-vals">
            <input type="text" data-newcat autocomplete="off" spellcheck="false" placeholder="Type a category, then Enter"></span></div>
        </div>` : ""}
      <button class="ed-row ed-toggle${f.clearable ? " on" : ""}" data-clear role="checkbox" aria-checked="${f.clearable}">
        <span class="ed-lbl">Can be cleared</span>
        <span class="ed-hint">${f.clearable ? CLEAR_HINT.on : CLEAR_HINT.off}</span>
        <span class="box">${ICON.tick}</span></button>`;
    this.placeThumbs(box);
  }

  categories() {
    const seen = new Set(["general"]);
    for (const r of this.card._data?.rows || []) if (r.category && r.category !== "system" && r.category !== "—") seen.add(r.category);
    if (this.f.category) seen.add(this.f.category);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }

  /* An element that should animate in this once (a picker just opened, a row just added). */
  takeEnter(key) {
    if (!this.ui.enter.has(key)) return false;
    this.ui.enter.delete(key);
    return !reduceMotion();
  }

  /* What makes it fire. "While true": conditions (If / And), and how long they must hold.
     "When it happens": triggers (When / Or - any one fires it), then optional conditions that
     must hold at that moment (Only if). */
  paintWhen(opts = {}) {
    const f = this.f;
    const box = this.sheet.querySelector("#edWhen");
    if (f.type === "builtin") {
      box.innerHTML = `
        <div class="ed-row ed-typerow ed-off"><span class="ed-lbl">Fires</span><span class="ed-vals">
          ${this.segHtml("ty", "", [["state", "While true"], ["event", "When it happens"]], "event", "What makes it fire")}</span></div>
        <div class="ed-row ed-off"><span class="ed-lbl">When</span>
          <span class="ed-vals"><span class="ed-chip sel ed-linkchip"><span class="ed-cin">${escapeHtml(BUILTIN[f.builtin] || "Alert2 reports it")}</span></span></span></div>
        <button class="ed-row ed-pickrow" data-pick="stay" aria-expanded="${this.ui.picker === "stay"}"><span class="ed-lbl">Stays firing</span>
          <span class="ed-hint">${f.stayMins ? "Then OK by itself" : ""}</span>
          <span class="ed-vals">${this.durChip("stay", fmtMins(f.stayMins, "Until cleared"))}</span></button>
        ${this.ui.picker === "stay" ? this.drumHtml("stay") : ""}
        <div class="ed-note ed-bnote">Built in: Alert2 fires it itself, so what sets it off can't be changed.</div>`;
      this.mountDrum();
      this.placeThumbs(box, opts.thumbFrom, opts.thumbSince);
      return;
    }
    const ev = f.type === "event";
    const kindsHtml = (rows, attr, enterKey) => `<div class="ed-kinds${this.takeEnter(enterKey) ? " enter" : ""}" data-kinds="${attr}">
        ${rows.map((k) => `<button class="ed-kind${k.lead ? " lead" : ""}" data-${attr}="${k.id}">
          <span class="ed-ktile${k.lead ? " hm" : ""}">${ICON[k.icon]}</span>
          <span class="ed-ktext"><span class="ed-kname">${k.label}</span><span class="ed-ksub">${k.sub}</span></span>
        </button>`).join("")}</div>`;
    // open, an add row is its list's heading, not a button: a kind is picked, or Escape closes it
    const addRow = (open, attr, label) => open
      ? `<div class="ed-row ed-addrow open"><span class="ed-addic">${ICON.plus}</span><span class="ed-lbl">${label}</span></div>`
      : `<button class="ed-row ed-addrow" data-${attr}><span class="ed-addic">${ICON.plus}</span><span class="ed-lbl">${label}</span></button>`;
    const trigIdx = f.conds.map((c, i) => (c.trig ? i : -1)).filter((i) => i >= 0);
    const condIdx = f.conds.map((c, i) => (c.trig ? -1 : i)).filter((i) => i >= 0);
    const condRows = condIdx.map((i, pos) => this.condHtml(f.conds[i], i, pos)).join("");
    const adding = this.ui.adding || (!ev && !condIdx.length);
    let body;
    if (ev) {
      const addingT = this.ui.addingT || !trigIdx.length;
      body = `${trigIdx.map((i, pos) => this.condHtml(f.conds[i], i, pos)).join("")}
        ${addRow(addingT, "addt", trigIdx.length ? "Add another trigger" : "Add a trigger")}
        ${addingT ? kindsHtml(TRIGGER_ROWS, "tkind", "addt") : ""}
        ${condRows}
        ${addRow(adding, "add", condIdx.length ? "Add another condition" : "Only if… (optional)")}
        ${adding ? kindsHtml(KIND_ROWS, "kind", "add") : ""}
        ${trigIdx.length ? `
          <button class="ed-row ed-pickrow" data-pick="stay" aria-expanded="${this.ui.picker === "stay"}"><span class="ed-lbl">Stays firing</span>
            <span class="ed-hint">${f.stayMins ? "Then OK by itself" : ""}</span>
            <span class="ed-vals">${this.durChip("stay", fmtMins(f.stayMins, "Until cleared"))}</span></button>
          ${this.ui.picker === "stay" ? this.drumHtml("stay") : ""}` : ""}`;
    } else {
      body = `${condRows}
        ${addRow(adding, "add", condIdx.length ? "Add another condition" : "Add a condition")}
        ${adding ? kindsHtml(KIND_ROWS, "kind", "add") : ""}
        ${condIdx.length ? `
          <button class="ed-row ed-pickrow" data-pick="for" aria-expanded="${this.ui.picker === "for"}"><span class="ed-lbl">For</span>
            <span class="ed-hint">${forPerDevice(f) && f.forMins ? perDeviceHint(f) : ""}</span>
            <span class="ed-vals">${this.durChip("for", fmtMins(f.forMins))}</span></button>
          ${this.ui.picker === "for" ? this.drumHtml("for") : ""}` : ""}`;
    }
    box.innerHTML = `
      <div class="ed-row ed-typerow"><span class="ed-lbl">Fires<button class="info ed-info" data-firesinfo
          title="While true or When it happens?" aria-label="While true or When it happens?"><svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/></svg></button></span><span class="ed-vals">
        ${this.segHtml("ty", "", [["state", "While true"], ["event", "When it happens"]], ev ? "event" : "state", "What makes it fire")}</span></div>
      ${body}
      <div class="ed-note ed-now" id="edNow"></div>`;
    this.mountDrum();
    this.paintNow();
    this.placeThumbs(box, opts.thumbFrom, opts.thumbSince);
    // a row that has just been added drops into place; its picker opens by itself (CSS)
    for (const el of box.querySelectorAll(".ed-cond.enter > .ed-condin > .ed-row")) {
      el.animate([{ opacity: 0, transform: "translateY(-10px) scale(.97)" }, { opacity: 1, transform: "none" }],
        { duration: 420, easing: "cubic-bezier(.34,1.42,.64,1)" });
    }
  }

  /* Where the alert takes you: a view or pop-up on each dashboard - Desktop from the
     tablet's, Mobile from the phone's - chosen from a list of them, suggested from the
     conditions, or typed. */
  /* Actions: the scripts it runs when it fires, picked from Home Assistant's scripts as the
     links are from the dashboards - a row each, "Run" then "And", and a row to add one. */
  paintThen() {
    const box = this.sheet.querySelector("#edThen");
    if (!box) return;
    if (this.f.type === "builtin") {
      box.innerHTML = `<div class="ed-head">Actions</div>
        <div class="ed-row ed-addrow ed-off"><span class="ed-addic">${ICON.plus}</span><span class="ed-lbl">Run a script when it fires</span></div>
        <div class="ed-note ed-bnote">A built-in alert can't run scripts.</div>`;
      return;
    }
    const acts = this.f.actions;
    const row = (eid, k) => {
      const key = `a${k}`;
      const open = this.ui.picker === key;
      return `<div class="ed-row ed-actrow" data-ai="${k}"><span class="ed-lbl">${k ? "And" : "Run"}</span>
          <span class="ed-vals"><button class="ed-chip sel${open ? " on" : ""}" data-pick="${key}"><span class="ed-cin">${
            escapeHtml(nameOf(this.hass, eid))}</span></button></span>
          <button class="ed-x" data-adel="${k}" title="Remove this action" aria-label="Remove this action">${ICON.x}</button>
        </div>${open ? this.scriptPickerHtml(key) : ""}`;
    };
    const adding = this.ui.picker === "anew";
    box.innerHTML = `<div class="ed-head">Actions<button class="info ed-info" data-actinfo title="What do actions do?"
          aria-label="What do actions do?"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/></svg></button></div>
      ${acts.map(row).join("")}
      <button class="ed-row ed-addrow${adding ? " open" : ""}" data-pick="anew"><span class="ed-addic">${ICON.plus}</span>
        <span class="ed-lbl">${acts.length ? "Add another action" : "Run a script when it fires"}</span></button>
      ${adding ? this.scriptPickerHtml("anew") : ""}`;
  }

  /* Notify, laid out as Links: "Push to" users - every device signed in to the Home Assistant
     app as them, now and later (the fork's `user:<id>`; Everyone is `user:*`) - and "Banner on"
     the dashboards: Alert2's `notifier` and the fork's `overlay`. Each row's chip says what is
     chosen; the row opens its list under it, where any number are picked (white) before it
     closes. */
  paintNotify() {
    const box = this.sheet.querySelector("#edNotify");
    if (!box) return;
    const row = (key, label) => {
      const open = this.ui.picker === key;
      const any = (key === "np" ? this.f.notify : this.f.banner).length > 0;
      return `<button class="ed-row ed-pickrow" data-pick="${key}" aria-expanded="${open}"><span class="ed-lbl">${label}</span>
          <span class="ed-vals"><span class="ed-chip ed-linkchip${any ? " sel" : " empty"}${open ? " on" : ""}" data-nchip="${key}">
            <span class="ed-cin">${escapeHtml(this.notifyChipText(key))}</span></span></span></button>
        ${open ? `<div class="ed-picker${this.takeEnter(key) ? " enter" : ""}" data-picker="${key}">
            ${key === "nb" ? this.bannerPagesHtml() : ""}
            <div class="ed-list ed-nlist">${this.notifyListHtml(key)}</div></div>` : ""}`;
    };
    box.innerHTML = `<div class="ed-head">Notify<button class="info ed-info" data-notifyinfo title="What does Notify do?"
          aria-label="What does Notify do?"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/></svg></button></div>
      ${row("np", "Push to")}
      ${row("nb", "Banner on")}`;
    this.placeThumbs(box);
    // the users and their devices, read from the fork each time the sheet opens - a phone
    // signed in a minute ago is there; the chip and an open list follow once it is read
    if (!this.pushUsers && !this._pushUsersP) {
      this._pushUsersP = this.hass.callWS({ type: "alert2/hm/push_users" })
        .catch(() => ({ users: [], devices: 0, failed: true }))
        .then((r) => {
          this._pushUsersP = null;
          this.pushUsers = r;
          if (this.dlg.open) this.paintNotify();
        });
    }
  }

  /* Banner on's list leads with where on the dashboards it shows: Every page, or each one's Home
     page alone (/home). A switch, not a row of the list - as a row it read as one more dashboard. */
  bannerPagesHtml() {
    return `<div class="ed-row ed-bpages"><span class="ed-lbl">Show on</span><span class="ed-vals">${
      this.segHtml("bp", "", [["every", "Every page"], ["home", "Home page"]], this.f.bannerMain ? "home" : "every", "Which pages")
    }</span></div>`;
  }

  /* What a list offers: Everyone and the users with a device (np), or the dashboards (nb). One
     the rule names but the list no longer has stays in it, so it can be let go - a user with
     no device now, or a single device named by hand. null while the users are being read. */
  notifyTargets(key) {
    if (key === "nb") {
      const all = bannerDashboards(this.hass).map((d) => ({ ...d, sub: `/${d.id}`, mono: true }));
      for (const id of this.f.banner) {
        if (!all.some((x) => x.id === id)) all.push({ id, name: id, icon: "mdi:view-dashboard", sub: "No longer found" });
      }
      return all;
    }
    const pu = this.pushUsers;
    if (!pu) return null;
    const ids = this.f.notify;
    const n = pu.devices;
    const all = [{ id: EVERYONE, name: "Everyone", icon: "mdi:account-group", everyone: true,
                   sub: n ? `All ${n} device${n === 1 ? "" : "s"}, and any added later` : "Every device with the app" }];
    for (const u of pu.users) {
      const id = `user:${u.id}`;
      if (!u.devices.length && !ids.includes(id)) continue;
      all.push({ id, name: u.name, icon: "mdi:account",
                 sub: u.devices.length ? u.devices.map((d) => d.name).join(", ") : "No device with the app now" });
    }
    const devices = pu.users.flatMap((u) => u.devices);
    for (const id of ids) {
      if (all.some((x) => x.id === id)) continue;
      const d = devices.find((x) => x.notifier === id.replace(/^notify\./, ""));
      all.push({ id, name: d ? d.name : id, icon: d ? "mdi:cellphone" : "mdi:bell-outline", sub: d ? "This device only" : "No longer found" });
    }
    return all;
  }

  // one: its name; more: the first and how many besides ("…" while the users are being read);
  // a banner on Home pages only says so, as its list - closed - would not
  notifyChipText(key) {
    const ids = key === "np" ? this.f.notify : this.f.banner;
    if (!ids.length) return key === "np" ? "Choose users" : "Choose dashboards";
    const chosen = this.notifyTargets(key)?.filter((x) => ids.includes(x.id));
    if (!chosen) return "…";
    const names = chosen.length === 1 ? chosen[0].name : `${chosen[0].name} + ${chosen.length - 1} more`;
    return key === "nb" && this.f.bannerMain ? `${names} · Home page` : names;
  }

  notifyListHtml(key) {
    const push = key === "np";
    const ids = push ? this.f.notify : this.f.banner;
    if (push && this.pushUsers?.failed) return `<div class="ed-none">The users could not be read. Close the rule and open it again.</div>`;
    const all = this.notifyTargets(key);
    if (!all) return `<div class="ed-none">Reading the users…</div>`;
    if (!all.length) return `<div class="ed-none">No dashboards found.</div>`;
    // Everyone apart from the users, as the link list sets its suggestions apart
    return all.map((x) => `<button class="ed-item ed-lnk${ids.includes(x.id) ? " sel" : ""}" data-${push ? "push" : "banner"}="${escapeHtml(x.id)}"
        role="checkbox" aria-checked="${ids.includes(x.id)}">
        <span class="ed-lic"><ha-icon icon="${escapeHtml(x.icon)}"></ha-icon></span>
        <span class="ed-itext"><span class="ed-iname">${escapeHtml(x.name)}</span>
          <span class="ed-iid${x.mono ? "" : " ed-isub"}">${escapeHtml(x.sub)}</span></span>
        <span class="ed-ichk">${ICON.tick}</span></button>${x.everyone && all.length > 1 ? `<div class="ed-lsep"></div>` : ""}`).join("");
  }

  // after a pick, in place - the list stays open: its rows' ticks and the row's chip
  syncNotify(key) {
    const ids = key === "np" ? this.f.notify : this.f.banner;
    const attr = key === "np" ? "push" : "banner";
    for (const r of this.sheet.querySelectorAll(`[data-${attr}]`)) {
      const on = ids.includes(r.dataset[attr]);
      r.classList.toggle("sel", on);
      r.setAttribute("aria-checked", String(on));
    }
    const chip = this.sheet.querySelector(`[data-nchip="${key}"]`);
    if (chip) {
      chip.classList.toggle("sel", ids.length > 0);
      chip.classList.toggle("empty", !ids.length);
      swapText(chip.querySelector(".ed-cin"), this.notifyChipText(key));
    }
  }

  scriptPickerHtml(key) {
    return `<div class="ed-picker${this.takeEnter(key) ? " enter" : ""}" data-picker="${key}">
        <label class="ed-search">${ICON.search}<input type="text" data-ssearch="${key}" autocomplete="off"
          spellcheck="false" placeholder="Search scripts" aria-label="Search scripts"></label>
        <div class="ed-list" id="edScriptList">${this.scriptListHtml(key, "")}</div>
      </div>`;
  }

  scriptListHtml(key, q) {
    const cur = key === "anew" ? null : this.f.actions[Number(key.slice(1))];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = Object.entries(this.hass?.states || {}).filter(([id]) => id.startsWith("script."))
      .map(([id, st]) => ({ id, name: st.attributes?.friendly_name || id }))
      .filter((x) => !words.length || words.every((w) => `${x.name} ${x.id}`.toLowerCase().includes(w)))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!out.length) return `<div class="ed-none">${words.length ? "Nothing matches." : "There are no scripts yet."}</div>`;
    return out.slice(0, ENTITY_ROWS).map((x) => `<button class="ed-item${x.id === cur ? " sel" : ""}" data-script="${escapeHtml(x.id)}">
        <span class="ed-itext"><span class="ed-iname">${escapeHtml(x.name)}</span><span class="ed-iid">${escapeHtml(x.id)}</span></span></button>`).join("") +
      (out.length > ENTITY_ROWS ? `<div class="ed-none">${out.length - ENTITY_ROWS} more - type to narrow it down.</div>` : "");
  }

  async removeAction(k) {
    await this.collapse(this.sheet.querySelector(`[data-ai="${k}"]`), 220);
    this.f.actions.splice(k, 1);
    this.ui.picker = null;
    this.paintThen();
  }

  paintLinks() {
    const box = this.sheet.querySelector("#edLinks");
    if (!box) return;
    const row = (key, label, value) => {
      const open = this.ui.picker === key;
      return `<button class="ed-row ed-pickrow" data-pick="${key}" aria-expanded="${open}"><span class="ed-lbl">${label}</span>
          <span class="ed-vals"><span class="ed-chip ed-linkchip${value ? " sel" : " empty"}${open ? " on" : ""}">
            <span class="ed-cin">${escapeHtml(value ? this.linkText(key, value) : "Choose a view or pop-up")}</span></span></span></button>
        ${open ? `<div class="ed-picker${this.takeEnter(key) ? " enter" : ""}" data-picker="${key}">
            <label class="ed-search">${ICON.search}<input type="text" data-lsearch="${key}" autocomplete="off" spellcheck="false"
              placeholder="Search views and pop-ups, or type an address" aria-label="Search views and pop-ups"></label>
            <div class="ed-list" id="edLinkList">${this.linkListHtml(key, "")}</div>
          </div>` : ""}`;
    };
    box.innerHTML = `<div class="ed-head">Links</div>
      ${row("ld", "Desktop link", this.f.linkDesktop)}
      ${row("lm", "Mobile link", this.f.linkMobile)}`;
    if (!this.links) {
      this.card._linkTargets().then((t) => {
        this.links = t;
        if (!this.dlg.open) return;
        // the chips' names and an open list, now that the dashboards are read
        this.paintLinks();
      });
    }
  }

  linkText(key, value) {
    const items = this.links?.[key === "ld" ? "desktop" : "mobile"]?.items || [];
    const it = items.find((x) => x.path === value);
    if (it) return linkLabel(it);
    // a filtered Health view: the view's name and its filters in words
    const m = /^([^?#]*)(\?[^#]*)(#.*)?$/.exec(value);
    const base = m && items.find((x) => x.path === m[1] + (m[3] || ""));
    const words = m && healthQueryWords(m[2], this.hass);
    return base && words ? `${base.healthLabel || linkLabel(base)} · ${words}` : value;
  }

  linkListHtml(key, q) {
    const which = key === "ld" ? "desktop" : "mobile";
    const src = this.links?.[which];
    const cur = key === "ld" ? this.f.linkDesktop : this.f.linkMobile;
    if (!this.links) return `<div class="ed-none">Reading the dashboards…</div>`;
    if (!src) return `<div class="ed-none">No ${which} dashboard found. Set <b>${which}_dashboard</b> in the card's options, or type an address.</div>`;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (it) => !words.length || words.every((w) => `${it.label} ${it.view || ""} ${it.path}`.toLowerCase().includes(w));
    const item = (it, sub) => `<button class="ed-item ed-lnk${it.kind === "pop" ? " pop" : ""}${it.path === cur ? " sel" : ""}"
        data-link="${escapeHtml(it.path)}">
        <span class="ed-lic">${it.kind === "pop" ? ICON.pop : `<ha-icon icon="${escapeHtml(it.icon)}"></ha-icon>`}</span>
        <span class="ed-itext"><span class="ed-iname">${escapeHtml(sub ? linkLabel(it) : it.label)}</span>
          <span class="ed-iid">${escapeHtml(it.note || it.path)}</span></span></button>`;
    let html = "";
    const typed = q.trim();
    if (/^(\/|https?:\/\/)/i.test(typed)) {
      html += `<button class="ed-item ed-lnk" data-link="${escapeHtml(typed)}"><span class="ed-lic">${ICON.plus}</span>
        <span class="ed-itext"><span class="ed-iname">Use this address</span><span class="ed-iid">${escapeHtml(typed)}</span></span></button>`;
    }
    if (cur && !words.length) {
      html += `<button class="ed-item ed-lnk" data-link=""><span class="ed-lic">${ICON.x}</span>
        <span class="ed-itext"><span class="ed-iname">No link</span></span></button>`;
    }
    // the Health view already filtered: to what this rule watches, and as it was last set here
    const hf = healthFilterOf(this.f, this.hass), last = lastHealthView();
    const only = hf && this.f.type !== "event" && healthRowConds(this.f).length > 0;
    const filtered = [];
    for (const it of src.items.filter((x) => x.health)) {
      const name = it.healthLabel || linkLabel(it);
      // only the rows behind THIS alert: compileRule turns hm_alert=this into the alert and its rows
      if (only) filtered.push({ ...it, path: withQuery(it.path, `${hf.query}&${ONLY_THIS}`), label: `${name} · ${hf.label} · ${ONLY_WORDS}`,
                                kind: "view", note: `Just the ${hf.noun} this alert is about, not every one` });
      if (hf) filtered.push({ ...it, path: withQuery(it.path, hf.query), label: `${name} · ${hf.label}`, kind: "view",
                              note: "Filtered to what this alert watches" });
      if (last && last.query !== hf?.query) {
        filtered.push({ ...it, path: withQuery(it.path, last.query), label: `${name} · ${last.label}`, kind: "view",
                        note: "As you last set the Health view" });
      }
    }
    const fhits = filtered.filter(hit);
    if (fhits.length) html += `<div class="ed-lsh">Health view, filtered</div>` + fhits.map((it) => item(it, false)).join("") + `<div class="ed-lsep"></div>`;
    // the places the conditions are about: what shows their entities, or the Health view
    // (unfiltered, when it is offered filtered above)
    const ents = new Set(this.f.conds.map((c) => c.entity).filter(Boolean));
    const health = this.f.conds.some((c) => HEALTH[c.kind]) && !hf;
    const sugg = src.items.filter((it) => hit(it) && ([...ents].some((e) => it.ents.has(e)) || (health && it.health)))
      .sort((a, b) => (a.kind === "pop" ? 0 : 1) - (b.kind === "pop" ? 0 : 1)).slice(0, 5);
    if (sugg.length) html += `<div class="ed-lsh">Suggested</div>` + sugg.map((it) => item(it, true)).join("");
    const rest = src.items.filter(hit);
    if (rest.length) html += (sugg.length ? `<div class="ed-lsep"></div>` : "") + rest.map((it) => item(it, false)).join("");
    return html || `<div class="ed-none">Nothing matches. Type an address starting with / to use it as it is.</div>`;
  }

  /* Folds an element away before the render that drops it, so nothing just vanishes. */
  async collapse(el, ms = 170) {
    if (!el || reduceMotion()) return;
    // min-height and padding go too: a row (.ed-row, min-height 48px) would otherwise
    // stop at its minimum and never fold
    const h = `${el.offsetHeight}px`;
    await el.animate([{ height: h, minHeight: h, opacity: 1, overflow: "hidden" },
      { height: "0px", minHeight: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0, overflow: "hidden" }],
      { duration: ms, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
  }

  condHtml(c, i, pos = i) {
    const hass = this.hass;
    const enter = this.takeEnter(`c${i}`) ? " enter" : "";
    const pk = this.ui.picker;
    // a chosen value is white, as the filters show theirs; one still to choose is outlined
    const chip = (key, text, empty) => `<button class="ed-chip${empty ? " empty" : " sel"}${pk === key ? " on" : ""}"
        data-pick="${key}"><span class="ed-cin">${escapeHtml(text)}</span></button>`;
    let sent = "";
    let below = "";
    if (HEALTH[c.kind]) {
      // the Health view's own words and status tags
      // "some device / battery / helper is ..." - each watched one by one
      sent = this.segHtml("hk", i, [["dev", "Device"], ["bat", "Battery"], ["hlp", "Helper"]], c.kind, "Health monitor") +
        `<span class="ed-word">is</span>` +
        `<button class="ed-chip sel ed-statchip${pk === `s${i}` ? " on" : ""}" data-pick="s${i}">${this.statTag(c.status, c.group)}</button>`;
    }
    switch (HEALTH[c.kind] ? "" : c.kind) {
      case "state":
        sent = chip(`e${i}`, c.entity ? nameOf(hass, c.entity) : "Choose an entity", !c.entity) +
          `<button class="ed-chip sel ed-op" data-op="${i}"><span class="ed-cin">${c.op === "not" ? "is not" : "is"}</span></button>` +
          chip(`v${i}`, c.value !== "" ? stateLabel(hass, c.entity, c.value) : "Choose a state", c.value === "");
        break;
      case "numeric": {
        const unit = hass?.states?.[c.entity]?.attributes?.unit_of_measurement;
        sent = chip(`e${i}`, c.entity ? nameOf(hass, c.entity) : "Choose an entity", !c.entity) +
          `<button class="ed-chip sel ed-op" data-op="${i}"><span class="ed-cin">${c.op === "below" ? "below" : "above"}</span></button>` +
          `<input class="ed-num" type="text" inputmode="decimal" data-num="${i}" value="${escapeHtml(c.value)}"
             placeholder="${escapeHtml(hass?.states?.[c.entity]?.state ?? "0")}" aria-label="Number">` +
          (unit ? `<span class="ed-word">${escapeHtml(unit)}</span>` : "");
        // how far back the value must come before the alert turns OK (an event alert's
        // conditions are only looked at when it fires: no margin there)
        if (this.f.type !== "event") {
          below = `<div class="ed-row ed-mrow"><span class="ed-word">Margin</span><button class="info ed-info" data-margininfo
              title="What is a margin?" aria-label="What is a margin?"><svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/></svg></button>
            <input class="ed-num" type="text" inputmode="decimal" data-margin="${i}" value="${escapeHtml(c.margin ?? "")}"
              placeholder="0" aria-label="Margin">${unit ? `<span class="ed-word">${escapeHtml(unit)}</span>` : ""}
            <span class="ed-hint" data-mhint="${i}">${escapeHtml(this.marginHint(c))}</span></div>`;
        }
        break;
      }
      case "time":
        sent = this.timeKindSeg(i, "time") + `<span class="ed-word">is between</span>` + this.durChip(`tf${i}`, fmtHM(c.from), TIME_WIDEST, true) +
          `<span class="ed-word">and</span>` + this.durChip(`tt${i}`, fmtHM(c.to), TIME_WIDEST, true);
        below = this.daysRowHtml(c, i);
        break;
      case "calendar":
        sent = this.timeKindSeg(i, "calendar") + chip(`e${i}`, c.entity ? nameOf(hass, c.entity) : "Choose a calendar", !c.entity) +
          `<span class="ed-word">has an event within</span>` + this.durChip(`d${i}`, fmtMins(c.mins, "0 min"));
        break;
      // ---- triggers
      case "hev":
        sent = this.segHtml("hp", i, [["dev", "Device"], ["bat", "Battery"], ["hlp", "Helper"]], c.part, "Health monitor") +
          chip(`w${i}`, hevWhat(c), false);
        break;
      case "tstate": {
        const evt = c.entity.startsWith("event.");
        sent = chip(`e${i}`, c.entity ? nameOf(hass, c.entity) : "Choose an entity", !c.entity) + (c.entity
          ? `<span class="ed-word">${evt ? "sends" : "changes to"}</span>` +
            chip(`v${i}`, c.value === "" ? (evt ? "Choose an event" : "Choose a state") : this.trigValueText(c), c.value === "")
          : "");
        break;
      }
      case "tat":
        sent = `<span class="ed-word">It is</span>` + this.durChip(`ta${i}`, fmtHM(c.at), TIME_WIDEST, true);
        below = this.daysRowHtml(c, i);
        break;
      case "tcal":
        sent = chip(`e${i}`, c.entity ? nameOf(hass, c.entity) : "Choose a calendar", !c.entity) +
          `<span class="ed-word">has an event starting in</span>` + this.durChip(`d${i}`, fmtMins(c.mins, "0 min"));
        // which events set it off: every event of the calendar; every event with a title (typed
        // here, or chosen in the Simple Schedule card); or one event / series made there - with a
        // way back to every event
        if (c.event?.match === "title") {
          below = `<div class="ed-row ed-mrow ed-evrow${this.takeEnter(`ev${i}`) ? " enter" : ""}" data-evrow="${i}">
            <span class="ed-word">Only events called</span>
            <input class="ed-evtitle" type="text" data-evtitle="${i}" value="${escapeHtml(c.event.title || "")}"
              placeholder="Their title" aria-label="Only events called" autocomplete="off" spellcheck="false">
            <button class="ed-x" data-evdel="${i}" title="Any event of this calendar" aria-label="Any event of this calendar">${ICON.x}</button></div>`;
        } else if (c.event?.uid) {
          const which = c.event.match === "series" ? "every occurrence"
            : c.event.start && Number.isFinite(Date.parse(c.event.start)) ? fmtDT(Date.parse(c.event.start)) : "this event";
          below = `<div class="ed-row ed-mrow ed-evrow" data-evrow="${i}"><span class="ed-word">Only</span>
            <span class="ed-chip sel ed-evname"><span class="ed-cin">${escapeHtml(c.event.summary || "One event")}</span></span>
            <span class="ed-word">· ${escapeHtml(which)}</span>
            <button class="ed-x" data-evdel="${i}" title="Any event of this calendar" aria-label="Any event of this calendar">${ICON.x}</button></div>`;
        } else if (c.entity) {
          below = `<button class="ed-row ed-mrow ed-evadd${this.takeEnter(`eva${i}`) ? " enter" : ""}" data-evadd="${i}">
            <span class="ed-addic">${ICON.plus}</span><span class="ed-word">Only events called…</span></button>`;
        }
        break;
      case "tnum": {
        const unit = hass?.states?.[c.entity]?.attributes?.unit_of_measurement;
        sent = chip(`e${i}`, c.entity ? nameOf(hass, c.entity) : "Choose an entity", !c.entity) +
          `<button class="ed-chip sel ed-op" data-op="${i}"><span class="ed-cin">${this.opText(c)}</span></button>` +
          `<input class="ed-num" type="text" inputmode="decimal" data-num="${i}" value="${escapeHtml(c.value)}"
             placeholder="${escapeHtml(hass?.states?.[c.entity]?.state ?? "0")}" aria-label="Number">` +
          (unit ? `<span class="ed-word">${escapeHtml(unit)}</span>` : "");
        break;
      }
      case "tyaml":
        sent = `<span class="ed-word">This trigger fires</span>`;
        below = `<div class="ed-row notes ed-tplrow"><textarea class="ed-tarea mono" data-tpl="${i}" rows="4"
          placeholder="trigger: state&#10;entity_id: binary_sensor.doorbell&#10;to: &quot;on&quot;">${escapeHtml(c.template)}</textarea></div>`;
        break;
      case "template":
        sent = `<span class="ed-word">This template is true</span>`;
        below = `<div class="ed-row notes ed-tplrow"><textarea class="ed-tarea mono" data-tpl="${i}" rows="3"
          placeholder="{{ states('sensor.x') | float(0) > 10 }}">${escapeHtml(c.template)}</textarea></div>`;
    }
    let picker = "";
    if (pk === `e${i}`) picker = this.entityPickerHtml(i);
    else if (pk === `v${i}`) picker = this.valuePickerHtml(i);
    else if (pk === `s${i}`) picker = this.statusPickerHtml(i);
    else if (pk === `d${i}`) picker = this.drumHtml(`d${i}`);
    else if (pk === `tf${i}` || pk === `tt${i}` || pk === `ta${i}`) picker = this.timeDrumHtml(pk);
    else if (pk === `w${i}`) picker = this.whatPickerHtml(i);
    return `<div class="ed-cond${enter}" data-ci="${i}"><div class="ed-condin">
        <div class="ed-row cond${c.trig ? " trig" : ""}"><span class="ed-lbl${pos && !c.trig ? " join" : ""}">${c.trig
          // any trigger fires it
          ? (pos ? "Or" : "When")
          : pos
            ? `<button class="ed-chip sel ed-join" data-join title="All must hold (And), or any one is enough (Or)">${this.f.match === "any" ? "Or" : "And"}</button>`
            : this.f.type === "event" ? "Only if" : "If"}</span>
          <span class="ed-sent">${sent}</span>
          ${c.trig ? "" : `<span class="ed-hold" data-hold="${i}"></span>`}
          <button class="ed-x" data-del="${i}" title="Remove this ${c.trig ? "trigger" : "condition"}"
            aria-label="Remove this ${c.trig ? "trigger" : "condition"}">${ICON.x}</button>
        </div>${below}${picker}</div></div>`;
  }

  /* The days a time counts on, in the profile's week order. */
  daysRowHtml(c, i) {
    return `<div class="ed-row ed-daysrow"><span class="ed-days" role="group" aria-label="Days">
      ${DAY_NAMES.map((d, k) => [d, k]).sort((a, b) => ((a[1] - (LOCALE.firstDay + 6) % 7 + 7) % 7) - ((b[1] - (LOCALE.firstDay + 6) % 7 + 7) % 7))
        .map(([d, k]) => `<button class="ed-day${(c.days || []).includes(k) ? " on" : ""}" data-day="${i}:${k}"
          aria-pressed="${(c.days || []).includes(k)}">${d}</button>`).join("")}</span></div>`;
  }

  /* A numeric condition's Margin line says when the alert turns OK again: at the number, or
     back from it by the margin - or why its margin cannot apply. */
  marginHint(c) {
    const m = String(c.margin ?? "").trim();
    if (m !== "" && !(isNum(m) && Number(m) >= 0)) return "A margin is a number, 0 or more";
    const set = m !== "" && Number(m) > 0;
    if (set && plainConds(this.f).some((x) => x !== c && x.kind === "numeric" && Number(x.margin) > 0)) return "Only one condition can have a margin";
    if (set && this.f.match === "any" && plainConds(this.f).length > 1) return "A margin needs And between the conditions";
    if (!isNum(c.value)) return "";
    const unit = this.hass?.states?.[c.entity]?.attributes?.unit_of_measurement;
    const at = Number((Number(c.value) + (c.op === "below" ? 1 : -1) * (set ? Number(m) : 0)).toFixed(6));
    return `OK again at ${at}${unit ? ` ${unit}` : ""} or ${c.op === "below" ? "above" : "below"}`;
  }

  paintMargins() {
    this.sheet.querySelectorAll("[data-mhint]").forEach((el) => {
      const c = this.f.conds[Number(el.dataset.mhint)];
      if (c) swapText(el, this.marginHint(c));
    });
  }

  opText(c) {
    if (c.kind === "state") return c.op === "not" ? "is not" : "is";
    if (c.kind === "tnum") return c.op === "below" ? "drops below" : "rises above";
    return c.op === "below" ? "below" : "above";
  }

  /* An entity-change trigger's value: a state in Home Assistant's own words, an event's type,
     or any change at all ("*"). */
  trigValueText(c) {
    const evt = c.entity.startsWith("event.");
    if (c.value === "*") return evt ? "any event" : "anything";
    return evt ? c.value.replace(/_/g, " ") : stateLabel(this.hass, c.entity, c.value);
  }

  /* The chip itself; the row around it is what is tapped. */
  durChip(key, text, widest = DUR_WIDEST, button = false) {
    const inner = `<span class="ed-cin">${escapeHtml(text)}</span><span class="ed-sizer" aria-hidden="true">${widest}</span>`;
    // in a sentence the chip is a button of its own; on a row the row is the button
    return button || key.startsWith("d")
      ? `<button class="ed-chip dur sel${this.ui.picker === key ? " on" : ""}" data-pick="${key}">${inner}</button>`
      : `<span class="ed-chip dur sel${this.ui.picker === key ? " on" : ""}">${inner}</span>`;
  }

  /* Time or Calendar: the first word of the sentence, and the switch between the two. */
  /* An iOS segmented control: the chosen segment sits on a thumb that slides to the next one. */
  segHtml(attr, i, opts, cur, label) {
    return `<span class="ed-seg ed-sw" data-sw="${attr}${i}" role="radiogroup" aria-label="${label}"><span class="ed-thumb"></span>${opts
      .map(([k, l]) => `<button class="ed-seg-btn${k === cur ? " on" : ""}" data-${attr}="${i}:${k}" role="radio"
        aria-checked="${k === cur}">${l}</button>`).join("")}</span>`;
  }

  timeKindSeg(i, kind) {
    return this.segHtml("tk", i, [["time", "Time"], ["calendar", "Calendar"]], kind, "Time or calendar");
  }

  /* Put each control's thumb under its chosen segment; from where it was (`from`, by control),
     it slides there on a spring - picking up `since` that moment when a repaint replaced the
     thumb mid-slide, so the slide carries on rather than starting over. */
  placeThumbs(root, from = {}, since = 0) {
    for (const seg of root.querySelectorAll(".ed-sw")) {
      const thumb = seg.querySelector(".ed-thumb");
      const on = seg.querySelector(".ed-seg-btn.on");
      if (!thumb || !on) continue;
      const to = { left: on.offsetLeft, width: on.offsetWidth };
      thumb.style.left = `${to.left}px`;
      thumb.style.width = `${to.width}px`;
      const was = from[seg.dataset.sw];
      if (was && !reduceMotion() && (was.left !== to.left || was.width !== to.width)) {
        const a = thumb.animate([{ left: `${was.left}px`, width: `${was.width}px` }, { left: `${to.left}px`, width: `${to.width}px` }],
          { duration: 380, easing: "cubic-bezier(.34,1.26,.64,1)" });
        if (since) a.currentTime = Math.min(380, performance.now() - since);
      }
    }
  }

  thumbsOf(root) {
    const out = {};
    for (const seg of root?.querySelectorAll(".ed-sw") || []) {
      const t = seg.querySelector(".ed-thumb");
      if (t) out[seg.dataset.sw] = { left: t.offsetLeft, width: t.offsetWidth };
    }
    return out;
  }

  /* A condition changing what it is about (Time / Calendar, Device / Battery / Helper): the rest
     of its sentence slides out the way the thumb is going, the row eases to its new height, and
     the new words slide in from the other side - never a jump. */
  async switchCond(i, mutate, dir, btn) {
    // a second tap mid-switch waits its turn instead of tangling the two
    const prev = this._switching;
    let done;
    this._switching = new Promise((r) => { done = r; });
    await prev;
    let out;
    try { out = await this.switchCondNow(i, mutate, dir, btn); } finally { done(); }
    // resolves once the row has settled, for whatever opens next (a calendar's list)
    return out.settled;
  }

  async switchCondNow(i, mutate, dir, btn) {
    const el = this.sheet.querySelector(`[data-ci="${i}"]`);
    const moving = (root) => [...(root?.querySelectorAll(".ed-sent > :not(.ed-sw), .ed-condin > .ed-row:not(.cond), .ed-condin > .ed-picker") || [])];
    const from = this.thumbsOf(el);
    const h0 = el?.offsetHeight || 0;
    // the thumb goes at once, as on iOS, while the words make way
    const since = performance.now();
    const seg = btn?.closest(".ed-sw");
    if (seg?.isConnected) {
      seg.querySelectorAll(".ed-seg-btn").forEach((x) => { x.classList.toggle("on", x === btn); x.setAttribute("aria-checked", String(x === btn)); });
      this.placeThumbs(seg.parentElement, from);
    }
    if (!reduceMotion()) {
      await Promise.all(moving(el).map((x) => x.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 16}px)` }],
        { duration: 150, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {})));
    }
    mutate();
    this.ui.picker = null;
    this.paintWhen({ thumbFrom: from, thumbSince: since });
    const nel = this.sheet.querySelector(`[data-ci="${i}"]`);
    const anims = [];
    if (nel && !reduceMotion()) {
      const h1 = nel.offsetHeight;
      if (h1 !== h0) anims.push(nel.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 340, easing: IOS }));
      moving(nel).forEach((x, k) => anims.push(x.animate([{ opacity: 0, transform: `translateX(${dir * 20}px)` }, { opacity: 1, transform: "none" }],
        { duration: 380, delay: 25 * k, easing: IOS, fill: "backwards" })));
    }
    this.preview();
    // wrapped, so awaiting the switch itself does not wait for the slide
    return { settled: Promise.all(anims.map((a) => a.finished.catch(() => {}))) };
  }

  /* "While true" <-> "When it happens": the thumb slides at once, the rows below make way the
     way it is going, the group eases to its new height and the other kind's rows slide in.
     Nothing is lost: conditions stay (as "Only if"), triggers wait for a way back. */
  async switchType(type, btn) {
    if (this.f.type === type || this._typing) return;
    this._typing = true;
    const box = this.sheet.querySelector("#edWhen");
    const dir = type === "event" ? 1 : -1;
    const from = this.thumbsOf(box);
    const since = performance.now();
    const seg = btn.closest(".ed-sw");
    seg.querySelectorAll(".ed-seg-btn").forEach((x) => { x.classList.toggle("on", x === btn); x.setAttribute("aria-checked", String(x === btn)); });
    this.placeThumbs(seg.parentElement, from);
    const rest = () => [...box.children].filter((x) => !x.classList.contains("ed-typerow"));
    const h0 = box.offsetHeight;
    if (!reduceMotion()) {
      await Promise.all(rest().map((x) => x.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 16}px)` }],
        { duration: 150, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {})));
    }
    this.f.type = type;
    this.ui.picker = null;
    this.ui.adding = false;
    this.ui.addingT = false;
    // (a kind list that opens with the switch comes in with the rest of the rows, not with an
    // opening of its own - the group's new height is measured at once)
    // an event is cleared by hand (it has no end of its own); a condition ends by itself -
    // unless "Can be cleared" was set by hand
    if (!this.ui.clearTouched) {
      this.f.clearable = type === "event";
      const cb = this.sheet.querySelector("[data-clear]");
      if (cb) {
        cb.classList.toggle("on", this.f.clearable);
        cb.setAttribute("aria-checked", String(this.f.clearable));
        swapText(cb.querySelector(".ed-hint"), this.f.clearable ? CLEAR_HINT.on : CLEAR_HINT.off);
      }
    }
    this.paintWhen({ thumbFrom: from, thumbSince: since });
    if (!reduceMotion()) {
      const h1 = box.offsetHeight;
      if (h1 !== h0) box.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 360, easing: IOS });
      rest().forEach((x, k) => x.animate([{ opacity: 0, transform: `translateX(${dir * 20}px)` }, { opacity: 1, transform: "none" }],
        { duration: 380, delay: Math.min(k, 8) * 25, easing: IOS, fill: "backwards" }));
    }
    this._typing = false;
    this.paintFolds();
    this.preview();
  }

  /* A Health status as the Health view draws it in its tables and filters. */
  statTag(status, group) {
    return `<span class="tag stt" style="--c:${H_STATUS[status]?.tone || "#8B949E"}">${escapeHtml(statusWord(status, this.hass, group))}</span>`;
  }

  statusPickerHtml(i) {
    const c = this.f.conds[i];
    return `<div class="ed-picker${this.takeEnter(`s${i}`) ? " enter" : ""}" data-picker="s${i}">
        <div class="ed-opts ed-stats">${HEALTH[c.kind].statuses.map((x) =>
          `<button class="ed-stat${x === c.status ? " sel" : ""}" data-hs="${escapeHtml(x)}">${this.statTag(x, c.group)}</button>`).join("")}</div>
      </div>`;
  }

  whatPickerHtml(i) {
    const c = this.f.conds[i];
    return `<div class="ed-picker${this.takeEnter(`w${i}`) ? " enter" : ""}" data-picker="w${i}">
        <div class="ed-opts">${HEV[c.part].whats.map(([k, l]) =>
          `<button class="ed-chip${k === c.what ? " on" : ""}" data-hw="${k}">${l}</button>`).join("")}</div>
      </div>`;
  }

  entityPickerHtml(i) {
    return `<div class="ed-picker${this.takeEnter(`e${i}`) ? " enter" : ""}" data-picker="e${i}">
        <label class="ed-search">${ICON.search}<input type="text" data-search="${i}" autocomplete="off"
          spellcheck="false" placeholder="Search by name or entity id" aria-label="Search entities"></label>
        <div class="ed-list" id="edList">${this.entityListHtml(i, "")}</div>
      </div>`;
  }

  entityListHtml(i, q) {
    const c = this.f.conds[i];
    const hass = this.hass;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const [id, st] of Object.entries(hass?.states || {})) {
      if (id.startsWith("alert2.")) continue;
      if ((c.kind === "numeric" || c.kind === "tnum") && !isNum(st.state)) continue;
      if ((c.kind === "calendar" || c.kind === "tcal") && !id.startsWith("calendar.")) continue;
      const name = st.attributes?.friendly_name || id;
      const hay = `${name} ${id}`.toLowerCase();
      if (words.length && !words.every((w) => hay.includes(w))) continue;
      const lead = words.length && name.toLowerCase().startsWith(words[0]) ? 0 : 1;
      out.push({ id, name, st, lead });
    }
    out.sort((a, b) => a.lead - b.lead || a.name.localeCompare(b.name));
    if (!out.length) return `<div class="ed-none">Nothing matches.</div>`;
    return out.slice(0, ENTITY_ROWS).map((x) => `<button class="ed-item${x.id === c.entity ? " sel" : ""}" data-eid="${escapeHtml(x.id)}">
        <span class="ed-itext"><span class="ed-iname">${escapeHtml(x.name)}</span><span class="ed-iid">${escapeHtml(x.id)}</span></span>
        <span class="ed-istate">${escapeHtml(stateLabel(hass, x.id, x.st.state))}</span></button>`).join("") +
      (out.length > ENTITY_ROWS ? `<div class="ed-none">${out.length - ENTITY_ROWS} more - type to narrow it down.</div>` : "");
  }

  valuePickerHtml(i) {
    const c = this.f.conds[i];
    const hass = this.hass;
    if (c.kind === "tstate") {
      // a trigger: any change first, then the states it can change to (or an event entity's types)
      const st = hass?.states?.[c.entity];
      const evt = c.entity.startsWith("event.");
      const opts = evt ? [...(st?.attributes?.event_types || [])]
        : [...(DOMAIN_STATES[c.entity.split(".")[0]] || []), ...(st?.attributes?.options || []), ...(st?.attributes?.hvac_modes || [])];
      if (!evt && st && !["unavailable", "unknown"].includes(st.state) && !opts.includes(st.state)) opts.push(st.state);
      if (c.value !== "" && c.value !== "*" && !opts.includes(c.value)) opts.push(c.value);
      return `<div class="ed-picker${this.takeEnter(`v${i}`) ? " enter" : ""}" data-picker="v${i}">
          <div class="ed-opts">${["*", ...new Set(opts)].map((v) => `<button class="ed-chip${v === c.value ? " on" : ""}" data-val="${escapeHtml(v)}"
            title="${escapeHtml(v)}">${escapeHtml(this.trigValueText({ ...c, value: v }))}</button>`).join("")}</div>
          ${evt ? "" : `<div class="ed-row"><span class="ed-lbl">Other</span><span class="ed-vals">
            <input type="text" data-other="${i}" autocomplete="off" spellcheck="false" placeholder="Type a state, then Enter"></span></div>`}
        </div>`;
    }
    const st = hass?.states?.[c.entity];
    const domain = c.entity.split(".")[0];
    const opts = [...(DOMAIN_STATES[domain] || []), ...(st?.attributes?.options || []), ...(st?.attributes?.hvac_modes || [])];
    if (st && !opts.includes(st.state)) opts.push(st.state);
    if (c.value !== "" && !opts.includes(c.value)) opts.push(c.value);
    for (const v of ["unavailable", "unknown"]) if (!opts.includes(v)) opts.push(v);
    return `<div class="ed-picker${this.takeEnter(`v${i}`) ? " enter" : ""}" data-picker="v${i}">
        <div class="ed-opts">${[...new Set(opts)].map((v) => `<button class="ed-chip${v === c.value ? " on" : ""}" data-val="${escapeHtml(v)}"
          title="${escapeHtml(v)}">${escapeHtml(stateLabel(hass, c.entity, v))}</button>`).join("")}</div>
        <div class="ed-row"><span class="ed-lbl">Other</span><span class="ed-vals">
          <input type="text" data-other="${i}" autocomplete="off" spellcheck="false" placeholder="Type a state, then Enter"></span></div>
      </div>`;
  }

  /* Days, hours and minutes on three drums - the snooze sheet's drum, a column each. */
  drumHtml(key) {
    const col = (unit, max, label) => `<div class="wheel-col" tabindex="0" role="spinbutton" data-unit="${unit}"
        aria-label="${unit}" aria-valuemin="0" aria-valuemax="${max}">
        ${Array.from({ length: max + 1 }, (_, n) => `<div class="wheel-item">${label(n)}</div>`).join("")}</div>`;
    return `<div class="ed-picker${this.takeEnter(key) ? " enter" : ""}" data-picker="${key}">
        <div class="wheel" data-drum="${key}" style="--wheel-h:${DRUM_ROW * DRUM_ROWS}px"><div class="wheel-band"></div>
          ${col("days", 30, (n) => `${n} ${n === 1 ? "day" : "days"}`)}
          ${col("hours", 23, (n) => `${n} h`)}
          ${col("minutes", 59, (n) => `${n} min`)}</div>
      </div>`;
  }

  /* A time of day on two drums - the snooze sheet's, hour and minute. */
  timeDrumHtml(key) {
    const hourLabel = (n) => (LOCALE.hour12 === false ? pad2(n) : `${n % 12 === 0 ? 12 : n % 12} ${n < 12 ? "AM" : "PM"}`);
    const col = (unit, max, label) => `<div class="wheel-col" tabindex="0" role="spinbutton" data-unit="${unit}"
        aria-label="${unit}" aria-valuemin="0" aria-valuemax="${max}">
        ${Array.from({ length: max + 1 }, (_, n) => `<div class="wheel-item">${label(n)}</div>`).join("")}</div>`;
    return `<div class="ed-picker${this.takeEnter(key) ? " enter" : ""}" data-picker="${key}">
        <div class="wheel" data-drum="${key}" data-time="1" style="--wheel-h:${DRUM_ROW * DRUM_ROWS}px"><div class="wheel-band"></div>
          ${col("hour", 23, hourLabel)}<div class="wheel-sep">:</div>${col("minute", 59, pad2)}</div>
      </div>`;
  }

  mountTimeDrum(wheel, key) {
    const c = this.f.conds[Number(key.slice(2))];
    if (!c) return;
    const field = { tf: "from", tt: "to", ta: "at" }[key.slice(0, 2)];
    const live = hm(c[field]);
    const set = () => {
      const was = c[field];
      c[field] = `${pad2(live[0])}:${pad2(live[1])}`;
      const chip = this.sheet.querySelector(`[data-pick="${key}"]`);
      rollChip(chip, chip?.querySelector(".ed-cin"), fmtHM(c[field]), Math.sign(c[field].localeCompare(was)));
    };
    ["hour", "minute"].forEach((unit, u) => new Drum(wheel.querySelector(`[data-unit="${unit}"]`), {
      rowH: DRUM_ROW, radius: (DRUM_ROW * DRUM_ROWS) / 2, max: u ? 59 : 23, reduced: reduceMotion,
      onMove: (n) => { live[u] = n; set(); },
      onSettle: (n) => { live[u] = n; set(); this.preview(); },
    }, live[u]));
  }

  mountDrum() {
    const wheel = this.sheet.querySelector("[data-drum]");
    if (!wheel) return;
    const key = wheel.dataset.drum;
    if (wheel.dataset.time) return this.mountTimeDrum(wheel, key);
    const get = () => (key === "for" ? this.f.forMins : key === "stay" ? this.f.stayMins : this.f.conds[Number(key.slice(1))]?.mins || 0);
    const set = (m) => {
      const was = get();
      if (key === "for") this.f.forMins = m;
      else if (key === "stay") this.f.stayMins = m;
      else { const c = this.f.conds[Number(key.slice(1))]; if (c) c.mins = m; }
      const pick = this.sheet.querySelector(`[data-pick="${key}"]`);
      const chip = pick?.classList.contains("ed-chip") ? pick : pick?.querySelector(".ed-chip");
      rollChip(chip, chip?.querySelector(".ed-cin"),
        fmtMins(m, key === "for" ? "Immediately" : key === "stay" ? "Until cleared" : "0 min"), Math.sign(m - was));
      if (key === "stay" && Boolean(m) !== Boolean(was)) swapText(pick?.querySelector(".ed-hint"), m ? "Then OK by itself" : "");
    };
    const m0 = get();
    const parts = { days: Math.floor(m0 / 1440), hours: Math.floor((m0 % 1440) / 60), minutes: m0 % 60 };
    const live = { ...parts };
    const total = (p) => p.days * 1440 + p.hours * 60 + p.minutes;
    for (const [unit, max] of [["days", 30], ["hours", 23], ["minutes", 59]]) {
      new Drum(wheel.querySelector(`[data-unit="${unit}"]`), {
        rowH: DRUM_ROW, radius: (DRUM_ROW * DRUM_ROWS) / 2, max, reduced: reduceMotion,
        onMove: (n) => { live[unit] = n; set(total(live)); },
        onSettle: (n) => { live[unit] = n; set(total(live)); this.preview(); },
      }, parts[unit]);
    }
  }

  /* What the rule would do right now, live from Home Assistant. */
  paintNow() {
    const el = this.sheet.querySelector("#edNow");
    if (!el) return;
    const r = this.res;
    let html;
    const ev = this.f.type === "event";
    if (ev) {
      const msg = r?.said?.ok && r.said.msg ? r.said.msg : "";
      // what it would say for its first trigger, and - for a time or a calendar - when it fires next
      const cal = r?.of?.kind === "tcal";
      let line;
      if (cal) {
        // the event it will fire for, worded as the message will be when it is sent
        const x = r.cal;
        const calName = nameOf(this.hass, r.of.entity);
        line = !x ? "Looking for the next event…"
          : x.err ? `${calName} could not be read.`
          : x.none ? `No event in ${calName} to fire for in the next two months.`
          // said as what it is: a time before an event - and why sooner events are passed over
          : r.of.mins
            ? `Next fires ${fmtDT(x.at)} - ${fmtMins(r.of.mins)} before ${x.summary} (${fmtDT(x.start)}).` +
              (x.skipped ? ` Anything sooner is less than ${fmtMins(r.of.mins)} away.` : "")
            : `Next fires ${fmtDT(x.at)}, when ${x.summary} starts.`;
      } else if (Number.isFinite(r?.at) && r.at > Date.now()) line = `Next fires ${fmtDT(r.at)}${msg ? `: ${msg}` : ""}`;
      else line = msg ? `It would say: ${msg}` : "Fires each time it happens.";
      if (!r || r.incomplete) html = `<span class="ed-dot"></span>Finish the trigger to see what it would do.`;
      else if (r.err) html = `<span class="ed-dot fire"></span>It cannot be worked out: ${escapeHtml(r.err)}`;
      else if (!r.gated) html = `<span class="ed-dot"></span>${escapeHtml(line)}`;
      else if (r.cond === undefined) html = `<span class="ed-dot"></span>Checking…`;
      else if (truthy(r.cond)) html = `<span class="ed-dot fire"></span>If it happened now, it would fire${msg ? `: ${escapeHtml(msg)}` : "."}`;
      else html = `<span class="ed-dot ok"></span>If it happened now, the conditions would hold it back.`;
    }
    else if (!r || r.incomplete) html = `<span class="ed-dot"></span>Finish the conditions to see what it would do now.`;
    else if (r.err) html = `<span class="ed-dot fire"></span>It cannot be worked out: ${escapeHtml(r.err)}`;
    else if (r.cond === undefined) html = `<span class="ed-dot"></span>Checking…`;
    else if (truthy(r.cond)) html = `<span class="ed-dot fire"></span>Would fire now${r.msg ? `: ${escapeHtml(r.msg.split("\n").map((l) => l.trim()).filter(Boolean).join(" · "))}` : ""}`;
    else html = `<span class="ed-dot ok"></span>Would not fire now`;
    // with several conditions: how many hold, and how many must
    const idx = r?.holdIdx || [];
    const n = idx.length;
    const holds = r && !r.incomplete && !r.err && Array.isArray(r.holds) && r.holds.length === n ? r.holds : null;
    if (holds && n > 1) {
      const k = holds.filter(truthy).length;
      html += `<span class="ed-count">${k} of ${n} ${k === 1 ? "holds" : "hold"} now - ${this.f.match === "any" ? "any one is enough" : "all must"}</span>`;
    }
    this.sheet.querySelectorAll("[data-hold]").forEach((d) => {
      const at = idx.indexOf(Number(d.dataset.hold));
      const v = holds && at >= 0 ? truthy(holds[at]) : null;
      d.classList.toggle("yes", v === true);
      d.classList.toggle("no", v === false);
      d.title = v === null ? "" : v ? "Holds now" : "Does not hold now";
      d.setAttribute("aria-label", d.title);
    });
    if (el._html !== html) {
      el._html = html;
      el.innerHTML = html;
      if (!reduceMotion()) el.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 220, easing: IOS });
    }
    const said = this.sheet.querySelector("#edSaid");
    // "When it happens": what it will say, in words - the names come with the event
    if (said && ev) {
      swapText(said, r?.cal && !r.cal.none && !r.cal.err ? this.calMsg(r.cal)
        : (r?.said?.ok && r.said.msg) || this.f.message.trim() || r?.sample || "—");
    }
    else if (said) swapText(said, r?.msg ? r.msg : r && !r.incomplete && !truthy(r.cond) ? "(nothing to say while it is not firing)" : "—");
  }

  // ------------------------------------------------------------------ events

  async setPicker(key) {
    await this.collapse(this.sheet.querySelector(".ed-picker"));
    if (key) {
      const shut = [];
      if (this.ui.adding && (this.f.type === "event" || plainConds(this.f).length)) { this.ui.adding = false; shut.push("kind"); }
      if (this.ui.addingT && this.f.conds.some((c) => c.trig)) { this.ui.addingT = false; shut.push("tkind"); }
      await Promise.all(shut.map((k) => this.collapse(this.sheet.querySelector(`.ed-kinds[data-kinds="${k}"]`))));
    }
    this.ui.picker = key;
    if (key) this.ui.enter.add(key);
    this.paintBasics();
    this.paintWhen();
    this.paintThen();
    this.paintNotify();
    this.paintLinks();
    const search = this.sheet.querySelector("[data-search]");
    if (search && matchMedia("(pointer: fine)").matches) search.focus({ preventScroll: true });
    this.sheet.querySelector(".ed-picker")?.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  }

  onClick(e) {
    if (this.ui?.armed && !e.target.closest('[data-act="delete"]')) this.disarm();
    const t = e.target;
    const hit = (sel) => t.closest(sel);
    let b;
    if ((b = hit("[data-act]"))) {
      if (b.dataset.act === "delete") return this.remove(b);
      return b.dataset.act === "save" ? this.save() : this.close();
    }
    if (this.ui.busy) return;
    if ((b = hit("[data-prio]"))) {
      const seg = b.closest(".ed-sw");
      const from = this.thumbsOf(seg.parentElement);
      this.f.priority = b.dataset.prio;
      this.sheet.style.setProperty("--accent", PRIO[this.f.priority].tone);
      seg.style.setProperty("--thumb", PRIO[this.f.priority].tone);
      this.sheet.querySelectorAll("[data-prio]").forEach((x) => {
        x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b));
      });
      this.placeThumbs(seg.parentElement, from);
      return;
    }
    if ((b = hit("[data-pick]"))) return this.setPicker(this.ui.picker === b.dataset.pick ? null : b.dataset.pick);
    if ((b = hit("[data-cat]"))) { this.f.category = b.dataset.cat === "general" ? "" : b.dataset.cat; this.ui.catTouched = true; return this.setPicker(null); }
    if ((b = hit("[data-clear]"))) {
      this.ui.clearTouched = true;
      this.f.clearable = !this.f.clearable;
      b.classList.toggle("on", this.f.clearable);
      b.setAttribute("aria-checked", String(this.f.clearable));
      swapText(b.querySelector(".ed-hint"), this.f.clearable ? CLEAR_HINT.on : CLEAR_HINT.off);
      return;
    }
    if ((b = hit("[data-bp]"))) {
      // in place, as a dashboard is picked: the list stays open, the thumb slides, the chip follows
      const main = b.dataset.bp.split(":")[1] === "home";
      if (main === this.f.bannerMain) return;
      const seg = b.closest(".ed-sw");
      const from = this.thumbsOf(seg.parentElement);
      this.f.bannerMain = main;
      for (const x of seg.querySelectorAll(".ed-seg-btn")) {
        const on = x === b;
        x.classList.toggle("on", on);
        x.setAttribute("aria-checked", String(on));
      }
      this.placeThumbs(seg.parentElement, from);
      this.syncNotify("nb");
      return;
    }
    if ((b = hit("[data-tk]"))) {
      const [i, kind] = b.dataset.tk.split(":");
      const c = this.f.conds[Number(i)];
      if (c.kind === kind) return;
      return this.switchCond(Number(i), () => { this.f.conds[Number(i)] = newCond(kind, this.hass); }, kind === "calendar" ? 1 : -1, b)
        // a calendar is chosen at once, as an entity is - once the row has settled, so opening
        // its list does not cut the new words' slide short
        .then(() => { if (this.dlg.open && kind === "calendar" && this.f.conds[Number(i)]?.kind === "calendar" && !this.ui.picker) this.setPicker(`e${i}`); });
    }
    if ((b = hit("[data-firesinfo]"))) return this.card._popAt(b, FIRES_INFO, "x");
    if ((b = hit("[data-margininfo]"))) return this.card._popAt(b, MARGIN_INFO, "x");
    if ((b = hit("[data-actinfo]"))) return this.card._popAt(b, ACTIONS_INFO, "x");
    if ((b = hit("[data-notifyinfo]"))) return this.card._popAt(b, NOTIFY_INFO, "x");
    if ((b = hit("[data-push]")) || (b = hit("[data-banner]"))) {
      // picked or let go in place: the list stays open for the next one, the chip follows
      const key = b.dataset.push != null ? "np" : "nb";
      const list = key === "np" ? this.f.notify : this.f.banner;
      const id = b.dataset.push ?? b.dataset.banner;
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
      else {
        // Everyone already is every user: picking it lets the users go, a user lets it go
        if (id === EVERYONE) list.length = 0;
        else if (key === "np" && list.includes(EVERYONE)) list.splice(list.indexOf(EVERYONE), 1);
        list.push(id);
      }
      this.syncNotify(key);
      return;
    }
    if ((b = hit("[data-adel]"))) return this.removeAction(Number(b.dataset.adel));
    if ((b = hit("[data-script]"))) {
      // a new one, or the one whose picker is open changed; never the same script twice
      const eid = b.dataset.script;
      const at = this.ui.picker === "anew" ? -1 : Number(this.ui.picker.slice(1));
      if (!this.f.actions.some((x, k) => x === eid && k !== at)) {
        if (at < 0) this.f.actions.push(eid); else this.f.actions[at] = eid;
      }
      return this.setPicker(null);
    }
    if ((b = hit("[data-ty]"))) return this.switchType(b.dataset.ty.split(":")[1], b);
    if ((b = hit("[data-hp]"))) {
      const [i, part] = b.dataset.hp.split(":");
      const c = this.f.conds[Number(i)];
      if (c.part === part) return;
      const order = ["dev", "bat", "hlp"];
      const dir = Math.sign(order.indexOf(part) - order.indexOf(c.part)) || 1;
      return this.switchCond(Number(i), () => {
        c.part = part;
        if (!HEV[part].whats.some(([k]) => k === c.what)) c.what = HEV[part].whats[0][0];
      }, dir, b);
    }
    if ((b = hit("[data-hw]"))) {
      this.f.conds[Number(this.ui.picker.slice(1))].what = b.dataset.hw;
      this.preview();
      return this.setPicker(null);
    }
    if ((b = hit("[data-hk]"))) {
      const [i, kind] = b.dataset.hk.split(":");
      const c = this.f.conds[Number(i)];
      if (c.kind === kind) return;
      const order = ["dev", "bat", "hlp"];
      const dir = Math.sign(order.indexOf(kind) - order.indexOf(c.kind)) || 1;
      return this.switchCond(Number(i), () => {
        c.kind = kind;
        if (!HEALTH[kind].statuses.includes(c.status)) c.status = HEALTH[kind].statuses[0];
      }, dir, b);
    }
    if ((b = hit("[data-day]"))) {
      const [i, k] = b.dataset.day.split(":").map(Number);
      const c = this.f.conds[i];
      const days = new Set(c.days || []);
      days.has(k) ? days.delete(k) : days.add(k);
      c.days = [...days].sort();
      b.classList.toggle("on", days.has(k));
      b.setAttribute("aria-pressed", String(days.has(k)));
      return this.preview();
    }
    if ((b = hit("[data-join]"))) {
      this.f.match = this.f.match === "any" ? "all" : "any";
      this.sheet.querySelectorAll(".ed-join").forEach((x) => swapText(x, this.f.match === "any" ? "Or" : "And"));
      this.paintMargins();
      return this.preview();
    }
    if ((b = hit("[data-op]"))) {
      const c = this.f.conds[Number(b.dataset.op)];
      c.op = c.kind === "state" ? (c.op === "not" ? "is" : "not") : (c.op === "below" ? "above" : "below");
      swapText(b.querySelector(".ed-cin"), this.opText(c));
      this.paintMargins();
      return this.preview();
    }
    if ((b = hit("[data-evdel]"))) return this.dropEventFilter(Number(b.dataset.evdel));
    if ((b = hit("[data-evadd]"))) {
      // "Only events called…": the row turns into the title field, which takes the typing
      const i = Number(b.dataset.evadd);
      this.f.conds[i].event = { match: "title", title: "" };
      this.ui.enter.add(`ev${i}`);
      this.paintWhen();
      this.sheet.querySelector(`[data-evtitle="${i}"]`)?.focus();
      return this.preview();
    }
    if ((b = hit("[data-del]"))) return this.removeCond(Number(b.dataset.del));
    if ((b = hit("[data-add]"))) return this.openAdding();
    if ((b = hit("[data-addt]"))) return this.openAdding(true);
    if ((b = hit("[data-kind]"))) return this.addCond(b.dataset.kind);
    if ((b = hit("[data-tkind]"))) return this.addCond(b.dataset.tkind, true);
    if ((b = hit("[data-eid]"))) {
      const i = Number(this.ui.picker.slice(1));
      const c = this.f.conds[i];
      // a reminder's event belongs to its calendar: another calendar has no such event
      if (c.kind === "tcal" && c.entity !== b.dataset.eid) delete c.event;
      c.entity = b.dataset.eid;
      // a state is chosen next, as an entity is chosen first
      if (c.kind === "state" || c.kind === "tstate") { c.value = ""; this.ui.picker = `v${i}`; this.ui.enter.add(this.ui.picker); }
      else this.ui.picker = null;
      this.paintWhen();
      if (c.kind === "numeric" || c.kind === "tnum") this.sheet.querySelector(`[data-num="${i}"]`)?.focus();
      return this.preview();
    }
    if ((b = hit("[data-link]"))) {
      if (this.ui.picker === "ld") this.f.linkDesktop = b.dataset.link;
      else this.f.linkMobile = b.dataset.link;
      return this.setPicker(null);
    }
    if ((b = hit("[data-hs]"))) {
      this.f.conds[Number(this.ui.picker.slice(1))].status = b.dataset.hs;
      this.preview();
      return this.setPicker(null);
    }
    if ((b = hit("[data-val]"))) {
      this.f.conds[Number(this.ui.picker.slice(1))].value = b.dataset.val;
      this.preview();
      return this.setPicker(null);
    }
    if ((b = hit("[data-fold]"))) {
      this.ui.folds[b.dataset.fold] = !this.ui.folds[b.dataset.fold];
      return this.paintFolds();
    }
  }

  /* The list of condition kinds - or, `trig`, of trigger kinds - opens under its add row. */
  async openAdding(trig = false) {
    if (trig ? this.ui.addingT : this.ui.adding) return;
    await this.collapse(this.sheet.querySelector(".ed-picker"));
    if (trig) { this.ui.addingT = true; this.ui.enter.add("addt"); } else { this.ui.adding = true; this.ui.enter.add("add"); }
    this.ui.picker = null;
    this.paintWhen();
  }

  async addCond(kind, trig = false) {
    await this.collapse(this.sheet.querySelector(`.ed-kinds[data-kinds="${trig ? "tkind" : "kind"}"]`));
    if (kind === "health") kind = "dev";   // its row then chooses Device / Battery / Helper
    const c = newCond(kind, this.hass, this.f.conds);
    this.f.conds.push(c);
    const i = this.f.conds.length - 1;
    if (trig) this.ui.addingT = false; else this.ui.adding = false;
    this.ui.enter.add(`c${i}`);
    this.ui.picker = ["state", "numeric", "calendar", "tstate", "tnum", "tcal"].includes(kind) ? `e${i}` : null;
    if (this.ui.picker) this.ui.enter.add(this.ui.picker);
    // a Health condition (or trigger) makes a Health alert, unless a category was chosen
    if ((HEALTH[kind] || kind === "hev") && !this.ui.catTouched && !this.f.category) { this.f.category = "health"; this.paintBasics(); }
    this.paintWhen();
    if (matchMedia("(pointer: fine)").matches) this.sheet.querySelector("[data-search]")?.focus({ preventScroll: true });
    if (kind === "template" || kind === "tyaml") this.sheet.querySelector(`[data-tpl="${i}"]`)?.focus();
    this.sheet.querySelector(`[data-ci="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
    this.preview();
  }

  /* A calendar trigger's event filter let go - every event of the calendar sets it off now.
     The row folds away first, as a removed condition does; "Only events called…" comes back. */
  async dropEventFilter(i) {
    await this.collapse(this.sheet.querySelector(`[data-evrow="${i}"]`), 220);
    if (this.f.conds[i]) delete this.f.conds[i].event;
    this.ui.enter.add(`eva${i}`);
    this.paintWhen();
    this.preview();
  }

  async removeCond(i) {
    await this.collapse(this.sheet.querySelector(`[data-ci="${i}"]`), 220);
    const trig = !!this.f.conds[i]?.trig;
    this.f.conds.splice(i, 1);
    this.ui.picker = null;
    // the last one gone, its list opens again (the conditions of "When it happens" are optional)
    if (trig && !this.f.conds.some((c) => c.trig)) { this.ui.addingT = true; this.ui.enter.add("addt"); }
    if (!trig && this.f.type !== "event" && !plainConds(this.f).length) { this.ui.adding = true; this.ui.enter.add("add"); }
    this.paintWhen();
    this.preview();
  }

  onInput(e) {
    const t = e.target;
    const f = this.f;
    if (t.classList.contains("ed-title")) { f.title = t.value; return this.clearError(); }
    if (t.dataset.ssearch !== undefined) {
      const list = this.sheet.querySelector("#edScriptList");
      list.innerHTML = this.scriptListHtml(t.dataset.ssearch, t.value);
      list.scrollTop = 0;
      return;
    }
    if (t.dataset.lsearch !== undefined) {
      const list = this.sheet.querySelector("#edLinkList");
      list.innerHTML = this.linkListHtml(t.dataset.lsearch, t.value);
      list.scrollTop = 0;
      return;
    }
    if (t.dataset.search !== undefined) {
      const list = this.sheet.querySelector("#edList");
      list.innerHTML = this.entityListHtml(Number(t.dataset.search), t.value);
      list.scrollTop = 0;
      return;
    }
    if (t.dataset.num !== undefined) { f.conds[Number(t.dataset.num)].value = t.value.trim().replace(",", "."); this.paintMargins(); return this.preview(); }
    if (t.dataset.margin !== undefined) { f.conds[Number(t.dataset.margin)].margin = t.value.trim().replace(",", "."); return this.paintMargins(); }
    if (t.dataset.tpl !== undefined) { f.conds[Number(t.dataset.tpl)].template = t.value; return this.preview(); }
    if (t.dataset.evtitle !== undefined) {
      const ev = f.conds[Number(t.dataset.evtitle)]?.event;
      if (ev) ev.title = t.value;
      this.clearError();
      return this.preview();
    }
    if (t.id === "edMsg") { f.message = t.value; this.paintFolds(); return this.preview(); }
    if (t.id === "edDesc") { f.description = t.value; return this.paintFolds(); }
  }

  onKey(e) {
    if (e.key !== "Enter") return;
    const t = e.target;
    if (t.dataset.newcat !== undefined && slugify(t.value)) {
      this.f.category = slugify(t.value);
      this.ui.catTouched = true;
      return this.setPicker(null);
    }
    if (t.dataset.other !== undefined && t.value.trim()) {
      this.f.conds[Number(t.dataset.other)].value = t.value.trim();
      this.preview();
      return this.setPicker(null);
    }
    if (t.dataset.search !== undefined) {
      this.sheet.querySelector("#edList .ed-item")?.click();
      return;
    }
    if (t.dataset.ssearch !== undefined) {
      this.sheet.querySelector("#edScriptList .ed-item")?.click();
      return;
    }
    if (t.dataset.lsearch !== undefined) {
      this.sheet.querySelector("#edLinkList .ed-item")?.click();
      return;
    }
    if (t.classList.contains("ed-title")) t.blur();
  }

  // ------------------------------------------------------------------ preview

  preview() {
    clearTimeout(this._pt);
    this._pt = setTimeout(() => this.runPreview(), 300);
  }

  unsubscribe() {
    this._pseq++;
    for (const u of this._unsubs) { try { u(); } catch { /* gone already */ } }
    this._unsubs = [];
    this._pkey = null;
  }

  async runPreview() {
    if (!this.dlg.open) return;
    const out = compileRule(this.f, this.hass, this.key);
    if (out.builtin) return;
    if (out.event) return this.runEventPreview(out);
    const key = `${out.condition}\u0000${out.message}`;
    if (key === this._pkey) return;
    this.unsubscribe();
    this._pkey = key;
    if (!out.condition) { this.res = { incomplete: true }; this.paintNow(); return; }
    const seq = this._pseq;
    const res = { cond: undefined, msg: "", err: null, holds: null, holdIdx: out.holdIdx };
    this.res = res;
    this.paintNow();
    const paint = () => { if (seq === this._pseq) this.paintNow(); };
    const sub = (template, fn) => this.hass.connection.subscribeMessage(
      (m) => { if (m.error) res.err = String(m.error); else { res.err = null; fn(m.result); } paint(); },
      { type: "render_template", template, report_errors: true, timeout: 3 });
    try {
      const subs = await Promise.all([sub(out.condition, (v) => { res.cond = v; }),
                                      sub(out.message, (v) => { res.msg = String(v ?? "").trim(); }),
                                      ...(out.holds ? [sub(out.holds, (v) => {
                                        try { res.holds = Array.isArray(v) ? v : JSON.parse(v); } catch { res.holds = null; }
                                      })] : [])]);
      if (seq !== this._pseq) subs.forEach((u) => u());
      else this._unsubs = subs;
    } catch (err) {
      res.err = err?.message || String(err);
      paint();
    }
  }

  /* What a calendar trigger's message says for an event, as of the moment it fires ("Tomorrow"
     is the day after that moment) - or your own message. */
  calMsg(x) {
    if (this.f.message.trim()) return this.f.message.trim();
    return `${x.summary} · ${fmtDay(x.start, x.at)}${x.allDay ? "" : `, ${fmtTime(x.start)}`}`;
  }

  /* The first event a calendar trigger will fire for: the first whose moment ("starts in" before
     it) is still ahead. The calendar entity itself knows only its very next event, which may be
     inside that time already - so the calendar's own list is read, two months past the offset.
     Kept a minute per calendar and offset while the sheet is open. A reminder's trigger (`ev`)
     looks only at its own event. */
  async findCalEvent({ entity, mins, ev }) {
    const key = `${entity}|${mins}|${ev?.match || ""}|${ev?.uid || ""}|${ev?.match === "event" ? ev.recurrence_id || "" : ""}|${titleKey(ev?.title)}`;
    if (this._calCache?.key === key && Date.now() - this._calCache.t < 60e3) return this._calCache.v;
    const now = Date.now();
    const off = mins * 60e3;
    const end = new Date(now + off + 62 * DAY).toISOString();
    let v;
    try {
      const evs = await this.hass.callApi("GET",
        `calendars/${entity}?start=${encodeURIComponent(new Date(now).toISOString())}&end=${encodeURIComponent(end)}`);
      const mine = (e) => !ev || (ev.match === "title" ? titleKey(e.summary) === titleKey(ev.title)
        : e.uid === ev.uid && (ev.match !== "event" || !ev.recurrence_id || e.recurrence_id === ev.recurrence_id));
      const list = (evs || []).filter(mine).map((e) => {
        const allDay = !e.start?.dateTime;
        return { summary: e.summary || "", allDay,
                 start: allDay ? new Date(`${e.start?.date}T00:00:00`).getTime() : Date.parse(e.start?.dateTime) };
      }).filter((e) => Number.isFinite(e.start)).sort((a, b) => a.start - b.start);
      const hit = list.find((e) => e.start - off > now);
      // events still to come that it passes over: they start sooner than its time before them
      const skipped = list.filter((e) => e.start > now && e.start - off <= now).length;
      v = hit ? { ...hit, at: hit.start - off, skipped } : { none: true };
    } catch {
      v = { err: true };
    }
    this._calCache = { key, t: Date.now(), v };
    return v;
  }

  /* "When it happens" has no "now" to show: it says what it waits for, and - with "Only if"
     conditions - whether they would let it through if it happened now. */
  async runEventPreview(out) {
    const key = `E\u0000${out.ready}\u0000${out.preview}\u0000${out.holds}\u0000${out.sampleTpl}\u0000${out.sampleAt}\u0000${JSON.stringify(out.calSample)}\u0000${this.f.message}`;
    if (key === this._pkey) return;
    this.unsubscribe();
    this._pkey = key;
    if (!out.ready) { this.res = { incomplete: true, event: true }; this.paintNow(); return; }
    const seq = this._pseq;
    const res = { event: true, gated: !!out.preview, cond: undefined, err: null, holds: null, holdIdx: out.holdIdx,
                  sample: out.sample, said: null, at: out.sampleAt, of: out.sampleOf, cal: null };
    this.res = res;
    this.paintNow();
    const paint = () => { if (seq === this._pseq) this.paintNow(); };
    if (out.calSample) this.findCalEvent(out.calSample).then((x) => { res.cal = x; paint(); });
    if (!out.preview && !out.sampleTpl) return;
    const sub = (template, fn) => this.hass.connection.subscribeMessage(
      (m) => { if (m.error) res.err = String(m.error); else { res.err = null; fn(m.result); } paint(); },
      { type: "render_template", template, report_errors: true, timeout: 3 });
    try {
      const subs = await Promise.all([...(out.preview ? [sub(out.preview, (v) => { res.cond = v; })] : []),
                                      ...(out.sampleTpl ? [sub(out.sampleTpl, (v) => {
                                        let o = v;
                                        try { if (typeof o === "string") o = JSON.parse(o); } catch { o = null; }
                                        res.said = o && typeof o === "object" ? o : null;
                                        if (res.said?.at != null) res.at = Number(res.said.at) * 1000;
                                      })] : []),
                                      ...(out.holds ? [sub(out.holds, (v) => {
                                        try { res.holds = Array.isArray(v) ? v : JSON.parse(v); } catch { res.holds = null; }
                                      })] : [])]);
      if (seq !== this._pseq) subs.forEach((u) => u());
      else this._unsubs = subs;
    } catch (err) {
      res.err = err?.message || String(err);
      paint();
    }
  }

  // ------------------------------------------------------------------ save

  clearError() {
    const el = this.sheet.querySelector("#edErr");
    if (el && !el.hidden) el.hidden = true;
  }

  showError(lines) {
    const el = this.sheet.querySelector("#edErr");
    el.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
    el.hidden = false;
    if (!reduceMotion()) el.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }],
      { duration: 360, easing: "cubic-bezier(.34,1.42,.64,1)" });
    el.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  }

  setBusy(on) {
    this.ui.busy = on;
    const btn = this.sheet.querySelector('[data-act="save"]');
    btn.disabled = on;
    swapText(btn, this.editing ? (on ? "Saving…" : "Save") : (on ? "Adding…" : "Add"));
    this.sheet.querySelector('[data-act="cancel"]').disabled = on;
    const del = this.sheet.querySelector('[data-act="delete"]');
    if (del) del.disabled = on;
  }

  /* Delete, as in the Simple Schedule card: the first tap arms it (filled red, "Tap again
     to delete"), the second deletes; a tap anywhere else in the sheet disarms it. */
  async remove(btn) {
    if (this.ui.busy) return;
    if (!this.ui.armed) {
      this.ui.armed = true;
      btn.classList.add("armed");
      swapText(btn, "Tap again to delete");
      return;
    }
    this.clearError();
    const eid = this.editing.eid;
    this.setBusy(true);
    swapText(btn, "Deleting…");
    // Save stays as it is: one button talking at a time
    swapText(this.sheet.querySelector('[data-act="save"]'), "Save");
    try {
      const r = await this.hass.callApi("POST", "alert2/manageAlert", { delete: { uiId: this.editing.uiId } });
      if (r?.error) throw new Error(r.error);
      for (let n = 0; n < 50 && this.hass.states[eid]; n++) await new Promise((ok) => setTimeout(ok, 100));
      await this.close();
      this.card._afterDelete(eid);
    } catch (err) {
      this.setBusy(false);
      this.disarm();
      this.showError([`Home Assistant did not delete it: ${err?.body?.message || err?.message || err}`]);
    }
  }

  disarm() {
    if (!this.ui.armed) return;
    this.ui.armed = false;
    const btn = this.sheet.querySelector('[data-act="delete"]');
    if (!btn) return;
    btn.classList.remove("armed");
    swapText(btn, "Delete");
  }

  async save() {
    if (this.ui.busy) return;
    if (this.editing) return this.saveEdit();
    this.clearError();
    const out = compileRule(this.f, this.hass, this.key);
    const errors = [...out.errors];
    const twin = !errors.length && this.twinName(out.cfg.friendly_name);
    if (twin) errors.push(`There is already an alert called "${twin}". Give this one another name.`);
    if (errors.length) return this.showError(errors);
    this.setBusy(true);
    try {
      const api = (body) => this.hass.callApi("POST", "alert2/manageAlert", body);
      const v = await api({ validate: out.cfg });
      if (v?.error) throw new Error(v.error);
      const r = await api({ create: out.cfg });
      if (r?.error) throw new Error(r.error);
      // closed once the new alert is on screen, not merely accepted
      for (let n = 0; n < 50 && !this.hass.states[out.entityId]; n++) await new Promise((ok) => setTimeout(ok, 100));
      await this.close();
      this.card._showAlert(out.entityId);
    } catch (err) {
      this.setBusy(false);
      this.showError([`Home Assistant did not take it: ${err?.body?.message || err?.message || err}`]);
    }
  }

  /* Edit: the same alert, changed - its id kept, so it keeps its history and timeline; name
     and category are only what it is called and filed under. Fields this editor does not
     know (an icon set in the rule's file) are kept as they are. */
  /* Another alert already called this (two alike would be told apart only by their ids). */
  twinName(title) {
    const t = title.trim().toLowerCase();
    const self = this.editing?.eid;
    const hit = Object.values(this.hass.states).find((st) => st.entity_id.startsWith("alert2.") && st.entity_id !== self &&
      String(st.attributes.friendly_name || "").trim().toLowerCase() === t);
    return hit ? hit.attributes.friendly_name : null;
  }

  async saveEdit() {
    this.clearError();
    const out = compileRule(this.f, this.hass, this.key);
    const errors = [...out.errors];
    const twin = !errors.length && this.twinName(out.cfg.friendly_name);
    if (twin) errors.push(`There is already an alert called "${twin}". Give this one another name.`);
    if (errors.length) return this.showError(errors);
    const old = this.editing.cfg;
    const cfg = { ...old, ...out.cfg };
    for (const k of OPTIONAL_CFG) if (!(k in out.cfg)) delete cfg[k];
    if (out.builtin && !out.cfg.category) delete cfg.category;
    const eid = this.editing.eid;
    const before = this.hass.states[eid];
    this.setBusy(true);
    try {
      const r = await this.hass.callApi("POST", "alert2/manageAlert", { update: { uiId: this.editing.uiId, cfg } });
      if (r?.error) throw new Error(r.error);
      // Alert2 replaces the entity: closed once the new one is on screen
      for (let n = 0; n < 50 && (!this.hass.states[eid] || this.hass.states[eid] === before); n++) {
        await new Promise((ok) => setTimeout(ok, 100));
      }
      await this.close();
      this.card._showEdited(eid);
    } catch (err) {
      this.setBusy(false);
      this.showError([`Home Assistant did not take it: ${err?.body?.message || err?.message || err}`]);
    }
  }
}

/* Tiles. Each is a count and a shortcut to the rows it counted.
     High / Low Priority Alerts - Firing alerts of that priority, out of all alerts of
                                  that priority, in the priority's colour.
     Snoozed                    - active but snoozed, in the snoozed rose.
     Total Number of Alert Rules - white, always.
   A snoozed alert is counted once: in Snoozed, not in its priority tile. */
const firingOf = (prio) => (rows) => {
  const all = rows.filter((r) => r.priority === prio);
  return { n: all.filter((r) => statusOf(r).text === "Firing").length, total: all.length };
};
const STATS = [
  { id: "high", label: "High Priority Alerts", tone: COL.high, view: "active",
    statuses: ["Firing"], prios: ["High"], calc: firingOf("high") },
  { id: "low", label: "Low Priority Alerts", tone: COL.low, view: "active",
    statuses: ["Firing"], prios: ["Low"], calc: firingOf("low") },
  { id: "snoozed", label: "Snoozed", tone: COL.snoozed, view: "active",
    statuses: ["Snoozed"],
    calc: (rows) => ({ n: rows.filter((r) => statusOf(r).text === "Snoozed").length, total: null }) },
  { id: "rules", label: "Total Number of Alert Rules", tone: null, view: "all",
    calc: (rows) => ({ n: rows.length, total: null }) },
];

// ------------------------------------------------------------------ helpers

/* A filter button names what is picked, as Grafana does: a chip per value - status and
   priority in their colours, as in the table - as many as fit comfortably, then "+N".
   Nothing picked: the menu's "All …", in grey. A value just picked pops in. */
function paintPicked(host, spec, setOf) {
  const picked = [];
  for (const g of spec.groups) {
    const set = setOf(g.key);
    for (const x of g.values) if (set.has(x.v)) picked.push({ k: `${g.key}:${x.v}`, v: x.v, tone: x.tone });
    // picked from a table chip, but not among the tab's values
    for (const v of set) if (!g.values.some((x) => x.v === v)) picked.push({ k: `${g.key}:${v}`, v, tone: null });
  }
  host.classList.toggle("active", picked.length > 0);
  host.querySelector(".msbtn").title = picked.map((p) => p.v).join(", ");
  const lab = host.querySelector(".mslabel");
  const sig = spec.empty + "::" + picked.map((p) => p.k).join("|");
  if (lab._sig === sig) return;
  const had = new Set(lab._keys || []);
  const moreWas = lab.querySelector(".msmore:not([hidden])")?.textContent;
  lab._sig = sig;
  lab._keys = picked.map((p) => p.k);
  lab.innerHTML = picked.length
    ? picked.map((p) => `<span class="mspill${p.tone ? " stt" : ""}" data-k="${escapeHtml(p.k)}"${
        p.tone ? ` style="--c:${p.tone}"` : ""}><span>${escapeHtml(p.v)}</span></span>`).join("") +
      `<span class="msmore" hidden></span>`
    : `<span class="msph">${escapeHtml(spec.empty)}</span>`;
  fitPills(lab);
  if (reduceMotion()) return;
  const pop = (el) => el.animate([{ opacity: 0, transform: "scale(.8)" }, { opacity: 1, transform: "none" }],
    { duration: 280, easing: IOS_SOFT });
  lab.querySelectorAll(".mspill:not([hidden])").forEach((el) => { if (!had.has(el.dataset.k)) pop(el); });
  const more = lab.querySelector(".msmore:not([hidden])");
  if (more && more.textContent !== moreWas) pop(more);
}

/* Show the chips that fit, with room to spare, and "+N" for the rest; at least one, cut
   short if it must be. Measured, so it follows the button's width. */
const FIT_SLACK = 12;
function fitPills(lab) {
  const pills = [...lab.querySelectorAll(".mspill")];
  const more = lab.querySelector(".msmore");
  if (!pills.length || !more || !lab.clientWidth) return;
  const end = () => {
    let e = 0;
    for (const c of lab.children) if (!c.hidden) e = Math.max(e, c.offsetLeft + c.offsetWidth);
    return e;
  };
  for (const p of pills) { p.hidden = false; p.classList.remove("solo"); }
  more.hidden = true;
  if (end() <= lab.clientWidth) return;
  more.hidden = false;
  let shown = pills.length;
  while (shown > 1) {
    pills[--shown].hidden = true;
    more.textContent = `+${pills.length - shown}`;
    if (end() <= lab.clientWidth - FIT_SLACK) return;
  }
  pills[0].classList.add("solo");
}

function sortBy(rows, key, dir, tie) {
  return [...rows].sort((x, y) => {
    const a = key(x), b = key(y);
    const c = typeof a === "string" ? a.localeCompare(b) : a - b;
    const t = tie(x), u = tie(y);
    const tc = typeof t === "string" ? t.localeCompare(u) : t - u;
    return (dir === "asc" ? c : -c) || tc;
  });
}

/* Chart slots: a "nice" clock step (15 min, 1 h, 3 h …) giving at most `target` slots,
   aligned to the local clock. Same as the Health card. */
const STEP_MIN = [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
function slotGrid(t0, t1, target) {
  const spanMin = (t1 - t0) / 60000;
  const stepMin = STEP_MIN.find((s) => spanMin / s <= target) || 1440;
  const d = new Date(t0);
  if (stepMin < 60) d.setMinutes(Math.floor(d.getMinutes() / stepMin) * stepMin, 0, 0);
  else { const h = stepMin / 60; d.setMinutes(0, 0, 0); d.setHours(Math.floor(d.getHours() / h) * h); }
  const slots = [];
  for (let a = d.getTime(); a < t1; a += stepMin * 60000) slots.push({ a, b: a + stepMin * 60000 });
  return slots;
}

/* Split `total` lines between lists of the given lengths: round robin, so the split is
   even and a short list's unused share flows to the longer ones. */
const TIP_NAMES = 9;
function shareOut(lengths, total) {
  const out = lengths.map(() => 0);
  for (let left = total, moved = true; left > 0 && moved;) {
    moved = false;
    for (let j = 0; j < lengths.length && left > 0; j++) {
      if (out[j] < lengths[j]) { out[j]++; left--; moved = true; }
    }
  }
  return out;
}

function niceTicks(max) {
  if (max <= 4) return Array.from({ length: max + 1 }, (_, i) => i);
  const step = Math.ceil(max / 4);
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

/* The status band's name column, fixed - at the Health card's width, so both cards'
   charts carry the same time marks - so the band's track is known and the chart above
   carries its marks: bandTrackWidth() is state-history-card's own layout
   (_layoutMetrics), as in the Health card. */
const BAND_LABEL_W = 240;
function bandTrackWidth(cardWidth, labelW = BAND_LABEL_W) {
  const compact = cardWidth <= 520;
  const inner = Math.max(0, cardWidth - (compact ? 24 : 32));
  const gap = compact ? 6 : 8;
  const minL = compact ? 68 : 72;
  const label = Math.round(Math.min(Math.max(minL, inner - gap - 120), Math.max(minL, labelW)));
  return Math.max(120, Math.round(inner - label - gap));
}

/* Time marks for a chart across [t0, t1] drawn `width` px wide - state-history-card's own
   axis (its _axisTicks), so the chart reads exactly like the status band
   below it: the tightest step of 1, 2, 3, 4, 6, 8, 12 h or a day
   at which every ~76px label fits, a midnight named by its weekday ("Tue"), any other
   mark by its time ("4:00 PM"). */
const AXIS_STEPS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168, 336, 720, 2160, 8760];
function axisMarks(t0, t1, width) {
  const labelW = width < 260 ? 64 : 76;
  const pos = (t) => ((t - t0) / (t1 - t0)) * width;
  const candidates = (step) => {
    const d = new Date(t0);
    d.setMinutes(0, 0, 0);
    if (step < 24) {
      d.setHours(Math.ceil(d.getHours() / step) * step);
      if (d.getTime() < t0) d.setHours(d.getHours() + step);
    } else {
      d.setHours(0, 0, 0, 0);
      while (d.getTime() < t0) d.setHours(d.getHours() + step);
    }
    const out = [];
    for (; d.getTime() <= t1; d.setHours(d.getHours() + step)) {
      const t = d.getTime();
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      out.push({ t, midnight, label: midnight
        ? new Date(t).toLocaleDateString(LOCALE.lang, t1 - t0 <= 7 * 86400e3 ? { weekday: "short" } : { month: "short", day: "numeric" })
        : fmtTime(t) });
    }
    return out;
  };
  const fits = (m) => pos(m.t) - labelW / 2 >= 0 && pos(m.t) + labelW / 2 <= width;
  const spread = (marks) => {
    const kept = [];
    for (const m of marks) {
      if (!fits(m)) continue;
      const prev = kept[kept.length - 1];
      if (prev && pos(m.t) - labelW / 2 < pos(prev.t) + labelW / 2 + 8) {
        if (m.midnight && !prev.midnight) kept[kept.length - 1] = m;   // a day name wins
        continue;
      }
      kept.push(m);
    }
    return kept;
  };
  for (const step of AXIS_STEPS) {
    const marks = candidates(step);
    const kept = spread(marks);
    if (kept.length && kept.length === marks.filter(fits).length) return kept;
  }
  return spread(candidates(AXIS_STEPS[AXIS_STEPS.length - 1]));
}


function ago(t) {
  if (!t) return "—";
  const s = (Date.now() - t) / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* Home Assistant's own language and 12/24-hour setting (the user's profile), refreshed
   from hass on every tick, so times read the way the rest of the dashboard does rather
   than the way the browser's locale would print them. */
let LOCALE = { lang: undefined, hour12: undefined, firstDay: 1 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function setLocale(hass) {
  const l = hass?.locale || {};
  const lang = l.language || hass?.language || undefined;
  // The profile's first weekday, or the language's (Intl: 1 = Monday … 7 = Sunday).
  let firstDay = WEEKDAYS.indexOf(l.first_weekday);
  if (firstDay < 0) {
    try {
      const loc = new Intl.Locale(lang || navigator.language);
      const info = loc.getWeekInfo?.() || loc.weekInfo;
      firstDay = info ? info.firstDay % 7 : 1;
    } catch { firstDay = 1; }
  }
  LOCALE = {
    lang,
    hour12: l.time_format === "12" ? true : l.time_format === "24" ? false : undefined,
    firstDay,
  };
}

/* ---- snooze ---------------------------------------------------------------- */
const HOUR = 3600e3;
const SNOOZE_MAX = 366 * DAY;
const SNOOZE_UNIT = { m: 60e3, h: HOUR, d: DAY, w: 7 * DAY };
const SNOOZE_RE = /(\d+(?:[.,]\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)(?![a-z])/g;

/* What a person types for a length - "90m", "3h", "1h 30m", "2 days", "1w2d", or a bare
   number of hours - in milliseconds; null when any of it is not understood. */
function parseDuration(text) {
  const s = String(text || "").trim().toLowerCase().replace(/\band\b|,(?!\d)/g, " ");
  if (!s) return null;
  if (/^\d+(?:[.,]\d+)?$/.test(s)) return Number(s.replace(",", ".")) * HOUR;
  let total = 0;
  for (const m of s.matchAll(SNOOZE_RE)) total += Number(m[1].replace(",", ".")) * SNOOZE_UNIT[m[2][0]];
  if (!total || s.replace(SNOOZE_RE, "").trim()) return null;
  return total;
}

const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* One date-time format everywhere - tables, timeline, chart, snooze: "Today, 9:21 PM",
   "Yesterday, 8:24 PM", "Tomorrow, 8:00 AM", otherwise "Sun, Oct 4, 9:21 PM". */
function fmtDay(t, ref = Date.now()) {
  const days = Math.round((dayStart(t) - dayStart(ref)) / DAY);
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  if (days === 1) return "Tomorrow";
  return new Date(t).toLocaleDateString(LOCALE.lang, { weekday: "short", month: "short", day: "numeric" });
}
const fmtTime = (t) => new Date(t).toLocaleTimeString(LOCALE.lang, { hour: "numeric", minute: "2-digit", hour12: LOCALE.hour12 });
function fmtDT(t) {
  if (!t || !Number.isFinite(t)) return "—";
  return `${fmtDay(t)}, ${fmtTime(t)}`;
}
const fmtUntil = fmtDT;

/* The ready-made lengths: tomorrow at 8:00, and a week from now. */
function snoozePresets(now = Date.now()) {
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(8, 0, 0, 0);
  return [
    { label: "Tomorrow Morning", t: morning.getTime() },
    { label: "One Week", t: now + 7 * DAY },
  ];
}

/* Replace a line of text so the change is seen: the new words settle in (never fading
   below 80%, so a quick run of changes does not flicker). */
function swapText(el, text) {
  if (!el || el.textContent === text) return;
  el.textContent = text;
  if (!text || reduceMotion()) return;
  el.getAnimations().forEach((a) => a.cancel());
  el.animate([{ opacity: 0.8, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }],
    { duration: 200, easing: IOS });
}

/* A dashboard's views and Bubble pop-ups as link targets: /dash/view and /dash/view#hash.
   Each carries the entities it shows (any entity id in its cards) and whether it holds the
   Health view, so the editor can suggest the places a rule is about. A pop-up's cards are
   its own and, in the older layout, the cards after it in its vertical stack. */
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
function linkItems(dash, cfg) {
  const out = [];
  const scan = (o, acc) => {
    if (typeof o === "string") { if (ENTITY_RE.test(o)) acc.ents.add(o); return; }
    if (!o || typeof o !== "object") return;
    if (!Array.isArray(o) && o.type === "custom:health-monitor-card") acc.health = true;
    // the Health card as a page of a page-switcher-card (the tablet's Alerts view): links to it
    // are named after its page ("System Health"), not the view ("Alerts")
    if (!Array.isArray(o) && o.type === "custom:page-switcher-card" && Array.isArray(o.pages)) {
      const page = o.pages.find((pg) => pg?.card?.type === "custom:health-monitor-card");
      if (page?.label) acc.healthLabel = String(page.label);
    }
    for (const v of Array.isArray(o) ? o : Object.values(o)) scan(v, acc);
  };
  (cfg.views || []).forEach((v, vi) => {
    const vpath = v.path || String(vi);
    const view = { path: `/${dash}/${vpath}`, label: v.title || vpath, icon: v.icon || "mdi:view-dashboard-outline",
                   kind: "view", ents: new Set(), health: false };
    scan(v, view);
    out.push(view);
    const pops = [];
    const walk = (o, parent, idx) => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach((x, i) => walk(x, o, i)); return; }
      if (typeof o.hash === "string" && o.hash.startsWith("#")) {
        const pop = { path: `${view.path}${o.hash}`, label: o.name || popupName(o.hash), view: view.label,
                      kind: "pop", ents: new Set(), health: false };
        scan(o, pop);
        if (parent && idx === 0) parent.slice(1).forEach((x) => scan(x, pop));
        if (!pops.some((x) => x.path === pop.path)) pops.push(pop);
      }
      for (const val of Object.values(o)) walk(val, null, -1);
    };
    walk(v, null, -1);
    pops.sort((a, b) => a.label.localeCompare(b.label));
    out.push(...pops);
  });
  return out;
}
// "#all-windows-doors-popup" -> "All windows doors"
const popupName = (hash) => {
  const s = hash.replace(/^#/, "").replace(/[-_]?pop-?up$/i, "").replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : hash;
};
const linkLabel = (it) => (it.kind === "pop" ? `${it.view} › ${it.label}` : it.label);

/* FILTERED HEALTH LINKS. The Health view reads its filters from its address (hm_tab,
   hm_status, hm_area … - the table is in the Health card) and writes them back as it is
   used. These build such addresses for a rule's link, so nobody types one: from the rule's
   own Health conditions or triggers, and the Health view as it was last set on this device
   (the Health card keeps that in localStorage, "hm-health-view"). */
const urlSlug = (v) => String(v).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+$/, "");
const H_TAB_OF = { dev: "devices", bat: "battery", hlp: "helpers" };
const H_TAB_WORDS = { devices: "Devices", helpers: "Helpers", battery: "Battery", signal: "Signal", ignored: "Ignored" };
const HEV_STATUS = { offline: "Unavailable", stale: "Not updating", low: "Low battery", failed: "Failed" };

/* The rule's Health rows -> { query, label }: the first one's tab, filtered to the statuses
   of every Health row on that tab ("OK" and "comes back online" filter nothing). */
function healthFilterOf(f, hass) {
  const rows = f.conds.map((c) => (HEALTH[c.kind] ? { part: c.kind, status: c.status === "OK" ? null : c.status, group: c.group }
    : c.kind === "hev" ? { part: c.part, status: HEV_STATUS[c.what] || null, group: c.group } : null)).filter(Boolean);
  if (!rows.length) return null;
  const tab = H_TAB_OF[rows[0].part] || "devices";
  const statuses = [...new Set(rows.filter((r) => r.part === rows[0].part && r.status).map((r) => r.status))];
  return { query: `hm_tab=${tab}${statuses.length ? `&hm_status=${statuses.map(urlSlug).join(",")}` : ""}`,
           label: [H_TAB_WORDS[tab], statuses.map((x) => statusWord(x, hass, rows[0].group)).join(", ")].filter(Boolean).join(" · "),
           noun: H_TAB_NOUN[tab] || "devices" };
}
const H_TAB_NOUN = { devices: "devices", helpers: "helpers", battery: "batteries" };

/* "Only what this alert is about". In the form the link says hm_alert=this; saved, that
   becomes the alert's entity id and hm_rows, a template naming what is in the statuses of
   the rule's Health conditions right now - one id per device, so the address stays short.
   Alert2 renders it again whenever that changes, and the Health view shows just those rows
   with the alert's name on a chip. Opened as a form, the rule turns it back into
   hm_alert=this, so it follows the conditions as they are edited. */
const ONLY_THIS = "hm_alert=this";
const ONLY_WORDS = "Only from this alert";
const healthRowConds = (f) => plainConds(f).filter((c) => HEALTH[c.kind] && H_STATUS[c.status]?.list);

function healthRowsTpl(f, mins) {
  const conds = healthRowConds(f);
  if (!conds.length) return "";
  const loops = conds.map((c) => {
    const h = HEALTH[c.kind];
    const late = !(mins > 0) ? ""
      : c.status === "Unavailable" ? ` and (not since.get(eid) or as_datetime(since.get(eid)) < now() - timedelta(minutes=${mins}))`
      : c.status === "Not updating" ? ` and (not seen.get(eid) or as_datetime(seen.get(eid)) < now() - timedelta(minutes=${mins} + ((state_attr(S, 'staleness_minutes') or 0) | float(0))))`
      : "";
    return `{% set S = ${summaryOf(c)} %}{% set dev = state_attr(S, 'device_ids') or {} %}{% set since = state_attr(S, 'offline_since') or {} %}{% set seen = state_attr(S, 'stale_since') or {} %}` +
      `{% for eid in state_attr(S, '${H_STATUS[c.status].list}') or [] if eid ${h.inScope ? "in" : "not in"} (state_attr(S, '${h.scope}') or {})${late} %}` +
      `{% set key = dev.get(eid) or eid %}{% if key not in ns.k %}{% set ns.k = ns.k + [key] %}{% set ns.r = ns.r + [eid] %}{% endif %}{% endfor %}`;
  });
  return `{% set ns = namespace(r=[], k=[]) %}${loops.join("")}{{ ns.r | join(',') }}`;
}

// the form's hm_alert=this -> the alert and its rows, and back
const expandOnly = (link, eid, rows) =>
  link.replace(/([?&])hm_alert=this(?=[&#]|$)/, (_, p) => `${p}hm_alert=${eid}${rows ? `&hm_rows=${rows}` : ""}`);
const collapseOnly = (link) =>
  String(link || "").replace(/([?&])hm_alert=alert2\.[a-z0-9_]+(&hm_rows=\{%[\s\S]*\}\})?/, (_, p) => `${p}${ONLY_THIS}`);

function lastHealthView() {
  try {
    const v = JSON.parse(localStorage.getItem("hm-health-view") || "null");
    return v?.query ? { query: String(v.query), label: String(v.label || v.query) } : null;
  } catch { return null; }
}

// a query before the address's #pop-up, if it has one
const withQuery = (path, query) => path.replace(/(#.*)?$/, (h) => `?${query}${h || ""}`);

/* An address's Health filters in words, for its chip: "Devices · Unavailable · House back". */
function healthQueryWords(search, hass) {
  const q = new URLSearchParams(search);
  const out = [];
  for (const [k, v] of q) {
    if (!k.startsWith("hm_") || !v) continue;
    if (k === "hm_tab") out.unshift(H_TAB_WORDS[v] || v);
    else if (k === "hm_q") out.push(`"${v}"`);
    else if (k === "hm_rows") out.push(`${v.split(",").length} linked`);
    else if (k === "hm_alert") out.push(ONLY_WORDS);
    else if (k === "hm_open") out.push("one open");
    else if (k === "hm_status") out.push(v.split(",").map((x) => statusWord(x.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), hass)).join(", "));
    else out.push(v.split(",").map((x) => (/^_/.test(x) ? x : x.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()))).join(", "));
  }
  return out.join(" · ");
}

/* A chip's value ROLLS as a drum turns it: the old value slides out the way the value
   moved and the new one slides in - never fading below 80%, which at drum speed reads as
   flicker. The faster the turn, the shorter the roll. dir 0: no roll, just the text. */
function rollChip(chip, inner, text, dir) {
  if (!inner || inner.textContent === text) return;
  const old = inner.textContent;
  inner.textContent = text;
  if (!dir || !old || reduceMotion()) return;
  const now = performance.now();
  const duration = Math.max(60, Math.min(170, (now - (chip._rollT || 0)) * 0.9));
  chip._rollT = now;
  const shift = 24;
  chip.querySelectorAll(".tcout").forEach((x) => x.remove());
  const out = document.createElement("span");
  out.className = "tcout";
  out.textContent = old;
  chip.appendChild(out);
  const opts = { duration, easing: "cubic-bezier(.25,.8,.35,1)" };
  inner.getAnimations().forEach((a) => a.cancel());
  inner.animate([{ transform: `translateY(${dir * shift}px)`, opacity: 0.8 }, { transform: "none", opacity: 1 }], opts);
  out.animate([{ transform: "none", opacity: 1 }, { transform: `translateY(${-dir * shift}px)`, opacity: 0.8 }],
    { ...opts, fill: "forwards" }).onfinish = () => out.remove();
}

/* While a modal sheet is open nothing behind it scrolls: wheel and touch moves outside
   its own scroller are dropped, and inside it they stop at its ends instead of carrying
   on to the page. */
function containScroll(dlg, scrollers) {
  let y0 = 0;
  // the sheet's scrollers under the pointer that can actually scroll, innermost first (a
  // function: a sheet whose scrollers come and go names them when asked). A list scrolled to its
  // end hands the scroll on to the one around it - a short screen still reaches the whole
  // sheet - and only when every one is at its end does the gesture stop there, short of the page.
  const under = (e) => {
    const path = e.composedPath();
    return (typeof scrollers === "function" ? scrollers() : scrollers).filter((el) => path.includes(el) && el.scrollHeight > el.clientHeight + 1);
  };
  const blocked = (e, dy) => under(e).every((el) =>
    dy < 0 ? el.scrollTop <= 0 : el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
  dlg.addEventListener("wheel", (e) => { if (blocked(e, e.deltaY)) e.preventDefault(); }, { passive: false });
  dlg.addEventListener("touchstart", (e) => { y0 = e.touches[0]?.clientY ?? 0; }, { passive: true });
  dlg.addEventListener("touchmove", (e) => {
    const y = e.touches[0]?.clientY ?? y0;
    if (blocked(e, y0 - y)) e.preventDefault();
    y0 = y;
  }, { passive: false });
}

/* ---- time drum ----------------------------------------------------------------
   The Simple Schedule card's drum (its src/drum.ts and src/data/drum.ts), ported as is:
   one column of an iOS picker driven by hand. A flick coasts and decelerates
   exponentially into a row, a drag past either end rubber-bands, a tap glides to the
   row drawn under the finger, and every row is drawn on a cylinder. The state is one
   number, the column's offset, written straight to the rows' transforms each frame.
   Values leave through one door, onSettle, once the drum is at rest on a row. */
const DRUM_ROW = 44;
const DRUM_ROWS = 5;
const KINETIC_TIME_MS = 325;      // the throw's deceleration time constant (iOS's figure)
const KINETIC_GAIN = 0.8;         // how much of the release velocity carries into it
const GLIDE_TIME_MS = 95;         // a tap, wheel notch, arrow key or settle: a glide
const VELOCITY_WINDOW_MS = 100;   // velocity is read off the pointer's last 100 ms
const RUBBER_C = 0.55;            // iOS's rubber band stiffness
const TAP_SLOP_PX = 6, TAP_MAX_MS = 400, SETTLED_PX = 0.4;
const WHEEL_NOTCH_PX = 50, TRACKPAD_SETTLE_MS = 120, BOUNCE_TIME_MS = 140, FLICK_MIN = 0.25;

const clampIndex = (i, max) => Math.min(max, Math.max(0, i));
/* Where a release lands: the column coasts on KINETIC_GAIN of its velocity for one
   time constant, then the nearest row takes it. */
const throwTarget = (offset, v, rowH, max) =>
  clampIndex(Math.round((offset + KINETIC_GAIN * v * KINETIC_TIME_MS) / rowH), max);
/* An exponential approach from `from` to `to`. */
const decay = (from, to, elapsed, tc) => to + (from - to) * Math.exp(-elapsed / tc);
/* iOS's rubber band: gives at first, then holds, never reaching `dim`. */
function rubber(over, dim) {
  const x = Math.abs(over);
  return Math.sign(over) * (1 - 1 / ((x * RUBBER_C) / dim + 1)) * dim;
}
/* Pointer velocity (px/ms, positive = down the screen) over the recent window. */
function velocityFrom(samples, now) {
  const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
  if (recent.length < 2) return 0;
  const dt = recent[recent.length - 1].t - recent[0].t;
  return dt > 0 ? (recent[recent.length - 1].y - recent[0].y) / dt : 0;
}
/* Where a row `delta` px from the centre is drawn on the cylinder: squashed and faded
   towards the rim, the chosen row full strength. Null past the rim. */
function cylinder(delta, radius, rowH) {
  const theta = delta / radius;
  if (Math.abs(theta) >= Math.PI / 2) return null;
  const cos = Math.cos(theta);
  const band = Math.max(0, 1 - Math.abs(delta) / rowH);
  return { y: radius * Math.sin(theta), scaleY: cos, scaleX: 0.86 + 0.14 * cos,
           opacity: Math.min(1, band * 0.45 + 0.55 * cos) };
}
/* The row drawn under a point `y` px from the centre line (the inverse of cylinder). */
function rowAt(y, offset, radius, rowH, max) {
  const s = Math.max(-1, Math.min(1, y / radius));
  return clampIndex(Math.round((offset + Math.asin(s) * radius) / rowH), max);
}

class Drum {
  constructor(col, o, index) {
    this.col = col; this.o = o;
    this.items = [...col.querySelectorAll(".wheel-item")];
    this.offset = clampIndex(index, o.max) * o.rowH;
    this.shown = new Set(); this.drag = null; this.anim = null; this.frame = 0; this.wheelTimer = 0;
    this.tick = this.tick.bind(this);
    for (const [ev, fn] of [["pointerdown", this.onDown], ["pointermove", this.onMove],
                            ["pointerup", this.onUp], ["pointercancel", this.onUp], ["keydown", this.onKey]]) {
      col.addEventListener(ev, fn.bind(this));
    }
    // not passive: the wheel is owned here, or the sheet behind scrolls along
    col.addEventListener("wheel", this.onWheel.bind(this), { passive: false });
    this.paint();
  }

  /* Follow a value set from outside - unless the drum is busy with one of its own. */
  sync(index) {
    if (this.drag || this.anim) return;
    const to = clampIndex(index, this.o.max) * this.o.rowH;
    if (Math.abs(this.offset - to) < SETTLED_PX) return;
    this.offset = to;
    this.quiet = true;           // set from outside: not a move to report
    this.paint();
    this.quiet = false;
  }

  paint() {
    const { rowH, radius, max } = this.o;
    const reach = Math.ceil((radius * Math.PI) / 2 / rowH) + 1;
    const centre = this.offset / rowH;
    const lo = Math.max(0, Math.floor(centre) - reach);
    const hi = Math.min(this.items.length - 1, Math.ceil(centre) + reach);
    const now = new Set();
    for (let i = lo; i <= hi; i++) {
      const pose = cylinder(i * rowH - this.offset, radius, rowH);
      if (!pose) continue;
      const el = this.items[i];
      el.style.transform = `translateY(${pose.y.toFixed(2)}px) scale(${pose.scaleX.toFixed(4)}, ${pose.scaleY.toFixed(4)})`;
      el.style.opacity = pose.opacity.toFixed(3);
      el.style.visibility = "visible";
      now.add(i);
    }
    for (const i of this.shown) if (!now.has(i)) this.items[i].style.visibility = "hidden";
    this.shown = now;
    const at = clampIndex(Math.round(centre), max);
    if (at !== this.at) { this.at = at; if (!this.quiet) this.o.onMove?.(at); }
    this.col.setAttribute("aria-valuenow", String(at));
    this.col.setAttribute("aria-valuetext", this.items[at]?.textContent?.trim() ?? "");
  }

  nearest() { return clampIndex(Math.round(this.offset / this.o.rowH), this.o.max); }
  heading() { return this.anim ? this.anim.index : this.nearest(); }

  animate(index, tc) {
    const to = index * this.o.rowH;
    cancelAnimationFrame(this.frame);
    if (this.o.reduced()) {
      this.anim = null; this.offset = to; this.paint(); this.o.onSettle(index);
      return;
    }
    this.anim = { from: this.offset, to, index, start: performance.now(), tc };
    this.frame = requestAnimationFrame(this.tick);
  }

  tick(now) {
    const a = this.anim;
    if (!a) return;
    if (!this.col.isConnected) { this.anim = null; return; }
    const x = decay(a.from, a.to, Math.max(0, now - a.start), a.tc);
    if (Math.abs(x - a.to) < SETTLED_PX) {
      this.anim = null; this.offset = a.to; this.paint(); this.o.onSettle(a.index);
      return;
    }
    this.offset = x;
    this.paint();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    const was = this.anim !== null;
    this.anim = null;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.wheelTimer);
    return was;
  }

  glideTo(index) { this.animate(clampIndex(index, this.o.max), GLIDE_TIME_MS); }

  banded(raw) {
    const end = this.o.max * this.o.rowH, span = this.o.radius * 2;
    if (raw < 0) return rubber(raw, span);
    if (raw > end) return end + rubber(raw - end, span);
    return raw;
  }

  onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const caught = this.stop();
    this.drag = { id: e.pointerId, startY: e.clientY, startOffset: this.offset, t0: e.timeStamp,
                  samples: [{ t: e.timeStamp, y: e.clientY }], moved: false, caught };
    try { this.col.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.col.classList.add("grabbing");
  }

  onMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    d.samples.push({ t: e.timeStamp, y: e.clientY });
    if (d.samples.length > 24) d.samples.splice(0, d.samples.length - 24);
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dy) < TAP_SLOP_PX) return;
    d.moved = true;
    this.offset = this.banded(d.startOffset - dy);
    this.paint();
  }

  onUp(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.col.classList.remove("grabbing");
    try { this.col.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const { rowH, radius, max } = this.o;
    if (!d.moved) {
      // a tap that caught a spinning drum only stops it
      if (!d.caught && e.type === "pointerup" && e.timeStamp - d.t0 <= TAP_MAX_MS) {
        const box = this.col.getBoundingClientRect();
        this.glideTo(rowAt(e.clientY - (box.top + box.height / 2), this.offset, radius, rowH, max));
      } else this.glideTo(this.nearest());
      return;
    }
    const end = max * rowH;
    if (this.offset < 0 || this.offset > end) { this.animate(this.offset < 0 ? 0 : max, BOUNCE_TIME_MS); return; }
    const v = -velocityFrom(d.samples, e.timeStamp);
    if (e.type === "pointerup" && Math.abs(v) >= FLICK_MIN) this.animate(throwTarget(this.offset, v, rowH, max), KINETIC_TIME_MS);
    else this.glideTo(this.nearest());
  }

  onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    if (this.drag) return;
    if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= WHEEL_NOTCH_PX) {
      const dir = Math.sign(e.deltaY);     // a mouse: one notch, one row
      if (dir) this.glideTo(this.heading() + dir);
      return;
    }
    this.stop();                           // a trackpad: follow, then settle
    const end = this.o.max * this.o.rowH;
    this.offset = Math.min(end, Math.max(0, this.offset + e.deltaY));
    this.paint();
    this.wheelTimer = setTimeout(() => this.glideTo(this.nearest()), TRACKPAD_SETTLE_MS);
  }

  onKey(e) {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    this.glideTo(this.heading() + step);
  }
}

/* ---- custom snooze ---------------------------------------------------------------
   Snooze's Custom - the tablet's popover and the phone's action sheet alike: a length to
   type ("90m", "3h", "2d", "1w"), a calendar a month at a time (from this month up to a year
   ahead), a time chip that opens an hour and a minute drum (the Simple Schedule card's)
   inline under it as iOS does, the moment it all adds up to, and Snooze. It keeps its own
   state; its host lays it out and hears from it through `hooks`:
     go(t)          Snooze pressed, for the moment t
     value(text)    what Custom's row says beside it ("" while nothing valid is set)
     drum(open, h)  the drum is about to open (h: the height it will take) or has closed
     scroller()     the box that scrolls, brought round to the Snooze button when the drum opens
   `el` holds its parts: text, cal, chip, drum, preview, go. */
class SnoozePicker {
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks;
    this.s = null;
    this.build();
    el.text.addEventListener("input", () => {
      const ms = parseDuration(el.text.value);
      if (ms != null) {
        const t = Date.now() + ms;
        const d = new Date(t);
        this.s.day = dayStart(t);
        this.s.month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
        this.s.hm = [d.getHours(), d.getMinutes()];
        this.s.typed = t;
      } else this.s.typed = null;
      this.paint();
    });
    el.text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !el.go.disabled) el.go.click(); });
    el.cal.addEventListener("click", (e) => {
      const nav = e.target.closest("[data-mon]");
      if (nav && !nav.disabled) {
        const m = new Date(this.s.month);
        m.setMonth(m.getMonth() + Number(nav.dataset.mon));
        this.s.month = m.getTime();
        this.paint();
        return;
      }
      const day = e.target.closest("[data-day]");
      if (!day || day.disabled) return;
      this.s.day = Number(day.dataset.day);
      this.s.typed = null;
      el.text.value = "";
      // a day picked for today keeps a time that is still ahead
      if (this.target() <= Date.now()) {
        const soon = new Date(Date.now() + HOUR);
        soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
        this.s.day = dayStart(soon.getTime());
        this.s.hm = [soon.getHours(), soon.getMinutes()];
      }
      this.paint();
    });
    el.chip.addEventListener("click", () => this.toggleDrum());
    el.go.addEventListener("click", () => {
      const t = this.target();
      if (this.valid(t)) this.hooks.go(t);
    });
  }

  /* A new opening: tomorrow morning on the calendar, 8:00 on the drum, nothing typed, the
     drum shut. */
  reset() {
    const el = this.el;
    const morning = snoozePresets(Date.now())[0].t;
    const m = new Date(morning);
    this.s = { typed: null, day: dayStart(morning), month: new Date(m.getFullYear(), m.getMonth(), 1).getTime(), hm: [8, 0] };
    this.chipV = null;
    this.liveHm = null;
    el.text.value = "";
    el.drum.getAnimations().forEach((a) => a.cancel());
    el.drum.hidden = true;
    el.chip.classList.remove("on");
    el.chip.setAttribute("aria-expanded", "false");
    this.paint();
  }

  /* The time: an hour and a minute drum behind the chip, which shows the time and turns
     with the drum. */
  build() {
    const el = this.el;
    const pad = (n) => String(n).padStart(2, "0");
    const hourLabel = (n) => {
      if (LOCALE.hour12 === false) return pad(n);
      return `${n % 12 === 0 ? 12 : n % 12} ${n < 12 ? "AM" : "PM"}`;
    };
    const col = (kind, max, label) => `<div class="wheel-col" tabindex="0" role="spinbutton"
        aria-label="${kind === "hour" ? "Hour" : "Minute"}" aria-valuemin="0" aria-valuemax="${max}" data-kind="${kind}">
        ${Array.from({ length: max + 1 }, (_, n) => `<div class="wheel-item">${label(n)}</div>`).join("")}</div>`;
    el.drum.innerHTML = `<div class="wheel" style="--wheel-h:${DRUM_ROW * DRUM_ROWS}px">
        <div class="wheel-band"></div>${col("hour", 23, hourLabel)}<div class="wheel-sep">:</div>${col("minute", 59, pad)}</div>`;
    const settle = (kind) => (i) => {
      const s = this.s;
      if (!s) return;
      s.hm = kind === "hour" ? [i, s.hm[1]] : [s.hm[0], i];
      this.liveHm = null;
      s.typed = null;
      el.text.value = "";
      this.paint(false);
    };
    // While a drum turns, the chip's time turns with it, row by row.
    const live = (kind) => (i) => {
      const s = this.s;
      if (!s || el.drum.hidden) return;
      // turned by hand: the drum's time replaces a typed length
      if (s.typed != null || el.text.value) { s.typed = null; el.text.value = ""; }
      const hm = this.liveHm || s.hm;
      this.liveHm = kind === "hour" ? [i, hm[1]] : [hm[0], i];
      this.setChip(this.liveHm[0], this.liveHm[1]);
      this.preview(this.liveHm);
    };
    const make = (kind, max) => new Drum(el.drum.querySelector(`[data-kind="${kind}"]`), {
      rowH: DRUM_ROW, radius: (DRUM_ROW * DRUM_ROWS) / 2, max,
      reduced: reduceMotion, onSettle: settle(kind), onMove: live(kind) }, kind === "hour" ? 8 : 0);
    el.chip.classList.toggle("h24", LOCALE.hour12 === false);
    this.drums = { hour: make("hour", 23), minute: make("minute", 59), h12: LOCALE.hour12 };
  }

  toggleDrum() {
    const el = this.el;
    const open = el.drum.hidden;
    // The 12/24-hour setting may have arrived after the drum was built.
    if (open && this.drums?.h12 !== LOCALE.hour12) this.build();
    el.chip.classList.toggle("on", open);
    el.chip.setAttribute("aria-expanded", String(open));
    const wheel = el.drum.firstElementChild;
    el.drum.getAnimations().forEach((a) => a.cancel());
    if (!open) {
      const shut = () => {
        el.drum.hidden = true;
        el.drum.getAnimations().forEach((x) => x.cancel());
        wheel.getAnimations().forEach((x) => x.cancel());
        this.hooks.drum(false, 0);
      };
      if (reduceMotion()) { shut(); return; }
      // the drum sinks back and fades as its box closes
      wheel.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-10px) scale(.94)", opacity: 0 }],
        { duration: 220, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
      el.drum.animate([{ height: `${el.drum.offsetHeight}px` }, { height: "0px" }],
        { duration: 340, easing: IOS, fill: "forwards" }).onfinish = shut;
      return;
    }
    el.drum.hidden = false;
    if (!reduceMotion()) {
      // the box makes room on the plain curve; the drum drops in on the spring
      el.drum.animate([{ height: "0px", opacity: 0 }, { height: `${DRUM_ROW * DRUM_ROWS}px`, opacity: 1 }],
        { duration: 460, easing: IOS });
      wheel.animate([{ transform: "translateY(-18px) scale(.9)", opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 620, easing: "cubic-bezier(.34,1.42,.64,1)", delay: 40, fill: "backwards" });
    }
    this.drums.hour.sync(this.s.hm[0]);
    this.drums.minute.sync(this.s.hm[1]);
    // The drum opens from zero height, so it is measured at its full height, not now.
    this.hooks.drum(true, DRUM_ROW * DRUM_ROWS);
    // Still taller than the screen: scroll (never the page behind) until the drum and the
    // Snooze button under it are in view.
    const box = this.hooks.scroller();
    setTimeout(() => {
      const below = el.go.getBoundingClientRect().bottom + 16 - box.getBoundingClientRect().bottom;
      if (below > 0) box.scrollTo({ top: box.scrollTop + below, behavior: reduceMotion() ? "auto" : "smooth" });
    }, reduceMotion() ? 0 : 280);
  }

  target(hm = this.s.hm) {
    const d = new Date(this.s.day);
    d.setHours(hm[0], hm[1], 0, 0);
    return this.s.typed ?? d.getTime();
  }

  valid(t) { return Number.isFinite(t) && t > Date.now() + 30e3 && t < Date.now() + SNOOZE_MAX; }

  /* The calendar, the time, the moment it adds up to, and whether Snooze can be pressed. */
  paint(withTime = true) {
    const el = this.el, s = this.s;
    const today = dayStart(Date.now());
    const month = new Date(s.month);
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const nowMonth = new Date(); nowMonth.setDate(1); nowMonth.setHours(0, 0, 0, 0);
    const lastMonth = new Date(nowMonth); lastMonth.setMonth(lastMonth.getMonth() + 12);
    const lead = (first.getDay() - LOCALE.firstDay + 7) % 7;
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const wk = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(2026, 0, 4 + ((LOCALE.firstDay + i) % 7)); // 4 Jan 2026 is a Sunday
      wk.push(`<span>${escapeHtml(d.toLocaleDateString(LOCALE.lang, { weekday: "narrow" }))}</span>`);
    }
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(`<span></span>`);
    for (let n = 1; n <= days; n++) {
      const t = new Date(month.getFullYear(), month.getMonth(), n).getTime();
      const cls = [t === s.day ? "sel" : "", t === today ? "today" : ""].filter(Boolean).join(" ");
      cells.push(`<button class="cday ${cls}" data-day="${t}"${t < today ? " disabled" : ""}>${n}</button>`);
    }
    el.cal.innerHTML = `
      <div class="calhd">
        <span class="calm">${escapeHtml(month.toLocaleDateString(LOCALE.lang, { month: "long", year: "numeric" }))}</span>
        <button class="calnav" data-mon="-1" aria-label="Previous month"${first <= nowMonth ? " disabled" : ""}>
          <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <button class="calnav" data-mon="1" aria-label="Next month"${first >= lastMonth ? " disabled" : ""}>
          <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
      </div>
      <div class="calwk">${wk.join("")}</div>
      <div class="calgrid">${cells.join("")}</div>`;
    // A new month slides in from the side it came from; a newly picked day pops in.
    if (!reduceMotion()) {
      if (s.shownMonth != null && s.shownMonth !== s.month) {
        const dir = s.month > s.shownMonth ? 1 : -1;
        el.cal.querySelector(".calgrid").animate(
          [{ transform: `translateX(${dir * 28}px)`, opacity: 0 }, { transform: "none", opacity: 1 }],
          { duration: 340, easing: IOS });
      }
      if (s.shownDay != null && s.shownDay !== s.day) {
        el.cal.querySelector(".cday.sel")?.animate(
          [{ transform: "scale(.55)", opacity: .4 }, { transform: "none", opacity: 1 }],
          { duration: 420, easing: "cubic-bezier(.34,1.42,.64,1)" });
      }
    }
    s.shownMonth = s.month;
    s.shownDay = s.day;
    this.setChip(s.hm[0], s.hm[1]);
    if (withTime) { this.drums?.hour.sync(s.hm[0]); this.drums?.minute.sync(s.hm[1]); }
    this.preview();
  }

  /* "Until …", the Snooze button and Custom's value - for the time set, or the time a
     turning drum is passing. */
  preview(hm = this.s.hm) {
    const el = this.el, s = this.s;
    const t = this.target(hm);
    const ok = this.valid(t);
    const typedBad = el.text.value.trim() && s.typed == null;
    el.preview.classList.toggle("ok", ok && !typedBad);
    swapText(el.preview, typedBad ? "Not understood. Try 90m, 3h, 1h 30m, 2d or 1w."
      : ok ? `Until ${fmtUntil(t)}`
      : t <= Date.now() ? "Pick a moment that is still ahead." : "Up to a year at most.");
    el.go.disabled = !ok || !!typedBad;
    this.hooks.value(ok && !typedBad ? fmtUntil(t) : "");
  }

  /* The time chip: a fixed width (the widest time fits), and its time rolls like the drum
     it stands for - the old time slides out as the new one slides in, up when the time
     goes later, down when earlier. Nothing fades below 80%, so a fast spin reads as a
     roll, not a flicker; the roll shortens to keep up with a fast drum. */
  setChip(h, m) {
    const chip = this.el.chip;
    const v = h * 60 + m;
    const prev = this.chipV;
    this.chipV = v;
    rollChip(chip, chip.querySelector(".tcin"), fmtTime(new Date(2000, 0, 1, h, m).getTime()),
      prev == null ? 0 : v > prev ? 1 : -1);
  }
}

/* A chart slot: "Sun, Oct 4, 9:15 – 9:30 PM". */
function fmtSlot(a, b) {
  // whole days (the 3d and 7d charts): the day itself, not "12:00 AM – 12:00 AM"
  const d = new Date(a);
  if (b - a >= 23 * HOUR && d.getHours() === 0 && d.getMinutes() === 0) {
    return b - a > 25 * HOUR ? `${fmtDay(a)} – ${fmtDay(b - 1)}` : fmtDay(a);
  }
  return `${fmtDay(a)}, ${fmtTime(a)} – ${fmtTime(b)}`;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 129600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

const SHC_ROW_H = 26;
const SHC_ROW_GAP = 4;

function whenDefined(tag, ms) {
  if (customElements.get(tag)) return Promise.resolve(true);
  return Promise.race([
    customElements.whenDefined(tag).then(() => true),
    new Promise((r) => setTimeout(() => r(!!customElements.get(tag)), ms)),
  ]);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Alert2 escapes a message for notifiers before storing it (last_fired_message), so
   "<class ...>" arrives as "&lt;class ...&gt;". Undo that before re-escaping for display. */
function unescapeHtml(s) {
  return String(s ?? "").replace(/&(lt|gt|amp|quot|#39);/g, (m, k) =>
    ({ lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'" }[k]));
}

/* The Health card's stylesheet, with the table pieces this card does not use removed and
   four additions at the end (key/value facts, message, button row, New alert). Keep the
   shared part in step with health-monitor-card.js. */
const STYLES = `
:host{display:block;
      --hm-pin:max(var(--hm-top,var(--header-height,56px)),env(safe-area-inset-top,0px))}
ha-card{
  /* TYPE SCALE: four roles, nothing else (same as the Health card).
       .t-title  21/700 primary    the card name. Once.
       .t-body   15/600 primary    anything READ as data: names, values, controls.
       .t-meta   13/500 secondary  anything that QUALIFIES data: ids, times, counts.
       .t-label  12/700 secondary  UPPERCASE structural labels. */
  --fs-title: 21px;
  --fs-body: 15px;
  --fs-meta: 13px;
  --fs-label: 12px;
  --tap: 47px;
  --pad: 20px;
  --gap: 12px;
  --f: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --line: rgba(255,255,255,.09);
  /* SELECTION is white, never blue: whatever is chosen (a filter, a ticked option, a
     chip, the open row) gets a faint white fill, a lighter edge, and its text one
     weight up. */
  --sel-bg: rgba(255,255,255,.09);
  --sel-line: rgba(255,255,255,.32);
  /* how far every popup dims the page: the editor, the snooze sheet, the (i) popup */
  --scrim-a: .6;
  --txt: var(--primary-text-color,#fff);
  --txt2: var(--secondary-text-color,#b0afaf);
  font-family:var(--f); overflow:visible;
  border-radius:var(--ha-card-border-radius,18px);
  background:var(--ha-card-background,#201b25);
  -webkit-font-smoothing:antialiased;
}

.t-title, .h1
  {font-size:var(--fs-title);font-weight:700;letter-spacing:-.3px;color:var(--txt)}
.t-body,
.nmt b, .vw, .rg, .clear, .msbtn, .msopt, .search input, .navbtn, .newbtn, .v, .msg
  {font-size:var(--fs-body);font-weight:600;color:var(--txt)}
.t-meta,
.nmt i, .muted, .tag, .mscount, .msact, .dsub, .lgt, .lgm, .loading, .none, .tfoot, .legend span, .desc
  {font-size:var(--fs-meta);font-weight:500;color:var(--txt2)}
.t-label,
.th, .ptitle .phead, .dhead, .k
  {font-size:var(--fs-label);font-weight:700;letter-spacing:.6px;
   text-transform:uppercase;color:var(--txt2)}
.ax{fill:var(--txt2);font-size:var(--fs-meta);font-family:var(--mono);opacity:.85}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}

.top{display:flex;align-items:center;gap:var(--gap);
     padding:var(--pad) var(--pad) 14px;border-bottom:1px solid var(--line)}
/* embedded: inside a card that is the panel and has the header (page-switcher-card) */
ha-card.embedded{background:transparent;border:0;box-shadow:none;border-radius:0}
ha-card.embedded > .top{display:none}
.ranges{display:flex;gap:3px;background:rgba(255,255,255,.05);border-radius:11px;padding:3px}
.rg{appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;
    font-size:var(--fs-body);font-weight:600;min-width:54px;min-height:41px;padding:0 15px;
    border-radius:9px;color:var(--txt2);transition:color .26s ${IOS},background .26s ${IOS}}
.rg.on{background:rgba(255,255,255,.13);color:var(--txt)}

.status{padding:16px var(--pad) 18px;border-bottom:1px solid var(--line)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}
.tile{appearance:none;border:0;cursor:pointer;font-family:inherit;
      display:flex;flex-direction:column;align-items:flex-start;gap:3px;
      padding:14px 16px 13px;border-radius:16px;
      background:rgba(255,255,255,.055);
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);
      transition:background .26s ${IOS},box-shadow .26s ${IOS}}
.tile:hover{background:rgba(255,255,255,.085)}
.tile:active{transform:scale(.965);transition:transform .12s ${IOS_SOFT}}
.tile.hot{background:color-mix(in srgb,var(--tc,#fff) 10%,rgba(255,255,255,.055))}
.tval{display:flex;align-items:baseline;gap:5px}
.tbig{font-size:31px;font-weight:700;letter-spacing:-1px;line-height:1.05;color:var(--txt)}
.tden{font-size:19px;font-weight:600;letter-spacing:-.4px;color:var(--txt)}
/* Labels wrap rather than truncate: "Total Number of Alert Rules" must read in full
   on a phone, where a tile is ~170px wide. */
.tlab{font-size:var(--fs-meta);font-weight:600;color:var(--txt2);line-height:1.3;
      white-space:normal;max-width:100%;text-align:left}

.panel{padding:16px var(--pad) 8px;border-bottom:1px solid var(--line)}
.ptitle{display:flex;align-items:center;gap:var(--gap);margin-bottom:10px;flex-wrap:wrap}
.ptitle .legend{margin-left:auto}
.ptitle .ranges{margin-left:var(--gap)}
.legend{display:flex;align-items:center;gap:4px}
.lg{appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;
    font-size:var(--fs-meta);font-weight:500;color:var(--txt2);display:flex;align-items:center;
    padding:6px 10px;border-radius:9px;opacity:.42;
    transition:opacity .22s ${IOS},background .22s ${IOS},color .22s ${IOS}}
.lg.on{opacity:1;color:var(--txt)}
.lg:hover{background:rgba(255,255,255,.07)}
.lg:active{transform:scale(.94);transition:transform .12s ${IOS_SOFT}}
.lg i{width:11px;height:11px;border-radius:3px;display:inline-block;margin-right:7px;
      background:var(--c);box-shadow:inset 0 0 0 1px rgba(0,0,0,.28)}
.lg:not(.on) i{background:transparent;box-shadow:inset 0 0 0 2px var(--c)}
/* pan-y: a vertical swipe still scrolls the page, a sideways drag scrubs the slots. */
.chartwrap{min-height:172px;position:relative;touch-action:pan-y;cursor:pointer;
           -webkit-user-select:none;user-select:none}
/* folded (nothing fired in the range): the title row alone, its count where the legend was */
.cfold{display:none;align-items:baseline;gap:8px;margin-left:auto;font-size:var(--fs-body);color:var(--txt2)}
.cfold b{font-family:var(--mono);font-size:26px;font-weight:700;letter-spacing:-1px;line-height:1;color:var(--txt);font-variant-numeric:tabular-nums}
.panel.folded .cfold{display:flex}
.panel.folded .legend, .panel.folded .chartwrap{display:none}
.panel.folded .ptitle{margin-bottom:8px}
.hband{fill:rgba(255,255,255,.07);pointer-events:none}
/* Chart tooltip (the Health card's): slot = body bold, priority = label in its hue,
   alert names = body regular. Above the sticky tabs so it is never cut off. */
.ctip{position:absolute;top:6px;left:0;z-index:30;pointer-events:none;
      min-width:200px;max-width:340px;padding:12px 34px 10px 14px;border-radius:13px;
      background:#2a2433;border:1px solid rgba(255,255,255,.14);
      box-shadow:0 18px 44px rgba(0,0,0,.55);
      transition:transform .18s ${IOS}}
.ctip[hidden]{display:none}
.twhen{font-size:var(--fs-body);font-weight:700;color:var(--txt);margin-bottom:6px}
.tsec{padding-top:8px}
.thd{display:flex;align-items:center;gap:8px;font-size:var(--fs-label);font-weight:700;
     letter-spacing:.6px;text-transform:uppercase;color:var(--c)}
.thd i{width:10px;height:10px;border-radius:3px;background:var(--c);flex:0 0 auto}
.thd b{margin-left:auto;font-family:var(--mono);font-size:var(--fs-body);letter-spacing:0;color:var(--c)}
.tsec ul{list-style:none;margin:5px 0 0;padding:0 0 0 18px}
.tsec li{font-size:var(--fs-body);font-weight:500;color:var(--txt);line-height:1.5;
         white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* what did not fit: one more line of the list, in the secondary colour (iOS) - its own
   class: "more" is the card's button and drew a 42px box here */
.tsec li.tmore{color:var(--txt2)}
.tnone{font-size:var(--fs-body);font-weight:500;color:var(--txt2);padding-top:4px}
.pin{appearance:none;font-family:inherit;cursor:pointer;flex:0 1 auto;min-width:0;
     display:flex;align-items:center;gap:9px;min-height:var(--tap);padding:0 14px;border-radius:11px;
     font-size:var(--fs-body);font-weight:600;color:var(--txt);
     background:color-mix(in srgb,var(--c) 16%,transparent);
     border:1px solid color-mix(in srgb,var(--c) 45%,transparent);
     transition:background .26s ${IOS}}
.pin[hidden]{display:none}
.pin:active{transform:scale(.96);transition:transform .12s ${IOS_SOFT}}
.pindot{width:10px;height:10px;border-radius:50%;background:var(--c);flex:0 0 auto}
.pinlab{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pin svg{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:var(--txt2);stroke-width:2.4;stroke-linecap:round}
.cbar{transform-box:fill-box;transform-origin:50% 100%;
     animation:grow .55s ${IOS} backwards;animation-delay:var(--d,0ms)}
@keyframes grow{from{transform:scaleY(0)}to{transform:none}}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

.views{display:flex;gap:4px;padding:12px var(--pad) 0;flex-wrap:wrap}
.vw{appearance:none;background:transparent;cursor:pointer;font-family:inherit;
    font-size:var(--fs-body);font-weight:600;min-height:var(--tap);padding:0 18px;color:var(--txt2);
    border:1px solid transparent;border-radius:11px;position:relative;
    transition:color .3s ${IOS},background .3s ${IOS},border-color .3s ${IOS}}
.vw:active{transform:scale(.96);transition:transform .12s ${IOS}}
/* Selected is WHITE, with the text in the card's own background colour: the tab on show
   and every filter with something picked stand out at a glance (the filters below too). */
.vw.on{color:var(--ha-card-background,#201b25);font-weight:700;background:#fff;border-color:#fff}

.filters{display:flex;gap:10px;padding:14px var(--pad);border-bottom:1px solid var(--line);flex-wrap:wrap}
.search{flex:1 1 240px;box-sizing:border-box;display:flex;align-items:center;gap:10px;
        padding:0 15px;min-height:var(--tap);
        background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:11px}
.search svg{width:18px;height:18px;fill:none;stroke:var(--txt2);stroke-width:2;
            stroke-linecap:round;flex:0 0 auto}
.search input{flex:1;min-width:0;appearance:none;border:0;background:transparent;outline:none;
              font-family:inherit;font-size:var(--fs-body);font-weight:600;color:var(--txt)}
.search input::placeholder{font-weight:500;color:var(--txt2)}

.ms{position:relative;flex:1 1 240px;min-width:0}   /* its chips must not size it */
.msbtn{display:flex;align-items:center;gap:9px;min-height:var(--tap);padding:0 15px;
       appearance:none;font-family:inherit;font-size:var(--fs-body);font-weight:600;border-radius:11px;
       background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--txt);
       cursor:pointer;width:100%;
       transition:border-color .26s ${IOS},background .26s ${IOS},color .26s ${IOS}}
.msbtn:active{transform:scale(.985);transition:transform .12s ${IOS}}
.ms.active .msbtn{border-color:#fff;background:#fff;color:var(--ha-card-background,#201b25);font-weight:700}
.ms.active .msbtn svg{stroke:var(--ha-card-background,#201b25)}
/* The picked values' chips, made for a dark button, redrawn for a white one: in the
   colour's own hue, dark enough to read on its tint - 6.8:1 or better for every status and
   priority colour (yellow, the hardest, was 3:1). A plain value (an integration, an area,
   a category) is drawn exactly like them, in a neutral grey. */
.ms.active .mspill:not(.stt){--c:#8B949E;font-family:inherit}
.ms.active .mspill{color:color-mix(in srgb,var(--c) 40%,#000);background:color-mix(in srgb,var(--c) 32%,#fff);
                       box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 60%,#fff);font-weight:700}
.ms.active .msmore{color:var(--ha-card-background,#201b25)}
/* nothing picked: the label steps back, so a filter that IS set stands out */
.ms:not(.active) .msbtn{color:var(--txt2);font-weight:500}
.mslabel{flex:1 1 auto;min-width:0;position:relative;display:flex;align-items:center;gap:6px;
         overflow:hidden;text-align:left}
.msph{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* the picked values, as the table's chips */
.mspill{flex:0 0 auto;display:inline-flex;align-items:center;min-width:0;height:27px;padding:0 9px;
        box-sizing:border-box;border-radius:6px;font-family:var(--mono);font-size:var(--fs-meta);
        font-weight:600;color:var(--txt);background:rgba(255,255,255,.1)}
.mspill.stt{font-family:inherit;color:var(--c);background:color-mix(in srgb,var(--c) 16%,transparent);
            box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 30%,transparent)}
.mspill>span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mspill.solo{flex-shrink:1}
.msmore{flex:0 0 auto;font-family:var(--mono);font-size:var(--fs-meta);font-weight:600;color:var(--txt)}
.mspill[hidden],.msmore[hidden]{display:none}
.msbtn svg{width:17px;height:17px;flex:0 0 auto;fill:none;stroke:var(--txt2);
           stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s ${EASE}}
.ms.open .msbtn svg{transform:rotate(180deg)}
.mspanel{display:none;position:absolute;z-index:20;top:calc(100% + 7px);left:0;min-width:250px;
         max-height:min(430px,70vh);overflow:auto;padding:7px;border-radius:13px;
         background:#2a2433;border:1px solid rgba(255,255,255,.14);
         box-shadow:0 18px 44px rgba(0,0,0,.55);
         scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.22) transparent}
.ms.open .mspanel{display:block;animation:pop .28s ${IOS_SOFT}}
@keyframes pop{from{opacity:0;transform:translateY(-8px) scale(.97)}to{opacity:1;transform:none}}
.msacts{display:flex;gap:7px;padding:3px 3px 7px;border-bottom:1px solid var(--line);margin-bottom:5px}
.msact{flex:1;appearance:none;font-family:inherit;font-size:var(--fs-meta);font-weight:600;
       min-height:39px;border-radius:9px;background:rgba(255,255,255,.07);border:0;
       color:var(--txt2);cursor:pointer}
.msopt{display:flex;align-items:center;gap:11px;width:100%;min-height:var(--tap);padding:0 9px;
       appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;
       font-size:var(--fs-body);font-weight:600;color:var(--txt);border-radius:9px;text-align:left;
       transition:background .2s ${IOS}}
.msopt:hover{background:rgba(255,255,255,.06)}
.msopt:active{transform:scale(.985);transition:transform .1s ${IOS}}
.box{flex:0 0 auto;width:22px;height:22px;border-radius:6px;border:2px solid rgba(255,255,255,.28);
     display:grid;place-items:center;transition:background .2s ${IOS},border-color .2s ${IOS}}
.box svg{width:14px;height:14px;fill:none;stroke:#fff;stroke-width:3;stroke-linecap:round;
         stroke-linejoin:round;opacity:0;transform:scale(.5);
         transition:opacity .2s ${IOS},transform .3s ${IOS_SOFT}}
.msopt.on{font-weight:700}
.msopt.on .box{background:#fff;border-color:#fff}
.msopt.on .box svg{stroke:var(--ha-card-background,#201b25)}
.msopt.on .box svg{opacity:1;transform:none}
.msname{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msgh{padding:9px 9px 5px}
.msopt + .msgh{margin-top:6px;padding-top:13px;border-top:1px solid var(--line)}
.msdot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:var(--c)}
.mscount{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt2)}

.clear{appearance:none;font-family:inherit;font-size:var(--fs-body);font-weight:600;
       min-height:var(--tap);padding:0 30px;border-radius:11px;background:transparent;
       border:1px solid var(--line);color:var(--txt2);cursor:pointer;
       transition:color .26s ${IOS},border-color .26s ${IOS},background-color .26s ${IOS}}
.clear:active{transform:scale(.96);transition:transform .12s ${IOS_SOFT}}
.clear:hover{color:var(--txt);border-color:rgba(255,255,255,.24)}
/* with a filter set, Reset has something to do: it stands out as a control (New alert's look) */
.clear.on{background:var(--sel-bg);border-color:var(--sel-line);color:var(--txt)}

.tbody{position:relative}
.stickyhead{position:sticky;top:var(--hm-pin);z-index:6;background:var(--ha-card-background,#201b25)}
.thead{position:sticky;top:calc(var(--hm-pin) + var(--sticky-h,0px));z-index:5;
       display:grid;gap:var(--gap);padding:0 var(--pad);
       background:var(--ha-card-background,#201b25);border-bottom:1px solid var(--line)}
@media (max-width: 700px){
  .stickyhead{position:static}
  .thead{top:var(--hm-pin)}
}
.th{appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;text-align:left;
    min-height:45px;padding:0;display:flex;align-items:center;gap:6px;transition:color .18s ${EASE}}
.th.r{justify-content:flex-end}
.th:hover{color:var(--txt)}
.th.on{color:var(--txt);font-weight:800}
.ar{font-size:9px}
.tr{display:grid;gap:var(--gap);align-items:center;padding:12px var(--pad);cursor:pointer;
    min-height:var(--tap);border-bottom:1px solid rgba(255,255,255,.05);
    transition:background .16s ${EASE}}
.tr:hover{background:rgba(255,255,255,.045)}
.tr:active{transform:scale(.995);transition:transform .1s ${IOS}}
.tr.open{background:rgba(255,255,255,.05)}
.td{min-width:0;display:flex;align-items:center;gap:9px}
.td.r{justify-content:flex-end;text-align:right}
.nm{display:flex;align-items:center;gap:12px;min-width:0;padding-right:32px}
.dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:var(--c);
     box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 20%,transparent)}
.nmt{display:flex;flex-direction:column;gap:2px;min-width:0}
.nmt b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nmt i{font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.clip{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.tag{appearance:none;border:0;cursor:pointer;text-align:left;
     font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;padding:6px 10px;border-radius:6px;
     background:rgba(255,255,255,.08);color:var(--txt2);
     white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;
     transition:background .16s ${EASE},color .16s ${EASE}}
.tag:hover{background:rgba(255,255,255,.15);color:var(--txt)}
.tag:active{transform:scale(.94);transition:transform .12s ${IOS_SOFT}}
.tag.on{background:var(--sel-bg);color:var(--txt);font-weight:600;
        box-shadow:inset 0 0 0 1px var(--sel-line)}
.tag.stt{font-family:inherit;font-weight:600;text-align:center;
         background:color-mix(in srgb,var(--c) 16%,transparent);color:var(--c);
         box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 30%,transparent)}
.tag.stt:hover{background:color-mix(in srgb,var(--c) 26%,transparent);color:var(--c)}
.tag.stt.on{background:color-mix(in srgb,var(--c) 30%,transparent);color:var(--c);
            box-shadow:inset 0 0 0 2px var(--c)}

.acts{display:flex;align-items:center;justify-content:flex-end;gap:2px}
.chev{display:grid;place-items:center;width:26px;height:38px}
.chev svg{width:20px;height:20px;fill:none;stroke:var(--txt2);stroke-width:2.4;
          stroke-linecap:round;stroke-linejoin:round;opacity:.6;transition:transform .42s ${IOS_SOFT}}
.chev.up svg{transform:rotate(180deg)}
.none{padding:36px;text-align:center}
/* an empty table: the phone's empty state - its sign in a tinted circle, a title, a line */
.nil{display:flex;flex-direction:column;align-items:center;text-align:center;padding:44px 24px 40px}
.nilic{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;color:var(--c);
       background:color-mix(in srgb,var(--c) 16%,transparent);margin-bottom:16px}
.nilic svg{width:32px;height:32px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.nilt{font-size:22px;font-weight:700;letter-spacing:.35px;color:var(--txt)}
.nilb{font-size:var(--fs-body);color:var(--txt2);margin-top:6px;line-height:1.35;max-width:360px}

.detail{padding:0 var(--pad);background:rgba(255,255,255,.03);border-bottom:1px solid var(--line);cursor:default}
.detailBody{padding:4px 0 20px}
.shc{margin:2px 0 4px;animation:fade .34s ${IOS}}
.shc state-history-card{
  display:block;
  --ha-card-border-width:0;
  --ha-card-box-shadow:none;
  --state-history-card-background:transparent;
  --state-history-card-border-radius:0;
  --state-history-card-padding:0;
  --state-history-row-height:${SHC_ROW_H}px;
  --state-history-row-gap:${SHC_ROW_GAP}px;
  --state-history-track-border-radius:4px;
  --state-history-track-background:rgba(255,255,255,.05);
  --state-history-track-grid-color:var(--line);
  --state-history-label-font-size:var(--fs-meta);
  --state-history-label-font-weight:500;
  --state-history-label-color:var(--txt2);
  --state-history-axis-font-size:var(--fs-label);
  --state-history-axis-color:var(--txt2);
  --state-history-axis-tick-color:var(--line);
  --state-history-tooltip-font-size:var(--fs-meta);
  --state-history-tooltip-border-radius:9px;
  --state-history-tooltip-padding:8px 11px;
}
.dhead{padding:13px 0 9px;display:flex;gap:11px;align-items:center;flex-wrap:wrap}
.dhead.sm{padding-top:18px}
.dsub{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;
      text-transform:none;letter-spacing:0;color:var(--txt2);opacity:.85}
.loading{padding:20px 0}
.log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.log li{display:flex;align-items:center;gap:11px;min-height:37px}
.logdot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:0 0 auto}
.lgt{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt2);flex:0 0 auto;min-width:176px}
.lgm{font-size:var(--fs-meta);font-weight:500;color:var(--txt);
     white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.navbtn{appearance:none;font-family:inherit;cursor:pointer;
        min-height:var(--tap);padding:0 18px;border-radius:11px;background:transparent;
        border:1px solid var(--line);color:var(--txt2);
        transition:color .26s ${IOS},border-color .26s ${IOS}}
.navbtn:active{transform:scale(.96);transition:transform .12s ${IOS_SOFT}}
.navbtn:hover{color:var(--txt);border-color:rgba(255,255,255,.24)}
.dhead .navbtn{margin-left:auto}

.pager{display:flex;align-items:center;justify-content:center;gap:18px;padding:14px var(--pad) 4px}
.pg{appearance:none;border:1px solid var(--line);background:rgba(255,255,255,.05);
    width:var(--tap);height:var(--tap);border-radius:14px;cursor:pointer;display:grid;place-items:center;
    transition:background .26s ${IOS},opacity .26s ${IOS}}
.pg svg{width:22px;height:22px;fill:none;stroke:var(--txt);stroke-width:2.4;
        stroke-linecap:round;stroke-linejoin:round}
.pg:hover:not(:disabled){background:rgba(255,255,255,.1)}
.pg:active:not(:disabled){transform:scale(.92);transition:transform .12s ${IOS_SOFT}}
.pg:disabled{opacity:.3;cursor:default}
/* room either side for a row's highlight, which reaches past the text */
.tl{overflow:hidden;margin:0 -8px;padding:0 8px}
/* a timeline row opens its whole event: highlighted under the pointer, ringed while open,
   a chevron at its end as the iOS sign of "more" */
.log li.lgi{margin:0 -8px;padding:0 8px;border-radius:9px;cursor:pointer;outline:none;
            -webkit-tap-highlight-color:transparent;transition:background-color .2s ease}
@media (hover:hover){.log li.lgi:hover{background:rgba(255,255,255,.05)}}
.log li.lgi:active{background:rgba(255,255,255,.08);transition:none}
.log li.lgi.on, .log li.lgi:focus-visible{background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px var(--sel-line)}
.lgchev{flex:0 0 auto;margin-left:auto;width:16px;height:16px;display:grid;place-items:center;color:var(--txt2)}
.lgchev svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.tlpager{display:flex;align-items:center;justify-content:center;gap:18px;padding:12px 0 2px}
.pgtext{font-size:var(--fs-body);font-weight:600;color:var(--txt);
        font-family:var(--mono);min-width:86px;text-align:center}
.tfoot{padding:14px var(--pad);border-top:1px solid var(--line);text-align:center}

/* ---- additions for alerts -------------------------------------------------- */
/* New alert: a control, in the selection white. */
.newbtn{margin-left:auto;appearance:none;font-family:inherit;cursor:pointer;
        display:flex;align-items:center;gap:8px;min-height:var(--tap);padding:0 18px 0 14px;
        border-radius:11px;background:var(--sel-bg);
        border:1px solid var(--sel-line);color:var(--txt);
        transition:background .26s ${IOS},opacity .26s ${IOS}}
.newbtn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round}
.newbtn:active:not(:disabled){transform:scale(.96);transition:transform .12s ${IOS_SOFT}}
.newbtn:disabled{opacity:.35;cursor:default}
/* What the alert is FOR (its description), above what it says now. */
.desc{padding:0 0 10px;max-width:900px;line-height:1.45}
/* What the alert says now, in its status hue - the one line that answers "what is wrong". */
/* anywhere, not just break-word: a long token (a Python repr in an error) must not set the
   card's minimum width - in a 1fr grid that widened the whole page */
.msg{padding:2px 0 12px;color:var(--c);word-break:break-word;overflow-wrap:anywhere}
.msglines{display:flex;flex-direction:column;gap:3px}
.msgline{white-space:pre-wrap}
.msgpager{justify-content:flex-start;padding:8px 0 0}
.btnrow{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:4px 0 6px}
/* History: the event, whole (the popup's fields), then the way to its alert */
.hevent{max-width:900px;padding:2px 0 4px}
.hevent .ipd, .hevent .ipid{font-size:var(--fs-body)}
.hevent .ipwhen{margin-left:12px}
.hbtnrow{display:flex;gap:10px;align-items:center;padding:10px 0 6px}
.golink{margin-left:auto}
.bnote{padding-left:6px}
.navbtn.primary{background:var(--sel-bg);border-color:var(--sel-line);color:var(--txt)}
/* Snoozed until …: the highlight, exactly as the chosen tab - white, in the card's own dark */
.navbtn.snoozed{background:#fff;border-color:#fff;color:var(--ha-card-background,#201b25);font-weight:700}
.navbtn.snoozed:hover{color:var(--ha-card-background,#201b25);border-color:#fff}
/* Clear: the one coloured control - it turns the alert green, so it is green (the OK hue,
   boxed like the OK chip). */
.navbtn.ok{color:${COL.ok};font-weight:700;background:color-mix(in srgb,${COL.ok} 14%,transparent);
           border-color:color-mix(in srgb,${COL.ok} 55%,transparent)}
.navbtn.ok:hover{color:${COL.ok};background:color-mix(in srgb,${COL.ok} 22%,transparent);border-color:${COL.ok}}

/* Row name line: name, (i), paused-notifications bell. */
.nml{display:flex;align-items:center;gap:4px;min-width:0}
.nml b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.info{appearance:none;border:0;background:transparent;padding:0;margin:-6px 0;cursor:pointer;
      flex:0 0 auto;width:30px;height:30px;display:grid;place-items:center;border-radius:50%}
.info svg, .quiet svg{width:17px;height:17px;fill:none;stroke:var(--txt2);stroke-width:2;
      stroke-linecap:round;stroke-linejoin:round;transition:stroke .16s ${EASE}}
.info:hover svg, .info.on svg{stroke:var(--txt)}
.info.on{background:rgba(255,255,255,.08)}
.quiet{flex:0 0 auto;display:grid;place-items:center;width:22px;height:22px}
/* The (i) popup: a modal like the snooze sheet - the page dims behind it - in the chart
   tooltip's box with a deeper shadow. */
ha-card{position:relative}
dialog.idlg, dialog.snz{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;
           padding:0;border:0;background:transparent;color:var(--txt);overflow:hidden}
dialog.idlg::backdrop, dialog.snz::backdrop{background:transparent}
.iscrim{position:absolute;inset:0;background:rgba(0,0,0,var(--scrim-a))}
.ipop{position:absolute;width:max-content;max-width:min(570px,calc(100% - 16px));
      padding:14px 16px;border-radius:13px;background:#2a2433;border:1px solid rgba(255,255,255,.14);
      box-shadow:0 30px 80px rgba(0,0,0,.7),0 4px 14px rgba(0,0,0,.45)}
.ipk{font-size:var(--fs-label);font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--txt2)}
.ipk + div{margin:3px 0 0}
.ipd + .ipk, .ipid + .ipk, .ipev + .ipk{margin-top:10px}
/* an event: what happened and when, then each of its fields; a long message wraps and, past
   the screen, scrolls inside the popup */
.ipop{max-height:calc(100% - 16px);overflow:auto;overscroll-behavior:contain;box-sizing:border-box}
.ipop.wide{width:min(570px,calc(100% - 16px))}
/* an explanation to read: wide on a tablet, so it runs to few lines */
.ipop.xwide{width:min(760px,calc(100% - 16px));max-width:min(760px,calc(100% - 16px));padding:16px 20px}
.ipop.xwide .ipd{font-size:var(--fs-body);line-height:1.5}
.ipop.xwide .ipd + .ipk{margin-top:14px}
.ipd b{font-weight:700}
/* an example under an explanation */
.ipeg{display:block;margin-top:2px;color:var(--txt2)}
.ipeg::before{content:"e.g. "}
/* a list in an explanation */
.iplist{margin:4px 0 0;padding-left:20px}
.iplist li{margin:4px 0;font-size:var(--fs-meta);font-weight:500;line-height:1.45;color:var(--txt)}
.iplist li::marker{color:var(--txt2)}
.ipop.xwide .iplist li{font-size:var(--fs-body);line-height:1.5}
.iplist + .ipk{margin-top:14px}
.ipd + .ipd{margin-top:8px}
.iplist + .ipd{margin-top:16px}
/* an explanation of two options: a panel each, side by side where there is room */
.ipop.xwide:has(.ipcols){padding:12px}
.ipcols{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ipcols.one{grid-template-columns:1fr}
.ipop.xwide:has(.ipcols.one){width:min(480px,calc(100% - 16px))}
@media (max-width:700px){.ipcols{grid-template-columns:1fr}}
.ipsec{padding:12px 14px 10px;border-radius:10px;background:rgba(255,255,255,.05);
       box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)}
.iph{font-size:17px;font-weight:700;color:var(--txt)}
.iptag{margin-top:1px;font-size:var(--fs-meta);font-weight:600;color:var(--txt2)}
.ipsec .ipd{margin-top:9px}
.ipneed{margin-top:12px;font-size:var(--fs-label);font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--txt2)}
.ipneed + .iplist{margin-top:5px}
/* the (i) beside a label in the editor */
.ed-lbl .ed-info{display:inline-grid;margin:-6px 0 -6px 4px;vertical-align:middle}
.ipev{display:flex;align-items:center;gap:9px;font-size:var(--fs-body);color:var(--txt)}
.ipwhen{margin-left:auto;padding-left:14px;font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt2);white-space:nowrap}
.ipmsg{white-space:pre-wrap;word-break:break-word}
.ipid{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt);word-break:break-all}

/* ---- snooze sheet: iOS action sheet / popover in the card's type scale ----------
   Wide: the list, and Custom beside it to the right. Narrow: stacked, Cancel last. */
.snzscrim{position:absolute;inset:0;background:rgba(0,0,0,var(--scrim-a))}
.snzpanel{position:absolute;max-height:calc(100% - 16px);overflow-y:auto;overscroll-behavior:contain;
          display:flex;flex-direction:row;align-items:flex-start;gap:8px;outline:none;scrollbar-width:none;
          -webkit-tap-highlight-color:transparent}
.snzpanel::-webkit-scrollbar{display:none}
.snzpanel > .sgrp{width:380px;box-sizing:border-box}
dialog.snz:not(.narrow) .snzpanel{overflow:visible;max-height:none}
dialog.snz:not(.narrow) .scust{position:relative;max-height:calc(100vh - 16px);overflow-y:auto;
                               scrollbar-width:none;transition:top 360ms ${IOS}}
dialog.snz.narrow .snzpanel{left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));
                            flex-direction:column;align-items:stretch;max-height:calc(100% - 48px)}
dialog.snz.narrow .snzpanel > .sgrp{width:auto}
.sgrp{flex:0 0 auto;border-radius:14px;overflow:hidden;background:rgba(48,42,58,.9);
      -webkit-backdrop-filter:blur(30px) saturate(1.6);backdrop-filter:blur(30px) saturate(1.6);
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.shead{padding:14px 18px 12px;text-align:left}
.stitle{font-size:var(--fs-meta);font-weight:700;color:var(--txt2)}
.srow{appearance:none;border:0;background:transparent;width:100%;min-height:52px;padding:0 18px;margin:0;
      display:flex;align-items:center;gap:10px;cursor:pointer;font-family:inherit;text-align:left;position:relative;
      font-size:var(--fs-body);font-weight:600;color:var(--txt);transition:background .25s ${EASE}}
.srow::before{content:"";position:absolute;left:18px;right:0;top:0;height:1px;background:rgba(255,255,255,.09)}
.srow:active{background:rgba(255,255,255,.12);transition:none}
@media (hover:hover){.srow:hover{background:rgba(255,255,255,.06)}}
.sval{margin-left:auto;font-size:var(--fs-meta);font-weight:500;color:var(--txt2);white-space:nowrap}
/* End Snooze: the row that undoes what is set, in the selection white. */
.srow.end, .srow.end:hover{background:#fff;color:var(--ha-card-background,#201b25)}
.srow.end .sval{color:inherit;opacity:.7}
.srow.end:active{background:rgba(255,255,255,.82)}
.srow.end::before, .srow.end + .srow::before{display:none}
.schev{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:var(--txt2);stroke-width:2.4;
       stroke-linecap:round;stroke-linejoin:round;transition:transform .42s ${IOS}}
/* Custom open: beside the list the row stays lit and its chevron points at it; under
   the list (a phone) the chevron turns down. */
.scustom.open{background:rgba(255,255,255,.08)}
dialog.snz.narrow .scustom.open{background:transparent}
dialog.snz.narrow .scustom.open .schev{transform:rotate(90deg)}
.scust{padding:16px;display:flex;flex-direction:column;gap:12px}
.scust[hidden]{display:none}
.stext{appearance:none;width:100%;box-sizing:border-box;height:46px;padding:0 14px;border-radius:11px;
       border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--txt);font-family:inherit;
       font-size:var(--fs-body);font-weight:600;outline:none;transition:border-color .2s ${EASE},background .2s ${EASE}}
.stext::placeholder{color:var(--txt2);font-weight:500}
.stext:focus{border-color:var(--sel-line);background:rgba(255,255,255,.09)}
.scal{-webkit-user-select:none;user-select:none}
.calhd{display:flex;align-items:center;gap:2px;padding:0 0 4px}
.calm{flex:1;font-size:var(--fs-body);font-weight:700;color:var(--txt)}
.calnav{appearance:none;border:0;background:transparent;width:38px;height:38px;border-radius:50%;
        display:grid;place-items:center;cursor:pointer;padding:0}
.calnav svg{width:20px;height:20px;fill:none;stroke:var(--txt);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.calnav:disabled{opacity:.25;cursor:default}
.calnav:not(:disabled):active{background:rgba(255,255,255,.12)}
.calwk, .calgrid{display:grid;grid-template-columns:repeat(7,1fr);text-align:center}
.calwk span{font-size:var(--fs-label);font-weight:700;color:var(--txt2);padding:2px 0 6px}
.cday{appearance:none;border:0;background:transparent;font-family:inherit;cursor:pointer;padding:0;
      width:38px;height:38px;margin:1px auto;border-radius:50%;display:grid;place-items:center;
      font-size:var(--fs-body);font-weight:500;color:var(--txt);
      transition:background .2s ${EASE},color .2s ${EASE},transform .14s ${IOS_SOFT}}
.cday:disabled{opacity:.25;cursor:default}
.cday.today{font-weight:800;box-shadow:inset 0 0 0 1px var(--sel-line)}
.cday.sel{background:#fff;color:var(--ha-card-background,#201b25);font-weight:700;box-shadow:none}
@media (hover:hover){.cday:not(:disabled):not(.sel):hover{background:rgba(255,255,255,.08)}}
.cday:not(:disabled):active{transform:scale(.88)}
.stime{display:flex;align-items:center;justify-content:space-between;gap:12px;
       font-size:var(--fs-body);font-weight:600;color:var(--txt)}
/* The time chip and its drum: the Simple Schedule card's, in this card's tokens. The
   chip is white while its drum is open. The drum opens in two parts - the box makes
   room on a plain ease, the drum drops in on the overshooting spring. */
/* Fixed width: the widest time ("00:00 AM", or "00:00" on a 24-hour clock) with room. */
.tchip{width:calc(8.4ch + 28px);overflow:hidden;text-align:center;flex:0 0 auto;
       appearance:none;border:0;cursor:pointer;min-height:40px;padding:0 14px;border-radius:10px;
       background:rgba(255,255,255,.09);color:var(--txt);font-family:inherit;font-size:var(--fs-body);
       font-weight:600;font-variant-numeric:tabular-nums;-webkit-tap-highlight-color:transparent;
       transition:background .15s ease,color .15s ease}
@media (hover:hover){.tchip:hover{background:rgba(255,255,255,.14)}}
.tchip.on{background:#fff;color:var(--ha-card-background,#201b25)}
.tchip.h24{width:calc(5.4ch + 28px)}
.tchip{position:relative}
.tcin{display:block;white-space:nowrap}
.tcout{position:absolute;inset:0;display:grid;place-items:center;white-space:nowrap;pointer-events:none}
.sdrum{border-radius:12px;background:rgba(0,0,0,.18);overflow:hidden}
.sdrum[hidden]{display:none}
.wheel{position:relative;display:flex;align-items:stretch;justify-content:center;gap:6px;
       height:var(--wheel-h);padding:0 10px}
.wheel-band{position:absolute;left:10px;right:10px;top:calc(50% - 22px);height:44px;border-radius:9px;
            background:rgba(255,255,255,.08);pointer-events:none}
/* The drum's gesture, all of it: no browser pan, zoom or text selection. */
.wheel-col{flex:0 1 120px;position:relative;overflow:hidden;touch-action:none;-webkit-user-select:none;
           user-select:none;-webkit-tap-highlight-color:transparent;cursor:grab;outline:none;text-align:center}
.wheel-col.grabbing{cursor:grabbing}
.wheel-col:focus-visible{box-shadow:inset 0 0 0 2px rgba(255,255,255,.35);border-radius:9px}
/* Hidden until the drum places it: every row starts on the centre line. */
.wheel-item{position:absolute;left:0;right:0;top:50%;height:44px;margin-top:-22px;line-height:44px;
            font-size:20px;font-weight:700;color:var(--txt);font-variant-numeric:tabular-nums;visibility:hidden}
.wheel-sep{align-self:center;font-size:20px;font-weight:700;color:var(--txt);opacity:.5}
.sprev{text-align:center;font-size:var(--fs-meta);font-weight:500;color:var(--txt2);min-height:18px}
.sprev.ok{color:var(--txt);font-weight:600}
.sgo{appearance:none;border:0;cursor:pointer;height:var(--tap);border-radius:12px;background:#fff;
     color:var(--ha-card-background,#201b25);font-family:inherit;font-size:var(--fs-body);font-weight:700;
     transition:opacity .2s ${EASE},transform .14s ${IOS_SOFT}}
.sgo:disabled{opacity:.3;cursor:default}
.sgo:not(:disabled):active{transform:scale(.97)}
.scancel{appearance:none;border:0;cursor:pointer;min-height:56px;width:100%;margin:0;font-family:inherit;
         font-size:var(--fs-body);font-weight:700;color:var(--txt);display:none}
dialog.snz.narrow .scancel{display:block}
.scancel:active{background:rgba(70,62,82,.95)}
.ipd{font-size:var(--fs-meta);font-weight:500;color:var(--txt);line-height:1.45}

/* ---- the rule editor ----
   The Simple Schedule card's event editor - banded groups of labelled rows, grey value
   chips that turn white while their picker is open, the priority's colour along the top -
   in the snooze sheet's materials: rounded, on its lighter panel colour, rows ruled by
   inset hairlines. Its own tokens, so nothing in the card's palette leaks in or out. */
dialog.red{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;
           padding:0;border:0;background:transparent;overflow:hidden;color:var(--ed-fg);
           --ed-fg:var(--primary-text-color,#fff);--ed-line:rgba(255,255,255,.09);
           --ed-line-strong:rgba(255,255,255,.22);--ed-band:rgba(255,255,255,.05);
           --ed-panel:rgb(48,42,58);--ed-spring:cubic-bezier(.34,1.42,.64,1);--ed-ease:cubic-bezier(.32,.72,0,1);
           --ed-sel:#fff;--ed-sel-fg:var(--ha-card-background,#201b25);--ed-red:rgba(255,71,51,1)}
dialog.red::backdrop{background:transparent}
.red-scrim{position:absolute;inset:0;background:rgba(0,0,0,var(--scrim-a,.6))}
/* centred by a wrapper, so the sheet's own transform is free to animate */
.red-wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.red-sheet{pointer-events:auto;position:relative;box-sizing:border-box;width:624px;max-width:calc(100vw - 32px);
           max-height:90vh;overflow-y:auto;overscroll-behavior:contain;padding:16px 18px 0;outline:none;
           border-radius:18px;background:var(--ed-panel);border-top:5px solid var(--accent);
           box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),0 30px 80px rgba(0,0,0,.6),0 4px 14px rgba(0,0,0,.4);
           transition:border-color .3s ease;font-size:15px;line-height:1.3;
           scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.22) transparent}
/* a phone: the whole width, rising from the bottom like the snooze action sheet */
dialog.red.narrow .red-wrap{align-items:flex-end}
dialog.red.narrow .red-sheet{width:100%;max-width:none;max-height:calc(100% - 24px - env(safe-area-inset-top,0px));
           border-radius:18px 18px 0 0;padding:14px 14px 0}
dialog.red.narrow .ed-actions{padding-bottom:calc(14px + env(safe-area-inset-bottom,0px))}
dialog.red.narrow .ed-hint{display:none}
/* without its hint, a tick row's box still sits at the right edge */
dialog.red.narrow .ed-toggle .box{margin-left:auto}
.red-sheet button{font-family:inherit}
.red-sheet svg{fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}

.ed-title-row{display:flex;align-items:center;gap:12px}
.ed-title{width:100%;min-width:0;box-sizing:border-box;background:transparent;border:0;
          border-bottom:1px solid var(--ed-line-strong);color:var(--ed-fg);font-family:inherit;
          font-size:22px;font-weight:700;letter-spacing:-.3px;padding:2px 2px 10px;outline:none;
          transition:border-color .2s ease}
.ed-title:focus{border-bottom-color:var(--accent)}
.ed-title::placeholder{color:var(--ed-fg);opacity:.45}
.ed-group{margin-top:14px;background:var(--ed-band);border-radius:14px;overflow:hidden}
.ed-head{padding:12px 14px 8px;font-size:var(--fs-label,12px);font-weight:700;letter-spacing:.6px;
         text-transform:uppercase;color:var(--txt2,rgba(255,255,255,.6))}
/* rows ruled by inset hairlines, as in the snooze sheet */
.ed-row{position:relative;display:flex;align-items:center;gap:12px;min-height:48px;padding:6px 14px;box-sizing:border-box}
.ed-row::before{content:"";position:absolute;left:14px;right:0;top:0;height:1px;background:var(--ed-line)}
.ed-group > .ed-row:first-child::before, .ed-head + .ed-row::before,
.ed-head + .ed-cond .ed-row.cond::before{display:none}
.ed-lbl{flex:0 0 auto;min-width:84px;font-size:15px;font-weight:600}
/* Actions: its heading carries the (i); a script's row ends in its remove button */
.ed-head .ed-info{display:inline-grid;margin:-8px 0 -8px 4px;vertical-align:middle}
.ed-actrow{padding-right:4px}
.ed-vals{flex:1 1 auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0}
button.ed-row{width:100%;border:0;background:transparent;color:var(--ed-fg);text-align:left;cursor:pointer;
              -webkit-tap-highlight-color:transparent;transition:background .2s ease}
@media (hover:hover){button.ed-row:hover{background:rgba(255,255,255,.04)}}
button.ed-row:active{background:rgba(255,255,255,.1);transition:none}

/* the tappable value: the snooze sheet's time chip, white while its picker is open */
.ed-chip{position:relative;border:0;border-radius:10px;background:rgba(255,255,255,.09);color:var(--ed-fg);
         font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;padding:0 14px;min-height:40px;
         max-width:100%;cursor:pointer;-webkit-tap-highlight-color:transparent;
         transition:background .15s ease,color .15s ease,transform .14s var(--ed-spring)}
@media (hover:hover){.ed-chip:hover:not(.on):not(.sel){background:rgba(255,255,255,.14)}
                     .ed-chip.sel:hover:not(.on){background:rgba(255,255,255,.88)}}
.ed-chip:active{transform:scale(.96)}
/* a chip whose picker is open: white, with a ring - chosen values are white already */
.ed-chip.on{background:var(--ed-sel);color:var(--ed-sel-fg);outline:2px solid var(--ed-sel);outline-offset:2px}
.ed-chip.empty:not(.on){font-weight:500;background:transparent;box-shadow:inset 0 0 0 1px var(--ed-line-strong)}
.ed-cin{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-op{min-width:64px}
/* a duration: one width whatever it says - the widest it can say, laid in the same cell
   unseen - so the chip never jumps while its drum turns, and the value rolls */
.ed-chip.dur{display:inline-grid;align-items:center;justify-items:center;overflow:hidden;text-align:center}
.ed-chip.dur > .ed-cin, .ed-chip.dur > .ed-sizer{grid-area:1/1;overflow:visible}
.ed-sizer{visibility:hidden;white-space:nowrap}

/* an iOS segmented control: a recessed track, and the chosen segment on a raised thumb that
   slides (placeThumbs) from one segment to the next rather than the colour jumping */
.ed-seg{position:relative;display:inline-flex;padding:2px;border-radius:10px;background:rgba(255,255,255,.08);
        box-sizing:border-box;isolation:isolate}
.ed-thumb{position:absolute;top:2px;bottom:2px;left:2px;width:0;border-radius:8px;z-index:0;
          background:var(--thumb,var(--ed-sel));box-shadow:0 2px 6px rgba(0,0,0,.28),0 0 0 .5px rgba(0,0,0,.08);
          transition:background-color .3s ease}
.ed-seg-btn{position:relative;z-index:1;min-width:76px;padding:0 14px;height:36px;border:0;border-radius:8px;
            background:transparent;color:var(--ed-fg);font-size:15px;font-weight:600;cursor:pointer;
            -webkit-tap-highlight-color:transparent;transition:color .25s ease,opacity .2s ease}
@media (hover:hover){.ed-seg-btn:hover:not(.on){opacity:.75}}
.ed-seg-btn:active:not(.on){opacity:.55;transition:none}
/* the chosen priority's thumb in its own colour, as the event editor's chosen unit wears its accent */
.ed-seg-btn.on{color:var(--ed-sel-fg);font-weight:700}

/* a row's quiet second word: what the setting does, what a duration counts */
.ed-hint{flex:1 1 auto;min-width:0;text-align:right;font-size:var(--fs-meta,13px);font-weight:500;
         color:var(--txt2,rgba(255,255,255,.6))}
/* a value that is chosen, as the filters show theirs: white */
.ed-chip.sel{background:var(--ed-sel);color:var(--ed-sel-fg)}
.ed-pickrow .ed-chip{pointer-events:none}
span.ed-chip{display:inline-flex;align-items:center;box-sizing:border-box}
.ed-toggle .box{margin-left:4px}
.ed-toggle.on .box{background:#fff;border-color:#fff}
.ed-toggle.on .box svg{stroke:var(--ha-card-background,#201b25);opacity:1;transform:none}

/* a condition: a sentence of chips, the remove button at its end */
.ed-cond{overflow:hidden}
.ed-row.cond{align-items:flex-start;padding:8px 4px 8px 14px}
.ed-row.cond .ed-lbl{min-width:62px;padding-top:11px}
/* And / Or: the rule's one choice, shown (and switched) on every joining row */
.ed-row.cond .ed-lbl.join{padding-top:0}
.ed-join{min-width:58px;padding:0 10px}
/* whether a condition holds right now: red as the "would fire" dot, grey when not */
.ed-hold{flex:0 0 auto;width:9px;height:9px;margin:15px 4px 0 6px;border-radius:50%;background:transparent;
         transition:background .3s ease,box-shadow .3s ease}
.ed-hold.yes{background:${COL.firing};box-shadow:0 0 0 3px color-mix(in srgb,${COL.firing} 22%,transparent)}
.ed-hold.no{background:var(--ed-line-strong)}
.ed-count{display:block;margin:3px 0 0 16px;color:var(--txt2,rgba(255,255,255,.6))}
.ed-sent{flex:1 1 auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
/* centred on a chip's 40px, but a wrapped phrase keeps its ordinary line spacing */
.ed-word{display:inline-flex;align-items:center;min-height:40px;font-size:15px;font-weight:600;line-height:1.3}
.ed-x{flex:0 0 auto;width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:50%;
      background:transparent;color:var(--ed-fg);opacity:.6;cursor:pointer;-webkit-tap-highlight-color:transparent;
      transition:opacity .15s ease,background .15s ease}
@media (hover:hover){.ed-x:hover{opacity:1;background:rgba(255,255,255,.08)}}
.ed-x svg{width:18px;height:18px}
.ed-num{width:88px;box-sizing:border-box;min-height:40px}
.ed-stat{display:inline-flex;align-items:center;min-height:40px;padding:0;border:0;background:transparent;
         cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .14s var(--ed-spring)}
.ed-stat:active{transform:scale(.95)}
.ed-stat .tag{pointer-events:none}
.ed-stats{gap:10px}
/* a chosen Health status: in a white chip, its tag drawn as the filters draw one on white */
.ed-statchip{padding:0 8px}
.ed-stat.sel{padding:0 8px;border-radius:10px;background:var(--ed-sel)}
.ed-chip.sel .tag.stt, .ed-stat.sel .tag.stt{color:color-mix(in srgb,var(--c) 40%,#000);
  background:color-mix(in srgb,var(--c) 32%,#fff);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 60%,#fff);
  font-weight:700}
.ed-tplrow{padding-top:0}
/* the days a time window counts on: seven buttons, the chosen ones white */
.ed-daysrow{padding-top:0;padding-left:76px}
.ed-daysrow::before{display:none}
.ed-days{flex:1 1 auto;display:flex;gap:6px;min-width:0}
.ed-day{flex:1 1 0;min-width:0;height:40px;border:0;border-radius:10px;background:rgba(255,255,255,.07);
        color:var(--ed-fg);font-size:14px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent;
        transition:background .2s ease,color .2s ease,transform .14s var(--ed-spring)}
@media (hover:hover){.ed-day:hover:not(.on){background:rgba(255,255,255,.13)}}
.ed-day:active{transform:scale(.94)}
.ed-day.on{background:var(--ed-sel);color:var(--ed-sel-fg);font-weight:700}
dialog.red.narrow .ed-daysrow{padding-left:14px}
/* a numeric condition's Margin: under its sentence, as the days under a time */
.ed-mrow{padding-top:0;padding-left:88px;gap:8px;flex-wrap:wrap}
.ed-mrow::before{display:none}
.ed-mrow .ed-info{margin:-6px 4px -6px -4px}
dialog.red.narrow .ed-mrow{padding-left:14px}
/* on a phone the Margin's hint is what says what it does: on its own line, under it */
dialog.red.narrow .ed-mrow .ed-hint{display:block;flex:1 0 100%;text-align:left;margin-top:-4px}
/* a reminder's one event, under its calendar trigger: a value, not a control */
.ed-evrow .ed-evname{pointer-events:none}
.ed-evrow .ed-x{margin:-6px -6px -6px auto}
/* "Only events called" a title: typed; the row drops in as a picker does, and folds away */
.ed-evrow .ed-evtitle{flex:1 1 140px;min-width:0;min-height:40px;box-sizing:border-box}
.ed-evrow.enter{animation:edRowIn 260ms var(--ed-ease) backwards;overflow:hidden}
.ed-evrow.enter > *{animation:edDrop 420ms var(--ed-spring) backwards}
/* the way to one: quiet, under the trigger it narrows */
button.ed-evadd{min-height:40px;padding-bottom:6px;gap:8px;color:var(--ed-fg)}
button.ed-evadd .ed-word{min-height:0;font-weight:600}
button.ed-evadd.enter{animation:edRowIn 260ms var(--ed-ease) backwards;overflow:hidden}
button.ed-evadd.enter > *{animation:edDrop 420ms var(--ed-spring) backwards}
/* a row opening from nothing: its min-height and padding grow with it (edOpen's max-height
   alone stops at a row's min-height) */
@keyframes edRowIn{from{max-height:0;min-height:0;padding-top:0;padding-bottom:0;opacity:0}to{max-height:140px;opacity:1}}
dialog.red.narrow .ed-evrow .ed-evtitle{flex-basis:100%}
.ed-tplrow::before{display:none}

/* every text field in the form: the snooze sheet's */
.red-sheet input[type=text], .ed-tarea{background:rgba(255,255,255,.06);border:1px solid var(--line,rgba(255,255,255,.1));
  border-radius:10px;color:var(--ed-fg);color-scheme:dark;font-family:inherit;font-size:15px;font-weight:600;
  padding:8px 11px;min-width:0;outline:none;box-sizing:border-box;
  transition:border-color .2s ease,background .2s ease}
.red-sheet input[type=text]:focus, .ed-tarea:focus{border-color:rgba(255,255,255,.32);background:rgba(255,255,255,.09)}
.red-sheet input::placeholder, .ed-tarea::placeholder{color:var(--txt2,rgba(255,255,255,.6));font-weight:500;opacity:1}
.ed-vals input[type=text]{flex:1 1 auto}
.ed-row.notes{align-items:flex-start;padding-top:10px;padding-bottom:10px}
.ed-row.notes .ed-lbl{padding-top:9px}
.ed-tarea{flex:1 1 auto;width:100%;resize:vertical;line-height:1.35;font-weight:500}
.ed-tarea.mono{font-family:var(--mono);font-size:13px}

/* inline pickers: the box opens on a plain ease, what is in it drops in on the spring */
.ed-picker{position:relative;background:rgba(0,0,0,.18);overflow:hidden}
.ed-picker.enter{animation:edOpen 260ms var(--ed-ease) backwards}
.ed-picker.enter > *{animation:edDrop 420ms var(--ed-spring) backwards}
/* Banner on's Show on: a setting of the list, ruled off from the dashboards under it */
.ed-bpages{border-bottom:1px solid rgba(255,255,255,.12)}
@keyframes edOpen{from{max-height:0;opacity:0}to{max-height:460px;opacity:1}}
@keyframes edDrop{from{transform:translateY(-14px) scale(.94);opacity:0}to{transform:none;opacity:1}}
.ed-opts{display:flex;flex-wrap:wrap;gap:8px;padding:12px 14px;max-height:240px;overflow-y:auto}

.ed-search{display:flex;align-items:center;gap:10px;padding:10px 14px}
.ed-search svg{width:18px;height:18px;flex:0 0 auto;opacity:.7}
.ed-search input[type=text]{flex:1 1 auto}
.ed-list{max-height:264px;overflow-y:auto}
.ed-item{position:relative;display:flex;align-items:center;gap:10px;width:100%;min-height:52px;padding:6px 14px;border:0;
         background:transparent;color:var(--ed-fg);text-align:left;cursor:pointer;
         -webkit-tap-highlight-color:transparent;transition:background .2s ease}
.ed-item::before{content:"";position:absolute;left:14px;right:0;top:0;height:1px;background:var(--ed-line)}
@media (hover:hover){.ed-item:hover{background:rgba(255,255,255,.05)}}
.ed-item:active{background:rgba(255,255,255,.1);transition:none}
.ed-item.sel{background:var(--ed-sel);color:var(--ed-sel-fg)}
.ed-itext{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.ed-iname{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-iid{font-family:var(--mono);font-size:12px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-istate{flex:0 1 auto;max-width:40%;font-size:var(--fs-meta,13px);opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-none{padding:14px;font-size:14px;color:var(--txt2,rgba(255,255,255,.6))}
/* the link list: a dashboard's views, each followed by its pop-ups, set in under it */
.ed-lsh{position:sticky;top:0;z-index:1;padding:9px 14px 5px;font-size:var(--fs-label,12px);font-weight:700;
        letter-spacing:.6px;text-transform:uppercase;color:var(--txt2,rgba(255,255,255,.6));background:rgb(40,35,48)}
.ed-lnk{gap:12px}
.ed-lsep{height:6px;background:rgba(0,0,0,.25)}
.ed-lnk.pop{padding-left:40px}
.ed-lic{flex:0 0 auto;width:22px;height:22px;display:grid;place-items:center;opacity:.8;--mdc-icon-size:20px}
.ed-lic svg{width:18px;height:18px}
.ed-lnk.sel .ed-lic{opacity:1}
.ed-linkchip{max-width:min(340px,100%)}
/* Notify's lists are short: all of it shows, and a chosen one carries a tick as well as the white */
.ed-nlist{max-height:none}
.ed-ichk{flex:0 0 auto;width:20px;height:20px;display:grid;place-items:center;opacity:0;transform:scale(.6);
  transition:opacity .18s ease,transform .26s var(--ed-spring)}
.ed-ichk svg{width:16px;height:16px;stroke-width:2.8}
.ed-item.sel .ed-ichk{opacity:1;transform:none}
.ed-iid.ed-isub{font-family:inherit;font-size:13px}

/* "Add a condition" and its list of kinds */
.ed-addrow{gap:10px}
.ed-addic{width:24px;height:24px;display:grid;place-items:center;transition:transform .42s var(--ed-spring)}
.ed-addic svg{width:20px;height:20px}
.ed-addrow .ed-lbl{min-width:0}
/* a panel of its own inside the group, set in from its edges, so it reads as a menu and
   not as more of the group's rows */
.ed-kinds{display:flex;flex-direction:column;margin:2px 10px 12px;border-radius:12px;overflow:hidden;
          background:rgba(0,0,0,.24);box-shadow:inset 0 0 0 1px var(--ed-line)}
.ed-kinds.enter{animation:edOpen 260ms var(--ed-ease) backwards}
.ed-kinds.enter > *{animation:edDrop 420ms var(--ed-spring) backwards}
/* iOS Settings rows: an icon tile, the name, a line under it; the separator starts at the text */
.ed-kind{position:relative;display:flex;align-items:center;width:100%;min-height:56px;padding:8px 14px 8px 60px;border:0;
         background:transparent;color:var(--ed-fg);text-align:left;cursor:pointer;
         -webkit-tap-highlight-color:transparent;transition:background .2s ease}
.ed-kind + .ed-kind::before{content:"";position:absolute;left:60px;right:0;top:0;height:1px;background:var(--ed-line)}
@media (hover:hover){.ed-kind:hover{background:rgba(255,255,255,.05)}}
.ed-kind:active{background:rgba(255,255,255,.1);transition:none}
.ed-ktext{display:flex;flex-direction:column;gap:2px;min-width:0}
.ed-ktile{position:absolute;left:14px;top:50%;width:32px;height:32px;margin-top:-16px;border-radius:8px;
          display:grid;place-items:center;background:rgba(255,255,255,.12);color:var(--ed-fg)}
.ed-ktile svg{width:20px;height:20px}
/* the Health monitor leads, the same size as the rest: the Health heart on a white tile and a
   full-width rule under it set it apart */
.ed-kind.lead .ed-ktile{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35)}
.ed-kind.lead + .ed-kind::before{left:0}
/* the sentence's own controls (Time / Calendar, Device / Battery / Helper) fit their words */
.ed-sent .ed-seg-btn{min-width:0;padding:0 10px}
/* Fires [While true | When it happens]: the group's first row, in place of a heading */
.ed-typerow .ed-seg-btn{min-width:0;padding:0 14px}
/* its label takes only its word, so the switch keeps one line on a phone */
.ed-typerow .ed-lbl{min-width:0}
.ed-seg-btn{white-space:nowrap}
dialog.narrow .ed-typerow .ed-seg-btn{padding:0 12px}
.ed-kname{font-size:15px;font-weight:600}
.ed-ksub{font-size:var(--fs-meta,13px);font-weight:500;color:var(--txt2,rgba(255,255,255,.6))}

/* what the rule would do right now */
.ed-note{position:relative;padding:10px 14px 12px;font-size:var(--fs-meta,13px);font-weight:500;line-height:1.4}
/* a built-in alert's settings that cannot change: shown as they are, greyed, not to be touched */
.ed-off{opacity:.42;pointer-events:none}
.ed-bnote{color:var(--txt2,rgba(255,255,255,.6))}
.ed-note::before{content:"";position:absolute;left:14px;right:0;top:0;height:1px;background:var(--ed-line)}
.ed-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:1px;
        background:var(--ed-line-strong)}
.ed-dot.fire{background:${COL.firing}}
.ed-dot.ok{background:${COL.ok}}

/* the folds: content stays mounted and collapses, the height on a plain ease, the content
   on the spring */
.ed-disclose .ed-sub{flex:1 1 auto;min-width:0;text-align:right;font-size:var(--fs-meta,13px);font-weight:500;
                     color:var(--txt2,rgba(255,255,255,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-chev{flex:0 0 auto;width:22px;height:22px;opacity:.7;transition:transform .44s var(--ed-spring)}
.ed-chev svg{width:22px;height:22px}
.ed-chev.open{transform:rotate(180deg)}
.ed-fold{max-height:0;opacity:0;overflow:hidden;transition:max-height .36s var(--ed-ease),opacity .2s ease}
.ed-fold.open{max-height:420px;opacity:1}
.ed-fold-in{transform:translateY(-12px) scale(.96);opacity:0;transition:transform .44s var(--ed-spring),opacity .3s ease}
.ed-fold.open .ed-fold-in{transform:none;opacity:1}
.ed-said{flex:1 1 auto;min-width:0;font-size:14px;line-height:1.35;white-space:pre-line}
.ed-msgauto{align-items:flex-start;padding-top:12px;padding-bottom:12px}

.ed-error{margin-top:14px;padding:10px 14px;border-radius:12px;background:rgba(255,71,51,.16);
          box-shadow:inset 3px 0 0 var(--ed-red);font-size:14px;line-height:1.35}
.ed-error[hidden]{display:none}
.ed-error div + div{margin-top:4px}
/* pinned to the bottom of the sheet: Add never scrolls out of reach */
.ed-actions{position:sticky;bottom:0;z-index:1;display:flex;align-items:center;gap:8px;margin-top:16px;
            padding:10px 0 18px;background:var(--ed-panel);box-shadow:0 -10px 14px -6px var(--ed-panel)}
.ed-spacer{flex:1 1 auto}
.ed-btn{border:0;border-radius:11px;background:rgba(255,255,255,.1);color:var(--ed-fg);font-size:15px;font-weight:600;
        padding:11px 18px;min-height:46px;cursor:pointer;-webkit-tap-highlight-color:transparent;
        transition:background .15s ease,transform .14s var(--ed-spring)}
@media (hover:hover){.ed-btn:hover:not([disabled]){background:rgba(255,255,255,.16)}}
.ed-btn:active:not([disabled]){transform:scale(.96)}
.ed-btn[disabled]{opacity:.5;cursor:default}
.ed-btn.primary{background:var(--ed-sel);color:var(--ed-sel-fg);font-weight:700;min-width:88px}
/* Delete: red words; armed by the first tap, filled red - the second tap is the one-way one */
.ed-btn.danger{background:transparent;color:var(--ed-red);transition:background-color .22s ease,color .22s ease}
@media (hover:hover){.ed-btn.danger:hover:not(.armed){background:rgba(255,71,51,.12)}}
.ed-btn.danger.armed{background:var(--ed-red);color:#fff}
/* one line always: on a phone the bar is tighter, so "Tap again to delete" fits beside Cancel and Save */
.ed-btn{white-space:nowrap}
dialog.narrow .ed-btn{padding-left:12px;padding-right:12px}
dialog.narrow .ed-btn.primary{min-width:72px}
@media (hover:hover){.ed-btn.primary:hover:not([disabled]){background:rgba(255,255,255,.88)}}
dialog.red .wheel{padding:0 14px}
dialog.red .wheel-item{font-size:18px}

@media (max-width:700px){
  ha-card{--pad:13px;--gap:9px;--scrim-a:.68}
  .ms,.msbtn{max-width:none;width:100%}
  .search,.ms{flex:1 1 100%}
}
button:focus{outline:none}
button:focus-visible{outline:2px solid rgba(255,255,255,.35);outline-offset:2px}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition-duration:.01ms!important}}
`;

/* ---- the phone layout (layout: phone) -------------------------------------------------
   The Alerts card on an iPhone, chosen from three concepts (2026-10-09, "Inbox"): a large
   title over search and a filter menu, Active | All | History, the firing-over-time chart (a
   tap names the alerts behind a bar and lists exactly them, as on the tablet), one line per
   alert with swipe actions, History as a timeline, and an alert's or an event's detail in a
   bottom sheet that opens to fit its own part and rises to the full screen. Drawn in a shadow
   root of its own (the tablet's stylesheet would collide) from the card's data, timeline,
   chart model and actions; the rule editor is the card's. The header - back, Alerts | Health,
   + - is page-switcher-card's (ios: true). Sizes: names 17, what is said 15, headings 20/22. */

const PH_TEXT = { "Alert rule created": "Rule created", "Alert rule edited": "Rule edited",
  "Alert rule deleted": "Rule deleted", "Home Assistant restarted": "Restarted" };
const phEventOf = (e, row) => { const ev = eventOf(e, row); return PH_TEXT[ev.text] ? { ...ev, text: PH_TEXT[ev.text] } : ev; };
const PH_EVENT_ORDER = ["Rule created", "Rule edited", "Rule deleted", "Restarted", "Detected", "Cleared early",
  "Activated", "Added", "Removed", "Changed", "Notified", "Snoozed", "Snooze ended", "Cleared", "Acknowledged",
  "Reopened", "Unacknowledged", "Resolved", "Notifications off", "Notifications on", "Action ran", "Action failed"];
const PH_STATUS_TONE = { Firing: COL.firing, Snoozed: COL.snoozed, OK: COL.ok };
const PH_EASE = "cubic-bezier(.25,.8,.25,1)";
const PH_CAT_ICON = {
  health: "mdi:heart-pulse", system: "mdi:cog", general: "mdi:bell", garbage: "mdi:trash-can",
  calendar: "mdi:calendar", security: "mdi:shield-home", climate: "mdi:thermometer",
  energy: "mdi:flash", water: "mdi:water", doors: "mdi:door",
};
const PH_RANGE_WORDS = { "24h": "24 hours", "3d": "3 days", "7d": "7 days" };
const PH_ICON = {
  back: `<svg viewBox="0 0 24 24"><path d="M14.5 5l-7 7 7 7"/></svg>`,
  chev: `<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>`,
  down: `<svg viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>`,
  x: `<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  filter: `<svg viewBox="0 0 24 24"><path d="M4 7h16M7 12h10M10 17h4"/></svg>`,
};
const phCap = (s) => String(s).replace(/^./, (c) => c.toUpperCase());
// what an event is about, on one line
function phWhat(e) {
  if (e.message) return unescapeHtml(e.message).split("\n").map((x) => x.trim()).filter(Boolean).join(" · ");
  if (e.about?.length) return e.about.join(" · ");
  if (e.added?.length) return e.added.join(" · ");
  if (e.removed?.length) return e.removed.join(" · ");
  if (e.notifiers?.length) return notifiedText(e);
  if (e.user) return `by ${e.user}`;
  if (e.error) return e.error;
  return "";
}
// rows the iOS way: "now", "5m", "2h", "Yesterday", "Tue", "Oct 3"
function phRel(ms) {
  const d = Date.now() - ms, t = dayStart(Date.now());
  if (d < 60e3) return "now";
  if (d < HOUR) return `${Math.floor(d / 60e3)}m`;
  if (ms >= t) return `${Math.floor(d / HOUR)}h`;
  if (ms >= t - DAY) return "Yesterday";
  if (ms >= t - 6 * DAY) return new Date(ms).toLocaleDateString(LOCALE.lang, { weekday: "short" });
  return new Date(ms).toLocaleDateString(LOCALE.lang, { month: "short", day: "numeric" });
}
// a moment ahead, short, for a row's trailing side: "until 3:15 PM", "until Tomorrow",
// "until Sat", "until Oct 20"
function phUntil(ms) {
  const t = dayStart(Date.now());
  if (ms < t + DAY) return `until ${fmtTime(ms)}`;
  if (ms < t + 2 * DAY) return "until Tomorrow";
  if (ms < t + 7 * DAY) return `until ${new Date(ms).toLocaleDateString(LOCALE.lang, { weekday: "short" })}`;
  return `until ${new Date(ms).toLocaleDateString(LOCALE.lang, { month: "short", day: "numeric" })}`;
}
function phRelLong(ms) {
  const d = Date.now() - ms;
  if (d < 60e3) return "just now";
  if (d < HOUR) return `${Math.floor(d / 60e3)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  const days = Math.floor(d / DAY);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
function phDayTitle(ms) {
  const t = dayStart(Date.now());
  if (ms >= t) return "Today";
  if (ms >= t - DAY) return "Yesterday";
  if (ms >= t - 6 * DAY) return new Date(ms).toLocaleDateString(LOCALE.lang, { weekday: "long" });
  return new Date(ms).toLocaleDateString(LOCALE.lang, { weekday: "short", month: "short", day: "numeric" });
}
function phFor(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(h / 24)} days`;
}
const phTile = (r, size = "") => `<span class="tile ${size}" style="--c:${r.firing && !r.snoozeUntil ? PRIO[r.priority].tone : r.firing ? COL.snoozed : "#636366"}">
    <ha-icon icon="${PH_CAT_ICON[r.category] || "mdi:bell"}"></ha-icon></span>`;

/* iOS hands a drag that nothing in a sheet, menu or dialog can take - content that fits, the
   dimmed backdrop, a list already at its end - to the page behind it, which then scrolls. So a
   drag that starts in one of them moves only what inside it can still scroll that way, never
   the page. (Pointer gestures - the sheet's own drag, the time drum - are untouched.) */
function scrollsTo(el, dx, dy) {
  const cs = getComputedStyle(el);
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (!/auto|scroll/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1) return false;
    return dy > 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }
  if (!/auto|scroll/.test(cs.overflowX) || el.scrollWidth <= el.clientWidth + 1) return false;
  return dx > 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}
function holdPage(root) {
  let x = 0, y = 0;
  root.addEventListener("touchstart", (e) => { x = e.touches[0].clientX; y = e.touches[0].clientY; }, { passive: true });
  root.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0], dx = t.clientX - x, dy = t.clientY - y;
    x = t.clientX; y = t.clientY;
    for (const n of e.composedPath()) {
      if (n instanceof Element && scrollsTo(n, dx, dy)) return;
      if (n === root) break;
    }
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
}

class AlertPhoneView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "active";
    this._q = "";
    this._f = { status: new Set(), event: new Set(), prio: new Set(), cat: new Set() };
    this._pin = null;     // a chart pick: { ids, label } - every alert that fired in a slot
    this._sel = -1;       // the chart's slot named in the callout
    this._pages = [];     // the sheet's pages, a stack
  }

  set card(c) { this._card = c; this._phoneRange(); if (!this._built) this._build(); }

  /* banner_host: the hidden copy the banner opens an alert's popup in (AlertBanner) - only
     the sheet, its menus and toast; no page, and the address is not its business */
  get _host() { return !!this._card?._config?.banner_host; }
  connectedCallback() {
    this._onLoc ||= () => setTimeout(() => this.land(), 80);
    window.addEventListener("location-changed", this._onLoc);
    window.addEventListener("popstate", this._onLoc);
    this.land();
  }
  disconnectedCallback() {
    window.removeEventListener("location-changed", this._onLoc);
    window.removeEventListener("popstate", this._onLoc);
  }

  /* A push opens the alert here: ?alert=<entity id> (a tap) opens its popup, &snooze=1 (its
     "Snooze: Custom…" button) its snooze menu over it. Read once - the address forgets them -
     and only once this page is on screen (the page switcher may still be showing it). */
  land(tries = 25) {
    if (this._host || !this._built || !this._card?._data) return;
    const q = new URLSearchParams(location.search);
    const eid = q.get("alert");
    if (!eid) return;
    if (!this.getClientRects().length) { if (tries > 0) setTimeout(() => this.land(tries - 1), 120); return; }
    const snooze = q.get("snooze") === "1";
    q.delete("alert");
    q.delete("snooze");
    history.replaceState(history.state, "", `${location.pathname}${q.toString() ? `?${q}` : ""}${location.hash}`);
    if (!this._data.byId[eid]) { this._toast("That alert is gone"); return; }
    this._openAlert(eid);
    if (snooze) setTimeout(() => this._openMenu(eid), reduceMotion() ? 0 : 480);
  }
  get card() { return this._card; }
  get _data() { return this._card._data; }

  update() { if (this._built && this._card?._data) { this._render(); this.land(); } }
  // the phone offers 24H and 7D only
  _phoneRange() { if (this._card._range === "3d") this._card._range = "24h"; }
  chartChanged() { if (this._built && !this._host) this._paintChart(); }

  /* ---------------------------------------------------------------- frame */

  _build() {
    this._built = true;
    this.shadowRoot.innerHTML = `<style>${PHONE_STYLES}</style>
      <div class="app"${this._host ? " hidden" : ""}>
        <div class="hero"><h1>${escapeHtml(this._card._config.title || "Alerts")}</h1><div class="sub"></div></div>
        <div class="srow"><label class="search">${PH_ICON.search}<input type="search" placeholder="Search" autocomplete="off"></label>
          <button class="fbtn" data-fmenu aria-label="Filter">${PH_ICON.filter}<span class="fn" hidden></span></button></div>
        <div class="fx"></div>
        <div class="seg tseg" data-seg="tab"><span class="thumb"></span>
          <button class="on" data-v="active">Active</button><button data-v="all">All</button><button data-v="history">History</button></div>
        <div class="pane"><div class="chartbox"></div><div class="pinbox"></div><div class="list"></div></div>
      </div>
      <div class="scrim" hidden></div>
      <section class="sheet" hidden><div class="grabzone"><div class="grab"></div></div><div class="sbody"></div></section>
      <div class="pmenu" hidden></div>
      <section class="menu" hidden></section>
      <div class="toast" hidden></div>`;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._el = { sub: $(".sub"), q: $(".search input"), fbtn: $(".fbtn"), fx: $(".fx"), tseg: $(".tseg"),
                 pane: $(".pane"), chartbox: $(".chartbox"), pinbox: $(".pinbox"), list: $(".list"), scrim: $(".scrim"), sheet: $(".sheet"), sbody: $(".sbody"),
                 pmenu: $(".pmenu"), menu: $(".menu"), toast: $(".toast") };
    this.shadowRoot.addEventListener("click", (e) => this._click(e));
    this._el.q.addEventListener("input", () => { this._q = this._el.q.value; this._renderList(); });
    this._el.scrim.addEventListener("click", () => {
      if (!this._el.menu.hidden) { this._closeMenu(); return; }
      if (!this._el.pmenu.hidden) { this._closePmenu(); return; }
      this._closeSheet();
    });
    this._bindChart();
    this._bindSheetDrag();
    for (const k of ["scrim", "sheet", "pmenu", "menu"]) holdPage(this._el[k]);
    requestAnimationFrame(() => this._placeThumbs(false));
  }

  _click(e) {
    const t = e.target.closest("button, [data-open]");
    if (!t) { this._hideCallout(); return; }
    const d = t.dataset;
    const seg = t.closest("[data-seg]");
    if (seg && d.v) { this._segTo(seg, d.v); return; }
    if (d.fmenu != null) { this._openPmenu(t); return; }
    if (d.fk) { this._toggleFilter(d.fk, d.fv); return; }
    if (d.freset != null) { this._resetFilters(); return; }
    if (d.chipx) { const [k, v] = d.chipx.split("|"); this._toggleFilter(k, v); return; }
    if (d.unpin != null) { this._pin = null; this._sel = -1; this._hideCallout(); this._render(); return; }
    if (d.act) { e.stopPropagation(); this._act(d.act, d.eid, t); return; }
    if (d.snz) { this._snooze(this._menuEid, Number(d.snz)); return; }
    if (d.snzcustom != null) { this._toggleCustom(); return; }
    if (d.snzcancel != null) { this._closeMenu(); return; }
    if (d.close != null) { this._closeSheet(); return; }
    if (d.sback != null) { this._sheetPop(); return; }
    if (d.spush) { this._sheetPush({ type: d.spush, eid: d.eid }); return; }
    if (d.edit) { this._edit(d.edit); return; }
    if (d.evmore != null) { this._showMore(t); return; }
    if (d.ev) {
      const x = this._evIndex?.get(d.ev);
      if (!x) return;
      if (t.closest(".sheet")) { if (!t.classList.contains("cur")) this._sheetPush({ type: "event", x }); }
      else this._showSheet({ type: "event", x });
      return;
    }
    if (d.open) this._openAlert(d.open);
  }

  /* A segmented control: the white thumb slides to the value tapped. */
  _segTo(seg, v) {
    if (seg.dataset.seg === "tab") {
      if (v !== this._tab) this._tabTo(v);
      return;
    }
    if (seg.dataset.seg === "range") this._rangeTo(seg, v);
  }

  /* Another range: the pill slides; the count, its sentence and the bars slide out the way you
     go and fade, and the new range's come in from the other side once they have loaded (up to
     a moment) - the motion of every switch here. */
  async _rangeTo(seg, v) {
    const cur = this._card._range;
    if (v === cur) return;
    const dir = v === "7d" ? 1 : -1;
    this._placeThumb(seg, v, true);
    this._card._range = v;
    this._sel = -1;
    this._hideCallout();
    const parts = [...this._el.chartbox.querySelectorAll(".ctext, .cbody")];
    if (reduceMotion() || !parts.length) { this._card._loadOverview(); return; }
    const seq = (this._chartLeaving = (this._chartSeq = (this._chartSeq || 0) + 1));
    parts.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    await Promise.all([
      ...parts.map((el) => el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 48}px)` }],
        { duration: 170, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {})),
      Promise.race([this._card._loadOverview(), new Promise((ok) => setTimeout(ok, 1500))]),
    ]);
    if (seq !== this._chartSeq) return;
    this._chartLeaving = 0;
    parts.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    this._paintChart(dir);
  }

  /* Another tab: what shows slides out the way you go and fades, the tab's own content comes
     in from the other side and fades up - the Alerts | Health switch's motion. Repaints wait
     until the old content is gone. */
  async _tabTo(v) {
    const order = ["active", "all", "history"];
    const dir = order.indexOf(v) > order.indexOf(this._tab) ? 1 : -1;
    this._tab = v;
    this._pin = null;     // a chart pick belongs to the tab it opened (the tablet's rule)
    this._sel = -1;
    this._placeThumb(this._el.tseg, v, true);
    const pane = this._el.pane;
    if (reduceMotion()) { this._render(); return; }
    const seq = (this._leaving = (this._tabSeq = (this._tabSeq || 0) + 1));
    pane.getAnimations().forEach((a) => a.cancel());
    await pane.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 48}px)` }],
      { duration: 170, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
    if (seq !== this._tabSeq) return;
    this._leaving = 0;
    pane.getAnimations().forEach((a) => a.cancel());
    this._render();
    pane.animate([{ opacity: 0, transform: `translateX(${dir * 48}px)` }, { opacity: 1, transform: "none" }],
      { duration: 360, easing: IOS });
  }

  _placeThumbs(animate) {
    for (const seg of this.shadowRoot.querySelectorAll(".seg")) {
      const on = seg.querySelector("button.on") || seg.querySelector("button");
      if (on) this._placeThumb(seg, on.dataset.v, animate);
    }
  }
  _placeThumb(seg, v, animate) {
    const b = [...seg.querySelectorAll("button")].find((x) => x.dataset.v === v);
    const th = seg.querySelector(".thumb");
    if (!b || !th) return;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    // drawn while hidden (a view or page not shown yet): no size to take - the thumb waits
    // for the control to get one, or the picked label sits dark on nothing
    if (!b.offsetWidth) {
      this._segRo ||= new ResizeObserver((entries) => entries.forEach(({ target }) => {
        const on = target.querySelector("button.on");
        if (!on?.offsetWidth) return;
        this._segRo.unobserve(target);
        this._placeThumb(target, on.dataset.v, false);
      }));
      this._segRo.observe(seg);
      return;
    }
    th.style.transition = animate && !reduceMotion() ? `transform .34s ${IOS}, width .34s ${IOS}` : "none";
    th.style.width = `${b.offsetWidth}px`;
    th.style.transform = `translateX(${b.offsetLeft - (parseFloat(getComputedStyle(seg).paddingLeft) || 2)}px)`;
  }

  /* ---------------------------------------------------------------- render */

  _render(animate = false) {
    if (!this._data || this._leaving) return;
    this._el.sub.textContent = this._summaryLine();
    this._paintFilterBar();
    this._placeThumb(this._el.tseg, this._tab, false);
    this._el.chartbox.hidden = this._tab !== "active";
    this._renderList(animate);
    if (this._sheetOpen) this._paintSheet();
    if (!this._el.pmenu.hidden) this._paintPmenu();
  }

  _renderList(animate = false) {
    const list = this._el.list;
    list.innerHTML = this._listHtml();
    this._paintFilterBar();
    if (animate && !reduceMotion()) {
      list.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: PH_EASE });
    }
  }

  // by status (statusOf): a snoozed alert is Snoozed, firing or not
  _counts() {
    const rows = this._data.rows;
    const firing = rows.filter((r) => r.firing && !r.snoozeUntil);
    const snoozed = rows.filter((r) => r.snoozeUntil);
    return { rows, firing, snoozed };
  }

  _summaryLine() {
    const { rows, firing, snoozed } = this._counts();
    if (!firing.length && !snoozed.length) return `All clear · ${rows.length} rules watching`;
    return [firing.length && `${firing.length} firing`, snoozed.length && `${snoozed.length} snoozed`].filter(Boolean).join(" · ");
  }

  _history() {
    const out = [];
    this._evIndex = new Map();
    for (const [eid, entries] of Object.entries(this._card._timeline || {})) {
      const row = this._data.byId[eid];
      const was = [...entries].reverse().find((e) => e.name)?.name;
      for (const e of entries) {
        if (e.kind === "notified") continue;   // the same moment as its activation
        out.push(this._evItem(eid, e, row, was));
      }
    }
    for (const r of this._card._restarts || []) {
      out.push(this._evItem(null, { t: r.started, kind: "restart", stopped: r.stopped }, null, "Home Assistant"));
    }
    return out.filter((x) => Number.isFinite(x.t)).sort((a, b) => b.t - a.t);
  }

  // one event, with the key it is opened by
  _evItem(eid, e, row, was) {
    this._evIndex ||= new Map();
    const x = { eid, t: Date.parse(e.t), e, ev: phEventOf(e, row), name: row ? row.name : was || eid || "Home Assistant", row,
                what: e.kind === "restart" ? (e.stopped ? `down for ${phFor(Date.parse(e.t) - Date.parse(e.stopped))}` : "") : phWhat(e) };
    let key = `${eid || "ha"}|${e.t}|${e.kind}`;
    for (let n = 1; this._evIndex.has(key) && this._evIndex.get(key).e !== e; n++) key = `${eid || "ha"}|${e.t}|${e.kind}|${n}`;
    x.key = key;
    this._evIndex.set(key, x);
    return x;
  }

  _empty(icon, title, body, tone = COL.ok) {
    return `<div class="empty"><span class="eic" style="--c:${tone}">${icon}</span>
      <div class="et">${escapeHtml(title)}</div><div class="eb">${escapeHtml(body)}</div></div>`;
  }

  /* One line per alert: its tile, its name, and its time or status. What it says is in its
     detail - on a phone a second line is never long enough to read. No swipe actions (the
     user's call): Snooze and Clear are in the alert's sheet. */
  _row(r, trailing = null) {
    return `<button class="row" data-open="${escapeHtml(r.id)}">
        ${phTile(r)}<span class="t1">${escapeHtml(r.name)}</span>
        <span class="meta">${trailing ?? `<span class="time">${escapeHtml(r.since ? phRel(r.since) : "")}</span>`}${PH_ICON.chev}</span>
      </button>`;
  }
  _statusTrail(r) { const st = statusOf(r); return `<span class="stt" style="--c:${st.tone}">${st.text}</span>`; }

  _listHtml() {
    const { rows, firing, snoozed } = this._counts();
    if (this._tab === "history") return this._timelineView(this._history().filter((x) => this._passEvent(x)));
    if (this._tab === "active" && this._pin) {
      const picked = rows.filter((r) => this._passRow(r)).sort((a, b) => PRIO[prioKey(a.priority)].rank - PRIO[prioKey(b.priority)].rank || a.name.localeCompare(b.name));
      return picked.length ? `<div class="group pinned">${picked.map((r) => this._row(r, this._statusTrail(r))).join("")}</div>`
        : this._empty(PH_ICON.filter, "No Matches", "None of these alerts matches.", COL.quiet);
    }
    if (this._tab === "active") {
      const f = firing.filter((r) => this._passRow(r)), s = snoozed.filter((r) => this._passRow(r));
      if (!f.length && !s.length) {
        if (this._q || this._filtersOn()) return this._empty(PH_ICON.filter, "No Matches", "Nothing active matches.", COL.quiet);
        return this._empty(PH_ICON.check, "No Active Alerts", `Everything is OK. ${rows.length} rules are watching.`);
      }
      const order = (a, b) => (a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1);
      const sec = (title, list, tone) => list.length ? `<div class="sh" style="color:${tone}">${title}<span class="shn">${list.length}</span></div>
        <div class="group">${list.sort(order).map((r) => this._row(r, r.snoozeUntil
          ? `<span class="time">${escapeHtml(phUntil(r.snoozeUntil))}</span>` : null)).join("")}</div>` : "";
      return sec("Firing", f, COL.firing) + sec("Snoozed", s, COL.snoozed) + `<div class="foot">Swipe an alert left to snooze or clear it.</div>`;
    }
    const by = {};
    for (const r of rows.filter((x) => this._passRow(x))) (by[r.category] ||= []).push(r);
    const cats = Object.keys(by).sort();
    if (!cats.length) return this._empty(PH_ICON.filter, "No Matches", "No rule matches.", COL.quiet);
    return cats.map((c) => `<div class="sh">${escapeHtml(phCap(c))}<span class="shn">${by[c].length}</span></div>
      <div class="group">${by[c].map((r) => this._row(r, this._statusTrail(r))).join("")}</div>`).join("");
  }

  /* History: a timeline - a line down the left, a dot per event, by day. The name as big as
     an alert's, what happened at most two lines; a tap opens the event. */
  _timelineView(items) {
    if (!this._card._tlLoaded) return `<div class="loading">Loading…</div>`;
    if (!items.length) {
      return this._filtersOn() ? this._empty(PH_ICON.filter, "No Matches", "No event matches the filters.", COL.quiet)
        : this._empty(PH_ICON.check, "No History", "Nothing has happened in the last 10 days.", COL.quiet);
    }
    let html = "", day = null;
    for (const x of items.slice(0, 150)) {
      const d = phDayTitle(x.t);
      if (d !== day) { html += `${day ? "</div>" : ""}<div class="sh">${escapeHtml(d)}</div><div class="tline">`; day = d; }
      html += `<button class="tev" data-ev="${escapeHtml(x.key)}">
        <span class="tt">${escapeHtml(fmtTime(x.t))}</span><span class="tdot" style="--c:${x.ev.tone}"></span>
        <span class="tbody"><span class="t1">${escapeHtml(x.name)}</span>
          <span class="t2"><b style="color:${x.ev.tone === COL.quiet ? "inherit" : x.ev.tone}">${escapeHtml(x.ev.text)}</b>${x.what ? ` · ${escapeHtml(x.what)}` : ""}</span></span></button>`;
    }
    return html + (day ? "</div>" : "");
  }

  /* ================================================================ chart
     The tablet's "Firing over time": per slot, the alerts firing in it, a bar per priority.
     A finger on it names the alerts behind a slot (the tablet's tooltip); a tap also lists
     exactly them - All Alerts, with a chip to let go (the tablet's pick). */

  /* `dir`: drawn for another range - it comes in from that side (no bars growing). The card
     and its range pills stay; what is under them is drawn anew. */
  _paintChart(dir = 0) {
    if (this._chartLeaving) return;   // a range switch paints it once the old one is gone
    const box = this._el.chartbox;
    const c = this._card._chart;
    const range = this._card._range;
    let card = box.querySelector(".chart");
    if (!card) {
      box.innerHTML = `<div class="card chart"><div class="chd"><div class="ctext"></div>
        <div class="seg rseg" data-seg="range"><span class="thumb"></span>${RANGES.filter((r) => r.id !== "3d").map((r) =>
          `<button class="${r.id === range ? "on" : ""}" data-v="${r.id}">${r.label.toUpperCase()}</button>`).join("")}</div></div>
        <div class="cbody"></div><div class="callout" hidden></div></div>`;
      card = box.querySelector(".chart");
      this._placeThumbs(false);
    }
    const text = card.querySelector(".ctext"), body = card.querySelector(".cbody");
    if (!c) { text.innerHTML = `<div class="abig">–</div><div class="asub">Loading…</div>`; body.innerHTML = ""; return; }
    const { slots, series } = c;
    /* A scale on the left, two or three whole numbers: 0 1 (2) while a slot holds one or two
       alerts, else 0, half and the top - rounded up so both are whole. */
    const peak = Math.max(1, ...series.flatMap((s) => s.per.map((p) => p.v)));
    const step = peak <= 2 ? 1 : Math.ceil(peak / 2);
    const max = peak <= 2 ? peak : step * 2;
    const ticks = [];
    for (let v = 0; v <= max; v += step) ticks.push(v);
    const fired = new Set();
    series.forEach((s) => s.per.forEach((p) => p.ids.forEach((_, id) => fired.add(id))));
    const n = slots.length;
    // a slot where nothing fired: a short white stub at zero, a bar wide
    const bars = slots.map((sl, i) => `<span class="slot${i === this._sel ? " sel" : ""}" data-i="${i}">${series.every((s) => !s.per[i].v)
      ? `<i class="zero" style="--d:${i * 14}ms${dir ? ";animation:none" : ""}"></i>`
      : series.map((s, k) => {
        const v = s.per[i].v;
        return `<i data-k="${k}" style="--c:${s.color};--d:${i * 14}ms;height:${v ? Math.max(5, (v / max) * 100) : 0}%${dir ? ";animation:none" : ""}"></i>`;
      }).join("")}</span>`).join("");
    const hours = range === "24h";
    const labels = [0, Math.round(n / 3), Math.round((2 * n) / 3)].map((i) => {
      const a = slots[i]?.a;
      if (!a) return "";
      const label = hours ? new Date(a).toLocaleTimeString(LOCALE.lang, { hour: "numeric", hour12: LOCALE.hour12 })
        : new Date(a).toLocaleDateString(LOCALE.lang, { weekday: "short" });
      return `<span style="left:${(i / n) * 100}%">${escapeHtml(label)}</span>`;
    }).join("");
    const h0 = box.offsetHeight;
    card.classList.toggle("folded", !fired.size);
    text.innerHTML = `<div class="abig">${fired.size}</div><div class="asub">${fired.size === 1 ? "alert" : "alerts"} fired in ${PH_RANGE_WORDS[range] || range}</div>`;
    body.innerHTML = fired.size ? `<div class="plot">
        <div class="yax"><i>${max}</i>${ticks.map((v) => `<span style="bottom:${(v / max) * 100}%">${v}</span>`).join("")}</div>
        <div class="bars" style="--n:${n}">${ticks.slice(1).map((v) => `<b class="gl" style="bottom:${(v / max) * 100}%"></b>`).join("")}${bars}</div>
        <span></span><div class="axis">${labels}</div></div>` : "";
    // folding or unfolding (another range): the card eases to its new height
    const h1 = box.offsetHeight;
    if (h0 && h1 !== h0 && !box.hidden && !reduceMotion()) {
      box.animate([{ height: `${h0}px`, overflow: "hidden" }, { height: `${h1}px`, overflow: "hidden" }], { duration: 320, easing: IOS });
    }
    if (dir && !reduceMotion()) {
      for (const el of [text, body]) el.animate([{ opacity: 0, transform: `translateX(${dir * 48}px)` }, { opacity: 1, transform: "none" }], { duration: 360, easing: IOS });
    }
    if (this._sel >= 0 && this._sel < n) this._showCallout(this._sel); else this._sel = -1;
  }

  _slotAt(x) {
    const bars = this._el.chartbox.querySelector(".bars");
    const c = this._card._chart;
    if (!bars || !c) return -1;
    const r = bars.getBoundingClientRect();
    if (x < r.left || x > r.right) return -1;
    return Math.min(c.slots.length - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * c.slots.length)));
  }

  _bindChart() {
    const box = this._el.chartbox;
    box.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".bars")) return;
      this._press = { x: e.clientX, y: e.clientY, moved: false };
      const i = this._slotAt(e.clientX);
      if (i >= 0) this._showCallout(i);
    });
    box.addEventListener("pointermove", (e) => {
      if (!this._press) return;
      if (Math.hypot(e.clientX - this._press.x, e.clientY - this._press.y) > 10) this._press.moved = true;
      const i = this._slotAt(e.clientX);
      if (i >= 0 && i !== this._sel) this._showCallout(i);
    });
    const up = (e) => {
      const p = this._press;
      this._press = null;
      if (!p || p.moved || e.type === "pointercancel") return;
      this._pick(e);
    };
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
  }

  _showCallout(i) {
    const c = this._card._chart;
    const box = this._el.chartbox;
    const co = box.querySelector(".callout");
    if (!c || !co) return;
    // folded (nothing in the range) or not drawn yet: no slot to point at - the pick lets go
    if (!box.querySelector(`.slot[data-i="${i}"]`)) { this._sel = -1; co.hidden = true; return; }
    this._sel = i;
    box.querySelectorAll(".slot").forEach((s) => s.classList.toggle("sel", Number(s.dataset.i) === i));
    const sl = c.slots[i];
    const parts = c.series.map((s) => ({ s, p: s.per[i] })).filter((x) => x.p.v > 0)
      .map((x) => ({ ...x, names: [...x.p.ids.keys()].map((id) => this._data.byId[id]?.name || id).sort((a, b) => a.localeCompare(b)) }));
    const room = shareOut(parts.map((x) => x.names.length), 6);
    co.innerHTML = `<div class="cwhen">${escapeHtml(fmtSlot(sl.a, sl.b))}</div>` + (parts.length
      ? parts.map(({ s, p, names }, j) => `<div class="csec" style="--c:${s.color}"><div class="chd2"><i></i>${escapeHtml(s.name)}<b>${p.v}</b></div>
          ${names.slice(0, room[j]).map((nm) => `<div class="cname">${escapeHtml(nm)}</div>`).join("")}
          ${names.length > room[j] ? `<div class="cmore">and ${names.length - room[j]} more</div>` : ""}</div>`).join("")
      : `<div class="cnone">Nothing firing</div>`);
    const wasHidden = co.hidden;
    co.hidden = false;
    // over the chart, above its slot; never past the card's edges
    const card = box.querySelector(".chart").getBoundingClientRect();
    const slot = box.querySelector(`.slot[data-i="${i}"]`).getBoundingClientRect();
    const w = co.offsetWidth;
    const left = Math.max(8, Math.min(card.width - w - 8, slot.left - card.left + slot.width / 2 - w / 2));
    co.style.transform = `translateX(${Math.round(left)}px)`;
    if (wasHidden && !reduceMotion()) co.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
  }
  _hideCallout() {
    const co = this._el?.chartbox.querySelector(".callout");
    if (!co || co.hidden) return;
    co.hidden = true;
    if (!this._pin) { this._sel = -1; this._el.chartbox.querySelectorAll(".slot.sel").forEach((s) => s.classList.remove("sel")); }
    // a finger that wandered off the picked slot: the highlight goes back to it
    else if (this._pin.i != null) {
      this._sel = this._pin.i;
      this._el.chartbox.querySelectorAll(".slot").forEach((s) => s.classList.toggle("sel", Number(s.dataset.i) === this._sel));
    }
  }

  /* A tap on a slot: every alert that fired in it, both priorities, listed under the chart;
     other filters let go. */
  _pick(e) {
    const c = this._card._chart;
    const i = this._slotAt(e.clientX);
    if (!c || i < 0) return;
    const ids = new Set(c.series.flatMap((s) => [...s.per[i].ids.keys()]));
    if (!ids.size) return;
    const sl = c.slots[i];
    for (const set of Object.values(this._f)) set.clear();
    this._q = ""; this._el.q.value = "";
    this._pin = { ids, label: fmtSlot(sl.a, sl.b), i };
    this._render(true);
    this._showCallout(i);
  }

  /* ================================================================ filters
     The tablet's two menus - status (event, in History) with priority, and category - as one
     pull-down by the search field; what is picked shows as chips that let go. */

  _hist() { return this._tab === "history"; }
  _filtersOn() { return this._filterCount() > 0; }
  _filterCount() {
    const f = this._f;
    return (this._hist() ? f.event.size : f.status.size) + f.prio.size + f.cat.size;
  }
  _passRow(r) {
    const f = this._f;
    if (this._pin && !this._pin.ids.has(r.id)) return false;
    if (f.status.size && !f.status.has(statusOf(r).text)) return false;
    if (f.prio.size && !f.prio.has(PRIO[r.priority].label)) return false;
    if (f.cat.size && !f.cat.has(phCap(r.category))) return false;
    const q = this._q.trim().toLowerCase();
    return !q || `${r.name} ${r.message} ${r.category}`.toLowerCase().includes(q);
  }
  _passEvent(x) {
    const f = this._f;
    if (f.event.size && !f.event.has(x.ev.text)) return false;
    if (f.prio.size && !(x.row && f.prio.has(PRIO[x.row.priority].label))) return false;
    if (f.cat.size && !(x.row && f.cat.has(phCap(x.row.category)))) return false;
    const q = this._q.trim().toLowerCase();
    return !q || `${x.name} ${x.what} ${x.ev.text}`.toLowerCase().includes(q);
  }
  // the groups the menu offers here, with how many of what is shown carry each value
  _filterGroups() {
    const hist = this._hist();
    const base = hist ? this._history() : this._tab === "all" ? this._data.rows : this._data.rows.filter((r) => r.firing);
    const count = (fn) => { const n = {}; for (const x of base) { const k = fn(x); if (k) n[k] = (n[k] || 0) + 1; } return n; };
    const groups = [];
    if (hist) {
      const n = count((x) => x.ev.text);
      const tone = {}; for (const x of base) tone[x.ev.text] = x.ev.tone;
      const rank = (v) => (PH_EVENT_ORDER.indexOf(v) + 1) || 99;
      groups.push({ key: "event", title: "Event", values: Object.keys(n).sort((a, b) => rank(a) - rank(b)).map((v) => ({ v, tone: tone[v], n: n[v] })) });
    } else {
      const n = count((r) => statusOf(r).text);
      groups.push({ key: "status", title: "Status", values: (this._tab === "all" ? ["Firing", "Snoozed", "OK"] : ["Firing", "Snoozed"])
        .map((v) => ({ v, tone: PH_STATUS_TONE[v], n: n[v] || 0 })) });
    }
    const np = count((x) => { const r = hist ? x.row : x; return r ? PRIO[r.priority].label : null; });
    groups.push({ key: "prio", title: "Priority", values: PRIO_IDS.map((p) => ({ v: PRIO[p].label, tone: PRIO[p].tone, n: np[PRIO[p].label] || 0 })) });
    const nc = count((x) => { const r = hist ? x.row : x; return r ? phCap(r.category) : null; });
    const cats = [...new Set(this._data.rows.map((r) => phCap(r.category)))].sort();
    groups.push({ key: "cat", title: "Category", values: cats.map((v) => ({ v, n: nc[v] || 0 })) });
    return groups;
  }
  _toggleFilter(k, v) { const set = this._f[k]; set.has(v) ? set.delete(v) : set.add(v); this._render(); }
  _resetFilters() { for (const s of Object.values(this._f)) s.clear(); this._pin = null; this._render(); }
  _paintFilterBar() {
    const f = this._f, hist = this._hist();
    const picked = [...(hist ? [...f.event].map((v) => ["event", v]) : [...f.status].map((v) => ["status", v])),
                    ...[...f.prio].map((v) => ["prio", v]), ...[...f.cat].map((v) => ["cat", v])];
    // red whatever fired: it only warns that the list shows a stretch of time
    const pin = this._pin && this._tab === "active" ? `<button class="pinchip" data-unpin style="--c:${COL.firing}"><span class="cdot"></span><span class="clab">${escapeHtml(this._pin.label)}</span><span class="px">${PH_ICON.x}</span></button>` : "";
    if (this._el.pinbox._html !== pin) { this._el.pinbox._html = pin; this._el.pinbox.innerHTML = pin; }
    const html = picked.length ? `<div class="chips">${picked.map(([k, v]) =>
      `<button class="chip" data-chipx="${k}|${escapeHtml(v)}"><span class="clab">${escapeHtml(v)}</span>${PH_ICON.x}</button>`).join("")}</div>` : "";
    if (this._el.fx._html !== html) { this._el.fx._html = html; this._el.fx.innerHTML = html; }
    const n = this._filterCount();
    this._el.fbtn.classList.toggle("on", n > 0);
    const fn = this._el.fbtn.querySelector(".fn");
    fn.hidden = !n; fn.textContent = n;
  }

  _openPmenu(anchor) {
    const m = this._el.pmenu;
    m.hidden = false;
    this._paintPmenu();
    const b = anchor.getBoundingClientRect();
    const mw = Math.min(290, window.innerWidth - 24);
    const left = Math.min(window.innerWidth - mw - 12, Math.max(12, b.right - mw));
    m.style.width = `${mw}px`;
    m.style.left = `${left}px`;
    m.style.top = `${b.bottom + 8}px`;
    m.style.maxHeight = `${window.innerHeight - b.bottom - 24}px`;
    m.style.transformOrigin = `${b.left + b.width / 2 - left}px 0`;
    this._el.scrim.hidden = false;
    this._el.scrim.classList.add("clear");
    if (!reduceMotion()) m.animate([{ opacity: 0, transform: "scale(.5)" }, { opacity: 1, transform: "none" }], { duration: 340, easing: IOS });
  }
  _paintPmenu() {
    const m = this._el.pmenu;
    const st = m.scrollTop;
    m.innerHTML = this._filterGroups().map((g) => `<div class="mgh">${escapeHtml(g.title)}</div>` + g.values.map((x) => {
      const on = this._f[g.key].has(x.v);
      return `<button class="mrow${on ? " on" : ""}" data-fk="${g.key}" data-fv="${escapeHtml(x.v)}">
        <span class="mck">${on ? PH_ICON.check : ""}</span>${x.tone ? `<span class="mdot" style="--c:${x.tone}"></span>` : ""}
        <span class="mlab">${escapeHtml(x.v)}</span><span class="mn">${x.n}</span></button>`;
    }).join("")).join("") + (this._filtersOn() ? `<button class="mreset" data-freset>Reset Filters</button>` : "");
    m.scrollTop = st;
  }
  _closePmenu() {
    const m = this._el.pmenu;
    if (m.hidden) return;
    this._el.scrim.classList.remove("clear");
    if (!this._sheetOpen) this._el.scrim.hidden = true;
    if (reduceMotion()) { m.hidden = true; return; }
    m.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.85)" }], { duration: 180, easing: "ease-in" })
      .finished.then(() => { m.hidden = true; });
  }

  /* ================================================================ detail sheet
     A stack of pages: an alert (its actions, then notifications, its timeline, its rule's
     details and its editor behind rows), an event (all it says, then its alert and the
     alert's whole timeline), an alert's timeline, a rule's details. Opens just tall enough
     for the page's own part; scrolling raises it to the full screen and goes on into it. */

  _openAlert(eid) { if (this._data.byId[eid]) this._showSheet({ type: "alert", eid }); }
  _showSheet(page) {
    this._pages = [page];
    this._sheetOpen = true;
    const { sheet, scrim } = this._el;
    sheet.hidden = false; scrim.hidden = false;
    sheet.style.height = `${this._sheetH()}px`;
    this._paintSheet(true);
    this._detent = "medium";
    this._setSheet(this._y("medium"), false, true);
    if (!reduceMotion()) scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "linear" });
  }
  _sheetPush(page) {
    this._pages.push(page);
    if (this._detent !== "large") this._toDetent("large");
    this._slideSheet(1);
  }
  _sheetPop() { if (this._pages.length > 1) { this._pages.pop(); this._slideSheet(-1); } }
  _slideSheet(dir) {
    const b = this._el.sbody;
    if (reduceMotion()) { this._paintSheet(true); return; }
    b.getAnimations().forEach((a) => a.cancel());
    b.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-dir * 24}%)`, opacity: 0 }],
      { duration: 150, easing: "cubic-bezier(.4,0,1,1)" }).finished.then(() => {
      this._paintSheet(true);
      b.animate([{ transform: `translateX(${dir * 40}%)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 380, easing: IOS });
    }, () => {});
  }

  _paintSheet(fresh = false) {
    const p = this._pages[this._pages.length - 1];
    if (!p) return;
    const b = this._el.sbody;
    const scroll = fresh ? 0 : b.scrollTop;
    let html;
    if (p.type === "event") html = this._eventPage(p.x, p);
    else {
      const r = this._data.byId[p.eid];
      if (!r) { this._closeSheet(); return; }
      html = p.type === "alert" ? this._alertPage(r) : p.type === "timeline" ? this._timelinePage(r) : this._detailsPage(r);
    }
    b.innerHTML = html;
    b.scrollTop = scroll;
    const txt = b.querySelector(".evtext.clamp");
    if (txt && txt.scrollHeight > txt.clientHeight + 2) b.querySelector(".evmore").hidden = false;
  }

  _backBtn() { return this._pages.length > 1 ? `<button class="glass sback" data-sback aria-label="Back">${PH_ICON.back}</button>` : ""; }
  _closeBtn() { return `<button class="glass sclose" data-close aria-label="Close">${PH_ICON.x}</button>`; }
  // a page's heading under a row of its own for back and close, as in an iOS sheet
  _head(icon, title, sub) {
    return `<div class="sbar2">${this._backBtn() || "<span></span>"}${this._closeBtn()}</div>
      <div class="shead">${icon}<div class="shtxt"><div class="sht1">${escapeHtml(title)}</div>${sub}</div></div>`;
  }
  // a pushed list page: back and close in their row, the heading under them - set as the
  // event page's Timeline, so both timelines read alike
  _listHead(title, sub = "") {
    return `<div class="sbar2">${this._backBtn() || "<span></span>"}${this._closeBtn()}</div>
      <div class="ph1">${escapeHtml(title)}</div>${sub ? `<div class="ph2">${escapeHtml(sub)}</div>` : ""}`;
  }
  _fact(k, v) { return v ? `<div class="frow2"><span class="fk">${escapeHtml(k)}</span><span class="fv">${escapeHtml(v)}</span></div>` : ""; }
  _navRow(attrs, icon, label, value = "", trail = PH_ICON.chev) {
    return `<button class="nrow" ${attrs}><span class="tile sm" style="--c:#636366"><ha-icon icon="${icon}"></ha-icon></span>
      <span class="nlab">${escapeHtml(label)}</span>${value ? `<span class="nval">${escapeHtml(value)}</span>` : ""}${trail}</button>`;
  }
  _alertEvents(r) {
    return [...(this._card._timeline?.[r.id] || [])].reverse().map((e) => this._evItem(r.id, e, r, r.name));
  }

  /* An alert: what it is and says now, and what can be done - as the tablet's buttons: Clear
     while it fires (where the rule allows it) and Snooze always (a flood of alerts is often
     known in advance), then Edit and Link (when it has them); its timeline and rule details
     behind rows. */
  _alertPage(r) {
    const st = statusOf(r);
    const msg = r.firing ? (r.message || r.description) : (r.description || r.message);
    const n = this._alertEvents(r).length;
    const link = this._card._linkFor(r);
    const editable = this._card._uiIds?.has(r.id);
    const id = escapeHtml(r.id);
    // a row of buttons each: what is done about it firing, then the rule's own. Snooze is
    // always there; with the alert's notifications switched off (Alert2's notification_control,
    // as a snooze without an end), the way back on is in its place, as on the tablet
    // snoozed: until when, on the selection white - as the tablet's button; it opens the menu
    // with End Snooze
    const quiet = r.notificationsOff
      ? `<button class="big" data-act="enable" data-eid="${id}">Notifications on</button>`
      : r.snoozeUntil
        ? `<button class="big snzd" data-act="snoozeMenu" data-eid="${id}">Snoozed until ${escapeHtml(fmtUntil(r.snoozeUntil))}</button>`
        : `<button class="big" data-act="snoozeMenu" data-eid="${id}">Snooze</button>`;
    const acts = [
      // Clear like any other button: white is kept for what is ON (Snoozed until …)
      (r.firing && r.allowClear ? `<button class="big" data-act="clear" data-eid="${id}">Clear</button>` : "") + quiet,
      (editable ? `<button class="big" data-edit="${id}">Edit</button>` : "") +
      (link ? `<button class="big" data-act="open" data-eid="${id}">Link</button>` : ""),
    ].filter(Boolean);
    return `${this._head(phTile(r, "lg"), r.name, `<div class="sht2">${escapeHtml(phCap(r.category))} · ${escapeHtml(PRIO[r.priority].label)} priority</div>`)}
      <div class="sstat" style="--c:${st.tone}"><span class="sdot"></span>${escapeHtml(st.text)}${r.since && r.firing ? ` · for ${escapeHtml(phFor(Date.now() - r.since))}` : r.okSince && !r.snoozeUntil ? ` · since ${escapeHtml(phRelLong(r.okSince))}` : ""}</div>
      ${msg ? `<div class="smsg">${escapeHtml(msg)}</div>` : ""}
      ${acts.map((a) => `<div class="sacts">${a}</div>`).join("")}
      <div class="group navs">
        ${this._navRow(`data-spush="timeline" data-eid="${id}"`, "mdi:timeline-clock-outline", "Timeline", n ? `${n} event${n === 1 ? "" : "s"}` : "")}
        ${this._navRow(`data-spush="details" data-eid="${id}"`, "mdi:information-outline", "Rule Details")}
      </div>`;
  }

  /* An event: what happened and when under the alert's name, the alert right below, all of
     what the event says (six lines, then Show more) and its own facts; then the alert's
     whole timeline, this event marked in it - below the opening height, for who wants it. */
  _eventPage(x, page) {
    const r = x.row && this._data.byId[x.row.id], e = x.e;
    const icon = x.row ? phTile(x.row, "lg") : `<span class="tile lg" style="--c:#636366"><ha-icon icon="mdi:home-assistant"></ha-icon></span>`;
    const parts = [];
    if (e.message) parts.push(unescapeHtml(e.message));
    if (e.about?.length) parts.push(e.about.join("\n"));
    if (e.added?.length) parts.push(`Added\n${e.added.join("\n")}`);
    if (e.removed?.length) parts.push(`Removed\n${e.removed.join("\n")}`);
    if (e.error) parts.push(e.error);
    const snoozed = e.kind === "notification_control" && e.snooze_until && Date.parse(e.snooze_until) > x.t + 5000;
    const facts = [
      this._fact("By", e.user),
      this._fact("Notified", e.notifiers?.length ? notifiedText(e) : ""),
      this._fact("Waiting", e.delay_secs ? phFor(e.delay_secs * 1000) : ""),
      snoozed ? this._fact("Snoozed until", fmtDT(Date.parse(e.snooze_until))) : "",
      e.kind === "action" ? this._fact("Result", e.ok === false ? "Failed" : "Ran") : "",
      e.kind === "restart" && e.stopped ? this._fact("Stopped", fmtDT(Date.parse(e.stopped))) + this._fact("Down for", phFor(x.t - Date.parse(e.stopped))) : "",
    ].join("");
    const fromAlert = this._pages.some((p) => p.type === "alert" && p.eid === r?.id);
    return `${this._head(icon, x.name, `<div class="sht2 evk" style="--c:${x.ev.tone}"><span class="sdot"></span>${escapeHtml(x.ev.text)}<span class="evt">· ${escapeHtml(fmtDT(x.t))}</span></div>`)}
      ${r && !fromAlert ? `<div class="group navs top">${this._navRow(`data-spush="alert" data-eid="${escapeHtml(r.id)}"`, PH_CAT_ICON[r.category] || "mdi:bell", "Alert", statusOf(r).text)}</div>` : ""}
      ${parts.length ? `<div class="group evcard"><div class="evtext${page?.more ? "" : " clamp"}">${escapeHtml(parts.join("\n\n"))}</div>
        <button class="evmore" data-evmore hidden>Show more${PH_ICON.down}</button></div>` : ""}
      ${facts ? `<div class="group facts">${facts}</div>` : ""}
      ${r ? `<div class="tlh">Timeline</div><div class="tlsub">Every event of ${escapeHtml(r.name)}, newest first</div>${this._tlList(r, x)}` : ""}`;
  }

  // an alert's events as a timeline; `cur`: the event being looked at, marked white
  _tlList(r, cur = null) {
    const items = this._alertEvents(r);
    if (!items.length) return `<div class="foot">${this._card._tlLoaded ? "Nothing in the last 10 days." : "Loading…"}</div>`;
    return `<div class="tline">${items.map((x) => `<button class="tev${cur && x.key === cur.key ? " cur" : ""}" data-ev="${escapeHtml(x.key)}">
        <span class="tt">${escapeHtml(fmtTime(x.t))}${phDayTitle(x.t) === "Today" ? "" : `<br><small>${escapeHtml(phDayTitle(x.t))}</small>`}</span>
        <span class="tdot" style="--c:${x.ev.tone}"></span><span class="tbody"><span class="t1">${escapeHtml(x.ev.text)}</span>${x.what ? `<span class="t2">${escapeHtml(x.what)}</span>` : ""}</span></button>`).join("")}</div>`;
  }

  _timelinePage(r) { return `${this._listHead("Timeline", `Every event of ${r.name}, newest first`)}${this._tlList(r)}`; }

  // the rule itself
  _detailsPage(r) {
    return `${this._listHead("Rule Details", r.name)}
      <div class="group facts">
        ${this._fact("Status", statusOf(r).text)}${this._fact("Priority", PRIO[r.priority].label)}${this._fact("Category", phCap(r.category))}
        ${this._fact(r.firing ? "Firing since" : "Last change", r.firing ? (r.since ? fmtDT(r.since) : "") : r.okSince ? fmtDT(r.okSince) : "")}
        ${r.snoozeUntil ? this._fact("Snoozed until", fmtDT(r.snoozeUntil)) : ""}
        ${this._fact("Notifications", r.notificationsOff ? "Off" : "")}
        ${this._fact("Clearing", r.allowClear ? "Can be cleared" : "OK once the condition ends")}
        ${this._fact("Entity", r.id)}
      </div>
      ${r.description ? `<div class="sh">About</div><div class="smsg">${escapeHtml(r.description)}</div>` : ""}`;
  }

  _showMore(btn) {
    const page = this._pages[this._pages.length - 1];
    page.more = true;
    const txt = this._el.sbody.querySelector(".evtext");
    const h0 = txt.offsetHeight;
    txt.classList.remove("clamp");
    btn.hidden = true;
    if (!reduceMotion()) txt.animate([{ height: `${h0}px`, overflow: "hidden" }, { height: `${txt.offsetHeight}px`, overflow: "hidden" }], { duration: 320, easing: IOS });
    if (this._detent !== "large") this._toDetent("large");
  }

  // raised all the way, the sheet takes the whole screen - up to the status bar on an iPhone
  _sheetH() { return Math.round(window.innerHeight - this._safeTop()); }
  _safeTop() {
    if (this._safeT == null) {
      const p = document.createElement("div");
      p.style.cssText = "position:fixed;top:0;height:0;padding-top:env(safe-area-inset-top);visibility:hidden;pointer-events:none";
      this.shadowRoot.appendChild(p);
      this._safeT = p.offsetHeight;
      p.remove();
    }
    return this._safeT;
  }
  _y(detent) {
    const h = this._sheetH();
    if (detent === "large") return 0;
    if (detent === "closed") return h + 20;
    return Math.round(h - this._fitH());
  }
  /* How tall the sheet opens: its grabber and the page down to where the timeline starts
     (or its end) - at most 88% of the screen. */
  _fitH() {
    const b = this._el.sbody;
    const stop = b.querySelector(".tlh");
    const last = stop ? stop.previousElementSibling : b.lastElementChild;
    const grab = this._el.sheet.querySelector(".grabzone")?.offsetHeight || 17;
    const content = last ? last.offsetTop + last.offsetHeight + 26 : b.scrollHeight;
    return Math.min(window.innerHeight * 0.88, Math.max(160, grab + content));
  }
  _curY() { return new DOMMatrixReadOnly(getComputedStyle(this._el.sheet).transform).m42; }
  _setSheet(y, animate, from) {
    const s = this._el.sheet;
    s.style.height = `${this._sheetH()}px`;
    s.getAnimations().forEach((a) => a.cancel());
    if (from && !reduceMotion()) {
      s.animate([{ transform: `translateY(${this._y("closed")}px)` }, { transform: `translateY(${y}px)` }], { duration: 520, easing: IOS });
    } else if (animate && !reduceMotion()) {
      s.animate([{ transform: `translateY(${this._lastY ?? y}px)` }, { transform: `translateY(${y}px)` }], { duration: 440, easing: IOS });
    }
    s.style.transform = `translateY(${y}px)`;
    this._lastY = y;
    const large = y === 0;
    this._el.sbody.style.overflowY = large ? "auto" : "hidden";
    this._el.sbody.style.touchAction = large ? "pan-y" : "none";
  }
  _toDetent(d) { this._detent = d; this._setSheet(this._y(d), true); }
  _closeSheet() {
    const { sheet, scrim } = this._el;
    if (sheet.hidden) return;
    this._sheetOpen = false;
    this._closeMenu();
    if (reduceMotion()) { sheet.hidden = true; scrim.hidden = true; return; }
    const cur = this._lastY ?? this._curY();
    sheet.getAnimations().forEach((a) => a.cancel());
    sheet.animate([{ transform: `translateY(${cur}px)` }, { transform: `translateY(${this._y("closed")}px)` }], { duration: 340, easing: IOS })
      .finished.then(() => { if (!this._sheetOpen) sheet.hidden = true; });
    sheet.style.transform = `translateY(${this._y("closed")}px)`;
    this._lastY = null;
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "linear" }).finished.then(() => { if (!this._sheetOpen) scrim.hidden = true; });
  }

  _bindSheetDrag() {
    const s = this._el.sheet, body = this._el.sbody;
    let drag = false, y0 = 0, start = 0, last = 0, lastT = 0, v = 0, y = 0, scrolled = 0;
    s.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, input, a")) return;
      const head = e.target.closest(".grabzone, .shead, .sbar2");
      // at the full height its content scrolls by itself; the top part still moves it
      if (!head && this._detent === "large") return;
      drag = true; y0 = e.clientY; last = e.clientY; lastT = performance.now(); v = 0; scrolled = 0;
      start = this._lastY ?? this._curY(); y = start;
      s.getAnimations().forEach((a) => a.cancel());
      s.style.transform = `translateY(${start}px)`;
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const now = performance.now();
      v = (e.clientY - last) / Math.max(1, now - lastT); last = e.clientY; lastT = now;
      y = start + (e.clientY - y0);
      if (y < 0) {
        // raised all the way: the rest of the drag scrolls its content on
        body.style.overflowY = "auto";
        scrolled = -y;
        body.scrollTop = scrolled;
        y = 0;
      }
      s.style.transform = `translateY(${y}px)`;
      this._lastY = y;
    });
    const end = () => {
      if (!drag) return;
      drag = false;
      const from = this._detent;
      const moved = y - start;
      if (scrolled > 0 || (from === "medium" && (moved < -24 || v < -0.25))) { this._toDetent("large"); return; }
      if (from === "medium" && (moved > 110 || v > 0.6)) { this._closeSheet(); return; }
      if (from === "large" && (moved > this._y("medium") * 0.5 || v > 0.6)) {
        if (moved > this._y("medium") + 80 || v > 1.4) this._closeSheet(); else this._toDetent("medium");
        return;
      }
      this._toDetent(from);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    s.addEventListener("wheel", (e) => {
      if (this._detent === "medium" && e.deltaY > 2) { e.preventDefault(); this._toDetent("large"); }
    }, { passive: false });
  }

  /* ================================================================ actions (the card's) */

  async _act(act, eid) {
    const r = this._data.byId[eid];
    if (!r) return;
    if (act === "snoozeMenu") { this._openMenu(eid); return; }
    if (act === "open") {
      const link = this._card._linkFor(r);
      if (!link) return;
      this._closeSheet();
      this._card._navigate(link);
      return;
    }
    if (act === "clear") {
      await this._card._action("ack", eid);
      this._toast(`${r.name} cleared`);
    }
    if (act === "enable") {
      await this._card._action("enable", eid);
      this._toast(`Notifications on for ${r.name}`);
    }
  }

  _edit(eid) {
    this._closeSheet();
    this._card._editor?.edit(eid, this._card._uiIds?.get(eid));
  }

  // the editor saved a new rule, or a change to one: its sheet, showing it
  showAlert(eid, tries = 15) {
    if (this._data?.byId[eid]) {
      if (this._sheetOpen && this._pages[0]?.eid === eid) { this._paintSheet(); return; }
      this._openAlert(eid);
    } else if (tries > 0) setTimeout(() => this.showAlert(eid, tries - 1), 200);
  }
  afterDelete(eid) {
    if (this._sheetOpen && this._pages.some((p) => p.eid === eid)) this._closeSheet();
    this._render();
  }

  /* Snooze: the Alerts card's lengths as an iOS action sheet - End Snooze while snoozed,
     Tomorrow Morning, One Week, Custom - and Cancel apart below. Custom is the tablet's
     picker (SnoozePicker): a typed length, a calendar, a time chip and its drum. */
  _openMenu(eid) {
    const r = this._data.byId[eid];
    this._menuEid = eid;
    const m = this._el.menu;
    const now = Date.now();
    m.innerHTML = `<div class="asheet">
        <div class="ah">Snooze notifications<div class="ahs">${escapeHtml(r?.name || "")}</div></div>
        ${r?.snoozeUntil ? `<button class="arow end" data-snz="0"><span>End Snooze</span><span class="aval">until ${escapeHtml(fmtDT(r.snoozeUntil))}</span></button>` : ""}
        ${snoozePresets(now).map((p) => `<button class="arow" data-snz="${p.t}"><span>${p.label}</span><span class="aval">${escapeHtml(fmtDT(p.t))}</span></button>`).join("")}
        <button class="arow" data-snzcustom><span>Custom</span><span class="aval cval"></span>${PH_ICON.down}</button>
        <div class="cust" hidden>
          <input class="stext" type="text" autocomplete="off" spellcheck="false" enterkeyhint="done"
            placeholder="Type a length: 90m, 3h, 2d, 1w" aria-label="Snooze length">
          <div class="scal"></div>
          <div class="stime"><span>Time</span><button class="tchip" aria-expanded="false"><span class="tcin"></span></button></div>
          <div class="sdrum" hidden></div>
          <div class="sprev"></div>
          <button class="sgo" disabled>Snooze</button>
        </div>
      </div>
      <button class="acancel" data-snzcancel>Cancel</button>`;
    const q = (sel) => m.querySelector(sel);
    const sheet = q(".asheet"), cust = q(".cust");
    this._picker = new SnoozePicker(
      { text: q(".stext"), cal: q(".scal"), chip: q(".tchip"), drum: q(".sdrum"), preview: q(".sprev"), go: q(".sgo") },
      { go: (t) => this._snooze(eid, t),
        value: (v) => swapText(q(".cval"), cust.hidden ? "" : v),
        drum: () => {},
        scroller: () => sheet });
    this._picker.reset();
    m.hidden = false;
    this._el.scrim.hidden = false;
    if (!reduceMotion()) m.animate([{ transform: "translateY(110%)" }, { transform: "none" }], { duration: 460, easing: IOS });
  }
  /* Custom opens under the list, the sheet making room as it goes, and the sheet scrolls it
     into view; no field takes the focus - a keyboard would cover the calendar. */
  _toggleCustom() {
    const m = this._el.menu;
    const c = m.querySelector(".cust"), sheet = m.querySelector(".asheet");
    const row = m.querySelector("[data-snzcustom]");
    const open = c.hidden;
    row.classList.toggle("open", open);
    c.getAnimations().forEach((a) => a.cancel());
    if (open) {
      c.hidden = false;
      this._picker.preview();
      if (reduceMotion()) return;
      c.animate([{ height: "0px", opacity: 0 }, { height: `${c.offsetHeight}px`, opacity: 1 }], { duration: 420, easing: IOS });
      setTimeout(() => sheet.scrollTo({ top: sheet.scrollTop + row.getBoundingClientRect().top - sheet.getBoundingClientRect().top,
                                        behavior: "smooth" }), 80);
      return;
    }
    const shut = () => { c.hidden = true; swapText(m.querySelector(".cval"), ""); };
    if (reduceMotion()) { shut(); return; }
    c.animate([{ height: `${c.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 300, easing: IOS }).onfinish = shut;
  }
  _closeMenu() {
    const m = this._el.menu;
    if (m.hidden) return;
    const done = () => { m.hidden = true; if (!this._sheetOpen) this._el.scrim.hidden = true; };
    if (reduceMotion()) { done(); return; }
    m.animate([{ transform: "none" }, { transform: "translateY(110%)" }], { duration: 300, easing: IOS }).finished.then(done);
  }

  // until 0: End Snooze (notifications back on at once - the card's "enable")
  async _snooze(eid, until) {
    const r = this._data.byId[eid];
    this._closeMenu();
    if (!until) {
      await this._card._action("enable", eid);
      if (r) this._toast(`${r.name}: snooze ended`);
      return;
    }
    await this._card._action("snooze", eid, String(until));
    if (r) this._toast(`${r.name} snoozed until ${fmtDT(until)}`);
  }

  _toast(text) {
    const t = this._el.toast;
    t.textContent = text;
    t.hidden = false;
    t.getAnimations().forEach((a) => a.cancel());
    t.animate([{ opacity: 0, transform: "translate(-50%,-12px) scale(.96)" }, { opacity: 1, transform: "translate(-50%,0)" },
               { opacity: 1, transform: "translate(-50%,0)", offset: 0.85 }, { opacity: 0, transform: "translate(-50%,-6px)" }],
      { duration: 2600, easing: PH_EASE }).finished.then(() => { t.hidden = true; }, () => {});
  }
}

const PHONE_STYLES = `
/* never wider than the screen, whatever slides sideways in it (tabs, the chart, sheet pages);
   clip, not hidden - sticky parts keep working */
:host{display:block;overflow-x:clip;--bg:var(--ha-card-background,rgb(32,27,37));--cell:rgb(46,42,52);
  --sep:rgba(255,255,255,.09);--l1:#fff;--l2:rgba(235,235,245,.62);--l3:rgba(235,235,245,.32);
  --fill:rgba(118,118,128,.24);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;color:var(--l1);-webkit-tap-highlight-color:transparent}
*{box-sizing:border-box}
button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:left;
  -webkit-tap-highlight-color:transparent}
button:disabled{opacity:.35;cursor:default}
svg{fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
[hidden]{display:none!important}
.app{padding:0 16px calc(40px + env(safe-area-inset-bottom))}
.glass{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;
  background:rgba(255,255,255,.1);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);
  box-shadow:inset 0 0 0 .5px rgba(255,255,255,.22),0 4px 14px rgba(0,0,0,.25);transition:transform .2s ${PH_EASE}}
.glass:active{transform:scale(.9)}

/* segmented control: a track, a white thumb that slides */
.seg{position:relative;display:flex;background:var(--fill);border-radius:10px;padding:2px;isolation:isolate}
.seg button{position:relative;z-index:1;flex:1;min-height:30px;padding:0 14px;font-size:13px;font-weight:600;
  text-align:center;border-radius:8px;color:var(--l1);transition:color .25s}
.seg button.on{color:#1c1c1e}
.seg .thumb{position:absolute;z-index:0;top:2px;bottom:2px;left:2px;border-radius:8px;background:#fff;
  box-shadow:0 3px 8px rgba(0,0,0,.18),0 1px 1px rgba(0,0,0,.12)}
.tseg{margin:12px 0 16px;border-radius:22px;padding:3px}
.tseg button{min-height:38px;font-size:16px;border-radius:19px}
.tseg .thumb{top:3px;bottom:3px;left:3px;border-radius:19px}

.hero{padding:6px 2px 10px}
.hero h1{margin:0;font-size:34px;line-height:41px;font-weight:700;letter-spacing:.37px}
.sub{font-size:15px;color:var(--l2);margin-top:2px}
.srow{display:flex;align-items:center;gap:10px}
.search{flex:1;display:flex;align-items:center;gap:6px;height:38px;padding:0 9px;border-radius:12px;background:var(--fill);color:var(--l2)}
.search svg{width:18px;height:18px;flex:0 0 auto}
.search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--l1);font:inherit;font-size:17px}
.search input::placeholder{color:var(--l2)}
.search input::-webkit-search-cancel-button{filter:invert(1);opacity:.5}

/* filters: a button by the search field, and the picks as chips */
.fbtn{position:relative;flex:0 0 auto;width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:var(--fill)}
.fbtn svg{width:20px;height:20px;stroke-width:2.4}
.fbtn.on{background:#fff;color:#1c1c1e}
.fn{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:${COL.firing};color:#fff;
  font-size:11px;font-weight:700;display:grid;place-items:center;padding:0 4px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-height:30px;padding:0 8px 0 12px;border-radius:15px;background:#fff;color:#1c1c1e;
  font-size:13px;font-weight:600}
.clab{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.chip svg{width:14px;height:14px;stroke-width:2.6;flex:0 0 auto}
.pinchip{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;margin:10px 0 2px;padding:0 8px 0 16px;border-radius:24px;
  font-size:16px;font-weight:600;color:var(--l1);background:color-mix(in srgb,var(--c) 18%,var(--bg));
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 50%,transparent)}
.pinchip .clab{flex:1}
.pinchip .px{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.12);flex:0 0 auto}
.pinchip .px svg{width:16px;height:16px;stroke-width:2.8}
.pinned{margin-top:12px}
.cdot{width:10px;height:10px;border-radius:50%;background:var(--c);flex:0 0 auto}
.pmenu{position:fixed;z-index:60;overflow-y:auto;border-radius:14px;padding:4px 0;
  background:rgba(58,52,64,.86);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);
  box-shadow:0 12px 40px rgba(0,0,0,.45),inset 0 0 0 .5px rgba(255,255,255,.14)}
.mgh{font-size:13px;color:var(--l2);padding:10px 16px 4px}
.mrow{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0 14px 0 10px;font-size:17px}
.mrow:active{background:rgba(255,255,255,.1)}
.mck{width:20px;display:grid;place-items:center}
.mck svg{width:16px;height:16px;stroke-width:3}
.mdot{width:9px;height:9px;border-radius:50%;background:var(--c);flex:0 0 auto}
.mlab{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mn{font-size:15px;color:var(--l2);font-variant-numeric:tabular-nums}
.mreset{display:block;width:100%;min-height:44px;margin-top:4px;border-top:.5px solid var(--sep);font-size:17px;color:${COL.firing};text-align:center}

/* the chart */
.card{background:var(--cell);border-radius:22px;padding:16px}
.chart{position:relative;margin-bottom:6px}
.chd{display:flex;align-items:center;justify-content:space-between;gap:10px}
.abig{font-size:34px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.asub{font-size:15px;color:var(--l2);margin-top:4px}
.rseg{border-radius:20px;padding:3px}
.rseg button{min-height:36px;min-width:58px;padding:0 14px;font-size:15px;border-radius:17px}
.rseg .thumb{top:3px;bottom:3px;left:3px;border-radius:17px}
.plot{display:grid;grid-template-columns:auto 1fr;column-gap:8px;margin-top:20px}
.yax{position:relative;height:110px;font-size:12px;color:var(--l2);font-variant-numeric:tabular-nums;text-align:right}
.yax i{visibility:hidden;font-style:normal}
.yax span{position:absolute;right:0;transform:translateY(50%);line-height:1}
.bars{position:relative;display:grid;grid-template-columns:repeat(var(--n),1fr);height:110px;touch-action:pan-y;cursor:pointer;
  background:linear-gradient(to top,rgba(255,255,255,.08) 1px,transparent 1px)}
.gl{position:absolute;left:0;right:0;height:1px;margin-bottom:-1px;background:rgba(255,255,255,.06);pointer-events:none}
.slot{display:flex;align-items:flex-end;justify-content:center;gap:2px;height:100%;border-radius:6px;transition:background .2s}
.slot.sel{background:rgba(255,255,255,.08)}
.slot i{display:block;width:min(18px,44%);background:var(--c);border-radius:3px 3px 1px 1px;transform-origin:bottom;
  animation:grow .5s ${PH_EASE} both;animation-delay:var(--d)}
@keyframes grow{from{transform:scaleY(0)}}
.slot i.zero{height:3px;background:#fff;border-radius:1.5px}
.axis{position:relative;height:18px;margin-top:6px;font-size:12px;color:var(--l2)}
.axis span{position:absolute;top:0;white-space:nowrap}
.callout{position:absolute;top:10px;left:0;z-index:5;min-width:170px;max-width:240px;padding:10px 12px;border-radius:14px;pointer-events:none;
  background:rgba(58,52,64,.94);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  box-shadow:0 10px 30px rgba(0,0,0,.45),inset 0 0 0 .5px rgba(255,255,255,.14);transition:transform .18s ${PH_EASE}}
.cwhen{font-size:15px;font-weight:600;margin-bottom:4px}
.csec{margin-top:6px}
.chd2{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;color:var(--c)}
.chd2 i{width:8px;height:8px;border-radius:2px;background:var(--c)}
.chd2 b{margin-left:auto}
.cname{font-size:15px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:14px}
.cmore,.cnone{font-size:15px;color:var(--l2);padding-left:14px}
.cnone{padding-left:0}

/* inset grouped list - one line per row */
.sh{display:flex;align-items:baseline;gap:8px;font-size:20px;font-weight:700;letter-spacing:.38px;margin:22px 4px 8px;color:var(--l1)}
.shn{font-size:15px;font-weight:600;color:var(--l2);letter-spacing:0}
.group{background:var(--cell);border-radius:16px;overflow:hidden}
.group > .row + .row::before{content:"";position:absolute;left:60px;right:0;top:0;border-top:.5px solid var(--sep)}
.row{position:relative;display:flex;align-items:center;gap:12px;width:100%;min-height:60px;padding:10px 12px 10px 14px;
  background:var(--cell);touch-action:pan-y}
.row:active{background-image:linear-gradient(rgba(255,255,255,.08),rgba(255,255,255,.08))}
.tile{flex:0 0 auto;width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--c);color:#fff}
.tile ha-icon{--mdc-icon-size:19px}
.tile.sm{width:26px;height:26px;border-radius:7px}.tile.sm ha-icon{--mdc-icon-size:16px}
.tile.lg{width:48px;height:48px;border-radius:12px}.tile.lg ha-icon{--mdc-icon-size:28px}
.t1{font-size:17px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row > .t1{flex:1;min-width:0}
.t2{font-size:15px;color:var(--l2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t2 b{font-weight:600}
.meta{flex:0 0 auto;display:flex;align-items:center;gap:4px;color:var(--l3);font-size:15px}
.meta .time{color:var(--l2)}
.meta svg{width:14px;height:14px;stroke-width:2.6}
.stt{font-size:15px;font-weight:600;color:var(--c)}
.foot{font-size:13px;color:var(--l2);text-align:center;margin:14px 20px}
.loading{color:var(--l2);text-align:center;padding:40px 0;font-size:15px}
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:48px 24px 40px}
.eic{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;color:var(--c);
  background:color-mix(in srgb,var(--c) 16%,transparent);margin-bottom:16px}
.eic svg{width:32px;height:32px;stroke-width:2.6}
.et{font-size:22px;font-weight:700;letter-spacing:.35px}
.eb{font-size:15px;color:var(--l2);margin-top:6px;line-height:20px;max-width:280px}

/* timeline (History, and an alert's own) */
.tline{position:relative;padding:4px 0 4px}
.tline::before{content:"";position:absolute;left:79px;top:14px;bottom:14px;width:2px;background:rgba(255,255,255,.1);border-radius:1px}
.tev{position:relative;display:flex;align-items:flex-start;gap:12px;width:100%;padding:9px 0;text-align:left}
.tev:active .tbody{opacity:.6}
.tt{flex:0 0 64px;text-align:right;font-size:14px;color:var(--l2);font-variant-numeric:tabular-nums;padding-top:3px}
.tt small{font-size:11px;color:var(--l3)}
.tdot{flex:0 0 auto;width:12px;height:12px;border-radius:50%;background:var(--c);margin-top:6px;
  box-shadow:0 0 0 4px var(--bg);position:relative;z-index:1}
.sheet .tdot{box-shadow:0 0 0 4px #2a2430}
.tbody{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.tbody .t1{font-size:17px}
.tbody .t2{font-size:15px;line-height:20px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
  overflow:hidden;overflow-wrap:anywhere}
.tev.cur{background:#fff;color:#1c1c1e;border-radius:14px;margin:4px -8px;padding:9px 8px;width:calc(100% + 16px);cursor:default}
.tev.cur .tt,.tev.cur .tt small,.tev.cur .t2{color:rgba(28,28,30,.66)}
.sheet .tev.cur .tdot{box-shadow:0 0 0 4px #fff}

/* ---- the sheet, the snooze action sheet, the toast ---- */
.scrim{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.45)}
.scrim.clear{background:transparent}
/* clip: a page slides sideways in and out (_slideSheet) - on a screen wider than the sheet it
   would show beside it. clip, not hidden: nothing can scroll the sheet itself */
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:50;background:#2a2430;border-radius:28px 28px 0 0;overflow:clip;
  box-shadow:0 -10px 40px rgba(0,0,0,.4);display:flex;flex-direction:column;max-width:600px;margin:0 auto}
.grabzone{padding:8px 0 4px;touch-action:none;cursor:grab}
.grab{width:38px;height:5px;border-radius:3px;background:rgba(255,255,255,.3);margin:0 auto}
.sbody{position:relative;flex:1;overflow:hidden;padding:4px 18px calc(30px + env(safe-area-inset-bottom));overscroll-behavior:contain}
.shead{display:flex;align-items:center;gap:12px;touch-action:none}
.shtxt{flex:1;min-width:0}
.sht1{font-size:22px;font-weight:700;letter-spacing:.35px;line-height:27px}
.sht2{font-size:15px;color:var(--l2)}
.sclose,.sback{width:44px;height:44px;flex:0 0 auto;background:rgba(255,255,255,.12)}
.sclose svg{width:20px;height:20px;stroke-width:2.6}
.sback svg{width:22px;height:22px;stroke-width:2.6}
.sbar2{display:flex;align-items:center;justify-content:space-between;margin-top:-4px;touch-action:none}
.sbar2 + .shead{padding-top:16px}
.sstat{display:inline-flex;align-items:center;gap:7px;margin:16px 0 0;padding:6px 12px;border-radius:14px;font-size:15px;font-weight:600;
  color:var(--c);background:color-mix(in srgb,var(--c) 16%,transparent)}
.sdot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:0 0 auto}
.smsg{font-size:17px;line-height:23px;margin:14px 2px 0;white-space:pre-line;overflow-wrap:anywhere}
.sacts{display:flex;gap:10px;margin:18px 0 6px}
.sacts + .sacts{margin-top:4px}
.big{flex:1;min-height:50px;border-radius:25px;background:rgba(255,255,255,.12);font-size:17px;font-weight:600;text-align:center;
  transition:transform .15s ${PH_EASE}}
/* snoozed: the tablet's highlight - white, the card's own colour for the words; beside Clear it
   takes two lines */
.big.snzd{background:#fff;color:var(--bg);line-height:1.2;padding:6px 14px}
.big:active{transform:scale(.96)}
.facts{margin-top:16px}
.frow2{display:flex;justify-content:space-between;gap:16px;padding:12px 16px;font-size:17px;position:relative}
.frow2 + .frow2::before{content:"";position:absolute;left:16px;right:0;top:0;border-top:.5px solid var(--sep)}
.fk{color:var(--l1)}
.fv{color:var(--l2);text-align:right;min-width:0;overflow-wrap:anywhere}
.navs{margin-top:16px}
.navs.top{margin-top:14px}
.nrow{position:relative;display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:0 14px;font-size:17px}
.nrow + .nrow::before{content:"";position:absolute;left:52px;right:0;top:0;border-top:.5px solid var(--sep)}
.nrow:active{background:rgba(255,255,255,.08)}
.nlab{flex:1;min-width:0}
.nval{color:var(--l2);font-size:17px}
.nrow > svg{width:14px;height:14px;stroke-width:2.6;color:var(--l3)}
.evk{display:flex;align-items:center;flex-wrap:wrap;gap:0 6px;color:var(--c);font-weight:600}
.evt{color:var(--l2);font-weight:400}
.evcard{margin-top:12px;padding:14px 16px}
.evtext{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:22px}
.evtext.clamp{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.evmore{display:inline-flex;align-items:center;gap:4px;margin-top:8px;min-height:32px;font-size:15px;font-weight:600}
.evmore svg{width:16px;height:16px;stroke-width:2.6}
.evcard + .facts{margin-top:12px}
.tlh,.ph1{font-size:22px;font-weight:700;letter-spacing:.35px;margin:28px 2px 2px}
.tlsub,.ph2{font-size:15px;color:var(--l2);margin:0 2px 8px}
.sbar2 + .ph1{margin-top:16px}
.ph2 + .facts{margin-top:8px}
.menu{position:fixed;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:60;max-width:584px;margin:0 auto;
  display:flex;flex-direction:column;gap:8px}
.asheet,.acancel{border-radius:16px;background:rgba(58,52,64,.92);-webkit-backdrop-filter:blur(24px) saturate(180%);
  backdrop-filter:blur(24px) saturate(180%);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.14)}
.menu{max-height:calc(100% - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom))}
/* taller than the screen with Custom open: the sheet scrolls, never the page behind; Cancel stays */
.asheet{overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;flex:0 1 auto;min-height:0;scrollbar-width:none}
.asheet::-webkit-scrollbar{display:none}
.acancel{flex:0 0 auto}
.ah{font-size:13px;font-weight:600;color:var(--l2);text-align:center;padding:14px 16px 12px}
.ahs{font-weight:400;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.arow{display:flex;align-items:center;gap:10px;width:100%;min-height:56px;padding:0 18px;font-size:19px;border-top:.5px solid var(--sep)}
.arow:active{background:rgba(255,255,255,.1)}
.arow > span:first-child{flex:1}
.aval{font-size:15px;color:var(--l2)}
.arow svg{width:16px;height:16px;stroke-width:2.6;color:var(--l3);transition:transform .25s ${PH_EASE}}
.arow.open svg{transform:rotate(180deg)}
.arow.end > span:first-child{color:${COL.snoozed}}
/* Custom: the tablet's picker (SnoozePicker) - a typed length, a calendar, a time chip and
   its drum - in the sheet's iOS materials: system font, white for the chosen day and an open
   chip, the fill colour for fields */
.cust{padding:4px 16px 16px;display:flex;flex-direction:column;gap:12px;overflow:hidden}
.cust[hidden]{display:none}
.stext{width:100%;height:44px;border:0;outline:0;border-radius:12px;background:var(--fill);color:var(--l1);
  font:inherit;font-size:17px;padding:0 14px}
.stext::placeholder{color:var(--l2)}
.scal{-webkit-user-select:none;user-select:none}
.calhd{display:flex;align-items:center;gap:2px;padding:4px 0 6px}
.calm{flex:1;font-size:17px;font-weight:600}
.calnav{width:40px;height:40px;border-radius:50%;display:grid;place-items:center}
.calnav svg{width:22px;height:22px;fill:none;stroke:var(--l1);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.calnav:disabled{opacity:.25}
.calnav:not(:disabled):active{background:rgba(255,255,255,.12)}
.calwk,.calgrid{display:grid;grid-template-columns:repeat(7,1fr);text-align:center}
.calwk span{font-size:13px;font-weight:600;color:var(--l2);padding:2px 0 6px}
.cday{width:40px;height:40px;margin:1px auto;border-radius:50%;display:grid;place-items:center;text-align:center;
  font-size:17px;font-variant-numeric:tabular-nums;transition:background .2s,color .2s,transform .14s ${PH_EASE}}
.cday:disabled{opacity:.28}
.cday.today{font-weight:700;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
.cday.sel{background:#fff;color:#1c1c1e;font-weight:700;box-shadow:none}
.cday:not(:disabled):active{transform:scale(.88)}
.stime{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:17px;padding-top:2px}
/* the widest time ("00:00 AM", or "00:00" on a 24-hour clock) fits; white while its drum is open */
.tchip{position:relative;overflow:hidden;width:calc(8.4ch + 28px);min-height:36px;padding:0 14px;border-radius:9px;
  background:var(--fill);font-size:17px;font-variant-numeric:tabular-nums;text-align:center;transition:background .15s,color .15s}
.tchip.on{background:#fff;color:#1c1c1e}
.tchip.h24{width:calc(5.4ch + 28px)}
.tcin{display:block;white-space:nowrap}
.tcout{position:absolute;inset:0;display:grid;place-items:center;white-space:nowrap;pointer-events:none}
.sdrum{border-radius:12px;background:rgba(0,0,0,.2);overflow:hidden}
.sdrum[hidden]{display:none}
.wheel{position:relative;display:flex;align-items:stretch;justify-content:center;gap:6px;height:var(--wheel-h);padding:0 10px}
.wheel-band{position:absolute;left:10px;right:10px;top:calc(50% - 22px);height:44px;border-radius:9px;background:rgba(255,255,255,.1);pointer-events:none}
/* the drum's gesture, all of it: no browser pan, zoom or text selection */
.wheel-col{flex:0 1 120px;position:relative;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;outline:none;text-align:center}
.wheel-item{position:absolute;left:0;right:0;top:50%;height:44px;margin-top:-22px;line-height:44px;
  font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;visibility:hidden}
.wheel-sep{align-self:center;font-size:22px;font-weight:600;opacity:.5}
.sprev{font-size:15px;color:var(--l2);min-height:20px;text-align:center}
.sprev.ok{color:var(--l1);font-weight:600}
.sgo{min-height:50px;border-radius:25px;background:#fff;color:#1c1c1e;font-size:17px;font-weight:600;text-align:center}
.sgo:disabled{opacity:.3}
.sgo:not(:disabled):active{transform:scale(.97)}
.acancel{min-height:56px;font-size:19px;font-weight:600;text-align:center}
.toast{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;z-index:70;transform:translateX(-50%);
  max-width:calc(100vw - 32px);padding:10px 18px;border-radius:22px;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  background:rgba(58,52,64,.92);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  box-shadow:0 8px 30px rgba(0,0,0,.4),inset 0 0 0 .5px rgba(255,255,255,.14)}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
`;

customElements.define("alert-phone-view", AlertPhoneView);

/* ---- the banner -------------------------------------------------------------------------
   An alert whose rule ticks dashboards (Notify: Banner - the fork's `overlay`) shows a banner
   across the top of those dashboards while it fires and is neither cleared nor snoozed (nor its
   notifications switched off), on every view but the Alerts view itself - or, with Home page only,
   on their Home views alone, and not while a pop-up is open over one (bannerHere). This file draws it on
   every dashboard: Home Assistant loads a card's file for all of them, whether the card is on
   the page or not. One stack per window, looking at Home Assistant's own state once a second.
   A banner drops in from the top, as on iOS; a tap opens the alert's popup right where it is -
   in a hidden copy of this card (banner_host), made on the first tap; a swipe up puts it away on
   this device until the alert fires again. At most three show, the newest on top.
   It is white, as an entity that is on, and says only the alert's name (what it says is in its
   popup), with an Open button for the alert's link; a tablet or a computer (wider than a phone)
   gets a bigger one, readable from across the room. */
const BANNER_AWAY_KEY = "hm-alert-banner-away";   // per device: { entity id: when it fired }
const BANNER_MAX = 3;
const BANNER_NARROW = "(max-width: 700px)";   // the card's own phone/tablet split

class AlertBannerStack extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${BANNER_STYLES}</style><div class="stack"></div><div class="hostbox"></div>`;
    this._stack = this.shadowRoot.querySelector(".stack");
    this._shown = new Map();   // entity id -> its banner
    try { this._away = JSON.parse(localStorage.getItem(BANNER_AWAY_KEY) || "{}") || {}; } catch { this._away = {}; }
    this._tick = this._tick.bind(this);
    setInterval(this._tick, 1000);
    // another page: what a banner opened (its popup, the editor, a help box) belongs to the page
    // it was opened on, as a card's own popups go with their view - the popup's copy is dropped
    this._path = location.pathname;
    const soon = () => {
      if (location.pathname !== this._path) { this._path = location.pathname; this._dropHost(); }
      setTimeout(this._tick, 60);
    };
    window.addEventListener("location-changed", soon);
    window.addEventListener("popstate", soon);
    // a pop-up opens and closes as the address's #hash (Bubble Card)
    window.addEventListener("hashchange", soon);
    this._bindGestures();
  }

  _dropHost() {
    this._host?.remove();
    this._host = this._hostHass = null;
  }

  _hass() { return document.querySelector("home-assistant")?.hass; }
  // put away until it fires again: the firing it was put away at
  _firing(r) { return String(r.since || r.lastFired || ""); }

  _tick() {
    const hass = this._hass();
    if (!hass?.states) return;
    // the popup's copy follows Home Assistant while it is open
    const view = this._host?._phView;
    if (view && hass !== this._hostHass && (view._sheetOpen || !view._el?.menu.hidden)) { this._hostHass = hass; this._host.hass = hass; }
    // read again only when an alert changed, the page changed or a pop-up opened or closed on it,
    // the screen turned between phone and tablet width (which link Open goes to), or half a minute
    // passed (an event alert stops firing when its time runs out, which no state change marks)
    let sig = `${location.pathname}${location.hash}|${matchMedia(BANNER_NARROW).matches}|${Math.floor(Date.now() / 30e3)}`;
    for (const id in hass.states) if (id.startsWith("alert2.")) sig += `|${id}:${hass.states[id].last_updated}`;
    if (sig === this._sig) return;
    this._sig = sig;
    const onAlerts = /^\/[^/]+\/alerts\/?$/.test(location.pathname);
    const { rows } = AlertConsoleCard.prototype._read.call(null, hass);
    const want = onAlerts ? [] : rows
      .filter((r) => bannerHere(r.overlay) && r.firing && !r.snoozeUntil && !r.notificationsOff && this._away[r.id] !== this._firing(r))
      .sort((a, b) => (b.since || 0) - (a.since || 0)).slice(0, BANNER_MAX);
    this._paint(want, hass);
  }

  /* The alert's link for this screen, as the card's own Link button picks it: the mobile one
     on the mobile dashboard or a phone-sized screen, the desktop one anywhere else. */
  _link(r, hass) {
    const card = AlertConsoleCard.prototype;
    return card._linkFor.call({ _hass: hass, _config: {}, _dashboards: card._dashboards,
                                _narrow: () => matchMedia(BANNER_NARROW).matches }, r);
  }

  // the Open button is there when the alert has a link
  _html(r, hass) {
    const link = this._link(r, hass);
    return `${phTile(r)}<span class="bt"><span class="b1">${escapeHtml(r.name)}</span></span>
      <span class="bw">${escapeHtml(r.since ? phRel(r.since) : "")}</span>${
      link ? `<button class="bgo" data-link="${escapeHtml(link)}">Open</button>` : ""}`;
  }

  // the others slide to their new places as one comes or goes
  _flip(change) {
    const before = new Map([...this._stack.children].map((el) => [el, el.getBoundingClientRect().top]));
    change();
    if (reduceMotion()) return;
    for (const [el, top] of before) {
      if (!el.isConnected || el._leaving) continue;
      const d = top - el.getBoundingClientRect().top;
      if (Math.abs(d) > 1) el.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: 420, easing: IOS });
    }
  }

  // the Open button: the alert's priority colour, and what reads on it (dark on yellow)
  _tone(el, r) {
    el.style.setProperty("--tone", PRIO[r.priority].tone);
    el.style.setProperty("--on", r.priority === "low" ? "rgba(0,0,0,.88)" : "#fff");
  }

  _paint(want, hass) {
    const keep = new Set(want.map((r) => r.id));
    for (const [id, el] of this._shown) if (!keep.has(id)) { this._shown.delete(id); this._leave(el); }
    want.slice().reverse().forEach((r) => {
      const html = this._html(r, hass);
      let el = this._shown.get(r.id);
      if (el) {
        if (el._html !== html) { el._html = html; el.innerHTML = html; }
        this._tone(el, r);
        return;
      }
      el = document.createElement("div");
      el.className = "bn";
      el.dataset.eid = r.id;
      el._html = html;
      el.innerHTML = html;
      this._tone(el, r);
      el._firing = this._firing(r);
      this._shown.set(r.id, el);
      this._flip(() => this._stack.prepend(el));
      if (!reduceMotion()) {
        el.animate([{ transform: "translateY(-140%)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 560, easing: IOS });
      }
    });
  }

  // up and away, from wherever a finger left it
  _leave(el, from = 0) {
    el._leaving = true;
    const done = () => this._flip(() => el.remove());
    if (reduceMotion()) { done(); return; }
    el.style.transition = "none";
    el.animate([{ transform: `translateY(${from}px)`, opacity: 1 }, { transform: "translateY(-130%)", opacity: 0 }],
      { duration: 300, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.then(done, done);
  }

  /* A tap opens the alert; a swipe up puts the banner away (on this device, until the alert
     fires again); let go anywhere else, it springs back. The tap is the browser's own `click`,
     not the finger lifting: a popup opened on the lift would be under the finger when the tap's
     click arrives, and that click - on its backdrop - would close it at once. A tap on Open
     goes to the alert's link instead. The banner holds the finger (pointer capture), so the
     click lands on the banner, not on the button - where the finger went down says which. */
  _bindGestures() {
    let el = null, x0 = 0, y0 = 0, t0 = 0, dy = 0, moved = false, dragged = false, onGo = false;
    this._stack.addEventListener("click", (e) => {
      const b = e.target.closest(".bn");
      // a mouse sends a click after a drag too - a drag is never a tap
      if (!b || b._leaving || dragged) return;
      const go = e.target.closest(".bgo") || (onGo && b.querySelector(".bgo"));
      onGo = false;
      if (go) { this._go(b, go.dataset.link); return; }
      this._open(b.dataset.eid);
    });
    this._stack.addEventListener("pointerdown", (e) => {
      el = e.target.closest(".bn");
      onGo = !!e.target.closest(".bgo");
      dragged = false;
      if (!el || el._leaving) { el = null; return; }
      x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); dy = 0; moved = false;
      try { el.setPointerCapture(e.pointerId); } catch { /* a made-up pointer */ }
    });
    this._stack.addEventListener("pointermove", (e) => {
      if (!el) return;
      dy = e.clientY - y0;
      if (!moved && Math.hypot(e.clientX - x0, dy) > 6) moved = true;
      if (!moved) return;
      el.style.transition = "none";
      // up follows the finger; down gives only a little
      el.style.transform = `translateY(${dy < 0 ? dy : dy / 5}px)`;
    });
    const up = () => {
      const b = el;
      el = null;
      if (!b) return;
      dragged = moved;
      if (!moved) return;   // a tap: its click opens the alert
      const v = dy / Math.max(1, performance.now() - t0);
      if (dy < -36 || v < -0.4) { this._putAway(b, dy); return; }
      b.style.transition = `transform .38s ${IOS}`;
      b.style.transform = "none";
    };
    this._stack.addEventListener("pointerup", up);
    this._stack.addEventListener("pointercancel", up);
  }

  _putAway(el, from) {
    const id = el.dataset.eid;
    this._away[id] = el._firing;
    try { localStorage.setItem(BANNER_AWAY_KEY, JSON.stringify(this._away)); } catch { /* private mode: for this visit only */ }
    this._shown.delete(id);
    this._leave(el, from);
  }

  // Open: the banner has done its job - it goes up and away (as a swipe would), and the page
  // goes to the link, where it would otherwise cover the top of what was opened
  _go(el, link) {
    if (!link) return;
    this._putAway(el, 0);
    AlertConsoleCard.prototype._navigate.call(this, link);
  }

  // the alert's popup, here: a hidden copy of the card, made on the first tap
  _open(eid) {
    const hass = this._hass();
    if (!hass) return;
    if (!this._host) {
      const card = document.createElement("alert-console-card");
      card.setConfig({ type: "custom:alert-console-card", layout: "phone", embedded: true, banner_host: true });
      this.shadowRoot.querySelector(".hostbox").appendChild(card);
      this._host = card;
    }
    this._hostHass = hass;
    this._host.hass = hass;
    const go = (tries) => {
      const view = this._host._phView;
      if (view?._built && this._host._data?.byId[eid]) view._openAlert(eid);
      else if (tries > 0) setTimeout(() => go(tries - 1), 50);
    };
    go(40);
  }
}

const BANNER_STYLES = `
/* White as an entity that is on (solid: no blur behind it to compute), the name alone in one
   centred row, floating well above the page */
:host{position:fixed;top:0;left:0;right:0;z-index:8;pointer-events:none;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
.stack{position:absolute;top:calc(env(safe-area-inset-top) + 8px);left:50%;transform:translateX(-50%);
  width:min(560px,calc(100vw - 16px));display:flex;flex-direction:column;gap:10px}
.bn{pointer-events:auto;touch-action:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:10px 10px 10px 12px;border-radius:24px;
  color:rgba(0,0,0,.9);background:#fff;user-select:none;-webkit-user-select:none;
  box-shadow:0 1px 3px rgba(0,0,0,.3),0 8px 20px rgba(0,0,0,.38),0 20px 50px rgba(0,0,0,.55)}
.tile{flex:0 0 auto;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--c);color:#fff}
.tile ha-icon{--mdc-icon-size:26px}
.bt{flex:1;min-width:0}
.b1{display:block;font-size:18px;font-weight:700;line-height:26px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* how long ago it fired: a wide screen only - a phone's row is the name's */
.bw{display:none;line-height:26px;color:rgba(0,0,0,.5);white-space:nowrap}
.bgo{flex:0 0 auto;height:44px;padding:0 20px;border:0;border-radius:22px;margin:0;background:var(--tone);color:var(--on);
  font:inherit;font-size:15px;font-weight:600;cursor:pointer;transition:transform .15s,opacity .15s}
.bgo:active{transform:scale(.95);opacity:.8}
.hostbox{pointer-events:auto}
/* A tablet or a computer: readable from across the room - the name the size of the dashboard's
   section headings, in its font */
@media (min-width: 701px){
  :host{font-family:var(--ha-font-family-body,Roboto,Noto,sans-serif)}
  .stack{top:calc(env(safe-area-inset-top) + 12px);width:min(760px,calc(100vw - 32px));gap:14px}
  .bn{gap:16px;padding:14px 14px 14px 16px;border-radius:28px;
    box-shadow:0 2px 4px rgba(0,0,0,.3),0 10px 24px rgba(0,0,0,.4),0 28px 70px rgba(0,0,0,.65)}
  .tile{width:52px;height:52px;border-radius:14px}
  .tile ha-icon{--mdc-icon-size:30px}
  .b1{font-size:24px;line-height:30px}
  .bw{display:block;font-size:18px;font-weight:500;line-height:30px}
  .bgo{height:52px;padding:0 26px;border-radius:26px;font-size:18px}
}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
`;

customElements.define("alert-banner-stack", AlertBannerStack);
// one stack per window, on every dashboard
(function mountBanner() {
  if (window.__hmAlertBanner) return;
  if (!document.body) { setTimeout(mountBanner, 100); return; }
  window.__hmAlertBanner = document.body.appendChild(document.createElement("alert-banner-stack"));
})();

customElements.define("alert-console-card", AlertConsoleCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "alert-console-card",
  name: "Alert Console Card",
  description: "Every Alert2 alert, what is firing now and what happened, in the Health card's design",
  preview: false,
});
console.info(
  `%c ALERT-CONSOLE-CARD %c ${VERSION} `,
  "background:#58A6FF;color:#04121f;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px",
  "background:#F85149;color:#1f0404;font-weight:700;border-radius:0 3px 3px 0;padding:2px 4px"
);
