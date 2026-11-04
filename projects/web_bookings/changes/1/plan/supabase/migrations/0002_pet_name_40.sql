alter table bookings drop constraint bookings_pet_name_check;
alter table bookings add constraint bookings_pet_name_check check (char_length(pet_name) between 1 and 40);
