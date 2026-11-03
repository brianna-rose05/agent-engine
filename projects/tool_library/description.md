# Neighborhood tool library

A small Python library (no web UI yet) for a community tool-lending library.

- Members borrow tools for a number of days. A tool can only be out with one member at a time,
  and a member can have at most 3 tools out at once.
- Returning a tool records the return date.
- Late fees: each tool has a daily late fee. A loan returned (or still out) after its due date costs
  the daily fee for each day late, capped at $50 per loan. Money is in whole cents.
- Staff need an overdue report: every loan still out past its due date, with the member's name, the
  tool's name, days late, and the fee so far, most overdue first.
