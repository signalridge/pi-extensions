---
"@signalridge/pi-usage-extension": minor
---

Add a This Month period to `/usage`, between Last Week and Last 30 Days, covering the calendar month to date in the table, graphs, insights and exports. The month starts at 00:00 on the local 1st, computed from the civil calendar so month length and DST changes never shift it (a midnight skipped by DST on the 1st starts the month at that day's first instant). Adapted from tmustier/pi-extensions `3de53e29`.
