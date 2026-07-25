# Screenshots to add to the README

The README currently ships with the two diagrams only (`booking-race.svg`,
`architecture.svg`) — no screenshots, so nothing renders broken. This file is the shot
list for adding them.

Capture the seven below, drop them in `docs/`, then add the `<img>` pairs back into the
README at these points:

| README section                                      | Images, side by side at `width="420"` |
| --------------------------------------------------- | ------------------------------------- |
| Under the opening pitch, above the `---`            | `calendar.png` · `booking-dialog.png` |
| "Availability the calendar and the server agree on" | `availability.png` · `conflicts.png`  |
| "Live, and honest about when it isn't"              | `live.png` at `width="100%"`          |
| "Teams"                                             | `people.png` · `roles.png`            |

Capture at roughly **1280×800**, browser zoom 100%, light mode. Crop to the panel
described rather than the whole window — the README lays most of them out two-up at
420px, so a tight crop reads much better than a full-screen shot scaled down.

## Setup that makes the shots look right

```bash
npm run dev:api
npm run dev:web
```

Create a workspace, then a room, then set Mon–Fri 09:00–17:00 opening hours on it and
make three or four bookings across the week with real-sounding titles. Empty grids and
`asdf` titles make a project look unfinished in exactly the way it isn't.

| File                 | What to capture                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar.png`       | The week grid for one resource. Must show **booked blocks and the hatched shading over closed hours** — that contrast is the point of the shot. Include the toolbar row so the resource picker and the "Outside opening hours" legend are visible.            |
| `booking-dialog.png` | The booking dialog open over the grid. Set a length of 90 min so the **Length** dropdown is clearly not a fixed 15, and pick a date whose opening-hours line reads `Open 09:00–17:00`.                                                                        |
| `availability.png`   | `/resources/<id>/availability` — the weekday rows with toggles and time inputs, plus at least one dated override in the table below (add a holiday closure so the table isn't empty).                                                                         |
| `conflicts.png`      | The amber warning panel listing bookings that no longer fit. To produce it: make a 10:00 booking, then narrow that resource's hours to 13:00–17:00 and save.                                                                                                  |
| `people.png`         | The People page just after adding someone — the **temporary password panel** should be on screen alongside the members table. Use a throwaway name; the password shown is single-use and the workspace is local, but crop out anything you would not publish. |
| `roles.png`          | Signed in as a **member**, with someone else's booking open in the detail panel, showing "Only its owner or an administrator can change this." Two-up with `people.png`, so a tight crop of the panel is enough.                                              |
| `live.png`           | Two browser windows side by side, same workspace, a booking just made in the left one now present in the right. Make sure the green **Live** indicator in the header is legible — it is the subject of the shot.                                              |

## Before committing them

- No real names, real email addresses, or anything from a non-test workspace.
- The temporary password in `people.png` is fine to show (single-use, local database) but
  do not reuse that password anywhere.
- PNG, not JPEG — screenshots of UI with text go blotchy under JPEG compression.
- Run them through an optimiser if any lands over ~300 KB.
