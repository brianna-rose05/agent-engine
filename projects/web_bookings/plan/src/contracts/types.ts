export type Role = "customer" | "staff";

export type Slot = { id: string; startsAt: Date };

export type Booking = {
  id: string;
  slotId: string;
  customerId: string;
  petName: string;
  status: "booked" | "cancelled";
};

export type BookInput = { slotId: string; petName: string };
