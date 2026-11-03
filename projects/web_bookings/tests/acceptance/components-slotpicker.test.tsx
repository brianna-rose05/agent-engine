// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SlotPicker } from "@/components/SlotPicker";

afterEach(cleanup);
const slots = [
  { id: "a", startsAt: new Date("2026-11-10T17:00:00Z") },
  { id: "b", startsAt: new Date("2026-11-10T21:30:00Z") },
];

describe("SlotPicker", () => {
  it("shows local times in order", () => {
    render(<SlotPicker slots={slots} tz="America/Los_Angeles" onPick={() => {}} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["9:00 AM", "1:30 PM"]);
  });
  it("picks and marks the selected slot", () => {
    const onPick = vi.fn();
    render(<SlotPicker slots={slots} tz="America/Los_Angeles" selectedId="b" onPick={onPick} />);
    fireEvent.click(screen.getByText("9:00 AM"));
    expect(onPick).toHaveBeenCalledWith("a");
    expect(screen.getByText("1:30 PM").getAttribute("aria-pressed")).toBe("true");
  });
  it("says when nothing is open", () => {
    render(<SlotPicker slots={[]} tz="America/Los_Angeles" onPick={() => {}} />);
    expect(screen.getByText("No open times this day")).toBeTruthy();
  });
});
