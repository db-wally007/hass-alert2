# Changelog

Releases of this fork of [redstone99/hass-alert2](https://github.com/redstone99/hass-alert2).
A release is `v<upstream version>+hm.<n>`; alert-console-card carries its own version.
Everything listed is add-only - upstream behaviour is unchanged unless it is used.

## [1.22+hm.1] - 2026-11-02

The fork's first release, on Alert2 1.22, with alert-console-card 1.0.0.

### Added

- **alert-console-card** (`alert-console-card/`): an Alerts view for tablets and phones - what
  is firing, a chart of firing over time, every alert's timeline and history, snooze and clear -
  in the design of health-monitor-card, plus a rule editor (conditions, triggers, calendar
  events, Health monitor built-ins, actions, notify, links).
- **Banners**: an alert can drop in across the top of chosen dashboards while it fires - white,
  its name and an Open button for its link, sized for a wall tablet on wider screens. *Banner
  on → Show on* puts it on every page, or only on each dashboard's Home page
  (`/<dashboard>/home`) and not over a pop-up there.
- **Push to users**: a notifier `user:<id>` (or `user:*`) reaches every phone signed in to the
  Home Assistant app as them, with Clear and Snooze buttons, and is taken back when the alert
  is OK, cleared or snoozed.
- **Rules as files** (`rules_dir`): every UI rule is also a YAML file, read back at start and
  on reload.
- **A timeline per alert**, kept across restarts, with Home Assistant's restarts on it.
- **Calendar reminders API** (`alert2/hm/reminders/*`): other cards (Simple Schedule card) put
  alerts on calendar events - one event, every repeat, or every event with a title - including
  `banner_home` for Home-page-only banners.
- Rule fields `category`, `description`, `link`, `link_mobile`, `overlay`, `allow_clear`,
  `stays_firing_mins`, `actions_on` on event alerts; top-level `start_delay_secs`,
  `merge_warnings_into_errors`, `alerts_page`.

### Fixed (in the editor)

- A trigger on an event entity (a doorbell, a button) no longer skips the first event after a
  restart: such an entity reads "unknown" until its first event, so from "unknown" it is a real
  event.
