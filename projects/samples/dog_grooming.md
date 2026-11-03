# Dog grooming booking site

A booking website for a single-location dog grooming shop in Los Angeles (America/Los_Angeles).

People
- Customers sign up, add their dogs (name, breed, size: small, medium or large), and book grooming.
- Staff manage the schedule and see the day's appointments. A person is either a customer or staff.

Services and prices
- Bath: small $45, medium $60, large $75. Full groom: small $70, medium $90, large $110.
- Add-ons: nail trim $15, teeth brushing $12. Prices are stored in cents.

Booking
- Staff publish appointment slots (a start time; every slot is 90 minutes). A slot holds one appointment.
- A customer picks one of their own dogs, a service, any add-ons, and an open slot. The price is calculated
  from the dog's size, service and add-ons when booking and saved with the appointment.
- A $20 deposit is due at booking (or the full price if it is under $20). Store the deposit amount; no real
  payment processing yet.
- Customers can cancel their own appointment up to 24 hours before it starts (deposit refunded), or later
  (deposit kept). Staff can cancel any appointment (deposit always refunded).

Pages
- Booking page: pick a dog, service and add-ons, see the price and deposit update, pick a day and an open
  time (shown in local time), confirm.
- My appointments page for customers: upcoming and past appointments with status and amounts.
- Staff day view: the day's appointments in time order with dog, owner, service, add-ons and price.
