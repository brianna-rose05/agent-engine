# Community garden

A Python library (no UI yet) that runs a neighborhood community garden.

- The garden has numbered plots in three sizes: small, medium and large. Members rent one plot per
  season (seasons are named like "2027-spring"). A member can rent at most one plot per season,
  and a plot can only be rented by one member per season.
- Season fees: small $40, medium $65, large $90. Members who rented any plot in the previous season
  get 10% off (seasons go spring, summer, fall, then the next year's spring). Seniors get $15 off
  after any other discount. Fees never go below $0. Money is in whole cents, rounded half up.
- When a season is full, members can join a waitlist for a plot size. When a rental is cancelled,
  the plot goes to the earliest waitlisted member for that size who doesn't already have a plot
  that season.
- Shared tools are watered on a rota: given the members renting in a season and the season's start
  date, produce a weekly watering schedule (one member per week, in order of plot number, wrapping
  around) for a given number of weeks.
- Staff need a season summary: plots rented by size, total fees collected, and waitlist length per size.
