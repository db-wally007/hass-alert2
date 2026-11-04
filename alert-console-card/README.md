# alert-console-card

The Alerts view for this Alert2 fork: every alert, what is firing now, and what happened.
It shares its design with
[health-monitor-card](https://github.com/db-wally007/ha-health-monitor/tree/main/health-monitor-card)
(type scale, colours, tiles, filters, table), so the two views read as one product.

Plain JavaScript, no build step.

## Install

1. Add a dashboard resource:
   `/local/hass-alert2/alert-console-card/alert-console-card.js?v=1.1.0`, type
   *JavaScript module*. Raise the `?v=` after every update, or browsers keep the old module.
2. Also load [state-history-card](https://github.com/db-wally007/state-history-card)
   (≥ 0.1.6). It draws each alert's firing/OK history.
3. Add the card:

```yaml
type: custom:alert-console-card
title: Alerts            # optional
hours: 24                # optional: 24 | 72 | 168
desktop_dashboard: tablet-dashboard   # optional: where Desktop links come from
mobile_dashboard: mobile-dashboard    # optional: where Mobile links come from
page_size: 50            # optional
embedded: false          # optional: true inside page-switcher-card - no title row or panel
                         # of its own (that card is the panel; its New alert calls newAlert())
grid_options:
  columns: full          # required inside a sections view
```

Rules made in the card are saved through Alert2's UI API (`/api/alert2/manageAlert`). With
the fork's `rules_dir` option set in the `alert2:` YAML, each one is also a YAML file of its
own, and those files are what Alert2 loads:

```yaml
alert2:
  rules_dir: alerts      # /config/alerts/<category>_<name>.yaml, one file per rule
```

The first start with the option writes out the rules Alert2 already holds. A save in the card
writes or removes the file at once; a file edited by hand applies at the next
`alert2.reload` (or restart), and deleting a file deletes its rule. A folder that is not
there changes nothing (a mistyped path does not read as "every rule deleted").

## What it shows

- **Tiles.**
  - *High Priority Alerts* and *Low Priority Alerts:* Firing alerts of that priority out
    of all alerts of that priority.
  - *Snoozed.*
  - *Total Number of Alert Rules.*

  Tapping a tile opens exactly what it counts - its tab, status and priority, ticked in
  the filter menu - even at zero, when the table says so ("No high priority alerts are
  firing").
- **Firing over time.** Bars per priority (high, low), each the number of alerts firing at
  any moment of its slot - firing as the list counts it, so not once it was cleared (the
  history is read with its attributes for that). An event alert counts in every slot it is
  Firing in - from the slot it fired in until its *Stays firing* runs out or it is cleared -
  and one still Firing from before the range counts from the range's start: the chart shows
  what was going on, not only what began. The last bar is the hour so far: an alert that stopped firing in it still counts. Hover, or drag a
  finger across it, and a tooltip names the alerts; tap a bar and the table shows every
  alert of its slot, both priorities, under a red chip naming the stretch of time. Tap the
  legend to hide a priority. A slot where nothing fired has a short white stub at zero, so
  it reads as a zero, not a gap. While nothing fired in the whole range the chart folds to
  its title row, which says so where the legend was ("0 alerts fired in 24 hours"), as the
  phone's chart folds to its count; another range eases it open or shut.
- **An empty table** shows the phone's empty states: *No Active Alerts* with a green tick
  ("Everything is OK. 3 rules are watching."), *No History*, or - with filters, a search or
  a tile's own filters - *No Matches* and what was asked for ("No high priority alerts are
  firing.").
- **Active / All Alerts / History tabs.**
  - *Active* is everything not OK. There are three statuses and nothing in between:
    - *Firing:* the condition holds, or an event alert (one that fires at a moment, with
      no "still on") fired in the last day.
    - *Snoozed:* notifications paused until a set moment - firing or not: Snooze is on
      every alert (a flood of alerts is often known in advance), and a snoozed alert is
      Snoozed in the status filter, the Snoozed tile and Active until the snooze ends. Then
      it is Firing if it still fires, else OK.
    - *OK:* anything else, including an alert someone has cleared (until it fires again).
  - *History* is every recorded event, newest first: every alert's (from before its edits,
    and a deleted rule's too, under the name it had), the rule's life (*Alert rule created /
    edited / deleted*, by whom) and Home Assistant's restarts. A row opens the event whole -
    every field, not the alert's status - with *Open alert* to jump to the alert itself.
- **Filters.** Search, plus two multi-select menus with the tab's counts per value:
  - *Status & priority:* a Status section (Firing, Snoozed, and OK on *All Alerts*; on
    *History* an Event section instead, in an alert's life order) and a Priority section.
  - *Category* (Alert2's `domain`).

  A menu's button names what is picked, as Grafana does: a chip per value (status and
  priority in their colours, as in the table), as many as fit, then *+N*. Priority,
  category, status and event chips in the table toggle the same filters. While any filter
  is set (a search too), *Reset* stands out in the selection white, as *New alert* does.
- **Rows.** The alert's name with an *(i)*, and under it what the alert is for (its
  `description`, one line). *(i)* opens a popup with the entity id and the whole
  description - the only place either is shown - over a dimmed, unscrollable page. A bell
  with a slash marks notifications switched off.
- **Expanded alert,** the same on every alert:
  - What it says now, in its status colour - a line per item (the editor's rules write each
    device, each condition's part, on its own line), ten to a page with ‹ › under them, the
    page sliding the way you go. Where a message has to fit one line (timeline rows,
    History) its items run on with " · ".
  - Buttons, always in this order: *Snooze* and *Edit* (both in the selection white, as
    *New alert*; Edit only on an alert made in this card - see below; a YAML alert, such as
    the two system ones, is edited in its file), and *Clear* where the rule allows it.
    While snoozed the first one reads *Snoozed until …* and is the highlight, exactly as
    the chosen tab: white, in the card's own dark.
  - *Clear* (green: it turns the alert OK until it fires again) shows only on rules that
    allow it - the fork's `allow_clear` on the rule. Unset, an event alert allows it and a
    condition alert does not: a device that is offline is still offline after a clear, and
    turns OK by itself when it is back. Clear is Alert2's ack.
  - *Snooze* opens an iOS-style sheet - a popover beside the button on a wide screen, an
    action sheet from the bottom on a phone - headed *Snooze notifications for:*, over a
    dimmed page that does not scroll. *Tomorrow Morning* (8:00) and *One Week* snooze at
    one tap, each showing when it ends. *Custom* opens beside the list on a wide screen
    (under it on a phone): a field to type a length (`90m`, `3h`, `1h 30m`, `2d`, `1w 2d`;
    a bare number is hours), a calendar, and a time chip that opens the Simple Schedule
    card's time drum (flick, coast, rubber band, tap a row) inline under it - opening and
    closing in two parts, the box on a plain curve and the drum on a spring; up to a year
    ahead. The chip keeps one width and its time rolls with the drum as it turns, as does
    the *Until …* line under it; a new month slides in and a picked day pops. While snoozed, the sheet starts with *End Snooze*, in the selection white.
    Snoozing only pauses notifications - it does not clear or acknowledge the alert.
  - Open link, when the alert has one: the mobile link on the mobile dashboard or a
    phone-sized screen, the desktop link anywhere else (each standing in for the other when
    only one is set). A phone notification opens the mobile one.
  - Its status history (Firing / Snoozed / OK, in the status colours) over the chart's
    range, drawn by state-history-card from the recorder. The card works the statuses out
    from the recorded state, fire, clear and snooze times by the same rules as the table,
    adding the moments no row records (a snooze or an event alert's day running out).
  - Its timeline (detected, activated, notified, cleared or acknowledged by whom, snoozed,
    resolved), kept by the fork for 10 days, 10 entries a page (‹ › under it, the page
    sliding out the way you are going; an update to the alert keeps the page). An alert that comes back already firing (a
    restart, a recreated rule) gets its activation back from what it remembers.
    While an alert is on, what it says is followed too: an item that comes or goes (a second
    device offline, one back) is *Added* / *Removed* with its text - told apart by name, so a
    battery's level or a "since" changing is not an entry; a change while Home Assistant was
    down is caught up when it is back. Editing the rule starts it over: the alert is made
    anew with no state carried over (a snooze ends too) and judged at once - still true, it
    activates again - and its timeline and status history start at *Alert rule edited* (and
    who did it). Nothing is thrown away: the History tab keeps what came before.
    Home Assistant's restarts are in every timeline since it began ("Home Assistant
    restarted · down 36 s", from the fork's restart log) and in the history band, as a grey
    *Restarting* stretch from the stop to the start. After a start, alerts keep their state
    for the fork's `start_delay_secs` (90 s here) before judging again, so integrations still
    loading - a calendar not fetched yet, the Health summary empty - cannot resolve and
    re-activate them, nor read as items coming and going.
    It follows the fork live (`alert2/hm/timeline/subscribe`): a snooze, an end of snooze,
    a clear shows the moment it is recorded, sliding in at the top - every client, whoever
    did it. A row shows one line, cut short; each row (a chevron at its end) opens the whole event
    in a popup like the *(i)* one: what happened and when, the alert, the full message
    (wrapped; a very long one scrolls inside the popup), by whom, the notifiers, until
    when a snooze runs, the delay waited, an error.

## Phone layout

`layout: phone` draws the card for an iPhone (the mobile dashboard, inside
`page-switcher-card` with `ios: true`, which gives it its navigation bar: a round back
button, the Alerts | Health switch, a round "+" for New alert):

- A large title and one line of summary ("2 firing · 1 snoozed"), search with a filter button
  beside it (the tablet's filters - status or event, priority, category - as one pull-down
  menu with counts; what is picked shows as chips that let go), and Active | All | History.
- On Active, the firing-over-time chart (24H / 7D), the tablet's data, with a scale of two or
  three whole numbers on its left (another range slides it out and the new one in), and a short
  white stub at zero in a slot where nothing fired - folded to its count while nothing fired
  in the range. A finger on it names the alerts behind a slot; a tap also
  lists them all, both priorities, whatever they are now, under a red chip below the chart
  that names the slot and lets go.
- Changing tab, the content slides out the way you go and fades; the tab's own comes in
  from the other side.
- One line per alert - its name and its time or status; what it says is in its detail. Swipe
  a firing alert left to Snooze or Clear it.
- History is a timeline by day; an event's line stops at two lines.
- An alert or an event opens in a bottom sheet just tall enough for its own part; scrolling
  raises it to the full screen. An alert: its status under its name, its message on white
  (category and priority are in Rule Details), the tablet's buttons - Clear while
  it fires (where the rule allows it) and Snooze always (a flood of alerts is often known in
  advance; *Notifications on* in its place if the alert's notifications were switched off) -
  then Edit / Link (a rule made in this card; the alert's link), then Timeline and Rule
  Details behind rows - headed as the event page's timeline. An event: what
  happened and when, the alert it belongs to, its full text (six lines, then Show more) and
  its facts, then the alert's whole timeline with this event marked.
- Snooze is the tablet's lengths as an iOS action sheet: End Snooze, Tomorrow Morning, One
  Week, Custom. Custom is the tablet's own picker (one `SnoozePicker` serves both) opening
  under the list: a length to type, the calendar, the time chip whose hour and minute drum
  opens under it, "Until …" and Snooze - no field takes the focus, so no keyboard covers the
  calendar. Taller than the screen, the sheet scrolls (never the page behind) with Cancel
  kept in view, and brings the Snooze button round when the drum opens.
- A push opens here: `?alert=<entity id>` opens that alert's sheet, `&snooze=1` its snooze
  menu too (the push's *Snooze: Custom…*); both are taken off the address once read.

## Banners

Loading the card's file (the dashboard resource) also puts a banner stack on every dashboard
- no card needed: Home Assistant loads every resource on every dashboard. An alert whose rule
ticks a dashboard (*Notify*, the fork's `overlay`) drops in across the top of it while it
fires, iOS-style. Three at most, newest first; not while snoozed or with notifications off, and
not on an Alerts view (`/<dashboard>/alerts`) that lists it anyway.

- **Where:** on every page of the dashboard, or - *Banner on → Show on: Home page* - only on
  its Home page (`/<dashboard>/home`) and not while a pop-up is open there (any `#…` address).
  Stored in `overlay` as `tablet-dashboard` or `tablet-dashboard/home`.
- **Looks:** white, as an entity that is on, floating above the page: the alert's tile, its
  name with what it says on one line under it (as an iOS notification; several lines are
  joined) and an **Open** button when it has a link - the mobile link on a phone-sized screen
  or the mobile dashboard, the desktop one elsewhere. Wider than a phone (over 700px) it is
  sized to be read across a room, and shows how long ago it fired. Solid colours, no blur
  behind it.
- **Tap:** the alert's sheet opens right there (the phone layout's, over the page - a hidden
  copy of this card, fed by Home Assistant only while its sheet or a menu is open, and dropped
  when the page changes): Clear, Snooze, Edit, Link as on the Alerts page.
- **Open:** goes to the alert's link and puts the banner away, so it does not cover what opened.
- **Swipe up:** puts it away on this device until the alert fires again (kept in the
  browser's `localStorage`, `hm-alert-banner-away`).
- It leaves by itself once the alert is OK, cleared or snoozed.
- **Open link on** (*Notify*, its own row and dashboard list under *Banner on*; the fork's
  `overlay_open`, stored as `overlay`): those dashboards go straight to the alert's link the
  moment it fires, instead of the banner (the doorbell's camera pop-up on the wall tablet), and
  back where they were after a minute without a touch, so a camera is not left streaming to an
  empty room. A touch anywhere gives it another minute; going somewhere else leaves it alone.
  A dashboard is in one list or the other - picked in one, it leaves the other. *Open from:
  Home page* opens it only from the Home page with no pop-up open. With no link, those
  dashboards show the banner. Only a firing seen while the page is open opens: a page reloaded
  later, or a step to the Home page, is not taken over.

## New alert

*New alert* (top right) opens the rule editor: the Simple Schedule card's event editor -
labelled rows in banded groups, pickers opening inline under their row, folds for what is
optional, the priority's colour along its top, Cancel / Add pinned to its foot - in the
snooze sheet's materials: rounded, on its lighter panel, white for whatever is selected.
624 px wide on a tablet or desktop; on a phone the whole width, rising from the bottom.
Durations (days, hours, minutes) are set on drums, and their chip keeps one width - the
widest a duration can read - while its value rolls as the drums turn.

- **Name**, **Priority** (High / Low, an iOS segmented control: the chosen one on a thumb in
  its colour, which slides to the other when tapped), **Category** (white, as a
  chosen value; the whole row opens the list - an existing one, or type a new one; a Health
  condition picks *health* unless one was chosen), and **Can be cleared** (`allow_clear`:
  *OK only once condition expires* / *Allowed to reset to OK*).
- **Fires** *[While true | When it happens]* - the group's first row, a segmented control.
  Its *(i)* opens the two in plain words - a situation or a moment - with examples of
  choosing one over the other (the *(i)* popup, wider here so it reads in few lines).
  Switching slides the rows out the way the thumb goes, eases the group to its new height
  and slides the other kind's rows in; nothing is lost (conditions stay, as *Only if*;
  triggers wait for a way back). *Can be cleared* follows the kind (an event is cleared by
  hand) unless it was set by hand.
  - **While true** - a condition alert: on while its conditions hold, OK once they stop
    (below).
  - **When it happens** - an Alert2 *event* alert: it fires each time a trigger does and
    its *Only if* conditions hold at that moment; it is Firing until cleared or until
    **Stays firing** runs out (a duration on the drums, a day to start with; *Until cleared*
    at zero, which needs *Can be cleared*) - the fork's `stays_firing_mins`, which the cards
    read (unset: a day). The card wakes for the moment it runs out; no state change marks it.
    *When* rows (more than one: *Or* - any of them fires it), picked from their own list,
    iOS rows like the conditions', *Health monitor* leading:
    - *Health monitor* - [Device | Battery | Helper] *goes offline / comes back online /
      stops updating*, *runs low*, *fails* - the Health integration's own bus events
      (`entity_availability_offline`, `_recovered`, `_stale`, `_low_battery`,
      `_job_failed`), for this Health group only (its `entry_id`); devices are what has a
      device, helpers what has none. The message names it: "Philips Hue Bridge went
      offline", a failed job with its error, a battery with its level.
    - *An entity changes* - [entity] *changes to* [a state, in Home Assistant's words, or
      anything]; an `event.*` entity (a button, a camera's detection) *sends* [any event or
      one of its types]. Never on start-up or an entity coming back from unavailable.
      "Garage Door changed to Open".
    - *A time of day* - *It is* [8:00 PM] on the days ticked.
    - *A calendar event starts* - [calendar] *has an event starting in* [12 h]: fires that
      long before it starts; "Plastic · Tomorrow, 4:00 AM". Under it, *Only events called…*
      narrows it to every event with a title: it rolls into a text field (*Only events
      called* [PrB]), compared trimmed and in any case. A reminder made on one event in the
      Simple Schedule card (the fork's calendar reminders) shows *Only* [Gymnastics] *· every
      occurrence* (or the one event's date) instead; one made there "by title" shows the
      title field. Either line's x lets every event of the calendar through again, folding
      the line away; choosing another calendar drops it too. The preview looks for those
      events only.
    - *A value crosses a number* - [entity] *rises above / drops below* [number].
    - *A trigger in YAML* - Home Assistant's own trigger syntax, for anything else (then the
      only trigger).

    Then *Only if… (optional)*: any of the conditions below, *And* / *Or* as there. The line
    under them previews it, live, with a stand-in for the first trigger's event made from
    what Home Assistant knows now: the calendar's next event, the entity as it is, a device
    that is offline now (or any device of that part of Health). It says when it fires next
    where that can be known, else what it would say; with *Only if* conditions, whether they
    would let it through now. A calendar trigger reads the calendar's own event list (the
    entity knows only its very next event) and names the first event it will really fire for -
    the first whose "starts in" moment is still ahead - worded as the message will read when it
    is sent: "Next fires Today, 8:30 AM: MaFy · Tomorrow, 8:30 AM" (1 day before); nothing to
    fire for in two months says so.
    *Message & details* shows the same message. The form is kept in `rule` (`type: event`); a trigger
    without one opens as YAML.
- **While true - If:** one or more conditions, each a sentence of chips, joined by *And* (all
  must hold at once) or *Or* (any one is enough) - one choice for the whole rule, switched
  by tapping the joining chip on any row. Each condition is marked red while it holds right
  now and grey while it does not, and the line under them counts them ("2 of 3 hold now -
  all must"). A Health condition asks about the whole house - *Device is
  Unavailable* is "some monitored device is unavailable" - so two of them joined by And
  are two separate questions both answered yes, not one device in two states. (Mixed
  And/Or needs grouping: write that as a template condition.) The message names each
  condition that holds, once.
  A chosen value is a white chip (a Health status inside it in the filters' high-contrast
  tag); one still to choose is outlined; the chip whose picker is open is ringed.
  They are picked from a list that opens as a panel of its own inside the group, laid out
  like iOS Settings: an icon tile, the name, a line under it, every row the same size.
  *Health monitor* leads, set apart only by the Health heart on a white tile and a
  full-width rule under it:
  - *Health monitor* - built in; its sentence starts with a [Device | Battery | Helper]
    switch, one per tab of the Health view, then "is" one of that tab's statuses, as the
    Health view draws them (Unavailable, Not Updating (24h) - the window is the group's staleness
    threshold - Low battery, Failed, OK) - each
    device, battery or helper is watched on its own. OK means everything in the tab is. A
    status the new tab does not have falls back to its first. (No Signal: a Bluetooth
    sensor's signal moves with whichever proxy hears it.)
  - *Time or calendar* - one condition, its sentence starting with a [Time | Calendar] switch:
    - *Time* "is between [6:00 PM] and [11:00 PM]" on the days ticked (in the profile's week
      order). A window that ends before it starts runs past midnight; the same start and end
      is the whole day. Alone, it is a reminder: active in the window, and with *Can be
      cleared* it can be ticked off until next time.
    - *Calendar* "[Garbage collection] has an event within [1 day]": an event in progress, or
      the calendar's next event starting within the time set. Its part of the message is the
      event and when: "Bio · Tomorrow, 4:00 AM", "Bio · happening now". (A calendar shows
      Home Assistant its next event only, so it cannot look past it.)
  - *An entity is in a state* - entity, *is* / *is not*, state (the entity's usual states,
    in Home Assistant's own words, or any other typed).
  - *A value is above or below a number* - numeric entities only. Under its sentence, a
    **Margin** [number] with an (i): the alert still fires past the number, but turns OK
    only once the value is back by the margin, so a value wobbling at the limit does not
    fire, clear and fire again. The line says where it turns OK ("OK again at -12 °C or
    below"; at the number itself without a margin). It becomes Alert2's own `threshold:`
    (`maximum`/`minimum` + `hysteresis`), the rest staying the `condition` with
    `has_value()` so an unavailable sensor is not 0. Alert2 keeps one threshold per alert,
    joined to the rest with And: one margin per rule, and not with Or - the line says so
    and Save refuses. Only on *While true* (an event alert's conditions are looked at only
    when it fires). The preview judges the number plainly, as a saved or edited rule starts.
  - *A template is true* - Jinja for anything else. Written with `{% %}`, it has to be
    the only condition.

  Switching a condition's own switch (Time / Calendar, Device / Battery / Helpers) never
  jumps: the thumb slides at once, the rest of the sentence fades out the way it is going,
  the row eases to its new height and the new words slide in from the other side; a
  calendar's list opens only once the row has settled. A second tap mid-switch waits its
  turn.
- **For:** how long it must hold before it fires, on the drums (the whole row opens them).
  When every condition is a Health *Unavailable* or *Not updating*, it is counted per device:
  from the time that device went offline (which survives a restart), or from when the whole
  device was last heard (`stale_since`) plus the group's staleness time - and the row says so. Nothing shows until a device has
  been out that long. Otherwise it is Alert2's `delay_on_secs`: the whole rule must hold that
  long, and its timeline shows *Detected* (with what made it true) and *Cleared early*. A
  wait under way when Home Assistant restarts carries on from when it began (the fork).
- **Right now:** whether the rule would fire this moment and what it would say, rendered
  live by Home Assistant as the rule is built.
- **Actions** (both kinds; an (i) explains them): the scripts the alert runs each time it
  fires - "Run [script]", then "And [script]", picked from Home Assistant's scripts with a
  search, as the links are picked from the dashboards; never the same script twice. Each is
  called with `alert` (the alert's name) and `message` (what it said when it fired, the
  fork's `alert_message`), so a script can announce it. Several run side by side
  (`parallel`), so one failing does not hold up the others, and a failure still lands on the
  timeline as *Action failed* with its error; an event alert queues its runs, so every fire
  runs them. They run while the alert is snoozed too: snooze is for notifications. Saved as
  Alert2's `actions_on`; the form keeps the scripts in `rule` (`actions`).
- **Notify** (an (i) explains it): who hears about it when it fires, laid out as Links - two
  rows, *Push to* and *Banner on*, each with a chip saying what is chosen
  ("Alex + 1 more", "Everyone"). A row opens its list under it:
  - *Push to* lists **users**, by their Home Assistant name, each with the devices signed in
    to the Home Assistant app as them on its second line; *Everyone* on top ("All 6 devices,
    and any added later"), set apart. A user stands for their devices as they are when the
    alert notifies - a new phone signed in as them is in at once, a renamed one is not lost -
    and Everyone for every device with the app; picking Everyone lets the users go, and a
    user lets Everyone go. The list is read from the fork (`alert2/hm/push_users`) each time
    the sheet opens; a user with no device is offered only while the rule names them, so they
    can be let go.
  - *Banner on* lists the dashboards (all but the map), with their icons and addresses, led by
    a *Show on* switch: **Every page** or **Home page** (see *Banners*). The chip adds
    "· Home page" when that is chosen.

  Any number are picked, white with a tick, and the list stays open until the row is tapped
  again. Saved as Alert2's `notifier` (a list: `user:<user id>`, Everyone `user:*`), `title`
  (the alert's name) and `annotate_messages: false` - the push is titled with the name, its
  text is the message alone - and the fork's `overlay` (the dashboards). Nothing picked tells
  nobody (the package's default `notifier: null`). What the fork does with a push - turning
  users into devices, its buttons, taking it back - is in its README (*Notifier config*); the
  timeline's *Notified* names the devices it reached.
- Scrolling a list inside the sheet (entities, calendars, links) hands on to the sheet once
  the list reaches its end, so a short screen still reaches everything; the page behind
  never moves.
- **Links:** where the alert takes you, one per dashboard - *Desktop link* from the tablet
  dashboard, *Mobile link* from the phone's (`link` and the fork's `link_mobile`). Each
  opens a list of that dashboard's views, each followed by its Bubble pop-ups (`#hash`),
  read live from the dashboard itself, so a new view or pop-up is there the next time.
  Scroll, type to filter, or type an address starting with `/` or `http` to use it as it
  is. On top, *Suggested*: the pop-ups and views that show an entity the conditions are
  about, or the Health view for a Health condition - ruled off from the rest. The
  dashboards are found by name (*tablet*/*desktop*, *mobile*/*phone*) unless the card's
  options name them.
  **Health view, filtered:** where the dashboard has the Health view, the list starts with it
  already filtered - to what the rule watches (its Health conditions or triggers: the first
  one's tab and every status asked on it, "Health · Devices · Unavailable"), and as the Health
  view was last set on this device ("as you last set it"). Set up any combination there -
  tab, statuses, integrations, areas, search - then pick it here. The link is the Health
  view's own address (`?hm_tab=…&hm_status=…`, see its README) and its chip reads it in words.
  For a rule that holds while true, the first entry is **Only from this alert**: the Health
  view with just the devices (or helpers, batteries) the alert is about, not every one in
  that status - a chip there names the alert and counts them, *2 of 6 unavailable*. Saved,
  the link carries the alert's entity id (`hm_alert`) and `hm_rows`, a template naming what
  is in the statuses of its Health conditions right now - one id per device, the *For* of a
  per-device "Unavailable" included. The fork renders it again whenever that changes; opened
  for editing, the rule reads it back as the same choice, so it follows the conditions.
- **Message & details** (one fold; its summary says *Automatic* or *Your Own Set*, and
  *About Set*): the automatic message - each condition says its part, e.g. the offline
  devices and since when - or your own text or template; and what the alert is for
  (`description`, the row's second line).

*Add* says what is missing if anything is, checks the rule with Alert2, creates it, and
closes once the new alert exists - then shows it, open, in *All Alerts*. The form is kept
in the rule's `rule` field so it can be opened again. Escape or a tap outside closes an
open picker first, then the sheet.

## Edit

*Edit* on an expanded alert opens the same sheet with the rule as Alert2 keeps it (the
`manageAlert` API: `search` tells which alerts were made here, `load` reads one, `update`
saves it). The form comes from the rule's `rule` field; a rule without one - or with a
condition kind the editor no longer knows - opens as what it is: its condition as a
template, its message as *Your own*. The link chips open with their names (the dashboards
are read before the sheet opens).

Nothing typed makes up an alert's id. A new rule is `alert2.rule_<generated id>` (Alert2's
domain `rule`, a generated name), its name is its display name and its category the fork's
`category` field - so both can change on Edit while the alert keeps its id, and with it its
history, timeline and snooze. Two alerts may not share a name. Fields
the editor does not show (an `icon` set in the rule's file) are kept; an emptied
description, link or delay is removed. *Save* closes once Alert2 has replaced the entity,
and the alert stays where it was, open, showing the change.

**The built-in alerts** (Alert2's own: *HASS Global Errors*, `alert2.alert2_global_exception`,
and *HASS Alerting Errors*, `alert2.alert2_error`) are edited in the same sheet once their
settings are in the rule store (here: `/config/alerts/alert2_*.yaml`, none in the YAML
`tracked:`). What may change can: the name, priority, category, *Can be cleared*, *Stays
firing*, *Notify*, the links and *About*. What cannot is shown greyed - *Fires* (When it
happens) and what sets it off, *Actions* (a built-in alert runs no scripts) and its message
(it says what was reported) - and there is no *Delete*. The fork makes a save the live
alert's at once.

*Delete* (Edit only) sits at the left of the sheet's foot, as in the Simple Schedule card:
red words; the first tap arms it - filled red, *Tap again to delete* - and the second
deletes the rule (its file and timeline with it); a tap anywhere else disarms it. The row
then leaves the table.

Every popup - the editor, the snooze sheet, the *(i)* - dims the page to the same 60%
(68% on a phone).

One date-time format everywhere - tables, timeline, chart, snooze: *Today, 9:21 PM*,
*Yesterday, 8:24 PM*, *Tomorrow, 8:00 AM*, otherwise *Sun, Oct 4, 9:21 PM* (the clock follows
the HA profile's 12/24-hour setting). Rule messages should use the same
(`timestamp_custom('%a, %b %-d, %-I:%M %p')`). The chart's ranges are 24h, 3d and 7d;
an open alert's status history follows the chosen range.

Two priorities: high (red) and low (yellow); Alert2's *medium* counts as high. Firing is
the Health card's "unavailable" red whatever the priority, snoozed is a pale rose (it is
active, and someone has put it off), OK is green. Selection is white and one weight up;
the only coloured control is *Clear*, in the OK green.
